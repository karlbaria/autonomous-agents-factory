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
 * The Jira calls Start's filing makes (#82 PR 3b-2), through the tenant's
 * outbound identity: the Forge app actor when configured, else the
 * user-delegated OAuth token (`resolveJiraOutboundAuth`). Reads (the label
 * search, a story's links) use the tenant's OAuth token.
 *
 * Outcomes are three-way so the caller never files twice: `created` / `linked`,
 * `rejected` (Jira or the proxy answered no, so nothing was written), and
 * `unknown` (a timeout, network error, 429 or 5xx: it may have been written;
 * the caller looks for it before trying again).
 */

import {
  createIssueRequest,
  createJiraIssueViaOauth,
  type JiraAppActorResult,
  type JiraIssueCreateFields,
  linkIssuesRequest,
  linkJiraIssuesViaOauth,
  requestJiraAppActor,
} from './jira-app-actor';
import { resolveJiraOauthToken, resolveJiraOutboundAuth } from './jira-oauth-resolver';
import { logger } from './logger';

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const READ_TIMEOUT_MS = 10_000;
const SEARCH_PAGE_SIZE = 50;

export type CreateIssueOutcome =
  | { readonly kind: 'created'; readonly key: string; readonly id: string }
  | {
    readonly kind: 'rejected';
    readonly status?: number;
    /** Jira's `errors` map (field id → message), when it gave one. */
    readonly fieldErrors?: Readonly<Record<string, string>>;
    readonly detail: string;
  }
  | { readonly kind: 'unknown' };

export type LinkIssuesOutcome =
  | { readonly kind: 'linked' }
  | { readonly kind: 'rejected'; readonly status?: number; readonly detail: string }
  | { readonly kind: 'unknown' };

/** An issue the label search found. */
export interface PlanLabelledIssue {
  readonly key: string;
  readonly id: string;
  readonly summary: string;
  readonly issueTypeName: string;
  readonly parentKey?: string;
}

/** What filing needs from Jira. */
export interface PlanJira {
  /** The tenant's site, e.g. `https://example.atlassian.net`. */
  readonly siteUrl: string;
  createIssue(fields: JiraIssueCreateFields): Promise<CreateIssueOutcome>;
  /** "`blockerKey` blocks `blockedKey`". */
  linkBlocks(blockerKey: string, blockedKey: string): Promise<LinkIssuesOutcome>;
  /** Issues carrying `label`, or null when the search failed. */
  findByLabel(label: string): Promise<readonly PlanLabelledIssue[] | null>;
  /** Whether `blockedKey` already has "is blocked by `blockerKey`", or null when unreadable. */
  hasBlocksLink(blockerKey: string, blockedKey: string): Promise<boolean | null>;
}

function parseJson(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- a non-JSON body carries no key or field errors; callers treat it as such
  }
}

function isUnknownOutcome(result: JiraAppActorResult): boolean {
  return !result.ok && (result.retryable || result.status === undefined);
}

function toCreateOutcome(result: JiraAppActorResult): CreateIssueOutcome {
  if (result.ok) {
    const body = parseJson(result.body);
    if (typeof body?.key === 'string' && typeof body.id === 'string') return { kind: 'created', key: body.key, id: body.id };
    // Created, but no key to record: look for it like any unknown outcome.
    return { kind: 'unknown' };
  }
  if (isUnknownOutcome(result)) return { kind: 'unknown' };
  const body = parseJson(result.body);
  const errors = body?.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)
    ? body.errors as Record<string, string>
    : undefined;
  const messages = Array.isArray(body?.errorMessages) ? (body.errorMessages as unknown[]).filter((m) => typeof m === 'string') : [];
  const detail = [
    ...messages as string[],
    ...Object.entries(errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ...(result.errorCode ? [result.errorCode] : []),
  ].join('; ') || `status ${result.status ?? 'unknown'}`;
  return { kind: 'rejected', ...(result.status !== undefined && { status: result.status }), ...(errors && { fieldErrors: errors }), detail };
}

