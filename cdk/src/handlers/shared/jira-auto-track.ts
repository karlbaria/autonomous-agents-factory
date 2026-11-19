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
  | { readonly kind: 'created'; readonly issueKey: string }
  // Jira's create response reports exactly which field it needed (or that
  // the issue type name doesn't exist in this project) via a 400 with an
  // `errors` map — the caller surfaces this reason verbatim rather than the
  // parsed-but-unusable response.
  | { readonly kind: 'skipped'; readonly reason: 'unknown_required_fields'; readonly jiraErrors: Record<string, string> }
  | { readonly kind: 'skipped'; readonly reason: 'unavailable' };

interface CreateIssueHttpOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: string;
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
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  } catch (err) {
    logger.warn('Jira auto-track OAuth create-issue request failed', {
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
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

  let outcome: CreateIssueHttpOutcome;
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
    outcome = appResult.ok
      ? { ok: true, status: appResult.status, body: appResult.body }
      : { ok: false, status: appResult.status, body: appResult.body };
  } else {
    outcome = await requestCreateIssueViaOauth(resolved.accessToken, params.cloudId, {
      project: { key: params.projectKey },
      issuetype: { name: DEFAULT_ISSUE_TYPE_NAME },
      summary: params.summary,
      ...(descriptionAdf !== undefined && { description: descriptionAdf }),
    });
  }

  if (outcome.ok) {
    const issueKey = parseCreatedIssueKey(outcome.body);
    if (issueKey) return { kind: 'created', issueKey };
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
  });
  return { kind: 'skipped', reason: 'unavailable' };
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
    await writeJiraAutoTrackSkippedEvent(params, mapping.projectKey, result.jiraErrors);
  }
  // 'unavailable' (outage, misconfigured tenant, network) is already logged
  // above in createAutoTrackedJiraIssue — no extra noise here.

  return { channelMetadata: params.channelMetadata };
}

/** Visible milestone for the one auto-track outcome the owner asked to
 *  surface: the mapped project rejected the create over a field it needs
 *  that this task couldn't supply. Best-effort, like every other task event
 *  write in `create-task-core.ts` — event loss here never fails the task. */
async function writeJiraAutoTrackSkippedEvent(
  params: ResolveJiraAutoTrackParams,
  projectKey: string,
  jiraErrors: Record<string, string>,
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
          jira_errors: jiraErrors,
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
