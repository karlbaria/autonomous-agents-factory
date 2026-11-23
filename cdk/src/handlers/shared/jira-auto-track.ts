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
 * Task 13 (fork), PR 2: outbound Jira issue creation for tasks that did not
 * originate in Jira (``channel_source`` ``slack``/``api``), opt-in per
 * mapping via ``bgagent jira map --auto-track``.
 *
 * Two pieces:
 *   - {@link findAutoTrackedJiraMapping} resolves a repo to its mapped Jira
 *     project, when one exists, is active, and has opted in.
 *   - {@link createAutoTrackedJiraIssue} creates the issue through whichever
 *     outbound identity the tenant has configured (Forge app actor or the
 *     legacy 3LO fallback — see ``jira-oauth-resolver.ts``).
 *
 * Both are best-effort and never throw: a Jira outage or a misconfigured
 * tenant must not block task creation. Callers (``create-task-core.ts``)
 * decide what to do with a ``skipped`` result.
 */

import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { requestJiraAppActor } from './jira-app-actor';
import { resolveJiraOutboundAuth } from './jira-oauth-resolver';
import { logger } from './logger';
import type { ChannelSource } from './types';
import { makeDocClient } from './ua';
import { computeTtlEpoch } from './validation';

const ddb = makeDocClient();
const REQUEST_TIMEOUT_MS = 5000;
/** Issue #71: wait before the single retry of a retryable create failure. */
const CREATE_RETRY_DELAY_MS = 1000;
/** Issue #71: retry only when the first attempt failed fast. A failure that
 *  took longer (a client-side timeout at REQUEST_TIMEOUT_MS) is not retried:
 *  it would push CreateTaskFn toward its 15 s timeout, and a timed-out
 *  request is the case most likely to have created the issue anyway. Worst
 *  case with a retry: ~3 s + 1 s + 5 s. */
const CREATE_RETRY_MAX_FIRST_ATTEMPT_MS = 3000;

/**
 * Atlassian cross-region REST gateway base — same host the legacy 3LO
 * fallback path in ``jira-feedback.ts`` uses, and for the same reason: the
 * resolved access token is minted with ``audience=api.atlassian.com``, so it
 * is only valid against this gateway, not the raw ``*.atlassian.net`` host.
 */
const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

/**
 * Jira issue type requested for every auto-tracked issue. Not resolved per
 * project: see {@link createAutoTrackedJiraIssue}'s doc comment for why a
 * missing/renamed type is handled as an ordinary skip rather than a separate
 * createmeta lookup.
 */
const DEFAULT_ISSUE_TYPE_NAME = 'Task';

export interface AutoTrackedMapping {
  readonly cloudId: string;
  readonly projectKey: string;
  readonly registryTableName: string;
}

/**
 * Find the active, ``auto_track``-opted-in Jira project mapping for a repo,
 * if any.
 *
 * ``JiraProjectMappingTable`` is keyed by ``{cloudId}#{projectKey}``, not by
 * repo, and this lookup goes the other direction (repo -> mapping), so there
 * is no index to query directly. Rather than add a GSI for what is, in this
 * lab, a handful of rows, this scans the table with a filter. **Scale-up
 * path:** add a GSI on ``repo`` (see LAB_LOG.md's Task 13 PR 2 entry) if the
 * table ever grows past a page — a single ``Scan`` here does not paginate.
 *
 * Returns ``null`` (never throws) when the Jira feature isn't deployed, the
 * repo has no mapping, the mapping isn't active, it hasn't opted in, or the
 * lookup itself fails — auto-tracking is advisory, and task creation must
 * proceed either way.
 */
export async function findAutoTrackedJiraMapping(repo: string): Promise<AutoTrackedMapping | null> {
  const mappingTableName = process.env.JIRA_PROJECT_MAPPING_TABLE_NAME;
  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!mappingTableName || !registryTableName) return null;

  try {
    const result = await ddb.send(new ScanCommand({
      TableName: mappingTableName,
      FilterExpression: 'repo = :repo AND #status = :active AND auto_track = :true',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':repo': repo, ':active': 'active', ':true': true },
    }));
    const row = result.Items?.[0];
    if (!row || typeof row.cloud_id !== 'string' || typeof row.project_key !== 'string') return null;
    return { cloudId: row.cloud_id, projectKey: row.project_key, registryTableName };
  } catch (err) {
    logger.warn('Jira auto-track mapping lookup failed', {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- advisory lookup: a DDB outage must not block task creation, same posture as lookupRepo/jira-feedback.ts
  }
}

export interface CreateAutoTrackedIssueParams {
  readonly cloudId: string;
  readonly projectKey: string;
  readonly registryTableName: string;
  readonly summary: string;
  /** Plain text, converted to a minimal ADF document (one paragraph per
   *  non-empty line) — not pre-built ADF, so callers don't need their own
   *  ADF builder just to describe a task. */
  readonly description?: string;
  /** Test seam: the wait before the single retry (default 1 s). */
  readonly retryDelayMs?: number;
}

/** Minimal plain-text -> ADF conversion: one paragraph per non-empty line.
 *  Deliberately simpler than ``jira-feedback.ts``'s markdown-aware builder
 *  (bold/italic/links) — an auto-generated task summary has none of that. */
function textToAdfDocument(text: string): Record<string, unknown> {
  const paragraphs = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length > 0
      ? paragraphs.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
      : [{ type: 'paragraph', content: [] }],
  };
}

