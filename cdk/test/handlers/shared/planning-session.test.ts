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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  APPROVAL_LEASE_SECONDS,
  beginFiling,
  cancelPlanningSession,
  claimApprovalLease,
  clearFilingInflight,
  completeFiling,
  completePrdApproval,
  createPlanningSession,
  getPlanningSession,
  markFilingInflight,
  newPlanningSessionId,
  pageIdFromPageUrl,
  parsePlanActionId,
  planActionId,
  PLANNING_SESSION_TTL_SECONDS,
  recordBuildStarted,
  recordFiledIssue,
  recordFiledLink,
  releaseApprovalLease,
} from '../../../src/handlers/shared/planning-session';

const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
const conditionFailed = Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => send.mockReset().mockResolvedValue({}));

function lastInput(): Record<string, any> {
  return send.mock.calls[send.mock.calls.length - 1][0].input;
}

describe('ids', () => {
  test('session ids are 26 random lowercase base32 characters', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPlanningSessionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{26}$/);
  });

  test('action ids round-trip', () => {
    const id = newPlanningSessionId();
    for (const action of ['approve', 'start', 'cancel', 'confirm'] as const) {
      expect(parsePlanActionId(planActionId(action, id))).toEqual({ action, sessionId: id });
    }
  });

  test.each([
    'plan_approve:short',
    'plan_approve:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'plan_file:abcdefghijklmnopqrstuvwxyz',
    'plan_approve:abcdefghijklmnopqrstuvwxyz1',
    'plan_approve:abcdefghijklmnopqrstuvwxyz:extra',
    'cancel_task:abcdefghijklmnopqrstuvwxyz',
  ])('rejects %s', (actionId) => {
    expect(parsePlanActionId(actionId)).toBeNull();
  });

  test.each([
    ['https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Plan+Wishlist', '1015867'],
    ['https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867', '1015867'],
    ['https://karlvb.atlassian.net/wiki/spaces/SD/pages/abc', null],
    ['not a url', null],
    [undefined, null],
  ])('page id of %s', (url, id) => {
    expect(pageIdFromPageUrl(url)).toBe(id);
  });
});

describe('createPlanningSession', () => {
  test('writes a drafted row with a 7-day TTL and no message text', async () => {
    const now = new Date('2026-11-24T00:00:00Z');
    await createPlanningSession(ddb, 'Sessions', {
      session_id: 's',
      task_id: 't',
      repo: 'o/r',
      page_id: '1',
      slack_team_id: 'T',
      slack_user_id: 'U',
      platform_user_id: 'p',
      slack_channel_id: 'C',
    }, now);
    const input = lastInput();
    expect(input.ConditionExpression).toBe('attribute_not_exists(session_id)');
    expect(input.Item).toEqual({
      session_id: 's',
      task_id: 't',
      repo: 'o/r',
      page_id: '1',
      slack_team_id: 'T',
      slack_user_id: 'U',
      platform_user_id: 'p',
      slack_channel_id: 'C',
      state: 'drafted',
      created_at: now.toISOString(),
      expires_at: now.getTime() / 1000 + PLANNING_SESSION_TTL_SECONDS,
    });
    expect(PLANNING_SESSION_TTL_SECONDS).toBe(7 * 86_400);
  });
});

describe('getPlanningSession', () => {
  test('treats an expired row as gone, since TTL deletion lags', async () => {
    send.mockResolvedValueOnce({ Item: { session_id: 's', expires_at: 100 } });
    expect(await getPlanningSession(ddb, 'Sessions', 's', 100)).toBeNull();
    send.mockResolvedValueOnce({ Item: { session_id: 's', expires_at: 101 } });
    expect(await getPlanningSession(ddb, 'Sessions', 's', 100)).toMatchObject({ session_id: 's' });
    expect(lastInput().ConsistentRead).toBe(true);
  });
});

describe('the approval lease', () => {
  test('is taken only from drafted, or from an expired lease, on a live session', async () => {
    expect(await claimApprovalLease(ddb, 'Sessions', 's', 1000)).toBe(true);
    const input = lastInput();
    expect(input.ConditionExpression).toBe(
      'expires_at > :now AND (#state = :drafted OR (#state = :approving AND approving_since < :stale))',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ':now': 1000, ':stale': 1000 - APPROVAL_LEASE_SECONDS });
  });

  test('a failed condition means busy or closed, not an error', async () => {
    send.mockRejectedValueOnce(conditionFailed);
    expect(await claimApprovalLease(ddb, 'Sessions', 's', 1000)).toBe(false);
  });

  test('other errors propagate', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(claimApprovalLease(ddb, 'Sessions', 's', 1000)).rejects.toThrow('throttled');
  });

  test('outlives the command processor timeout', () => {
    // slack-integration.ts COMMAND_PROCESSOR_TIMEOUT_SECONDS
    expect(APPROVAL_LEASE_SECONDS).toBeGreaterThan(30);
  });

  test('is released only by the holder of that lease', async () => {
    await releaseApprovalLease(ddb, 'Sessions', 's', 1000, null);
    expect(lastInput().ConditionExpression).toBe('#state = :approving AND approving_since = :since');
    expect(lastInput().ExpressionAttributeValues[':since']).toBe(1000);
    expect(lastInput().UpdateExpression).toBe('SET #state = :drafted REMOVE approving_since, confirm_digest');
  });

  test('release can record a pending confirmation digest', async () => {
    await releaseApprovalLease(ddb, 'Sessions', 's', 1000, 'digest-1');
    expect(lastInput().UpdateExpression).toBe('SET #state = :drafted, confirm_digest = :digest REMOVE approving_since');
    expect(lastInput().ExpressionAttributeValues[':digest']).toBe('digest-1');
  });

  test('a release after a takeover is a no-op', async () => {
    send.mockRejectedValueOnce(conditionFailed);
    await expect(releaseApprovalLease(ddb, 'Sessions', 's', 1000, null)).resolves.toBeUndefined();
  });

  test('release without a digest leaves the recorded one alone (#82 PR 3c)', async () => {
    await releaseApprovalLease(ddb, 'Sessions', 's', 1000);
    expect(lastInput().UpdateExpression).toBe('SET #state = :drafted REMOVE approving_since');
    expect(lastInput().ExpressionAttributeValues[':digest']).toBeUndefined();
  });
});

