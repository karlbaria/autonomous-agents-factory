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
 * Planning sessions (Task 15 (fork), #82 PR 3b-1 and 3c): one row per planning
 * document delivered to Slack with buttons. Two kinds:
 *
 * - `prd` (PR 3c): "PRD draft ready" with Approve PRD and Cancel.
 * - `design`: "Technical design ready: N stories, about $X" with Start and
 *   Cancel (a row without `kind`, from before PR 3c, is a design).
 *
 * The fan-out Slack dispatcher creates the row as it posts the message and
 * records the posted message ts. The Slack command processor reads it when a
 * button is clicked and moves its state with conditional updates:
 *
 *   drafted ──Approve PRD/Start/Confirm──▶ approving ──(check done)──▶ drafted
 *   approving ──(PRD approved, design task created)──▶ approved   (prd only)
 *   drafted ──Cancel──▶ cancelled
 *
 * `approving` is a lease, not a resting state: a click that finds an
 * unexpired lease is told the document is already being checked, and a lease
 * left behind by a crashed invocation can be taken over once it expires.
 * `filed` is reserved for PR 3b-2.
 *
 * No message or page text is stored: only references, the state, and, for a
 * design, a digest of the story count and cost the latest message showed.
 */

import * as crypto from 'crypto';
import { type DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const SESSION_TTL_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

/** How long a session lives: Approve and Cancel stop working after this. */
export const PLANNING_SESSION_TTL_SECONDS = SESSION_TTL_DAYS * SECONDS_PER_DAY;

/**
 * How long an Approve or Confirm holds the `approving` lease. Longer than the
 * command processor's timeout, so a live invocation is never overtaken, and
 * short enough that a crashed one blocks a retry only briefly.
 */
export const APPROVAL_LEASE_SECONDS = 150;

/** The session states. `approved` ends a PRD session; `filed` is set by PR 3b-2's filing. */
export type PlanningSessionState = 'drafted' | 'approving' | 'approved' | 'filed' | 'cancelled';

/** Which document a session is for (#82 PR 3c). */
export type PlanningSessionKind = 'prd' | 'design';

/** A planning-session row. */
export interface PlanningSession {
  readonly session_id: string;
  readonly task_id: string;
  readonly repo: string;
  readonly page_id: string;
  readonly slack_team_id: string;
  readonly slack_user_id: string;
  readonly platform_user_id: string;
  readonly slack_channel_id: string;
  readonly slack_thread_ts?: string;
  readonly slack_message_ts?: string;
  readonly state: PlanningSessionState;
  /** Absent on rows from before #82 PR 3c, which are designs. */
  readonly kind?: PlanningSessionKind;
  /** Epoch seconds the current `approving` lease was taken. */
  readonly approving_since?: number;
  /**
   * A design's `designNumbersDigest` (plan-parse.ts): the story count and cost the
   * latest message asked the PM to start with.
   */
  readonly confirm_digest?: string;
  /** The design task an approved PRD started. */
  readonly design_task_id?: string;
  // ── Filing checkpoints (#82 PR 3b-2). Written under the lease; a Start that
  // fails part-way resumes from them, so nothing is filed twice. ──
  /** `planDigest` of the design when filing began; a resume needs the same. */
  readonly filing_plan_digest?: string;
  /** The design page version filing began from (for the record). */
  readonly filing_page_version?: number;
  /** When the requester's Start began filing, ISO UTC (decision 18). */
  readonly filing_approved_at?: string;
  /** The filed parent: the Epic, or the only Story. */
  readonly filing_parent?: FiledIssue;
  /** Filed child issues by story id (`S<n>`). */
  readonly filing_children?: Readonly<Record<string, FiledIssue>>;
  /** Filed `Blocks` links, by `<blocker>><blocked>` story ids. */
  readonly filing_links?: Readonly<Record<string, boolean>>;
  /** A create or link sent but not yet recorded: its step and epoch seconds. */
  readonly filing_inflight?: { readonly step: string; readonly since: number };
  /** The build was started from the filed parent. */
  readonly filing_build_started?: boolean;
  readonly created_at: string;
  /** TTL, epoch seconds. */
  readonly expires_at: number;
}

/** A filed Jira issue (#82 PR 3b-2). */
export interface FiledIssue {
  readonly key: string;
  readonly id: string;
}

/** What the fan-out dispatcher knows when it creates a session. */
export type NewPlanningSession = Omit<
  PlanningSession,
  'state' | 'approving_since' | 'created_at' | 'expires_at' | 'slack_message_ts' | 'design_task_id'
  | 'filing_plan_digest' | 'filing_page_version' | 'filing_approved_at' | 'filing_parent'
  | 'filing_children' | 'filing_links' | 'filing_inflight' | 'filing_build_started'
>;

/**
 * The button actions: `approve` (Approve PRD, or a design's Approve from
 * before PR 3c), `start` (a design's Start), `confirm` (Start again with new
 * numbers) and `cancel`.
 */
export type PlanAction = 'approve' | 'start' | 'cancel' | 'confirm';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SESSION_ID_BYTES = 16;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE32_CHAR = 5;
const BINARY = 2;

/** `plan_<action>:<26-char session id>`, the only action ids the buttons carry. */
const PLAN_ACTION_ID_PATTERN = /^plan_(approve|start|cancel|confirm):([a-z2-7]{26})$/;

/** `/wiki/spaces/<KEY>/pages/<id>` in a published page URL. */
const PAGE_ID_IN_URL = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:[/?#]|$)/;

/** A new opaque session id: 128 random bits, lowercase base32 (26 chars). */
export function newPlanningSessionId(): string {
  const bits = [...crypto.randomBytes(SESSION_ID_BYTES)]
    .map((byte) => byte.toString(BINARY).padStart(BITS_PER_BYTE, '0'))
    .join('');
  let out = '';
  for (let i = 0; i < bits.length; i += BITS_PER_BASE32_CHAR) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + BITS_PER_BASE32_CHAR).padEnd(BITS_PER_BASE32_CHAR, '0'), BINARY)];
  }
  return out;
}

