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
import type { PlanPageReadResult } from '../../../src/handlers/shared/confluence-prd';
import {
  CHECK_PASSED_TEXT,
  handlePlanAction,
  ONLY_REQUESTER_TEXT,
  type PlanActionDeps,
  type PlanActionEvent,
} from '../../../src/handlers/shared/plan-approve';
import { APPROVAL_LEASE_SECONDS, type PlanningSession } from '../../../src/handlers/shared/planning-session';
import type { SlackMessage } from '../../../src/handlers/shared/slack-blocks';

const SID = 'abcdefghijklmnopqrstuvwxyz';
const NOW = 1_800_000_000;

/**
 * An in-memory planning-session table that applies the conditions each
 * planning-session update states (planning-session.test.ts pins the
 * expressions themselves).
 */
class FakeTable {
  readonly rows = new Map<string, Record<string, unknown>>();

  readonly client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const { input } = command;
      const name = command.constructor.name;
      if (name === 'GetCommand') {
        const row = this.rows.get(input.Key.session_id);
        return { Item: row ? { ...row } : undefined };
      }
      if (name === 'UpdateCommand') return this.update(input);
      throw new Error(`unexpected ${name}`);
    },
  } as unknown as DynamoDBDocumentClient;

  private update(input: Record<string, any>): Record<string, never> {
    const row = this.rows.get(input.Key.session_id);
    const v = input.ExpressionAttributeValues as Record<string, any>;
    const expr = input.UpdateExpression as string;
    const fail = (): never => {
      throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
    };
    if (!row) return fail();
    const live = (row.expires_at as number) > v[':now'];
    const staleLease = row.state === 'approving' && (row.approving_since as number) < v[':stale'];
    if (expr.startsWith('SET #state = :approving')) {
      if (!live || !(row.state === 'drafted' || staleLease)) return fail();
      Object.assign(row, { state: 'approving', approving_since: v[':now'] });
    } else if (expr.startsWith('SET #state = :drafted')) {
      if (row.state !== 'approving' || row.approving_since !== v[':since']) return fail();
      row.state = 'drafted';
      delete row.approving_since;
      if (':digest' in v) row.confirm_digest = v[':digest'];
      else delete row.confirm_digest;
    } else if (expr.startsWith('SET #state = :cancelled')) {
      if (!live || !(row.state === 'drafted' || staleLease)) return fail();
      row.state = 'cancelled';
      delete row.confirm_digest;
      delete row.approving_since;
    } else {
      throw new Error(`unexpected update ${expr}`);
    }
    return {};
  }
}

function session(overrides: Partial<PlanningSession> = {}): PlanningSession {
  return {
    session_id: SID,
    task_id: 'task-1',
    repo: 'karlbaria/factory-shop',
    page_id: '1015867',
    slack_team_id: 'T1',
    slack_user_id: 'UPM',
    platform_user_id: 'user-pm',
    slack_channel_id: 'C1',
    slack_thread_ts: '111.1',
    slack_message_ts: '222.2',
    state: 'drafted',
    created_at: '2026-11-24T00:00:00.000Z',
    expires_at: NOW + 3600,
    ...overrides,
  };
}

function story(n: number, blockedBy = 'none', title = `Story ${n}`): string {
  return `<h3>S${n}: ${title}</h3><p>Blocked by: ${blockedBy}</p><p>Do it.</p>`
    + `<p><strong>Acceptance criteria</strong></p><ul><li>Works ${n}</li></ul>`;
}

function page(...stories: string[]): Extract<PlanPageReadResult, { ok: true }> {
  return {
    ok: true,
    title: 'Plan: Wishlist · ABC123',
    version: 3,
    storage: `<h2>Stories</h2>${stories.join('')}<h2>Open questions</h2><p>None.</p>`,
  };
}

const LARGE = Array.from({ length: 6 }, (_, i) => story(i + 1));

interface Harness {
  readonly table: FakeTable;
  deps: PlanActionDeps;
  readonly posts: SlackMessage[];
  readonly ephemerals: string[];
  readonly readPlanPage: jest.Mock;
  now: number;
}

function harness(pages: PlanPageReadResult[] | PlanPageReadResult, row = session()): Harness {
  const table = new FakeTable();
  table.rows.set(row.session_id, { ...row });
  const queue = Array.isArray(pages) ? [...pages] : null;
  const readPlanPage = jest.fn(async () => (queue ? queue.shift()! : pages as PlanPageReadResult));
  const h: Harness = {
    table,
    posts: [],
    ephemerals: [],
    readPlanPage,
    now: NOW,
    deps: undefined as unknown as PlanActionDeps,
  };
  h.deps = {
    ddb: table.client,
    tableName: 'Sessions',
    now: () => new Date(h.now * 1000),
    lookupPlatformUser: async (team, user) => (team === 'T1' && user === 'UPM' ? 'user-pm' : null),
    lookupRepoConfig: async () => ({ confluence_cloud_id: 'cloud-1', confluence_space_key: 'SD' }),
    readPlanPage,
    postInThread: async (_s, message) => {
      h.posts.push(message);
    },
    replyEphemeral: async (_url, text) => {
      h.ephemerals.push(text);
    },
  };
  return h;
}

