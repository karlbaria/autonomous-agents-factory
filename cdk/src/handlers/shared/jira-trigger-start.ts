/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Start the work a Jira parent issue asks for, once the trigger is attributed
 * to a platform user (#82 PR 3b-2, decision 13): an orchestration over its
 * authored subtasks when it has any, otherwise one coding task for the issue.
 *
 * Extracted from `jira-webhook-processor.ts` so the label trigger and the Slack
 * Start button run the same path. Failures are reported on the issue through
 * `deps.reportFailure`, as the webhook processor always did.
 */

import * as crypto from 'crypto';
import { ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import type { S3Client } from '@aws-sdk/client-s3';
import { type DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { ScreeningConfig } from './attachment-screening';
import { createTaskCore } from './create-task-core';
import { extractDescriptionMarkdown } from './jira-adf';
import {
  cleanupPreScreenedAttachments,
  downloadScreenAndStoreJiraAttachments,
  fetchRecentHumanComments,
  JiraAttachmentError,
  type RenderedComment,
} from './jira-attachments';
import { resolveJiraOauthToken } from './jira-oauth-resolver';
import type { JiraSubIssueNode } from './jira-subissue-fetch';
import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import { lookupValueOr } from './lookup-result';
import { makeJiraChannel } from './orchestration-channel-jira';
import { discoverOrchestration } from './orchestration-discovery';
import { jiraGraphSource } from './orchestration-graph-source';
import {
  applyTerminalCreateFailures,
  readConcurrencyBudget,
  releaseReadyChildren,
} from './orchestration-release';
import { upsertEpicPanel } from './orchestration-rollup';
import {
  deriveOrchestrationId,
  loadOrchestration,
  setStatusCommentId,
  type OrchestrationReleaseContext,
} from './orchestration-store';
import { lookupRepo } from './repo-config';
import { DEFAULT_LABEL_FILTER } from './trigger-label';
import type { Attachment, PassedAttachmentRecord } from './types';
import { MAX_TASK_DESCRIPTION_LENGTH } from './validation';
import { resolveChannelDefaultWorkflow } from './workflows';

/** The parts of a Jira issue the start path reads. */
export interface JiraTriggerIssue {
  readonly id: string;
  readonly key: string;
  readonly fields?: {
    readonly summary?: string;
    readonly description?: unknown; // ADF document
    /** Jira `media` file attachments. Shape validated in jira-attachments.ts. */
    readonly attachment?: unknown[];
    readonly [key: string]: unknown;
  };
}

/** Tables, clients and the failure reporter of the calling Lambda. */
export interface StartJiraParentWorkDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly projectMappingTable: string;
  readonly workspaceRegistryTable?: string;
  readonly orchestrationTable?: string;
  readonly userConcurrencyTable?: string;
  readonly maxConcurrent: number;
  readonly s3Client?: S3Client;
  readonly attachmentsBucket?: string;
  readonly screeningConfig?: ScreeningConfig;
  /** Post a failure comment on the issue; must never throw. */
  readonly reportFailure: (issueIdOrKey: string, cloudId: string | undefined, message: string) => Promise<void>;
}

/** The attributed trigger. */
export interface StartJiraParentWorkInput {
  readonly issue: JiraTriggerIssue;
  readonly cloudId: string;
  readonly projectKey: string;
  readonly mapping: ProjectMapping;
  readonly repo: string;
  readonly labelFilter: string;
  readonly platformUserId: string;
  /** Idempotency key for the single-task path. */
  readonly idempotencyKey?: string;
}

/**
 * Start the parent's work: seed or extend its orchestration, or create its
 * single coding task. See the module comment.
 */
// eslint-disable-next-line complexity -- moved unchanged from the Jira webhook processor's handler (#82 PR 3b-2), which predates the ceiling; must not grow
export async function startJiraParentWork(
  deps: StartJiraParentWorkDeps,
  input: StartJiraParentWorkInput,
): Promise<void> {
  const { ddb, s3Client, screeningConfig } = deps;
  const WORKSPACE_REGISTRY_TABLE = deps.workspaceRegistryTable;
  const ORCHESTRATION_TABLE = deps.orchestrationTable;
  const USER_CONCURRENCY_TABLE = deps.userConcurrencyTable;
  const MAX_CONCURRENT = deps.maxConcurrent;
  const ATTACHMENTS_BUCKET = deps.attachmentsBucket;
  const safeReportIssueFailure = deps.reportFailure;
  const { issue, cloudId, projectKey, mapping, repo, labelFilter, platformUserId, idempotencyKey } = input;

  // Convert the ADF description to markdown once and reuse it for both the
  // task body and image-attachment extraction.
  const descriptionMarkdown = extractDescriptionMarkdown(issue.fields?.description);

  const channelMetadata: Record<string, string> = {
    jira_cloud_id: cloudId,
    jira_project_key: projectKey,
    jira_issue_id: issue.id,
    jira_issue_key: issue.key,
  };

  // Optional per-project workflow-transition overrides (issue #572). When an
  // admin configured `bgagent jira map ... --status-on-start/--status-on-pr`,
  // stamp them so the agent's best-effort transition helpers prefer these
  // status names over the built-in statusCategory / "In Review" heuristics.
  const statusOnStart = mapping.status_on_start as string | undefined;
  const statusOnPr = mapping.status_on_pr as string | undefined;
  if (statusOnStart) {
    channelMetadata.jira_status_on_start = statusOnStart;
  }
  if (statusOnPr) {
    channelMetadata.jira_status_on_pr = statusOnPr;
  }

  // Stash the resolved OAuth secret ARN on the task so the agent runtime
  // doesn't have to re-do the registry lookup. Also blocks tasks from
  // tenants that only verified via the stack-wide fallback (workspace
  // unknown to the registry) — we'd burn agent quota with no resolvable
  // Jira OAuth token for the outbound REST progress comments.
  let resolvedJira: Awaited<ReturnType<typeof resolveJiraOauthToken>> = null;
  if (WORKSPACE_REGISTRY_TABLE) {
    const resolved = await resolveJiraOauthToken(cloudId, WORKSPACE_REGISTRY_TABLE);
    if (!resolved) {
      logger.warn('Jira tenant not resolvable from registry — dropping event', {
        jira_cloud_id: cloudId,
        issue_key: issue.key,
      });
      return;
    }
    resolvedJira = resolved;
    channelMetadata.jira_oauth_secret_arn = resolved.oauthSecretArn;
    channelMetadata.jira_site_url = resolved.siteUrl;
  }

  let orchestrationChildren: readonly SubIssueNode[] | undefined;
  let existingOrchestration = false;
  if (ORCHESTRATION_TABLE && resolvedJira) {
    // Re-read an existing orchestration's authored graph so genuinely-new Jira
    // subtasks can be appended. The flag also prevents parent attachments from
    // being uploaded again below: the meta row already pins the first seed's S3
    // versions, and replacing them would eventually expire those pinned objects.
    const existing = await loadOrchestration(
      ddb,
      ORCHESTRATION_TABLE,
      deriveOrchestrationId(issue.key),
    );
    existingOrchestration = existing !== null;

    const graphResult = await jiraGraphSource(
      resolvedJira.accessToken,
      cloudId,
      issue.key,
    )();
    if (graphResult.kind === 'error') {
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        `❌ ABCA couldn't read this issue's Jira subtasks: ${graphResult.message}`,
      );
      return;
    }
    if (graphResult.kind === 'no_children' && existingOrchestration) {
      logger.info('Jira orchestration re-trigger has no current subtasks — no-op', {
        issue_key: issue.key,
      });
      return;
    }
    if (graphResult.kind === 'ok') {
      const routed = await routeJiraOrchestrationChildren(deps, {
        cloudId,
        parentProjectKey: projectKey,
        parentMapping: mapping,
        parentRepo: repo,
        children: graphResult.children as readonly JiraSubIssueNode[],
        oauthSecretArn: resolvedJira.oauthSecretArn,
        siteUrl: resolvedJira.siteUrl,
      });
      if (!routed.ok) {
        await safeReportIssueFailure(issue.key, cloudId, `❌ ${routed.message}`);
        return;
      }
      orchestrationChildren = routed.children;
    }
  }

  // Embedded HTTPS image URLs from the description (unchanged, #577 preserves).
  const urlAttachments = extractImageUrlAttachments(descriptionMarkdown);

  // Mint the task ID up front so pre-screened attachment S3 keys match the
  // eventual task record (createTaskCore honors context.taskId, #577).
  const taskId = ulid();

  // Context enrichment (#577). Both need the workspace registry to resolve an
  // OAuth token. Comments are fail-open (advisory); attachments are
  // fail-closed (a selected-but-unscreenable attachment rejects the task).
  let comments: RenderedComment[] = [];
  let preScreenedAttachments: PassedAttachmentRecord[] = [];
  if (WORKSPACE_REGISTRY_TABLE && !existingOrchestration) {
    const tenantCtx = { cloudId, registryTableName: WORKSPACE_REGISTRY_TABLE };

    // Recent human comments — advisory context, never gate task creation.
    const fetchedComments = await fetchRecentHumanComments(tenantCtx, issue.key);
    // Fail-OPEN on comment content policy: comments are third-party text the
    // reporter didn't write, so a policy-tripping comment must not fail the
    // reporter's task. Screen the rendered comment section on its own and drop
    // it (not the task) if the guardrail intervenes. (createTaskCore separately
    // screens the description, which the reporter authored.)
    comments = await screenCommentsOrDrop(screeningConfig, fetchedComments, issue.key, cloudId);

    const rawAttachments = issue.fields?.attachment;
    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      if (!s3Client || !ATTACHMENTS_BUCKET || !screeningConfig) {
        // Fail-closed: the issue has attachments but the processor can't
        // screen/store them. Don't silently drop selected context — reject
        // with a clear comment so the operator can fix configuration.
        logger.error('Jira issue has attachments but screening/storage is not configured (fail-closed)', {
          issue_key: issue.key,
          jira_cloud_id: cloudId,
          has_bucket: Boolean(ATTACHMENTS_BUCKET),
          has_guardrail: Boolean(screeningConfig),
        });
        await safeReportIssueFailure(
          issue.key,
          cloudId,
          '❌ This Jira issue has file attachments, but ABCA attachment screening is not configured. Contact your ABCA admin.',
        );
        return;
      }
      // Combined cap: URL image attachments already consume slots.
      const remainingSlots = 10 - urlAttachments.length;
      try {
        preScreenedAttachments = await downloadScreenAndStoreJiraAttachments(
          rawAttachments,
          remainingSlots,
          { ...tenantCtx, s3Client, bucketName: ATTACHMENTS_BUCKET, screeningConfig, userId: platformUserId, taskId },
        );
      } catch (err) {
        if (err instanceof JiraAttachmentError) {
          logger.warn('Rejecting Jira task: attachment could not be safely processed', {
            issue_key: issue.key,
            jira_cloud_id: cloudId,
            error: err.message,
          });
          await safeReportIssueFailure(
            issue.key,
            cloudId,
            `❌ ABCA couldn't safely process an attachment on this issue: ${err.message} Remove or fix the attachment and re-apply the trigger label.`,
          );
          return;
        }
        throw err;
      }
    }
  }

  const taskDescription = buildTaskDescription(issue, descriptionMarkdown, comments);

  if (ORCHESTRATION_TABLE && orchestrationChildren) {
    const releaseContext: OrchestrationReleaseContext = {
      platform_user_id: platformUserId,
      channel_source: 'jira',
      trigger_label: (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase(),
      ...(statusOnStart && { jira_status_on_start: statusOnStart }),
      ...(statusOnPr && { jira_status_on_pr: statusOnPr }),
      parent_context: {
        ...(issue.fields?.summary && { title: issue.fields.summary }),
        ...(descriptionMarkdown && { description: descriptionMarkdown }),
      },
      ...(preScreenedAttachments.length > 0 && {
        pre_screened_attachments: preScreenedAttachments,
      }),
    };
    const discovery = await discoverOrchestration({
      ddb,
      tableName: ORCHESTRATION_TABLE,
      parentIssueRef: issue.key,
      credentialsRef: cloudId,
      repo,
      now: new Date().toISOString(),
      releaseContext,
      graphSource: async () => ({ kind: 'ok', children: orchestrationChildren }),
    });

    if (discovery.kind === 'rejected' || discovery.kind === 'error') {
      if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
        await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
      }
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        `❌ ABCA couldn't create this Jira orchestration: ${discovery.message}`,
      );
      return;
    }

    // A concurrent replay can win between the preflight read and the seed
    // condition. The shared discovery path returns that race as an empty extend;
    // any attachment objects uploaded by this invocation are duplicates.
    if (discovery.kind === 'seeded' && discovery.alreadyExisted) {
      if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
        await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
      }
      return;
    }

    if (discovery.kind === 'seeded') {
      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot) {
        const now = new Date().toISOString();
        const budget = USER_CONCURRENCY_TABLE
          ? await readConcurrencyBudget(
            ddb,
            USER_CONCURRENCY_TABLE,
            snapshot.meta.release_context.platform_user_id,
            MAX_CONCURRENT,
          )
          : undefined;
        const results = await releaseReadyChildren(
          ddb,
          ORCHESTRATION_TABLE,
          snapshot.children,
          snapshot.meta.release_context,
          createTaskCore,
          now,
          snapshot.children,
          'main',
          budget,
        );
        await applyTerminalCreateFailures(
          ddb,
          ORCHESTRATION_TABLE,
          discovery.orchestrationId,
          snapshot.children,
          results,
          now,
        );

        if (WORKSPACE_REGISTRY_TABLE) {
          try {
            const fresh = await loadOrchestration(
              ddb,
              ORCHESTRATION_TABLE,
              discovery.orchestrationId,
            );
            if (fresh) {
              const commentId = lookupValueOr(await upsertEpicPanel({
                channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
                parent: {
                  issueId: issue.key,
                  credentialsRef: cloudId,
                  stateOverrides: {
                    ...(statusOnStart && { started: statusOnStart }),
                    ...(statusOnPr && { inReview: statusOnPr }),
                  },
                },
                children: fresh.children,
                labelFilter,
              }), null);
              if (commentId) {
                await setStatusCommentId(
                  ddb,
                  ORCHESTRATION_TABLE,
                  discovery.orchestrationId,
                  commentId,
                );
              }
            }
          } catch (err) {
            logger.warn('Failed to post Jira orchestration panel at seed (non-fatal)', {
              issue_key: issue.key,
              orchestration_id: discovery.orchestrationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      logger.info('Jira orchestration seeded — parent task suppressed', {
        issue_key: issue.key,
        orchestration_id: discovery.orchestrationId,
        child_count: discovery.childCount,
      });
      return;
    }
    if (discovery.kind === 'extended') {
      if (discovery.addedSubIssueIds.length === 0) {
        logger.info('Jira orchestration re-trigger added no new subtasks', {
          issue_key: issue.key,
          orchestration_id: discovery.orchestrationId,
        });
        return;
      }

      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot) {
        const releasableRows = snapshot.children.filter(
          (child) => discovery.releasableSubIssueIds.includes(child.sub_issue_id)
            && child.child_status === 'ready',
        );
        let panelSnapshot = snapshot;
        if (releasableRows.length > 0) {
          const now = new Date().toISOString();
          const results = await releaseReadyChildren(
            ddb,
            ORCHESTRATION_TABLE,
            releasableRows,
            snapshot.meta.release_context,
            createTaskCore,
            now,
            snapshot.children,
          );
          await applyTerminalCreateFailures(
            ddb,
            ORCHESTRATION_TABLE,
            discovery.orchestrationId,
            snapshot.children,
            results,
            now,
          );
          panelSnapshot = await loadOrchestration(
            ddb,
            ORCHESTRATION_TABLE,
            discovery.orchestrationId,
          ) ?? snapshot;
        }

        if (WORKSPACE_REGISTRY_TABLE) {
          try {
            // Unlike seed, extension already has a durable snapshot. Refresh the
            // panel from it even if a post-release read is temporarily unavailable.
            const commentId = lookupValueOr(await upsertEpicPanel({
              channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
              parent: {
                issueId: issue.key,
                credentialsRef: cloudId,
                stateOverrides: {
                  ...(panelSnapshot.meta.release_context.jira_status_on_start && {
                    started: panelSnapshot.meta.release_context.jira_status_on_start,
                  }),
                  ...(panelSnapshot.meta.release_context.jira_status_on_pr && {
                    inReview: panelSnapshot.meta.release_context.jira_status_on_pr,
                  }),
                },
              },
              ...(panelSnapshot.meta.status_comment_id && {
                statusCommentId: panelSnapshot.meta.status_comment_id,
              }),
              children: panelSnapshot.children,
              inProgress: true,
              labelFilter,
            }), null);
            if (commentId && !panelSnapshot.meta.status_comment_id) {
              await setStatusCommentId(
                ddb,
                ORCHESTRATION_TABLE,
                discovery.orchestrationId,
                commentId,
              );
            }
          } catch (err) {
            logger.warn('Failed to refresh Jira orchestration panel on extend (non-fatal)', {
              issue_key: issue.key,
              orchestration_id: discovery.orchestrationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      logger.info('Jira orchestration extended with new subtasks', {
        issue_key: issue.key,
        orchestration_id: discovery.orchestrationId,
        added_count: discovery.addedSubIssueIds.length,
        releasable_count: discovery.releasableSubIssueIds.length,
      });
      return;
    }
  }

  const requestId = crypto.randomUUID();
  // Explicit coding workflow: a label-triggered Jira task always targets a
  // mapped repo, so it must not fall through the resolution ladder to the
  // repo-less default/agent-v1 (which never commits or opens a PR). #546
  // Task 13 (fork): the repo's own default_workflow wins when set, so a
  // repo like factory-shop can default to the adversarial workflow instead.
  const { config: jiraTaskRepoConfig } = await lookupRepo(repo);
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      workflow_ref: resolveChannelDefaultWorkflow(jiraTaskRepoConfig),
      ...(urlAttachments.length > 0 && { attachments: urlAttachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'jira',
      channelMetadata,
      taskId,
      // Deterministic key so an async re-delivery of the same trigger event
      // dedupes instead of minting a second task (and re-downloading every
      // attachment). Keyed on issue + webhook timestamp, matching the
      // receiver's dedup key shape.
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      ...(preScreenedAttachments.length > 0 && { preScreenedAttachments }),
    },
    requestId,
  );

  if (result.statusCode === 200) {
    // Idempotent replay: this is a duplicate delivery of the same trigger event
    // (createTaskCore matched the deterministic idempotency key to an existing
    // task). Not a failure — but the attachments we re-downloaded and uploaded
    // this round are keyed on a fresh taskId the replayed task doesn't
    // reference, so delete them rather than orphan them. No ❌ comment.
    logger.info('Jira-triggered task was an idempotent replay (duplicate delivery)', {
      issue_key: issue.key,
      request_id: requestId,
    });
    if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
      await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
    }
    return;
  }

  if (result.statusCode !== 201) {
    logger.warn('Jira-triggered task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_key: issue.key,
    });
    // Don't orphan the attachment objects we uploaded before this call failed —
    // createTaskCore only rolls back its own inline uploads, not ours.
    if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
      await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
    }
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      buildCreateTaskFailureMessage(result.statusCode, result.body),
    );
    return;
  }

  logger.info('Jira-triggered task created', {
    issue_key: issue.key,
    issue_id: issue.id,
    repo,
    request_id: requestId,
  });
}

type ProjectMapping = Readonly<Record<string, unknown>>;

async function routeJiraOrchestrationChildren(deps: StartJiraParentWorkDeps, params: {
  readonly cloudId: string;
  readonly parentProjectKey: string;
  readonly parentMapping: ProjectMapping;
  readonly parentRepo: string;
  readonly children: readonly JiraSubIssueNode[];
  readonly oauthSecretArn: string;
  readonly siteUrl: string;
}): Promise<
  | { readonly ok: true; readonly children: readonly SubIssueNode[] }
  | { readonly ok: false; readonly message: string }
> {
  const mappings = new Map<string, ProjectMapping>([
    [params.parentProjectKey, params.parentMapping],
  ]);
  for (const projectKey of new Set(params.children.map((child) => child.project_key))) {
    if (mappings.has(projectKey)) continue;
    const result = await deps.ddb.send(new GetCommand({
      TableName: deps.projectMappingTable,
      Key: { jira_project_identity: `${params.cloudId}#${projectKey}` },
    }));
    if (result.Item) mappings.set(projectKey, result.Item);
  }

  for (const child of params.children) {
    const childMapping = mappings.get(child.project_key);
    if (!childMapping || childMapping.status !== 'active' || typeof childMapping.repo !== 'string') {
      return {
        ok: false,
        message: `${child.identifier ?? child.id} belongs to Jira project ${child.project_key}, `
          + 'which is not actively mapped to an ABCA repository. Map that project and re-apply the trigger label.',
      };
    }
    if (childMapping.repo !== params.parentRepo) {
      return {
        ok: false,
        message: `${child.identifier ?? child.id} maps to ${childMapping.repo}, but the parent maps to `
          + `${params.parentRepo}. All executable Jira subtasks must map to the same repository.`,
      };
    }
  }

  return {
    ok: true,
    children: params.children.map((child) => {
      const childMapping = mappings.get(child.project_key)!;
      return {
        ...child,
        channel_metadata: {
          jira_cloud_id: params.cloudId,
          jira_project_key: child.project_key,
          jira_issue_id: child.issue_id,
          jira_issue_key: child.identifier ?? child.id,
          jira_oauth_secret_arn: params.oauthSecretArn,
          jira_site_url: params.siteUrl,
          ...(typeof childMapping.status_on_start === 'string' && {
            jira_status_on_start: childMapping.status_on_start,
          }),
          ...(typeof childMapping.status_on_pr === 'string' && {
            jira_status_on_pr: childMapping.status_on_pr,
          }),
        },
      };
    }),
  };
}

/**
 * Translate a `createTaskCore` non-201 response into a user-facing Jira
 * comment. Mirrors the Linear-side helper.
 */
export function buildCreateTaskFailureMessage(
  statusCode: number,
  rawBody: string,
  retryHint = 'Please re-apply the trigger label in a few minutes.',
): string {
  let detail = '';
  try {
    if (rawBody) {
      const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } };
      const message = parsed.error?.message;
      if (typeof message === 'string' && message.trim()) {
        detail = message.trim();
      }
    }
  } catch {
    // fall through to the generic message
  }

  if (statusCode === 400 && detail) {
    return `❌ ABCA couldn't accept this task: ${detail}`;
  }
  if (statusCode === 503) {
    return `❌ ABCA is temporarily unavailable (status ${statusCode}). ${retryHint}`;
  }
  if (detail) {
    return `❌ ABCA couldn't create this task (status ${statusCode}): ${detail}`;
  }
  return `❌ ABCA couldn't create this task (status ${statusCode}). Check the ABCA admin logs for details.`;
}

