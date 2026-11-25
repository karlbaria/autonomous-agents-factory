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

import * as crypto from 'crypto';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { ScreeningConfig } from './shared/attachment-screening';
import {
  buildIterationInstruction,
  parseCommentTrigger,
} from './shared/comment-trigger';
import { createTaskCore } from './shared/create-task-core';
import { renderMaturingReply } from './shared/iteration-reply';
import { extractDescriptionMarkdown } from './shared/jira-adf';
import { reportIssueFailure } from './shared/jira-feedback';
import { resolveJiraOauthToken } from './shared/jira-oauth-resolver';
import {
  prNumberFromTask,
  resolveTaskByJiraIssue,
  type JiraIssueTask,
} from './shared/jira-task-by-issue';
import { resolveSoleActiveJiraTenant } from './shared/jira-tenant-registry';
import { buildCreateTaskFailureMessage, startJiraParentWork } from './shared/jira-trigger-start';
import { logger } from './shared/logger';
import { lookupValueOr } from './shared/lookup-result';
import type { CommentRef } from './shared/orchestration-channel';
import { makeJiraChannel } from './shared/orchestration-channel-jira';
import { parseRetryIntent } from './shared/orchestration-comment-trigger';
import { computeEpicRetryPlan } from './shared/orchestration-reconcile';
import {
  applyTerminalCreateFailures,
  readConcurrencyBudget,
  releaseReadyChildren,
} from './shared/orchestration-release';
import { upsertEpicPanel } from './shared/orchestration-rollup';
import {
  claimCommentAck,
  clearRollupClaim,
  deriveOrchestrationId,
  loadOrchestration,
  setStatusCommentId,
} from './shared/orchestration-store';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();

const PROJECT_MAPPING_TABLE = process.env.JIRA_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.JIRA_USER_MAPPING_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const DEFAULT_LABEL_FILTER = 'bgagent';
const COMMENT_ACK_TTL_SECONDS = 86_400;

/** Max length of the idempotency key (matches validation's IDEMPOTENCY_KEY_PATTERN). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// Attachment enrichment (#577). The processor downloads Jira `media` file
// attachments, screens them through the Bedrock Guardrail, and uploads the
// cleaned bytes to S3 before creating the task. All three must be configured;
// when they aren't, an issue carrying supported file attachments is rejected
// (fail-closed) rather than silently dropping them.
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const s3Client = ATTACHMENTS_BUCKET ? makeClient(S3Client) : undefined;
const bedrockClient = GUARDRAIL_ID && GUARDRAIL_VERSION ? makeClient(BedrockRuntimeClient) : undefined;
const screeningConfig: ScreeningConfig | undefined =
  bedrockClient && GUARDRAIL_ID && GUARDRAIL_VERSION
    ? { bedrockClient, guardrailId: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION }
    : undefined;

/**
 * Post a Jira comment without ever propagating an error. Mirrors the
 * Linear `safeReportIssueFailure` contract — feedback is best-effort,
 * advisory, and must never gate task-rejection logic.
 */