function click(action: PlanActionEvent['action'], user = 'UPM', team = 'T1'): PlanActionEvent {
  return { source: 'plan_action', action, session_id: SID, team_id: team, user_id: user, response_url: 'https://hooks.slack.com/r' };
}

function postedText(h: Harness): string {
  return h.posts.map((p) => p.blocks.map((b) => ('text' in b ? b.text.text : '')).join('\n')).join('\n---\n');
}

function rowOf(h: Harness): Record<string, unknown> {
  return h.table.rows.get(SID)!;
}

describe('only the requester can act', () => {
  test.each(['approve', 'confirm', 'cancel'] as const)('%s by someone else gets the ephemeral and changes nothing', async (action) => {
    const h = harness(page(story(1)));
    await handlePlanAction(click(action, 'UOTHER'), h.deps);
    expect(h.ephemerals).toEqual([ONLY_REQUESTER_TEXT]);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(h.posts).toEqual([]);
    expect(rowOf(h).state).toBe('drafted');
  });

  test('the same user id in another workspace is someone else', async () => {
    const h = harness(page(story(1)));
    await handlePlanAction(click('approve', 'UPM', 'T2'), h.deps);
    expect(h.ephemerals).toEqual([ONLY_REQUESTER_TEXT]);
  });

  test('a requester now linked to another platform user cannot act', async () => {
    const h = harness(page(story(1)));
    h.deps = { ...h.deps, lookupPlatformUser: async () => 'someone-else' };
    await handlePlanAction(click('approve'), h.deps);
    expect(h.ephemerals[0]).toContain('no longer linked');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });

  test('an expired session says so', async () => {
    const h = harness(page(story(1)), session({ expires_at: NOW - 1 }));
    await handlePlanAction(click('approve'), h.deps);
    expect(h.ephemerals[0]).toContain('expired');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });
});

describe('Approve re-reads and checks the page', () => {
  test('a ready plan passes, files nothing, and goes back to drafted', async () => {
    const h = harness(page(story(1), story(2, 'S1')));
    await handlePlanAction(click('approve'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledWith('1015867', { confluence_cloud_id: 'cloud-1', confluence_space_key: 'SD' });
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(postedText(h)).toContain('2 stories and nothing has been filed');
    expect(rowOf(h)).toMatchObject({ state: 'drafted' });
    expect(rowOf(h).approving_since).toBeUndefined();
  });

  test('the PM\'s edit is what gets checked: a story they broke is reported', async () => {
    const edited = page(story(1), story(2, 'S7'));
    const h = harness(edited);
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain('isn\'t ready to file yet');
    expect(postedText(h)).toContain('"S7"');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });

  test('every problem is listed, and page text is escaped for Slack', async () => {
    const h = harness(page('<h3>S1: &lt;!channel&gt; now</h3><p>Blocked by: none</p>', story(2, 'S2')));
    await handlePlanAction(click('approve'), h.deps);
    const text = postedText(h);
    expect(text).toContain('&lt;!channel&gt; now');
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('no acceptance criteria');
    expect(text).toContain('blocked by itself');
    expect(rowOf(h).state).toBe('drafted');
  });

  test('a page that can\'t be read is reported in the thread', async () => {
    const h = harness({ ok: false, reason: 'not_a_plan', message: 'That page no longer has the factory\'s plan labels.' });
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain('plan labels');
    expect(rowOf(h).state).toBe('drafted');
  });

  test('an oversized page is rejected, not truncated', async () => {
    const huge = page(story(1));
    const h = harness({ ...huge, storage: `${huge.storage}<p>${'x'.repeat(60_001)}</p>` } as PlanPageReadResult);
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain('longer than 60,000 characters');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });

  test('a failure while checking gives the lease back and tells the PM', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockRejectedValueOnce(new Error('boom'));
    await handlePlanAction(click('approve'), h.deps);
    expect(h.ephemerals[0]).toContain('Something went wrong');
    expect(rowOf(h)).toMatchObject({ state: 'drafted' });
    expect(rowOf(h).approving_since).toBeUndefined();
  });
});

describe('the approval lease', () => {
  test('a second click while a check is running is told to wait and reads nothing', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockImplementationOnce(async () => {
      await handlePlanAction(click('approve'), h.deps);
      return page(story(1));
    });
    await handlePlanAction(click('approve'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledTimes(1);
    expect(h.ephemerals).toEqual([expect.stringContaining('already checking')]);
    expect(h.posts.filter((p) => postedText({ ...h, posts: [p] }).includes(CHECK_PASSED_TEXT))).toHaveLength(1);
  });

  test('Cancel is refused while a check holds the lease', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - 1 }));
    await handlePlanAction(click('cancel'), h.deps);
    expect(rowOf(h).state).toBe('approving');
    expect(h.ephemerals[0]).toContain('already checking');
  });

  test('a lease left by a crashed invocation is taken over once it expires', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - APPROVAL_LEASE_SECONDS - 1 }));
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h).state).toBe('drafted');
  });

  test('an unexpired lease is not taken over', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - APPROVAL_LEASE_SECONDS + 5 }));
    await handlePlanAction(click('approve'), h.deps);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(rowOf(h).state).toBe('approving');
  });

  test('a stale holder finishing late does not overwrite the new holder', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockImplementationOnce(async () => {
      // While this check is slow, its lease expires and a second click takes over.
      h.now = NOW + APPROVAL_LEASE_SECONDS + 1;
      h.table.rows.get(SID)!.approving_since = NOW - APPROVAL_LEASE_SECONDS - 1;
      return page(...LARGE);
    });
    await handlePlanAction(click('approve'), h.deps);
    // The first holder's release didn't match the lease it took, so it changed nothing.
    expect(rowOf(h).state).toBe('approving');
  });
});