function buildTaskDescription(
  issue: JiraTriggerIssue,
  descriptionMarkdown: string,
  comments: readonly RenderedComment[] = [],
): string {
  const parts: string[] = [];
  const summary = issue.fields?.summary?.trim();
  if (summary) {
    parts.push(`${issue.key}: ${summary}`);
  } else {
    parts.push(issue.key);
  }
  if (descriptionMarkdown.trim()) {
    parts.push('');
    parts.push(descriptionMarkdown.trim());
  }
  const core = parts.join('\n');

  // Fold recent human comments in (oldest-first, already rendered to markdown)
  // under a clear heading so the agent can tell them from the description
  // (#577). Comments are ADVISORY and must stay fail-open: they must never grow
  // the description past MAX_TASK_DESCRIPTION_LENGTH and turn createTaskCore's
  // length check into a hard rejection. Only append what fits the remaining
  // budget (reserving a small margin), truncating the section if needed.
  if (comments.length === 0) return core;
  const commentSection = renderCommentSection(comments);
  const separator = '\n';
  const budget = MAX_TASK_DESCRIPTION_LENGTH - core.length - separator.length;
  if (budget <= 0) return core; // description already fills the budget — drop comments
  const fitted = commentSection.length <= budget
    ? commentSection
    : truncateCommentSection(commentSection, budget);
  return fitted ? core + separator + fitted : core;
}

