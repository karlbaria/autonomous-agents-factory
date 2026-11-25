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
import { logger } from './logger';
import sharedConstants from '../../../../contracts/constants.json';

const REQUEST_TIMEOUT_MS = 5000;
const FORGE_WEBTRIGGER_SUFFIX = sharedConstants.jira_app_actor.forge_webtrigger_suffix;
export const JIRA_APP_ACTOR_MIN_SECRET_LENGTH = sharedConstants.jira_app_actor.min_secret_length;
const PROXY_ERROR_CODES = new Set([
  'cloud_id_required',
  'invalid_comment_request',
  'invalid_create_issue_request',
  'invalid_epic_name_field',
  'invalid_link_issues_request',
  'invalid_parent_key',
  'invalid_plan_label',
  'invalid_update_comment_request',
  'invalid_issue_key',
  'invalid_json',
  'invalid_payload',
  'invalid_signature',
  'invalid_transition_request',
  'jira_request_failed',
  'method_not_allowed',
  'payload_too_large',
  'proxy_not_configured',
  'unsupported_operation',
]);

export interface JiraAppActorConfig {
  readonly proxyUrl: string;
  readonly sharedSecret: string;
}

export interface JiraAppActorRequest {
  readonly version: 1;
  readonly operation: 'comment' | 'update_comment' | 'get_transitions' | 'transition' | 'identity' | 'create_issue' | 'link_issues';
  readonly cloud_id: string;
  readonly issue_key?: string;
  readonly comment_id?: string;
  readonly body?: Record<string, unknown>;
  readonly transition_id?: string;
  /** `create_issue` only — target project key (e.g. `SHOP`). */
  readonly project_key?: string;
  /** `create_issue` only — issue type NAME (e.g. `Task`), not an id. */
  readonly issue_type_name?: string;
  /** `create_issue` only — the new issue's summary. */
  readonly summary?: string;
  /** `create_issue` only — the parent issue's key (a Story under an Epic, #82 PR 3b-2). */
  readonly parent_key?: string;
  /** `create_issue` only — at most one label, `factory-plan-<8 base32 chars>`. */
  readonly labels?: readonly string[];
  /** `create_issue` only — a company-managed Epic's Epic Name field id, set to the summary. */
  readonly epic_name_field?: string;
  /** `link_issues` only — always `Blocks`. */
  readonly link_type?: 'Blocks';
  /** `link_issues` only — the issue that blocks. */
  readonly outward_issue_key?: string;
  /** `link_issues` only — the issue that is blocked. */
  readonly inward_issue_key?: string;
}

export type JiraAppActorResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
    readonly ok: false;
    readonly status?: number;
    readonly retryable: boolean;
    readonly errorCode?: string;
    /**
     * Raw proxy response body, when one was received (a request that never
     * reached the proxy — network/timeout — has none). Comment/transition
     * callers don't need this; `create_issue` does, to show the caller
     * exactly which Jira field was missing or invalid.
     */
    readonly body?: string;
  };

function proxyErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const error = (value as { error?: unknown }).error;
    return typeof error === 'string' && PROXY_ERROR_CODES.has(error) ? error : undefined;
  } catch {
    return undefined; // nosemgrep: ts-silent-success-masking -- invalid proxy bodies have no code
  }
}

export function validateJiraAppActorProxyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !url.hostname.endsWith(FORGE_WEBTRIGGER_SUFFIX)
      || url.username
      || url.password
      || url.search
      || url.hash
      || !url.pathname.startsWith('/public/')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- invalid URL is the validator's null contract
  }
}

