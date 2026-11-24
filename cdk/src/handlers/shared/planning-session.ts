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
 * Planning sessions (Task 15 (fork), #82 PR 3b-1): one row per planning draft
 * delivered to Slack with Approve and Cancel buttons.
 *
 * The fan-out Slack dispatcher creates the row as it posts "Planning draft
 * ready" and records the posted message ts. The Slack command processor reads
 * it when a button is clicked and moves its state with conditional updates:
 *
 *   drafted ──Approve/Confirm──▶ approving ──(check done)──▶ drafted
 *   drafted ──Cancel──▶ cancelled
 *
 * `approving` is a lease, not a resting state: a click that finds an
 * unexpired lease is told the plan is already being checked, and a lease left
 * behind by a crashed invocation can be taken over once it expires. `filed`
 * is reserved for PR 3b-2.
 *
 * No message or page text is stored: only references, the state, and a digest
 * of the checked stories while a large-plan confirmation is pending.
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
export const APPROVAL_LEASE_SECONDS = 60;

/** The session states. `filed` is set by PR 3b-2's filing. */
export type PlanningSessionState = 'drafted' | 'approving' | 'filed' | 'cancelled';

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
  /** Epoch seconds the current `approving` lease was taken. */
  readonly approving_since?: number;
  /** Digest of the stories a pending large-plan confirmation covers. */
  readonly confirm_digest?: string;
  readonly created_at: string;
  /** TTL, epoch seconds. */
  readonly expires_at: number;
}

/** What the fan-out dispatcher knows when it creates a session. */
export type NewPlanningSession = Omit<
  PlanningSession,
  'state' | 'approving_since' | 'confirm_digest' | 'created_at' | 'expires_at' | 'slack_message_ts'
>;

/** The button actions. */
export type PlanAction = 'approve' | 'cancel' | 'confirm';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SESSION_ID_BYTES = 16;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE32_CHAR = 5;
const BINARY = 2;

/** `plan_<action>:<26-char session id>`, the only action ids the buttons carry. */
const PLAN_ACTION_ID_PATTERN = /^plan_(approve|cancel|confirm):([a-z2-7]{26})$/;

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

/** Record the ts of the posted "Planning draft ready" message. */
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
 * Give the lease back (state `drafted`), recording or clearing the digest of a
 * pending large-plan confirmation. Only the holder of the lease taken at
 * `leaseSince` can release it.
 */
export async function releaseApprovalLease(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  leaseSince: number,
  confirmDigest: string | null,
): Promise<void> {
  const setDigest = confirmDigest !== null;
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { session_id: sessionId },
      UpdateExpression: setDigest
        ? 'SET #state = :drafted, confirm_digest = :digest REMOVE approving_since'
        : 'SET #state = :drafted REMOVE approving_since, confirm_digest',
      ConditionExpression: '#state = :approving AND approving_since = :since',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':drafted': 'drafted',
        ':approving': 'approving',
        ':since': leaseSince,
        ...(setDigest && { ':digest': confirmDigest }),
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