/** Notice appended when the comment section is truncated to fit the budget. */
const COMMENT_TRUNCATION_NOTICE = '\n\n_(recent comments truncated)_';

function renderCommentSection(comments: readonly RenderedComment[]): string {
  const lines: string[] = ['', '## Recent comments'];
  for (const c of comments) {
    lines.push('');
    const attribution = c.createdAt ? `**${c.author}** (${c.createdAt}):` : `**${c.author}**:`;
    lines.push(attribution);
    lines.push(c.markdown);
  }
  return lines.join('\n');
}

/**
 * Trim a rendered comment section to at most `budget` characters, leaving room
 * for a truncation notice. Returns '' if even the heading + notice can't fit,
 * so the caller cleanly drops the section.
 */
function truncateCommentSection(section: string, budget: number): string {
  const room = budget - COMMENT_TRUNCATION_NOTICE.length;
  if (room <= 0) return '';
  return section.slice(0, room) + COMMENT_TRUNCATION_NOTICE;
}

/**
 * Screen the rendered comment block through the Bedrock Guardrail on its own,
 * so third-party comment content that trips the policy is DROPPED (fail-open)
 * rather than gating the reporter's task. Returns the comments unchanged when
 * they pass, and `[]` when the guardrail intervenes or is unavailable — the
 * task still proceeds with the reporter-authored summary/description (which
 * createTaskCore screens separately). This keeps the comment-enrichment
 * contract fail-open end to end (issue #577 review, item 4).
 */