export function signJiraAppActorRequest(
  sharedSecret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${crypto
    .createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

export async function requestJiraAppActor(
  config: JiraAppActorConfig,
  request: JiraAppActorRequest,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JiraAppActorResult> {
  const proxyUrl = validateJiraAppActorProxyUrl(config.proxyUrl);
  if (!proxyUrl || config.sharedSecret.length < JIRA_APP_ACTOR_MIN_SECRET_LENGTH) {
    logger.error('Jira app-actor configuration is invalid; refusing OAuth fallback', {
      error_id: 'JIRA_APP_ACTOR_CONFIG_INVALID',
      proxy_url_valid: Boolean(proxyUrl),
      shared_secret_valid: config.sharedSecret.length >= JIRA_APP_ACTOR_MIN_SECRET_LENGTH,
    });
    return { ok: false, retryable: false };
  }

  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetchImpl(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bgagent-Timestamp': timestamp,
        'X-Bgagent-Signature': signJiraAppActorRequest(config.sharedSecret, timestamp, body),
      },
      body,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    const responseBody = await result.text();
    if (result.ok) {
      return { ok: true, status: result.status, body: responseBody };
    }
    const errorCode = proxyErrorCode(responseBody);
    const retryable = errorCode !== 'proxy_not_configured'
      && (result.status === 429 || result.status >= 500);
    const details = {
      error_id: retryable
        ? 'JIRA_APP_ACTOR_PROXY_TRANSIENT'
        : 'JIRA_APP_ACTOR_PROXY_REJECTED',
      status: result.status,
      retryable,
      operation: request.operation,
      jira_cloud_id: request.cloud_id,
      issue_key: request.issue_key,
      proxy_error_code: errorCode,
    };
    if (retryable) {
      logger.warn('Jira app-actor proxy returned retryable non-2xx', details);
    } else {
      logger.error('Jira app-actor proxy rejected request', details);
    }
    return { ok: false, status: result.status, retryable, errorCode, body: responseBody };
  } catch (err) {
    logger.warn('Jira app-actor proxy request failed', {
      error_id: 'JIRA_APP_ACTOR_PROXY_NETWORK',
      operation: request.operation,
      jira_cloud_id: request.cloud_id,
      issue_key: request.issue_key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

// ─── OAuth twins (#82 PR 3b-2) ──────────────────────────────────────────────
// A tenant without the Forge app actor writes through its user-delegated 3LO
// token instead (see resolveJiraOutboundAuth). These send the same requests
// the proxy's `create_issue` and `link_issues` send, and return the same
// result shape.

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

async function requestJiraViaOauth(
  accessToken: string,
  cloudId: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<JiraAppActorResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetchImpl(`${JIRA_API_BASE}/${encodeURIComponent(cloudId)}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await result.text();
    if (result.ok) return { ok: true, status: result.status, body: responseBody };
    return {
      ok: false,
      status: result.status,
      retryable: result.status === 429 || result.status >= 500,
      body: responseBody,
    };
  } catch (err) {
    logger.warn('Jira OAuth write failed', {
      jira_cloud_id: cloudId,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** The fields of an issue to create; mirrors the proxy's `create_issue`. */
export interface JiraIssueCreateFields {
  readonly projectKey: string;
  readonly issueTypeName: string;
  readonly summary: string;
  readonly description?: Record<string, unknown>;
  readonly parentKey?: string;
  readonly labels?: readonly string[];
  readonly epicNameField?: string;
}

/** The proxy request for {@link JiraIssueCreateFields}. */
export function createIssueRequest(cloudId: string, fields: JiraIssueCreateFields): JiraAppActorRequest {
  return {
    version: 1,
    operation: 'create_issue',
    cloud_id: cloudId,
    project_key: fields.projectKey,
    issue_type_name: fields.issueTypeName,
    summary: fields.summary,
    ...(fields.description !== undefined && { body: fields.description }),
    ...(fields.parentKey !== undefined && { parent_key: fields.parentKey }),
    ...(fields.labels !== undefined && { labels: fields.labels }),
    ...(fields.epicNameField !== undefined && { epic_name_field: fields.epicNameField }),
  };
}

/** OAuth twin of the proxy's `create_issue`. */
export async function createJiraIssueViaOauth(
  accessToken: string,
  cloudId: string,
  fields: JiraIssueCreateFields,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraAppActorResult> {
  return requestJiraViaOauth(accessToken, cloudId, '/rest/api/3/issue', {
    fields: {
      project: { key: fields.projectKey },
      issuetype: { name: fields.issueTypeName },
      summary: fields.summary,
      ...(fields.description !== undefined && { description: fields.description }),
      ...(fields.parentKey !== undefined && { parent: { key: fields.parentKey } }),
      ...(fields.labels !== undefined && fields.labels.length > 0 && { labels: fields.labels }),
      ...(fields.epicNameField !== undefined && { [fields.epicNameField]: fields.summary }),
    },
  }, fetchImpl);
}

/** The proxy request for "`blockerKey` blocks `blockedKey`". */
export function linkIssuesRequest(cloudId: string, blockerKey: string, blockedKey: string): JiraAppActorRequest {
  return {
    version: 1,
    operation: 'link_issues',
    cloud_id: cloudId,
    link_type: 'Blocks',
    outward_issue_key: blockerKey,
    inward_issue_key: blockedKey,
  };
}

/** OAuth twin of the proxy's `link_issues`: "`blockerKey` blocks `blockedKey`". */
export async function linkJiraIssuesViaOauth(
  accessToken: string,
  cloudId: string,
  blockerKey: string,
  blockedKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraAppActorResult> {
  return requestJiraViaOauth(accessToken, cloudId, '/rest/api/3/issueLink', {
    type: { name: 'Blocks' },
    outwardIssue: { key: blockerKey },
    inwardIssue: { key: blockedKey },
  }, fetchImpl);
}