describe('the large-plan confirmation (decision 11)', () => {
  test('5 stories pass without a confirmation', async () => {
    const h = harness(page(...LARGE.slice(0, 5)));
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(postedText(h)).not.toContain('large plan');
  });

  test('6 stories ask first, with the count and cost, and pass nothing yet', async () => {
    const h = harness(page(...LARGE));
    await handlePlanAction(click('approve'), h.deps);
    const text = postedText(h);
    expect(text).toContain('6 stories, about $3.00');
    expect(text).not.toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h)).toMatchObject({ state: 'drafted', confirm_digest: expect.any(String) });
    const actions = h.posts[0].blocks.find((b) => b.type === 'actions');
    expect(actions && 'elements' in actions && actions.elements.map((e) => ('action_id' in e ? e.action_id : ''))).toEqual([
      `plan_confirm:${SID}`,
      `plan_cancel:${SID}`,
    ]);
  });

  test('Confirm on the unchanged plan passes and clears the pending digest', async () => {
    const h = harness([page(...LARGE), page(...LARGE)]);
    await handlePlanAction(click('approve'), h.deps);
    await handlePlanAction(click('confirm'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h).confirm_digest).toBeUndefined();
  });

  test('Confirm after a story was edited asks again with the new numbers', async () => {
    const edited = [...LARGE, story(7)];
    const h = harness([page(...LARGE), page(...edited)]);
    await handlePlanAction(click('approve'), h.deps);
    const firstDigest = rowOf(h).confirm_digest;
    h.posts.length = 0;
    await handlePlanAction(click('confirm'), h.deps);
    const text = postedText(h);
    expect(text).toContain('stories changed');
    expect(text).toContain('7 stories, about $3.50');
    expect(text).not.toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h).confirm_digest).not.toEqual(firstDigest);
  });

  test('Confirm with no pending confirmation asks first', async () => {
    const h = harness(page(...LARGE));
    await handlePlanAction(click('confirm'), h.deps);
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
    expect(postedText(h)).toContain('large plan');
  });

  test('a check that fails after a confirmation was asked clears it', async () => {
    const h = harness([page(...LARGE), page(...LARGE.slice(0, 5), story(6, 'S9'))]);
    await handlePlanAction(click('approve'), h.deps);
    await handlePlanAction(click('confirm'), h.deps);
    expect(rowOf(h).confirm_digest).toBeUndefined();
  });
});

describe('Cancel', () => {
  test('cancels, posts in the thread, and never reads the page', async () => {
    const h = harness(page(story(1)));
    await handlePlanAction(click('cancel'), h.deps);
    expect(rowOf(h).state).toBe('cancelled');
    expect(postedText(h)).toContain('Nothing was filed, and the Confluence page is unchanged');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });

  test('a cancelled plan can\'t be approved or cancelled again', async () => {
    const h = harness(page(story(1)), session({ state: 'cancelled' }));
    await handlePlanAction(click('approve'), h.deps);
    await handlePlanAction(click('cancel'), h.deps);
    expect(h.ephemerals).toEqual([expect.stringContaining('cancelled'), expect.stringContaining('cancelled')]);
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });
});