function toLinkOutcome(result: JiraAppActorResult): LinkIssuesOutcome {
  if (result.ok) return { kind: 'linked' };
  if (isUnknownOutcome(result)) return { kind: 'unknown' };
  return {
    kind: 'rejected',
    ...(result.status !== undefined && { status: result.status }),
    detail: result.errorCode ?? `status ${result.status ?? 'unknown'}`,
  };
}

async function getJson(accessToken: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jira returned status ${response.status}`);
  return response.json();
}

interface SearchIssue {
  readonly id?: unknown;
  readonly key?: unknown;
  readonly fields?: {
    readonly summary?: unknown;
    readonly issuetype?: { readonly name?: unknown };
    readonly parent?: { readonly key?: unknown };
    readonly issuelinks?: ReadonlyArray<{
      readonly type?: { readonly name?: unknown; readonly inward?: unknown };
      readonly inwardIssue?: { readonly key?: unknown };
    }>;
  };
}

/**
 * The filing's Jira client for a tenant, or null when its outbound identity
 * can't be resolved.
 */
export async function makePlanJira(cloudId: string, registryTableName: string): Promise<PlanJira | null> {
  const outbound = await resolveJiraOutboundAuth(cloudId, registryTableName);
  if (!outbound) return null;
  const readToken = async (): Promise<string | null> => (await resolveJiraOauthToken(cloudId, registryTableName))?.accessToken ?? null;
  const base = `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3`;

  return {
    siteUrl: outbound.siteUrl,
    async createIssue(fields) {
      const result = outbound.kind === 'app'
        ? await requestJiraAppActor(outbound.appActor, createIssueRequest(cloudId, fields))
        : await createJiraIssueViaOauth(outbound.accessToken, cloudId, fields);
      return toCreateOutcome(result);
    },
    async linkBlocks(blockerKey, blockedKey) {
      const result = outbound.kind === 'app'
        ? await requestJiraAppActor(outbound.appActor, linkIssuesRequest(cloudId, blockerKey, blockedKey))
        : await linkJiraIssuesViaOauth(outbound.accessToken, cloudId, blockerKey, blockedKey);
      return toLinkOutcome(result);
    },
    async findByLabel(label) {
      const token = await readToken();
      if (!token) return null;
      const query = new URLSearchParams({
        jql: `labels = "${label.replaceAll('"', '')}"`,
        fields: 'summary,issuetype,parent',
        maxResults: String(SEARCH_PAGE_SIZE),
      });
      try {
        const page = await getJson(token, `${base}/search/jql?${query.toString()}`) as { issues?: SearchIssue[] };
        return (page.issues ?? []).flatMap((issue): PlanLabelledIssue[] => {
          if (typeof issue.key !== 'string' || typeof issue.id !== 'string') return [];
          const parentKey = issue.fields?.parent?.key;
          return [{
            key: issue.key,
            id: issue.id,
            summary: typeof issue.fields?.summary === 'string' ? issue.fields.summary : '',
            issueTypeName: typeof issue.fields?.issuetype?.name === 'string' ? issue.fields.issuetype.name : '',
            ...(typeof parentKey === 'string' && { parentKey }),
          }];
        });
      } catch (err) {
        logger.warn('Plan filing: label search failed', { label, error: err instanceof Error ? err.message : String(err) });
        return null; // nosemgrep: ts-silent-success-masking -- null is the documented "search failed" result, distinct from an empty list; the filer stops on it rather than creating again
      }
    },
    async hasBlocksLink(blockerKey, blockedKey) {
      const token = await readToken();
      if (!token) return null;
      try {
        const issue = await getJson(token, `${base}/issue/${encodeURIComponent(blockedKey)}?fields=issuelinks`) as SearchIssue;
        return (issue.fields?.issuelinks ?? []).some((link) =>
          typeof link.type?.inward === 'string'
          && link.type.inward.trim().toLowerCase() === 'is blocked by'
          && link.inwardIssue?.key === blockerKey);
      } catch (err) {
        logger.warn('Plan filing: link read failed', { issue_key: blockedKey, error: err instanceof Error ? err.message : String(err) });
        return null; // nosemgrep: ts-silent-success-masking -- null is the documented "unreadable" result, distinct from false; a resume then sends the link again (at worst a duplicate Blocks link, which the graph read dedups) and an unknown outcome pauses
      }
    },
  };
}