async function screenCommentsOrDrop(
  screeningConfig: ScreeningConfig | undefined,
  comments: RenderedComment[],
  issueKey: string,
  cloudId: string,
): Promise<RenderedComment[]> {
  if (comments.length === 0) return comments;
  if (!screeningConfig) {
    // No guardrail configured — drop unscreened third-party text rather than
    // route it, unscreened, into the agent context.
    logger.warn('Dropping Jira comments: guardrail not configured to screen them', {
      issue_key: issueKey,
      jira_cloud_id: cloudId,
    });
    return [];
  }
  const text = renderCommentSection(comments);
  try {
    const result = await screeningConfig.bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: screeningConfig.guardrailId,
      guardrailVersion: screeningConfig.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn('Dropping Jira comments: blocked by content policy (task still proceeds)', {
        issue_key: issueKey,
        jira_cloud_id: cloudId,
      });
      return [];
    }
    return comments;
  } catch (err) {
    // Fail-open on a screening outage too — comments are advisory.
    logger.warn('Dropping Jira comments: screening unavailable (task still proceeds)', {
      issue_key: issueKey,
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- comments are advisory enrichment; a screening outage drops them (logged) and the reporter's task still proceeds. Fail-open is the deliberate posture, not a masked bug (#756 Category 3)
  }
}

/**
 * Extract image URLs from the rendered description markdown. Same limits
 * as the Linear processor: HTTPS only, capped at 10.
 */
function extractImageUrlAttachments(description: string | undefined): Attachment[] {
  if (!description) return [];

  const imagePattern = /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g;
  const attachments: Attachment[] = [];
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(description)) !== null) {
    if (attachments.length >= 10) break;
    const url = match[1];
    attachments.push({ type: 'url', url });
  }

  if (attachments.length > 0) {
    logger.info('Extracted image URL attachments from Jira issue description', {
      count: attachments.length,
    });
  }

  return attachments;
}