export type CreateAutoTrackedIssueResult =
  | {
    readonly kind: 'created';
    readonly issueKey: string;
    // Threaded through so the caller can stamp them into channel_metadata
    // (issue #34) — the agent needs its own Jira credentials later
    // (jira_reactions.py's resolve_jira_oauth_token), the same way a
    // Jira-origin task's channel_metadata already carries them.
    readonly oauthSecretArn: string;
    readonly siteUrl: string;
  }
  // Jira's create response reports exactly which field it needed (or that
  // the issue type name doesn't exist in this project) via a 400 with an
  // `errors` map — the caller surfaces this reason verbatim rather than the
  // parsed-but-unusable response.
  | { readonly kind: 'skipped'; readonly reason: 'unknown_required_fields'; readonly jiraErrors: Record<string, string> }
  // Issue #71: `status` / `proxyErrorCode` (when the create got that far)
  // are recorded on the visible jira_auto_track_skipped event.
  | {
    readonly kind: 'skipped';
    readonly reason: 'unavailable';
    readonly status?: number;
    readonly proxyErrorCode?: string;
  };

interface CreateIssueHttpOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: string;
  /** A 429/5xx or a network error: worth one more attempt (issue #71). */
  readonly retryable?: boolean;
  /** The Forge proxy's own error code (`{"error": "..."}`), app path only. */
  readonly proxyErrorCode?: string;
}

/** 429, 5xx, or no response at all (network error / timeout). */
function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

async function requestCreateIssueViaOauth(
  accessToken: string,
  cloudId: string,
  fields: Record<string, unknown>,
): Promise<CreateIssueHttpOutcome> {
  const url = `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/issue`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ fields }),
      signal: controller.signal,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      body: await resp.text(),
      retryable: !resp.ok && isRetryableStatus(resp.status),
    };
  } catch (err) {
    logger.warn('Jira auto-track OAuth create-issue request failed', {
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse Jira's ``{"errors": {...}}`` create-rejection body, if present. */
function parseJiraFieldErrors(body: string | undefined): Record<string, string> | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as { errors?: unknown };
    if (value.errors && typeof value.errors === 'object' && !Array.isArray(value.errors)) {
      return value.errors as Record<string, string>;
    }
    return null;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- a non-JSON create-rejection body has no field errors to parse
  }
}

/** Parse Jira's ``{"key": "SHOP-7", ...}`` create-success body. */
function parseCreatedIssueKey(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as { key?: unknown };
    return typeof value.key === 'string' ? value.key : null;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- an unparseable 2xx body still means the issue was created; caller logs this case separately
  }
}

/**
 * Create an issue in the mapped Jira project, through whichever outbound
 * identity the tenant has configured.
 *
 * No separate createmeta round trip to resolve the project's required
 * fields ahead of time: Jira's own create response already reports exactly
 * which field (or an invalid issue-type name) is missing via a 400 with an
 * ``errors`` map, which is cheaper than a project+issuetype-scoped
 * createmeta fetch for the common case (a project whose only required
 * fields are the ones already sent) and no less informative for the
 * uncommon one.
 */