describe('completePrdApproval (#82 PR 3c)', () => {
  test('moves the lease holder to approved and records the design task', async () => {
    expect(await completePrdApproval(ddb, 'Sessions', 's', 1000, 'task-design')).toBe(true);
    expect(lastInput().ConditionExpression).toBe('#state = :approving AND approving_since = :since');
    expect(lastInput().UpdateExpression).toBe('SET #state = :approved, design_task_id = :task REMOVE approving_since, confirm_digest');
    expect(lastInput().ExpressionAttributeValues).toMatchObject({ ':approved': 'approved', ':since': 1000, ':task': 'task-design' });
  });

  test('returns false after a takeover, and rethrows anything else', async () => {
    send.mockRejectedValueOnce(conditionFailed);
    expect(await completePrdApproval(ddb, 'Sessions', 's', 1000, 't')).toBe(false);
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(completePrdApproval(ddb, 'Sessions', 's', 1000, 't')).rejects.toThrow('throttled');
  });
});

describe('cancelPlanningSession', () => {
  test('only from drafted or an expired lease', async () => {
    expect(await cancelPlanningSession(ddb, 'Sessions', 's', 1000)).toBe(true);
    expect(lastInput().ConditionExpression).toBe(
      'expires_at > :now AND (#state = :drafted OR (#state = :approving AND approving_since < :stale))',
    );
    send.mockRejectedValueOnce(conditionFailed);
    expect(await cancelPlanningSession(ddb, 'Sessions', 's', 1000)).toBe(false);
  });
});

describe('filing checkpoints (#82 PR 3b-2)', () => {
  const LEASE = '#state = :approving AND approving_since = :since';

  test('every checkpoint write needs the lease taken at `since`', async () => {
    await beginFiling(ddb, 'T', 'sid', 500, { planDigest: 'd', pageVersion: 4, approvedAt: '2027-01-01T00:00:00.000Z' });
    await markFilingInflight(ddb, 'T', 'sid', 500, 'S2', 510);
    await clearFilingInflight(ddb, 'T', 'sid', 500);
    await recordFiledIssue(ddb, 'T', 'sid', 500, 'parent', { key: 'SHOP-1', id: '1' });
    await recordFiledIssue(ddb, 'T', 'sid', 500, 'S2', { key: 'SHOP-3', id: '3' });
    await recordFiledLink(ddb, 'T', 'sid', 500, 'S1>S2');
    await recordBuildStarted(ddb, 'T', 'sid', 500);
    await completeFiling(ddb, 'T', 'sid', 500);
    for (const [command] of send.mock.calls) {
      expect(command.input.ConditionExpression).toContain(LEASE);
      expect(command.input.ExpressionAttributeValues).toMatchObject({ ':approving': 'approving', ':since': 500 });
    }
  });

  test('filing is frozen once: the digest, the page version and the approval time', async () => {
    await beginFiling(ddb, 'T', 'sid', 500, { planDigest: 'd', pageVersion: 4, approvedAt: '2027-01-01T00:00:00.000Z' });
    const input = lastInput();
    expect(input.ConditionExpression).toBe(`${LEASE} AND attribute_not_exists(filing_plan_digest)`);
    expect(input.UpdateExpression).toContain('filing_plan_digest = :digest');
    expect(input.UpdateExpression).toContain('filing_page_version = :version');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':digest': 'd', ':version': 4, ':at': '2027-01-01T00:00:00.000Z', ':empty': {} });
  });

  test('a filed issue clears the in-flight marker in the same write', async () => {
    await recordFiledIssue(ddb, 'T', 'sid', 500, 'S2', { key: 'SHOP-3', id: '3' });
    const input = lastInput();
    expect(input.UpdateExpression).toBe('SET filing_children.#story = :issue REMOVE filing_inflight');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#story': 'S2' });
    expect(input.ExpressionAttributeValues[':issue']).toEqual({ key: 'SHOP-3', id: '3' });
    await markFilingInflight(ddb, 'T', 'sid', 500, 'S1>S2', 510);
    expect(lastInput().ExpressionAttributeValues[':inflight']).toEqual({ step: 'S1>S2', since: 510 });
  });

  test('a lost lease is reported, not thrown', async () => {
    send.mockRejectedValueOnce(conditionFailed);
    expect(await recordFiledLink(ddb, 'T', 'sid', 500, 'S1>S2')).toBe(false);
  });

  test('a completed filing ends the session as filed', async () => {
    await completeFiling(ddb, 'T', 'sid', 500);
    expect(lastInput().UpdateExpression).toBe('SET #state = :filed REMOVE approving_since, filing_inflight');
    expect(lastInput().ExpressionAttributeValues[':filed']).toBe('filed');
  });
});