/** The Block Kit action id for a plan button. */
export function planActionId(action: PlanAction, sessionId: string): string {
  return `plan_${action}:${sessionId}`;
}

/** The action and session id of a plan button's action id, or null for anything else. */
export function parsePlanActionId(actionId: string): { readonly action: PlanAction; readonly sessionId: string } | null {
  const match = PLAN_ACTION_ID_PATTERN.exec(actionId);
  return match ? { action: match[1] as PlanAction, sessionId: match[2] } : null;
}

/** The page id of a published Confluence page URL, or null. */
export function pageIdFromPageUrl(pageUrl: string | undefined): string | null {
  if (!pageUrl) return null;
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- an unparseable URL has no page id; the caller posts without buttons
  }
  return PAGE_ID_IN_URL.exec(path)?.[1] ?? null;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as Error)?.name === 'ConditionalCheckFailedException';
}

/** Create a `drafted` session. Throws on any DynamoDB failure. */
export async function createPlanningSession(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  session: NewPlanningSession,
  now: Date,
): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...session,
      state: 'drafted',
      created_at: now.toISOString(),
      expires_at: Math.floor(now.getTime() / 1000) + PLANNING_SESSION_TTL_SECONDS,
    },
    ConditionExpression: 'attribute_not_exists(session_id)',
  }));
}

/** Record the ts of the posted "PRD draft ready" or "Technical design ready" message. */
export async function setPlanningSessionMessageTs(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  messageTs: string,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { session_id: sessionId },
    UpdateExpression: 'SET slack_message_ts = :ts',
    ConditionExpression: 'attribute_exists(session_id)',
    ExpressionAttributeValues: { ':ts': messageTs },
  }));
}

/**
 * The session, or null when there is none or it has expired. DynamoDB can
 * take up to two days to delete an expired row, so expiry is checked here too.
 */
export async function getPlanningSession(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  nowSeconds: number,
): Promise<PlanningSession | null> {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { session_id: sessionId },
    ConsistentRead: true,
  }));
  const item = result.Item as PlanningSession | undefined;
  if (!item || typeof item.expires_at !== 'number' || item.expires_at <= nowSeconds) return null;
  return item;
}

/**
 * Take the `approving` lease: from `drafted`, or from `approving` whose lease
 * has expired. Returns false when the session is busy (an unexpired lease) or
 * closed (`filed`, `cancelled`, expired or gone).
 */
export async function claimApprovalLease(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  nowSeconds: number,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: 'SET #state = :approving, approving_since = :now',
      ConditionExpression: 'expires_at > :now AND (#state = :drafted OR (#state = :approving AND approving_since < :stale))',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':approving': 'approving',
        ':drafted': 'drafted',
        ':now': nowSeconds,
        ':stale': nowSeconds - APPROVAL_LEASE_SECONDS,
      },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * End an approved PRD's session (state `approved`), recording the design task
 * it started. Only the holder of the lease taken at `leaseSince` can do it;
 * returns false when someone took over an expired lease.
 */
export async function completePrdApproval(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  designTaskId: string,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: 'SET #state = :approved, design_task_id = :task REMOVE approving_since, confirm_digest',
      ConditionExpression: '#state = :approving AND approving_since = :since',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':approved': 'approved',
        ':approving': 'approving',
        ':since': leaseSince,
        ':task': designTaskId,
      },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Give the lease back (state `drafted`). `confirmDigest` records the digest of
 * the numbers a design's latest Start message showed; `null` clears it, and
 * `undefined` leaves it as it was (a failed check doesn't change what the PM
 * was last asked). Only the holder of the lease taken at `leaseSince` can
 * release it.
 */