export async function createAutoTrackedJiraIssue(
  params: CreateAutoTrackedIssueParams,
): Promise<CreateAutoTrackedIssueResult> {
  const resolved = await resolveJiraOutboundAuth(params.cloudId, params.registryTableName);
  if (!resolved) return { kind: 'skipped', reason: 'unavailable' };

  const descriptionAdf = params.description !== undefined ? textToAdfDocument(params.description) : undefined;

  const attempt = async (): Promise<CreateIssueHttpOutcome> => {
    if (resolved.kind === 'app') {
      const appResult = await requestJiraAppActor(resolved.appActor, {
        version: 1,
        operation: 'create_issue',
        cloud_id: params.cloudId,
        project_key: params.projectKey,
        issue_type_name: DEFAULT_ISSUE_TYPE_NAME,
        summary: params.summary,
        ...(descriptionAdf !== undefined && { body: descriptionAdf }),
      });
      return appResult.ok
        ? { ok: true, status: appResult.status, body: appResult.body }
        : {
          ok: false,
          status: appResult.status,
          body: appResult.body,
          retryable: appResult.retryable,
          proxyErrorCode: appResult.errorCode,
        };
    }
    return requestCreateIssueViaOauth(resolved.accessToken, params.cloudId, {
      project: { key: params.projectKey },
      issuetype: { name: DEFAULT_ISSUE_TYPE_NAME },
      summary: params.summary,
      ...(descriptionAdf !== undefined && { description: descriptionAdf }),
    });
  };

  // Issue #71: one transient failure (e.g. the Forge proxy's 502
  // jira_request_failed) used to lose the card for good. Retry exactly once,
  // and only a fast, retryable failure — never a 4xx, never Jira's
  // field-error rejection. A rare duplicate card is acceptable (owner
  // decision on #71); a silently missing one is not.
  const startedAt = Date.now();
  let outcome = await attempt();
  if (
    !outcome.ok
    && outcome.retryable
    && !parseJiraFieldErrors(outcome.body)
    && Date.now() - startedAt <= CREATE_RETRY_MAX_FIRST_ATTEMPT_MS
  ) {
    logger.warn('Jira auto-track issue create failed; retrying once', {
      jira_cloud_id: params.cloudId,
      project_key: params.projectKey,
      status: outcome.status,
      proxy_error_code: outcome.proxyErrorCode,
    });
    await new Promise((resolve) => setTimeout(resolve, params.retryDelayMs ?? CREATE_RETRY_DELAY_MS));
    outcome = await attempt();
  }

  if (outcome.ok) {
    const issueKey = parseCreatedIssueKey(outcome.body);
    if (issueKey) {
      return {
        kind: 'created',
        issueKey,
        oauthSecretArn: resolved.oauthSecretArn,
        siteUrl: resolved.siteUrl,
      };
    }
    logger.warn('Jira auto-track issue create succeeded without a usable issue key', {
      jira_cloud_id: params.cloudId,
      project_key: params.projectKey,
    });
    return { kind: 'skipped', reason: 'unavailable' };
  }

  const jiraErrors = parseJiraFieldErrors(outcome.body);
  if (jiraErrors) {
    return { kind: 'skipped', reason: 'unknown_required_fields', jiraErrors };
  }
  logger.warn('Jira auto-track issue create failed', {
    jira_cloud_id: params.cloudId,
    project_key: params.projectKey,
    status: outcome.status,
    proxy_error_code: outcome.proxyErrorCode,
  });
  return {
    kind: 'skipped',
    reason: 'unavailable',
    ...(outcome.status !== undefined && { status: outcome.status }),
    ...(outcome.proxyErrorCode !== undefined && { proxyErrorCode: outcome.proxyErrorCode }),
  };
}

/** Jira's own `summary` field limit. */
const JIRA_SUMMARY_MAX_LENGTH = 255;

/** Channels auto-tracking covers. Jira-origin tasks already have an issue;
 *  the generic webhook channel and Linear (its own tracker) are out of
 *  scope for this PR — see the issue's scope discussion. */
const JIRA_AUTO_TRACK_CHANNELS: ReadonlySet<ChannelSource> = new Set(['slack', 'api']);

export interface ResolveJiraAutoTrackParams {
  readonly repo?: string;
  readonly channelSource: ChannelSource;
  /** The channel's own metadata, merged with any auto-tracked Jira fields
   *  into the returned {@link JiraAutoTrackResult.channelMetadata}. */
  readonly channelMetadata: Record<string, string>;
  readonly taskId: string;
  readonly taskDescription?: string;
  /** Where to write the visible skip-event (TaskEventsTable). */
  readonly eventsTableName: string;
  readonly now: string;
  readonly taskRetentionDays: number;
  /** Test seam passed to createAutoTrackedJiraIssue (default 1 s). */
  readonly retryDelayMs?: number;
}

export interface JiraAutoTrackResult {
  /** `channelMetadata` ready to assign straight onto the TaskRecord, whether
   *  or not anything changed — callers never need their own merge/ternary. */
  readonly channelMetadata: Record<string, string>;
}