async function safeReportIssueFailure(
  issueIdOrKey: string,
  cloudId: string | undefined,
  message: string,
): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Skipping Jira feedback: JIRA_WORKSPACE_REGISTRY_TABLE_NAME not set', {
      issue_id_or_key: issueIdOrKey,
    });
    return;
  }
  if (!cloudId) {
    logger.warn('Skipping Jira feedback: webhook payload missing cloudId', {
      issue_id_or_key: issueIdOrKey,
    });
    return;
  }
  try {
    await reportIssueFailure(
      { cloudId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issueIdOrKey,
      message,
    );
  } catch (err) {
    logger.warn('Jira feedback failed (non-fatal)', {
      issue_id_or_key: issueIdOrKey,
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Subset of the Jira Cloud `jira:issue_*` webhook payload we depend on.
 * Undocumented fields are tolerated.
 */
interface JiraIssueEvent {
  readonly webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | 'comment_created' | string;
  readonly timestamp?: number;
  readonly cloudId?: string;
  readonly user?: {
    readonly accountId?: string;
    readonly displayName?: string;
  };
  readonly issue?: {
    readonly id: string;
    readonly key: string;
    readonly fields?: {
      readonly summary?: string;
      readonly description?: unknown; // ADF document
      readonly labels?: string[];
      /** Jira `media` file attachments. Shape validated in jira-attachments.ts. */
      readonly attachment?: unknown[];
      readonly creator?: { readonly accountId?: string };
      readonly reporter?: { readonly accountId?: string };
      readonly project?: {
        readonly id?: string;
        readonly key?: string;
      };
      readonly [key: string]: unknown;
    };
  };
  readonly changelog?: {
    readonly items?: Array<{
      readonly field?: string;
      readonly fieldId?: string;
      readonly fromString?: string | null;
      readonly toString?: string | null;
    }>;
  };
  readonly comment?: {
    readonly id?: string;
    readonly body?: unknown;
    readonly author?: {
      readonly accountId?: string;
      readonly accountType?: string;
      readonly displayName?: string;
    };
  };
}

interface ProcessorEvent {
  readonly raw_body: string;
  /**
   * True when the receiver verified this delivery against the stack-wide
   * fallback secret rather than a per-tenant signing secret. The stack-wide
   * secret is not bound to any `cloudId`, so a body-supplied `cloudId` on
   * such a delivery is untrusted — the processor ignores it and binds the
   * event to the sole active tenant instead (dropping when that's ambiguous).
   * Absent/false means the signature was per-tenant, so `payload.cloudId`
   * is trustworthy for routing.
   */
  readonly verified_via_stack_wide?: boolean;
}

/**
 * Async processor for verified Jira webhooks.
 *
 * Responsibilities:
 * - Parse the issue payload.
 * - Detect whether the configured trigger label was added on creation OR
 *   added by an `issue_updated` event whose changelog shows a `labels`
 *   diff with the label newly present (Atlassian's label diff format
 *   differs from Linear's).
 * - Resolve `(cloudId, projectKey)` → repo mapping.
 * - Resolve `(cloudId, accountId)` → platform user mapping.
 * - Call `createTaskCore` with `channelSource: 'jira'` and metadata the
 *   agent uses to address the originating issue via the Jira REST v3 API
 *   (`jira_reactions.py`; see ADR-015 for why outbound is REST, not MCP).
 */
// eslint-disable-next-line complexity -- predates the ceiling (116 when it landed); must not grow
export async function handler(event: ProcessorEvent): Promise<void> {
  if (!event.raw_body) {
    logger.error('Jira webhook processor invoked without raw_body');
    return;
  }

  let payload: JiraIssueEvent;
  try {
    payload = JSON.parse(event.raw_body) as JiraIssueEvent;
  } catch (err) {
    logger.error('Jira webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const isIssueEvent =
    payload.webhookEvent === 'jira:issue_created'
    || payload.webhookEvent === 'jira:issue_updated';
  const isCommentEvent = payload.webhookEvent === 'comment_created';
  if (!isIssueEvent && !isCommentEvent) {
    logger.info('Jira processor skipping unsupported event', { webhookEvent: payload.webhookEvent });
    return;
  }

  const issue = payload.issue;
  if (!issue || !issue.id || !issue.key) {
    logger.warn('Jira issue payload missing id or key', { webhookEvent: payload.webhookEvent });
    return;
  }

  // Resolve the tenant `cloudId`, honoring the signature's trust boundary:
  //
  // - Per-tenant signature (`verified_via_stack_wide` false/absent): the
  //   sender proved knowledge of *this* tenant's secret, so the body-supplied
  //   `payload.cloudId` is trustworthy. Fall back to the sole-active-tenant
  //   lookup only when the body omits it (Settings-UI webhooks).
  // - Stack-wide fallback signature: the secret is not bound to any tenant,
  //   so a body-supplied `cloudId` is attacker-controllable. We IGNORE it and
  //   bind the delivery to the sole active tenant; `resolveSoleActiveJiraTenant`
  //   returns undefined (→ drop) when zero or multiple tenants are active, so
  //   a stack-wide secret can never steer an event at a chosen tenant.
  let cloudId: string | undefined;
  if (event.verified_via_stack_wide) {
    cloudId = await resolveSoleActiveJiraTenant(ddb, WORKSPACE_REGISTRY_TABLE);
    if (payload.cloudId && payload.cloudId !== cloudId) {
      logger.warn('Ignoring body cloudId on stack-wide-verified webhook; binding to sole active tenant', {
        body_cloud_id: payload.cloudId,
        bound_cloud_id: cloudId,
        issue_key: issue.key,
      });
    }
  } else {
    cloudId = payload.cloudId
      ?? (await resolveSoleActiveJiraTenant(ddb, WORKSPACE_REGISTRY_TABLE));
  }

  if (isCommentEvent) {
    if (!cloudId) {
      logger.warn('Jira comment webhook missing cloudId and no sole active tenant', {
        issue_key: issue.key,
      });
      return;
    }
    const commentProjectKey = issue.fields?.project?.key;
    if (
      commentProjectKey
      && !await getActiveProjectMapping(cloudId, commentProjectKey, issue.key)
    ) {
      return;
    }
    await handleCommentTrigger(payload, issue, cloudId, commentProjectKey);
    return;
  }

  const projectKey = issue.fields?.project?.key;
  if (!projectKey) {
    logger.info('Jira issue has no project.key — skipping (cannot route to a repo)', {
      issue_key: issue.key,
    });
    return;
  }

  if (!cloudId) {
    // No cloudId in the payload AND the single-tenant fallback couldn't
    // resolve one (zero or multiple active tenants). Without it we can't
    // look up the project mapping (composite PK is `{cloudId}#{projectKey}`)
    // or post feedback. Log and drop.
    logger.warn('Jira webhook missing cloudId and no sole active tenant — cannot resolve tenant', {
      issue_key: issue.key,
      project_key: projectKey,
    });
    return;
  }

  const mapping = await getActiveProjectMapping(cloudId, projectKey, issue.key);
  if (!mapping) {
    return;
  }
  const repo = mapping.repo as string;
  const labelFilter = (mapping.label_filter as string | undefined) ?? DEFAULT_LABEL_FILTER;

  if (!shouldTrigger(payload, labelFilter)) {
    logger.info('Jira webhook does not match trigger criteria', {
      webhookEvent: payload.webhookEvent,
      issue_key: issue.key,
      label_filter: labelFilter,
      current_labels: issue.fields?.labels,
      changelog_label_items: payload.changelog?.items?.filter((i) => i?.field === 'labels'),
    });
    return;
  }

  const actorAccountId = payload.user?.accountId;
  const reporterAccountId = issue.fields?.reporter?.accountId;
  const creatorAccountId = issue.fields?.creator?.accountId;
  const accountId = actorAccountId ?? reporterAccountId ?? creatorAccountId;
  const accountSource = actorAccountId
    ? 'webhook_user'
    : reporterAccountId
      ? 'issue_reporter'
      : creatorAccountId
        ? 'issue_creator'
        : undefined;
  if (!accountId) {
    logger.warn('Jira webhook missing user.accountId — cannot attribute task', {
      issue_key: issue.key,
      jira_cloud_id: cloudId,
      jira_actor_account_id: actorAccountId,
      jira_reporter_account_id: reporterAccountId,
      jira_creator_account_id: creatorAccountId,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ Jira webhook is missing the user accountId — ABCA can't attribute this task to a user. This is unusual; please report it to your ABCA admin.",
    );
    return;
  }

  const platformUserId = await lookupPlatformUser(cloudId, accountId);
  if (!platformUserId) {
    logger.warn('Jira account has no linked platform user — skipping task creation', {
      jira_cloud_id: cloudId,
      jira_account_id: accountId,
      jira_account_source: accountSource,
      jira_actor_account_id: actorAccountId,
      jira_reporter_account_id: reporterAccountId,
      jira_creator_account_id: creatorAccountId,
      jira_identity_lookup_key: `${cloudId}#${accountId}`,
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      `❌ The Jira user for this trigger isn't linked to a platform user (accountId: \`${accountId}\`). `
      + `Ask an admin to run \`bgagent jira invite-user ${cloudId} ${accountId}\`, then redeem the generated link code.`,
    );
    return;
  }

  await startJiraParentWork(
    {
      ddb,
      projectMappingTable: PROJECT_MAPPING_TABLE,
      workspaceRegistryTable: WORKSPACE_REGISTRY_TABLE,
      orchestrationTable: ORCHESTRATION_TABLE,
      userConcurrencyTable: USER_CONCURRENCY_TABLE,
      maxConcurrent: MAX_CONCURRENT,
      s3Client,
      attachmentsBucket: ATTACHMENTS_BUCKET,
      screeningConfig,
      reportFailure: safeReportIssueFailure,
    },
    {
      issue,
      cloudId,
      projectKey,
      mapping,
      repo,
      labelFilter,
      platformUserId,
      idempotencyKey: buildIdempotencyKey(issue.key, payload.timestamp),
    },
  );
}

/**
 * Handle `comment_created` independently of the label-trigger path.
 *
 * When Jira supplies project.key, the caller establishes that its mapping is
 * active. Otherwise the prior task supplies the project key and this handler
 * revalidates that mapping before producing feedback or creating a task.
 * Comments do not require the trigger label to remain present.
 */
async function handleCommentTrigger(
  payload: JiraIssueEvent,
  issue: NonNullable<JiraIssueEvent['issue']>,
  cloudId: string,
  verifiedProjectKey?: string,
): Promise<void> {
  const comment = payload.comment;
  if (!comment?.id) {
    logger.warn('Jira comment payload missing comment.id', { issue_key: issue.key });
    return;
  }

  // Native app users are never human reviewers. ABCA's own 3LO comments are
  // attributed to the authorizing Atlassian user, so parseCommentTrigger also
  // rejects ABCA's stable rendered prefixes to prevent self-trigger loops.
  if (comment.author?.accountType?.toLowerCase() === 'app') {
    logger.info('Ignoring Jira app-authored comment', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  const commentBody = extractDescriptionMarkdown(comment.body);
  const trigger = parseCommentTrigger(commentBody);
  if (!trigger.triggered) {
    logger.info('Jira comment has no @bgagent trigger', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  let linkedCommentAuthor: string | null | undefined;
  if (parseRetryIntent(trigger.instruction)) {
    linkedCommentAuthor = comment.author?.accountId
      ? await lookupPlatformUser(cloudId, comment.author.accountId)
      : null;
    if (!linkedCommentAuthor) {
      logger.warn('Jira epic retry refused: commenter has no linked platform user', {
        jira_cloud_id: cloudId,
        jira_account_id: comment.author?.accountId,
        issue_key: issue.key,
        comment_id: comment.id,
      });
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        'I can only retry an orchestration for a linked ABCA user. '
          + 'Link your Jira account first, then comment `@bgagent retry` again.',
      );
      return;
    }
    if (await handleJiraEpicRetry(issue.key, cloudId, comment.id)) {
      return;
    }
  }

  const priorTask = await resolveTaskByJiraIssue(
    ddb,
    TASK_TABLE,
    cloudId,
    issue.key,
  );
  if (!verifiedProjectKey) {
    const priorProjectKey = priorTask?.channel_metadata?.jira_project_key;
    if (!priorProjectKey) {
      logger.info(
        'Jira comment issue has no project.key or prior project metadata — skipping silently',
        { issue_key: issue.key },
      );
      return;
    }
    if (!await getActiveProjectMapping(cloudId, priorProjectKey, issue.key)) {
      return;
    }
    logger.warn('Jira comment issue has no project.key — routing via active prior task project', {
      issue_key: issue.key,
      project_key: priorProjectKey,
    });
  }
  const prNumber = priorTask ? prNumberFromTask(priorTask) : null;
  if (!priorTask || prNumber === null) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ I couldn't find an ABCA pull request for this Jira issue. Run the issue with the configured ABCA trigger label first, then retry this comment.",
    );
    return;
  }
  if (!priorTask.repo) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ I found the earlier ABCA task, but it has no repository recorded, so I can't update its pull request.",
    );
    return;
  }

  linkedCommentAuthor ??= comment.author?.accountId
    ? await lookupPlatformUser(cloudId, comment.author.accountId)
    : null;
  const platformUserId = linkedCommentAuthor ?? priorTask.user_id;
  if (!platformUserId) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      '❌ I found the pull request, but neither the comment author nor the original task has a linked ABCA user.',
    );
    return;
  }

  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Cannot run Jira comment iteration: workspace registry is not configured', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }
  const resolved = await resolveJiraOauthToken(cloudId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    logger.warn('Cannot run Jira comment iteration: tenant OAuth is unavailable', {
      jira_cloud_id: cloudId,
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  const channelMetadata = buildIterationChannelMetadata(
    priorTask,
    issue,
    cloudId,
    comment.id,
    resolved.oauthSecretArn,
    resolved.siteUrl,
  );
  const idempotencyKey = buildCommentIdempotencyKey(cloudId, issue.key, comment.id);
  const requestId = crypto.randomUUID();
  const taskId = ulid();
  const result = await createTaskCore(
    {
      repo: priorTask.repo,
      workflow_ref: 'coding/pr-iteration-v1',
      pr_number: prNumber,
      task_description: buildIterationInstruction(trigger),
    },
    {
      userId: platformUserId,
      channelSource: 'jira',
      channelMetadata,
      idempotencyKey,
      taskId,
    },
    requestId,
  );

  if (result.statusCode === 200) {
    logger.info('Jira comment iteration was an idempotent replay', {
      issue_key: issue.key,
      comment_id: comment.id,
      prior_task_id: priorTask.task_id,
    });
    return;
  }

  if (result.statusCode !== 201) {
    logger.warn('Jira comment iteration task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_key: issue.key,
      comment_id: comment.id,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      buildCreateTaskFailureMessage(
        result.statusCode,
        result.body,
        'Please add a new `@bgagent` comment in a few minutes.',
      ),
    );
    return;
  }

  let reply: CommentRef | null = null;
  try {
    reply = await makeJiraChannel(WORKSPACE_REGISTRY_TABLE).postComment(
      { issueId: issue.key, credentialsRef: cloudId },
      renderMaturingReply({ state: 'on_it' }),
    );
  } catch (err) {
    logger.warn('Jira iteration acknowledgement post failed (non-fatal)', {
      task_id: taskId,
      issue_key: issue.key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (reply?.commentId) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TASK_TABLE,
        Key: { task_id: taskId },
        UpdateExpression: 'SET channel_metadata.iteration_reply_comment_id = :comment_id',
        ConditionExpression: 'attribute_exists(task_id)',
        ExpressionAttributeValues: { ':comment_id': reply.commentId },
      }));
    } catch (err) {
      logger.warn('Jira iteration acknowledgement posted but its comment id was not persisted', {
        task_id: taskId,
        issue_key: issue.key,
        comment_id: reply.commentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Jira comment-triggered PR iteration task created', {
    task_id: taskId,
    issue_key: issue.key,
    comment_id: comment.id,
    prior_task_id: priorTask.task_id,
    repo: priorTask.repo,
    pr_number: prNumber,
    attributed_to_linked_comment_author: Boolean(linkedCommentAuthor),
    request_id: requestId,
  });
}

/**
 * Retry a terminal Jira parent orchestration without requiring the parent to
 * have its own task or PR. Successful children remain untouched; only failed
 * and transitively skipped nodes are reset and released.
 */
async function handleJiraEpicRetry(
  parentIssueKey: string,
  cloudId: string,
  commentId: string,
): Promise<boolean> {
  if (!ORCHESTRATION_TABLE) return false;
  const orchestrationId = deriveOrchestrationId(parentIssueKey);
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot || snapshot.meta.parent_issue_ref !== parentIssueKey) return false;

  const now = new Date().toISOString();
  const claimed = await claimCommentAck(
    ddb,
    ORCHESTRATION_TABLE,
    orchestrationId,
    `retry:${commentId}`,
    now,
    Math.floor(Date.now() / 1000) + COMMENT_ACK_TTL_SECONDS,
  );
  if (!claimed) return true;

  const plan = computeEpicRetryPlan(snapshot.children);
  if (plan.statusUpdates.length === 0) {
    const allSucceeded = plan.succeededCount === snapshot.children.length
      && snapshot.children.length > 0;
    await safeReportIssueFailure(
      parentIssueKey,
      cloudId,
      allSucceeded
        ? "👋 Everything in this orchestration already succeeded — there's nothing to retry."
        : "👋 This orchestration is still running — nothing has failed yet, so there's nothing to retry.",
    );
    return true;
  }

  const previousStatus = new Map(
    snapshot.children.map((child) => [child.sub_issue_id, child.child_status]),
  );
  for (const update of plan.statusUpdates) {
    const prior = previousStatus.get(update.sub_issue_id);
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :next, updated_at = :now',
        ConditionExpression: 'child_status = :prior',
        ExpressionAttributeValues: {
          ':next': update.child_status,
          ':prior': prior,
          ':now': now,
        },
      }));
    } catch (err) {
      logger.warn('Jira epic retry child reset lost a race; continuing best-effort', {
        orchestration_id: orchestrationId,
        sub_issue_id: update.sub_issue_id,
        prior_status: prior,
        next_status: update.child_status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const reset = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!reset) return true;
  const ready = reset.children.filter(
    (child) => plan.toRelease.includes(child.sub_issue_id)
      && child.child_status === 'ready',
  );
  const budget = USER_CONCURRENCY_TABLE
    ? await readConcurrencyBudget(
      ddb,
      USER_CONCURRENCY_TABLE,
      reset.meta.release_context.platform_user_id,
      MAX_CONCURRENT,
    )
    : undefined;
  const releaseResults = await releaseReadyChildren(
    ddb,
    ORCHESTRATION_TABLE,
    ready,
    reset.meta.release_context,
    createTaskCore,
    now,
    reset.children,
    'main',
    budget,
    true,
  );
  await applyTerminalCreateFailures(
    ddb,
    ORCHESTRATION_TABLE,
    orchestrationId,
    reset.children,
    releaseResults,
    now,
  );

  await safeReportIssueFailure(
    parentIssueKey,
    cloudId,
    `🔄 Retrying ${plan.failedCount} failed and ${plan.skippedCount} skipped sub-issue(s); `
      + `${plan.succeededCount} successful sub-issue(s) are unchanged.`,
  );
  if (WORKSPACE_REGISTRY_TABLE) {
    const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    if (refreshed) {
      const panelId = lookupValueOr(await upsertEpicPanel({
        channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
        parent: {
          issueId: parentIssueKey,
          credentialsRef: cloudId,
          stateOverrides: {
            ...(refreshed.meta.release_context.jira_status_on_start && {
              started: refreshed.meta.release_context.jira_status_on_start,
            }),
            ...(refreshed.meta.release_context.jira_status_on_pr && {
              inReview: refreshed.meta.release_context.jira_status_on_pr,
            }),
          },
        },
        children: refreshed.children,
        statusCommentId: refreshed.meta.status_comment_id,
        inProgress: true,
        labelFilter: refreshed.meta.release_context.trigger_label,
      }), null);
      if (panelId) {
        await setStatusCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, panelId);
      }
    }
  }
  logger.info('Jira epic retry released failed/skipped graph', {
    orchestration_id: orchestrationId,
    parent_issue_key: parentIssueKey,
    failed: plan.failedCount,
    skipped: plan.skippedCount,
    succeeded: plan.succeededCount,
  });
  return true;
}

function buildIterationChannelMetadata(
  priorTask: JiraIssueTask,
  issue: NonNullable<JiraIssueEvent['issue']>,
  cloudId: string,
  commentId: string,
  oauthSecretArn: string,
  siteUrl: string,
): Record<string, string> {
  const previous = priorTask.channel_metadata ?? {};
  const metadata: Record<string, string> = {
    jira_cloud_id: cloudId,
    jira_issue_id: issue.id,
    jira_issue_key: issue.key,
    jira_oauth_secret_arn: oauthSecretArn,
    jira_site_url: siteUrl,
    jira_trigger_comment_id: commentId,
    jira_prior_task_id: priorTask.task_id,
    trigger_comment_id: commentId,
    trigger_comment_issue_id: issue.key,
  };

  const projectKey = issue.fields?.project?.key ?? previous.jira_project_key;
  if (projectKey) metadata.jira_project_key = projectKey;
  if (previous.jira_status_on_start) {
    metadata.jira_status_on_start = previous.jira_status_on_start;
  }
  if (previous.jira_status_on_pr) {
    metadata.jira_status_on_pr = previous.jira_status_on_pr;
  }
  if (previous.orchestration_id && previous.orchestration_sub_issue_id) {
    metadata.orchestration_id = previous.orchestration_id;
    metadata.orchestration_sub_issue_id = previous.orchestration_sub_issue_id;
    metadata.orchestration_iteration = 'true';
  }
  return metadata;
}

function buildCommentIdempotencyKey(
  cloudId: string,
  issueKey: string,
  commentId: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${cloudId}\0${issueKey}\0${commentId}`)
    .digest('hex');
  return `jira-iterate-${digest}`;
}

/**
 * Decide whether a Jira issue event should trigger a task.
 *
 * Two trigger paths:
 * - `jira:issue_created` with the trigger label already present.
 * - `jira:issue_updated` whose `changelog.items[]` contains a labels
 *   change where the trigger label is in `toString` but NOT in
 *   `fromString` (i.e. it was newly added). Atlassian's label diff is
 *   delivered as space-separated strings, not arrays, so we tokenize.
 */
function shouldTrigger(payload: JiraIssueEvent, labelFilter: string): boolean {
  const filter = labelFilter.toLowerCase();
  const currentLabels = (payload.issue?.fields?.labels ?? []).map((l) => l.toLowerCase());
  const hasLabel = currentLabels.includes(filter);

  if (payload.webhookEvent === 'jira:issue_created') {
    return hasLabel;
  }

  if (payload.webhookEvent === 'jira:issue_updated') {
    if (!hasLabel) return false;
    const items = payload.changelog?.items ?? [];
    // Match the labels change item. Atlassian uses `field === 'labels'`
    // (or sometimes `fieldId === 'labels'`) for the labels system field.
    const labelsItem = items.find(
      (i) => i?.field === 'labels' || i?.fieldId === 'labels',
    );
    if (!labelsItem) return false;
    const previous = tokenizeLabelString(labelsItem.fromString);
    const next = tokenizeLabelString(labelsItem.toString);
    // Trigger only if the label is newly present.
    return next.includes(filter) && !previous.includes(filter);
  }

  return false;
}

/**
 * Atlassian delivers the labels-field change as a space-separated string
 * (e.g. `"bug" → "bug bgagent"`). Tokenize and lowercase for comparison.
 * Empty / null inputs return an empty list.
 */
function tokenizeLabelString(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Deterministic idempotency key for a trigger event: `<issueKey>#<timestamp>`,
 * sanitized to the allowed key charset (`[A-Za-z0-9_-]{1,128}`). A webhook
 * re-delivery of the same event yields the same key so createTaskCore dedupes
 * instead of creating a duplicate task (and re-downloading attachments). Falls
 * back to undefined if we can't form a stable key, preserving prior behavior.
 */
function buildIdempotencyKey(issueKey: string, timestamp: number | undefined): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  const raw = `jira-${issueKey}-${timestamp}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  return sanitized || undefined;
}

async function lookupPlatformUser(cloudId: string, accountId: string): Promise<string | null> {
  const key = `${cloudId}#${accountId}`;
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { jira_identity: key },
    ConsistentRead: true,
  }));
  const platformUserId = result.Item?.platform_user_id;
  if (
    result.Item?.status !== 'active'
    || typeof platformUserId !== 'string'
    || !platformUserId
  ) {
    return null;
  }
  return platformUserId;
}

async function getActiveProjectMapping(
  cloudId: string,
  projectKey: string,
  issueKey: string,
): Promise<Record<string, unknown> | null> {
  const projectIdentity = `${cloudId}#${projectKey}`;
  const mapping = await ddb.send(new GetCommand({
    TableName: PROJECT_MAPPING_TABLE,
    Key: { jira_project_identity: projectIdentity },
    ConsistentRead: true,
  }));
  if (!mapping.Item || mapping.Item.status !== 'active') {
    // Jira admin-console webhooks fire site-wide. An unmapped project has not
    // opted into ABCA, so it must remain a true no-op for every event type.
    logger.info('Jira project is not onboarded or is removed — skipping silently', {
      jira_project_identity: projectIdentity,
      issue_key: issueKey,
    });
    return null;
  }
  return mapping.Item;
}
