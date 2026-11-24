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
 * Factory pages in Confluence, read and labelled with the tenant token (Task
 * 15 (fork), #82): the mapped-space page fetch, storage-to-text conversion,
 * the planning-page reader (PR 3b-1, 3c) and marking a page final (PR 3c).
 *
 * Split from `confluence-prd.ts` so a handler that only reads planning pages
 * (the fan-out Slack dispatcher) doesn't bundle the guardrail screening and
 * its PDF parser.
 */

import { getRegistryRow, resolveJiraOauthToken } from './jira-oauth-resolver';
import { logger } from './logger';
import type { RepoConfig } from './repo-config';
import { makeDocClient } from './ua';

type ConfluenceMapping = Pick<RepoConfig, 'confluence_cloud_id' | 'confluence_space_key'>;

const CONFLUENCE_API_BASE = 'https://api.atlassian.com/ex/confluence';
const FETCH_TIMEOUT_MS = 8_000;
/** Highest Unicode code point (`String.fromCodePoint` throws above it). */
const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text of a Confluence storage-format (XHTML) body: headings as `#`
 * lines, list items as `- ` lines, code-macro bodies kept, every tag and
 * attribute dropped. Pure.
 */
export function confluenceStorageToText(storage: string): string {
  return decodeEntities(
    storage
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => body.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|tr|ul|ol|table|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getJson(fetchFn: typeof fetch, url: string, token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: await response.json() };
}

interface PageApiBody {
  readonly id?: string;
  readonly status?: string;
  readonly title?: string;
  readonly spaceId?: string;
  readonly version?: { readonly number?: number };
  readonly body?: { readonly storage?: { readonly value?: string } };
}

type MappedPageFetch =
  | { readonly ok: true; readonly page: PageApiBody; readonly accessToken: string; readonly gateway: string }
  | { readonly ok: false; readonly reason: 'unreadable' | 'other_space' };

/**
 * Fetch a current page by id with the tenant token and check, through the
 * API, that it is in `spaceKey`. Never throws.
 */
export async function fetchPageInMappedSpace(
  fetchFn: typeof fetch,
  cloudId: string,
  registryTable: string,
  pageId: string,
  spaceKey: string,
): Promise<MappedPageFetch> {
  try {
    const token = await resolveJiraOauthToken(cloudId, registryTable);
    if (!token) return { ok: false, reason: 'unreadable' };
    const gateway = `${CONFLUENCE_API_BASE}/${encodeURIComponent(cloudId)}/wiki/api/v2`;
    const pageRes = await getJson(fetchFn, `${gateway}/pages/${encodeURIComponent(pageId)}?body-format=storage`, token.accessToken);
    const page = (pageRes.body ?? {}) as PageApiBody;
    if (!pageRes.body || String(page.id) !== pageId || (page.status && page.status !== 'current') || !page.spaceId) {
      logger.warn('Confluence read: page not readable', { page_id: pageId, status: pageRes.status, page_status: page.status });
      return { ok: false, reason: 'unreadable' };
    }
    const spaceRes = await getJson(fetchFn, `${gateway}/spaces/${encodeURIComponent(page.spaceId)}`, token.accessToken);
    const realKey = (spaceRes.body as { key?: string } | null)?.key;
    if (!realKey) return { ok: false, reason: 'unreadable' };
    if (realKey.toUpperCase() !== spaceKey.toUpperCase()) return { ok: false, reason: 'other_space' };
    return { ok: true, page, accessToken: token.accessToken, gateway };
  } catch (err) {
    logger.warn('Confluence read: request failed', {
      page_id: pageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'unreadable' };
  }
}

/** Which planning document a page is (#82 PR 3c). */
export type PlanningPageKind = 'design' | 'prd';

/** Labels a page must carry to be read as that factory document (the agent's publisher sets them). */
const PLANNING_PAGE_LABELS: Record<PlanningPageKind, readonly string[]> = {
  design: ['factory-generated', 'factory-plan'],
  prd: ['factory-generated', 'factory-prd'],
};

const PAGE_NOUN: Record<PlanningPageKind, string> = { design: 'technical design', prd: 'PRD' };

export type PlanPageRejectReason = 'no_mapping' | 'tenant_unavailable' | 'unreadable' | 'other_space' | 'not_a_plan';

export type PlanPageReadResult =
  | {
    readonly ok: true;
    readonly title: string;
    /** The current version's storage-format body, untruncated. */
    readonly storage: string;
    readonly version: number | null;
  }
  | { readonly ok: false; readonly reason: PlanPageRejectReason; readonly message: string };

/**
 * Read the current version of a factory planning page by id: a technical
 * design for Start (#82 PR 3b-1), the fan-out's story count, or a PRD for
 * Approve PRD (`kind: 'prd'`, PR 3c).
 *
 * The id comes from the planning session or task record the platform wrote,
 * never from a user. The same tenant and space checks as `readPrdPage` (confluence-prd.ts)
 * apply, and the page must still carry the factory's `factory-generated`
 * label and `factory-plan` (design) or `factory-prd` (PRD). The page is never
 * truncated: a dropped story would be a silent change to what gets filed, so
 * the caller rejects an oversized page instead. The body is untrusted: the
 * caller only parses it into a fixed structure. Never throws.
 */
export async function readPlanPage(
  pageId: string,
  mapping: ConfluenceMapping | null | undefined,
  deps: { readonly fetchFn?: typeof fetch; readonly kind?: PlanningPageKind } = {},
): Promise<PlanPageReadResult> {
  const fail = (reason: PlanPageRejectReason, message: string): PlanPageReadResult => ({ ok: false, reason, message });
  const kind = deps.kind ?? 'design';
  const noun = PAGE_NOUN[kind];
  const cloudId = mapping?.confluence_cloud_id;
  const spaceKey = mapping?.confluence_space_key;
  if (!cloudId || !spaceKey) {
    return fail('no_mapping', `This repo no longer has a Confluence space mapped, so I can't read the ${noun}.`);
  }
  const registryTable = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  const row = registryTable ? await getRegistryRow(makeDocClient(), registryTable, cloudId) : null;
  if (!row || row.status !== 'active') {
    logger.warn('Plan read: Confluence tenant not resolvable', { confluence_cloud_id: cloudId, status: row?.status });
    return fail('tenant_unavailable', `The Confluence connection for this repo isn't available right now, so I can't read the ${noun}.`);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const unreadable = `I couldn't read the ${noun} page. Check that it still exists and is published, then try again.`;
  const fetched = await fetchPageInMappedSpace(fetchFn, cloudId, registryTable!, pageId, spaceKey);
  if (!fetched.ok) {
    return fetched.reason === 'other_space'
      ? fail('other_space', `The ${noun} page is no longer in this repo's Confluence space (${spaceKey}).`)
      : fail('unreadable', unreadable);
  }

  let labels: string[];
  try {
    const res = await getJson(fetchFn, `${fetched.gateway}/pages/${encodeURIComponent(pageId)}/labels?limit=200`, fetched.accessToken);
    const results = (res.body as { results?: Array<{ name?: unknown }> } | null)?.results;
    if (!Array.isArray(results)) return fail('unreadable', unreadable);
    labels = results.map((l) => (typeof l.name === 'string' ? l.name.toLowerCase() : ''));
  } catch (err) {
    logger.warn('Plan read: label request failed', { page_id: pageId, error: err instanceof Error ? err.message : String(err) });
    return fail('unreadable', unreadable);
  }
  const required = PLANNING_PAGE_LABELS[kind];
  if (!required.every((l) => labels.includes(l))) {
    logger.warn('Plan read: page is missing the factory labels', { page_id: pageId, kind });
    return fail(
      'not_a_plan',
      `That page no longer has the factory's ${noun} labels (${required.map((l) => `\`${l}\``).join(', ')}), so I won't use it.`,
    );
  }

  const version = fetched.page.version?.number;
  return {
    ok: true,
    title: String(fetched.page.title ?? '').trim(),
    storage: fetched.page.body?.storage?.value ?? '',
    version: typeof version === 'number' ? version : null,
  };
}

/** The label a final factory page carries, replacing `factory-draft` (Task 14's lifecycle). */
const LABEL_FINAL = 'factory-final';
const LABEL_DRAFT = 'factory-draft';

/**
 * Mark a factory page final (#82 PR 3c, an approved PRD): add `factory-final`,
 * then remove `factory-draft`, with the tenant token (`write:label:confluence`).
 * Returns false on any failure, logged; never throws.
 */
export async function markPageFinal(
  pageId: string,
  mapping: ConfluenceMapping | null | undefined,
  deps: { readonly fetchFn?: typeof fetch } = {},
): Promise<boolean> {
  const cloudId = mapping?.confluence_cloud_id;
  const registryTable = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!cloudId || !registryTable) return false;
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const token = await resolveJiraOauthToken(cloudId, registryTable);
    if (!token) return false;
    const labelUrl = `${CONFLUENCE_API_BASE}/${encodeURIComponent(cloudId)}/wiki/rest/api/content/${encodeURIComponent(pageId)}/label`;
    const headers = { 'Authorization': `Bearer ${token.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    const added = await fetchFn(labelUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ prefix: 'global', name: LABEL_FINAL }]),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!added.ok) {
      logger.warn('Mark final: adding the final label failed', { page_id: pageId, status: added.status });
      return false;
    }
    const removed = await fetchFn(`${labelUrl}?name=${encodeURIComponent(LABEL_DRAFT)}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404: the draft label was already gone, which is the end state wanted.
    if (!removed.ok && removed.status !== 404) {
      logger.warn('Mark final: removing the draft label failed', { page_id: pageId, status: removed.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Mark final: request failed', { page_id: pageId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