/**
 * Resolve Jira auto-tracking for a task end to end: decide whether this
 * channel/repo qualifies, look up an opted-in mapping, attempt the create,
 * and write the one visible milestone the owner asked for (a field-related
 * skip) — all as a single call so `create-task-core.ts`'s own call site adds
 * no branching of its own (see its comment at the call site for why that
 * matters: a pre-existing, suppressed complexity ceiling that must not grow).
 *
 * Advisory end to end and never throws: a missing mapping, an unopted-in
 * one, a Jira outage, or a rejected create all fall through to returning the
 * channel's own metadata unchanged.
 */
export async function resolveJiraAutoTrack(
  params: ResolveJiraAutoTrackParams,
): Promise<JiraAutoTrackResult> {
  if (!params.repo || !JIRA_AUTO_TRACK_CHANNELS.has(params.channelSource)) {
    return { channelMetadata: params.channelMetadata };
  }
  const mapping = await findAutoTrackedJiraMapping(params.repo);
  if (!mapping) return { channelMetadata: params.channelMetadata };

  const summary = (params.taskDescription ?? `Task for ${params.repo}`).slice(0, JIRA_SUMMARY_MAX_LENGTH);
  const description = [
    params.taskDescription,
    `Repo: ${params.repo}`,
    `Submitted via ${params.channelSource}; auto-tracked by the factory.`,
  ].filter((line): line is string => Boolean(line)).join('\n');

  const result = await createAutoTrackedJiraIssue({
    cloudId: mapping.cloudId,
    projectKey: mapping.projectKey,
    registryTableName: mapping.registryTableName,
    summary,
    description,
    retryDelayMs: params.retryDelayMs,
  });

  if (result.kind === 'created') {
    logger.info('Jira auto-track created an issue for a non-Jira-origin task', {
      task_id: params.taskId,
      repo: params.repo,
      channel_source: params.channelSource,
      jira_cloud_id: mapping.cloudId,
      jira_issue_key: result.issueKey,
    });
    return {
      channelMetadata: {
        ...params.channelMetadata,
        jira_cloud_id: mapping.cloudId,
        jira_issue_key: result.issueKey,
        // The agent resolves its own Jira credentials from this ARN at task
        // start (jira_reactions.py via resolve_jira_oauth_token) — without
        // it, the task has a Jira link but no way to act on it (issue #34).
        jira_oauth_secret_arn: result.oauthSecretArn,
        jira_site_url: result.siteUrl,
      },
    };
  }

  if (result.reason === 'unknown_required_fields') {
    logger.warn('Jira auto-track skipped — the mapped project needs fields this task cannot supply', {
      task_id: params.taskId,
      repo: params.repo,
      jira_cloud_id: mapping.cloudId,
      jira_project_key: mapping.projectKey,
      jira_errors: result.jiraErrors,
    });
  }
  // Issue #71: every skip is visible on the task, not only the field-error
  // one — an 'unavailable' skip (outage, misconfigured tenant, network)
  // used to leave no trace, so a task without a card was indistinguishable
  // from one that never qualified.
  await writeJiraAutoTrackSkippedEvent(params, mapping.projectKey, skipEventDetails(result));

  return { channelMetadata: params.channelMetadata };
}

type SkippedResult = Extract<CreateAutoTrackedIssueResult, { kind: 'skipped' }>;

/** The skip event's reason-specific fields. */
function skipEventDetails(result: SkippedResult): Record<string, unknown> {
  if (result.reason === 'unknown_required_fields') {
    return { reason: result.reason, jira_errors: result.jiraErrors };
  }
  return {
    reason: result.reason,
    ...(result.status !== undefined && { status: result.status }),
    ...(result.proxyErrorCode !== undefined && { proxy_error_code: result.proxyErrorCode }),
  };
}

/** Visible milestone for every auto-track skip on a qualifying task (issue
 *  #71; originally only the field-error one). Best-effort, like every other
 *  task event write in `create-task-core.ts` — event loss here never fails
 *  the task. */
async function writeJiraAutoTrackSkippedEvent(
  params: ResolveJiraAutoTrackParams,
  projectKey: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: params.eventsTableName,
      Item: {
        task_id: params.taskId,
        event_id: ulid(),
        event_type: 'jira_auto_track_skipped',
        timestamp: params.now,
        ttl: computeTtlEpoch(params.taskRetentionDays),
        metadata: {
          jira_project_key: projectKey,
          ...details,
        },
      },
    }));
  } catch (err) {
    logger.error('Failed to write jira_auto_track_skipped event', {
      task_id: params.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