export async function releaseApprovalLease(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  confirmDigest?: string | null,
): Promise<void> {
  let update = 'SET #state = :drafted REMOVE approving_since';
  if (confirmDigest === null) update = 'SET #state = :drafted REMOVE approving_since, confirm_digest';
  if (typeof confirmDigest === 'string') update = 'SET #state = :drafted, confirm_digest = :digest REMOVE approving_since';
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: update,
      ConditionExpression: '#state = :approving AND approving_since = :since',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':drafted': 'drafted',
        ':approving': 'approving',
        ':since': leaseSince,
        ...(typeof confirmDigest === 'string' && { ':digest': confirmDigest }),
      },
    }));
  } catch (err) {
    // Someone took over an expired lease; their outcome stands.
    if (isConditionalCheckFailed(err)) return;
    throw err;
  }
}

/**
 * Cancel a `drafted` session (or one whose `approving` lease has expired).
 * Returns false when it is busy or closed.
 */
export async function cancelPlanningSession(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  nowSeconds: number,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: 'SET #state = :cancelled REMOVE confirm_digest, approving_since',
      ConditionExpression: 'expires_at > :now AND (#state = :drafted OR (#state = :approving AND approving_since < :stale))',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':cancelled': 'cancelled',
        ':drafted': 'drafted',
        ':approving': 'approving',
        ':now': nowSeconds,
        ':stale': nowSeconds - APPROVAL_LEASE_SECONDS,
      },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

// ─── Filing checkpoints (#82 PR 3b-2) ───────────────────────────────────────

/** A checkpoint write the lease holder made; false when the lease was lost. */
async function leaseUpdate(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  update: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  extraCondition = '',
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: update,
      ConditionExpression: `#state = :approving AND approving_since = :since${extraCondition}`,
      ExpressionAttributeNames: { '#state': 'state', ...names },
      ExpressionAttributeValues: { ':approving': 'approving', ':since': leaseSince, ...values },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Freeze what is about to be filed: the design's digest, its page version and
 * the approval time. Only when filing hasn't begun; returns false otherwise
 * (or when the lease was lost), and the caller compares the frozen digest.
 */
export async function beginFiling(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  freeze: { readonly planDigest: string; readonly pageVersion: number | null; readonly approvedAt: string },
): Promise<boolean> {
  return leaseUpdate(
    ddb, tableName, sessionId, leaseSince,
    'SET filing_plan_digest = :digest, filing_approved_at = :at, filing_children = :empty, filing_links = :empty'
      + (freeze.pageVersion !== null ? ', filing_page_version = :version' : ''),
    {},
    {
      ':digest': freeze.planDigest,
      ':at': freeze.approvedAt,
      ':empty': {},
      ...(freeze.pageVersion !== null && { ':version': freeze.pageVersion }),
    },
    ' AND attribute_not_exists(filing_plan_digest)',
  );
}

/** Mark a create or link as sent before sending it, so an unknown outcome is looked for, not repeated. */
export async function markFilingInflight(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  step: string,
  nowSeconds: number,
): Promise<boolean> {
  return leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET filing_inflight = :inflight', {}, {
    ':inflight': { step, since: nowSeconds },
  });
}

/** Forget an in-flight marker whose request definitely failed. */
export async function clearFilingInflight(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
): Promise<boolean> {
  return leaseUpdate(ddb, tableName, sessionId, leaseSince, 'REMOVE filing_inflight', {}, {});
}

/** Record a filed issue: the parent (`step` = `parent`) or a story's child, and clear the in-flight marker. */
export async function recordFiledIssue(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  step: string,
  issue: FiledIssue,
): Promise<boolean> {
  const value = { key: issue.key, id: issue.id };
  return step === 'parent'
    ? leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET filing_parent = :issue REMOVE filing_inflight', {}, {
      ':issue': value,
    })
    : leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET filing_children.#story = :issue REMOVE filing_inflight', {
      '#story': step,
    }, { ':issue': value });
}

/** Record a filed `Blocks` link and clear the in-flight marker. */
export async function recordFiledLink(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  linkId: string,
): Promise<boolean> {
  return leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET filing_links.#link = :true REMOVE filing_inflight', {
    '#link': linkId,
  }, { ':true': true });
}

/** Record that the build was started from the filed parent. */
export async function recordBuildStarted(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
): Promise<boolean> {
  return leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET filing_build_started = :true', {}, { ':true': true });
}

/** End a design's session: filed and started (state `filed`). */
export async function completeFiling(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
): Promise<boolean> {
  return leaseUpdate(ddb, tableName, sessionId, leaseSince, 'SET #state = :filed REMOVE approving_since, filing_inflight', {}, {
    ':filed': 'filed',
  });
}
