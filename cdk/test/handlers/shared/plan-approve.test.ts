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
import type { PlanPageReadResult } from '../../../src/handlers/shared/confluence-page';
import {
  CHECK_PASSED_TEXT,
  handlePlanAction,
  ONLY_REQUESTER_TEXT,
  PRD_APPROVED_TEXT,
  type PlanActionDeps,
  type PlanActionEvent,
  type StartDesignResult,
} from '../../../src/handlers/shared/plan-approve';
import { designNumbersDigest } from '../../../src/handlers/shared/plan-parse';
import { APPROVAL_LEASE_SECONDS, type PlanningSession } from '../../../src/handlers/shared/planning-session';
import type { SlackMessage } from '../../../src/handlers/shared/slack-blocks';

const SID = 'abcdefghijklmnopqrstuvwxyz';
const NOW = 1_800_000_000;
const MAPPING = { confluence_cloud_id: 'cloud-1', confluence_space_key: 'SD' };

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
    const holdsLease = row.state === 'approving' && row.approving_since === v[':since'];
    if (expr.startsWith('SET #state = :approving')) {
      if (!live || !(row.state === 'drafted' || staleLease)) return fail();
      Object.assign(row, { state: 'approving', approving_since: v[':now'] });
    } else if (expr.startsWith('SET #state = :drafted')) {
      if (!holdsLease) return fail();
      row.state = 'drafted';
      delete row.approving_since;
      if (':digest' in v) row.confirm_digest = v[':digest'];
      else if (expr.includes('confirm_digest')) delete row.confirm_digest;
    } else if (expr.startsWith('SET #state = :approved')) {
      if (!holdsLease) return fail();
      Object.assign(row, { state: 'approved', design_task_id: v[':task'] });
      delete row.approving_since;
      delete row.confirm_digest;
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

/** A design session whose message showed `postedStories` stories. */
function session(overrides: Partial<PlanningSession> = {}, postedStories: number | null = 1): PlanningSession {
  return {
    session_id: SID,
    task_id: 'task-1',
    repo: 'karlbaria/factory-shop',
    page_id: '1015867',
    kind: 'design',
    slack_team_id: 'T1',
    slack_user_id: 'UPM',
    platform_user_id: 'user-pm',
    slack_channel_id: 'C1',
    slack_thread_ts: '111.1',
    slack_message_ts: '222.2',
    state: 'drafted',
    created_at: '2026-11-24T00:00:00.000Z',
    expires_at: NOW + 3600,
    ...(postedStories !== null && { confirm_digest: designNumbersDigest(postedStories) }),
    ...overrides,
  };
}

function prdSession(overrides: Partial<PlanningSession> = {}): PlanningSession {
  return session({ kind: 'prd', page_id: '1048580', ...overrides }, null);
}

function story(n: number, blockedBy = 'none', title = `Story ${n}`): string {
  return `<h3>S${n}: ${title}</h3><p>Blocked by: ${blockedBy}</p><p>Do it.</p>`
    + `<p><strong>Acceptance criteria</strong></p><ul><li>Works ${n}</li></ul>`
    + `<p><strong>Technical notes</strong></p><ul><li>Change file ${n}</li></ul>`;
}

function page(...stories: string[]): Extract<PlanPageReadResult, { ok: true }> {
  return {
    ok: true,
    title: 'Technical design: Wishlist · ABC123',
    version: 3,
    storage: '<h2>Technical decisions</h2><h3>D1: Reuse the DB</h3><p>Reason: it exists.</p>'
      + `<h2>Stories</h2>${stories.join('')}<h2>Questions for the PM</h2><p>None.</p>`,
  };
}

function withQuestion(p: Extract<PlanPageReadResult, { ok: true }>, answer: string, section = 'Questions for the PM'): PlanPageReadResult {
  return {
    ...p,
    storage: p.storage.replace(
      '<h2>Questions for the PM</h2><p>None.</p>',
      `<h2>${section}</h2><h3>Q1: Can guests use it?</h3><p>Answer: ${answer}</p>`,
    ),
  };
}

function prdPage(answer = 'No, sign-in first.'): PlanPageReadResult {
  return {
    ok: true,
    title: 'PRD: Wishlist · ABC123',
    version: 2,
    storage: '<h2>Problem</h2><p>Lost items.</p><h2>Requirements</h2><ul><li>Save items</li></ul>'
      + `<h2>Product questions</h2><h3>Q1: Can guests save items?</h3><p>Answer: ${answer}</p>`,
  };
}

const SIX = Array.from({ length: 6 }, (_, i) => story(i + 1));

interface Harness {
  readonly table: FakeTable;
  deps: PlanActionDeps;
  readonly posts: SlackMessage[];
  readonly ephemerals: string[];
  readonly readPlanPage: jest.Mock;
  readonly startDesignFromPrd: jest.Mock;
  readonly markPageFinal: jest.Mock;
  now: number;
}

function harness(pages: PlanPageReadResult[] | PlanPageReadResult, row = session()): Harness {
  const table = new FakeTable();
  table.rows.set(row.session_id, { ...row });
  const queue = Array.isArray(pages) ? [...pages] : null;
  const readPlanPage = jest.fn(async () => (queue ? queue.shift()! : pages as PlanPageReadResult));
  const startDesignFromPrd = jest.fn(async (): Promise<StartDesignResult> => ({ ok: true, taskId: 'task-design' }));
  const markPageFinal = jest.fn(async () => true);
  const h: Harness = {
    table,
    posts: [],
    ephemerals: [],
    readPlanPage,
    startDesignFromPrd,
    markPageFinal,
    now: NOW,
    deps: undefined as unknown as PlanActionDeps,
  };
  h.deps = {
    ddb: table.client,
    tableName: 'Sessions',
    now: () => new Date(h.now * 1000),
    lookupPlatformUser: async (team, user) => (team === 'T1' && user === 'UPM' ? 'user-pm' : null),
    lookupRepoConfig: async () => MAPPING,
    readPlanPage,
    startDesignFromPrd,
    markPageFinal,
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

function textOf(posts: readonly SlackMessage[]): string {
  return posts.map((p) => p.blocks.map((b) => ('text' in b ? b.text.text : '')).join('\n')).join('\n---\n');
}

function postedText(h: Harness): string {
  return textOf(h.posts);
}

function actionIds(message: SlackMessage | undefined): string[] {
  const block = message?.blocks.find((b) => b.type === 'actions');
  return block && 'elements' in block ? block.elements.map((e) => ('action_id' in e ? e.action_id : '')) : [];
}

function rowOf(h: Harness): Record<string, unknown> {
  return h.table.rows.get(SID)!;
}

describe('only the requester can act', () => {
  test.each(['approve', 'start', 'confirm', 'cancel'] as const)('%s on a design by someone else gets the ephemeral and changes nothing', async (action) => {
    const h = harness(page(story(1)));
    await handlePlanAction(click(action, 'UOTHER'), h.deps);
    expect(h.ephemerals).toEqual([ONLY_REQUESTER_TEXT]);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(h.posts).toEqual([]);
    expect(rowOf(h).state).toBe('drafted');
  });

  test.each(['approve', 'cancel'] as const)('%s on a PRD by someone else gets the ephemeral and starts nothing', async (action) => {
    const h = harness(prdPage(), prdSession());
    await handlePlanAction(click(action, 'UOTHER'), h.deps);
    expect(h.ephemerals).toEqual([ONLY_REQUESTER_TEXT]);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(h.startDesignFromPrd).not.toHaveBeenCalled();
    expect(rowOf(h).state).toBe('drafted');
  });

  test('the same user id in another workspace is someone else', async () => {
    const h = harness(page(story(1)));
    await handlePlanAction(click('start', 'UPM', 'T2'), h.deps);
    expect(h.ephemerals).toEqual([ONLY_REQUESTER_TEXT]);
  });

  test('a requester now linked to another platform user cannot act', async () => {
    const h = harness(page(story(1)));
    h.deps = { ...h.deps, lookupPlatformUser: async () => 'someone-else' };
    await handlePlanAction(click('start'), h.deps);
    expect(h.ephemerals[0]).toContain('no longer linked');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });

  test('an expired session says so', async () => {
    const h = harness(page(story(1)), session({ expires_at: NOW - 1 }));
    await handlePlanAction(click('start'), h.deps);
    expect(h.ephemerals[0]).toContain('expired');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });
});

describe('Approve PRD (#82 PR 3c)', () => {
  test('blocks on an unanswered product question, lists it, and starts nothing', async () => {
    const h = harness(prdPage(''), prdSession());
    await handlePlanAction(click('approve'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledWith('1048580', MAPPING, 'prd');
    const text = postedText(h);
    expect(text).toContain('The PRD isn\'t ready to approve yet.');
    expect(text).toContain('Q1 (Can guests save items?) has no answer');
    expect(text).toContain('click Approve PRD again');
    expect(h.startDesignFromPrd).not.toHaveBeenCalled();
    expect(h.markPageFinal).not.toHaveBeenCalled();
    expect(rowOf(h)).toMatchObject({ state: 'drafted' });
  });

  test('with every question answered, starts the design, posts in the thread and marks the PRD final', async () => {
    const h = harness(prdPage(), prdSession());
    await handlePlanAction(click('approve'), h.deps);
    expect(h.startDesignFromPrd).toHaveBeenCalledTimes(1);
    expect(h.startDesignFromPrd.mock.calls[0]).toEqual([expect.objectContaining({ session_id: SID, page_id: '1048580' }), MAPPING]);
    expect(postedText(h)).toContain(PRD_APPROVED_TEXT);
    expect(h.markPageFinal).toHaveBeenCalledWith('1048580', MAPPING);
    // Marked final only once the design task exists.
    expect(h.startDesignFromPrd.mock.invocationCallOrder[0]).toBeLessThan(h.markPageFinal.mock.invocationCallOrder[0]);
    expect(rowOf(h)).toMatchObject({ state: 'approved', design_task_id: 'task-design' });
    expect(rowOf(h).approving_since).toBeUndefined();
  });

  test('an approved PRD can\'t be approved again', async () => {
    const h = harness(prdPage(), prdSession());
    await handlePlanAction(click('approve'), h.deps);
    await handlePlanAction(click('approve'), h.deps);
    expect(h.startDesignFromPrd).toHaveBeenCalledTimes(1);
    expect(h.ephemerals).toEqual([expect.stringContaining('already been approved')]);
  });

  test('a page no longer labelled factory-prd or outside the space is reported, and nothing starts', async () => {
    const h = harness({ ok: false, reason: 'not_a_plan', message: 'That page no longer has the factory\'s PRD labels.' }, prdSession());
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain('PRD labels');
    expect(h.startDesignFromPrd).not.toHaveBeenCalled();
    expect(rowOf(h).state).toBe('drafted');
  });

  test('a design that can\'t be started (guardrail, screening) is reported and the PRD stays draft', async () => {
    const h = harness(prdPage(), prdSession());
    h.startDesignFromPrd.mockResolvedValueOnce({ ok: false, message: 'That PRD page was blocked by content policy, so I didn\'t use it.' });
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain('couldn\'t start the technical design');
    expect(postedText(h)).toContain('blocked by content policy');
    expect(postedText(h)).not.toContain(PRD_APPROVED_TEXT);
    expect(h.markPageFinal).not.toHaveBeenCalled();
    expect(rowOf(h).state).toBe('drafted');
  });

  test('a failed mark-final is reported, after the design has started', async () => {
    const h = harness(prdPage(), prdSession());
    h.markPageFinal.mockResolvedValueOnce(false);
    await handlePlanAction(click('approve'), h.deps);
    expect(postedText(h)).toContain(PRD_APPROVED_TEXT);
    expect(postedText(h)).toContain('couldn\'t mark the PRD page final');
    expect(rowOf(h).state).toBe('approved');
  });

  test('Start or Confirm on a PRD session does nothing', async () => {
    const h = harness(prdPage(), prdSession());
    await handlePlanAction(click('start'), h.deps);
    await handlePlanAction(click('confirm'), h.deps);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(h.posts).toEqual([]);
    expect(rowOf(h).state).toBe('drafted');
  });

  test('Cancel on a PRD cancels it and says no design will be written', async () => {
    const h = harness(prdPage(), prdSession());
    await handlePlanAction(click('cancel'), h.deps);
    expect(rowOf(h).state).toBe('cancelled');
    expect(postedText(h)).toContain('No technical design will be written');
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });
});

describe('Start re-reads and checks the design', () => {
  test('a ready design with the numbers the message showed passes, files nothing, and goes back to drafted', async () => {
    const h = harness(page(story(1), story(2, 'S1')), session({}, 2));
    await handlePlanAction(click('start'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledWith('1015867', MAPPING, 'design');
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(postedText(h)).toContain('2 stories and nothing has been filed');
    expect(rowOf(h)).toMatchObject({ state: 'drafted', confirm_digest: designNumbersDigest(2) });
    expect(rowOf(h).approving_since).toBeUndefined();
  });

  test('a design of more than 5 stories passes on the first Start: the message was the confirmation', async () => {
    const h = harness(page(...SIX), session({}, 6));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(postedText(h)).toContain('6 stories');
  });

  test('an edit that leaves the numbers alone still passes', async () => {
    const h = harness(page(story(1, 'none', 'Renamed by an engineer')), session({}, 1));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
  });

  test('blocks on an unanswered question for the PM', async () => {
    const h = harness(withQuestion(page(story(1)), ''), session({}, 1));
    await handlePlanAction(click('start'), h.deps);
    const text = postedText(h);
    expect(text).toContain('The technical design isn\'t ready to start yet.');
    expect(text).toContain('Q1 (Can guests use it?) has no answer');
    expect(text).not.toContain(CHECK_PASSED_TEXT);
    // A failed check keeps the numbers the PM was last asked about.
    expect(rowOf(h)).toMatchObject({ state: 'drafted', confirm_digest: designNumbersDigest(1) });
  });

  test('an answered question for the PM passes', async () => {
    const h = harness(withQuestion(page(story(1)), 'Yes.'), session({}, 1));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
  });

  test('a design made before #82 PR 3c: "Open questions" still blocks, as an alias', async () => {
    const legacy = withQuestion(page(story(1)), '', 'Open questions');
    const h = harness(legacy, session({}, 1));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('Q1 (Can guests use it?) has no answer');
  });

  test('a pre-3c session (no kind) with its old Approve button is checked as a design', async () => {
    const h = harness(page(story(1)), session({ kind: undefined }, 1));
    await handlePlanAction(click('approve'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledWith('1015867', MAPPING, 'design');
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
  });

  test('an engineer\'s edit is what gets checked: a story they broke is reported', async () => {
    const h = harness(page(story(1), story(2, 'S7')), session({}, 2));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('"S7"');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });

  test('every problem is listed, and page text is escaped for Slack', async () => {
    const h = harness(page('<h3>S1: &lt;!channel&gt; now</h3><p>Blocked by: none</p>', story(2, 'S2')), session({}, 2));
    await handlePlanAction(click('start'), h.deps);
    const text = postedText(h);
    expect(text).toContain('&lt;!channel&gt; now');
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('no acceptance criteria');
    expect(text).toContain('blocked by itself');
  });

  test('more than 15 stories is still refused', async () => {
    const many = Array.from({ length: 16 }, (_, i) => story(i + 1));
    const h = harness(page(...many), session({}, 16));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('the most I can file is 15');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });

  test('a page that can\'t be read is reported in the thread', async () => {
    const h = harness({ ok: false, reason: 'not_a_plan', message: 'That page no longer has the factory\'s technical design labels.' });
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('technical design labels');
    expect(rowOf(h).state).toBe('drafted');
  });

  test('an oversized page is rejected, not truncated', async () => {
    const huge = page(story(1));
    const h = harness({ ...huge, storage: `${huge.storage}<p>${'x'.repeat(60_001)}</p>` } as PlanPageReadResult);
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('longer than 60,000 characters');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });

  test('a failure while checking gives the lease back and tells the PM', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockRejectedValueOnce(new Error('boom'));
    await handlePlanAction(click('start'), h.deps);
    expect(h.ephemerals[0]).toContain('Something went wrong');
    expect(rowOf(h)).toMatchObject({ state: 'drafted' });
    expect(rowOf(h).approving_since).toBeUndefined();
  });
});

describe('Start asks again when the numbers changed (decision 20)', () => {
  test('a story added since the message: the new count and cost, with Start and Cancel, and nothing passes', async () => {
    const h = harness(page(...SIX), session({}, 5));
    await handlePlanAction(click('start'), h.deps);
    const text = postedText(h);
    expect(text).toContain('number of stories changed');
    expect(text).toContain('Technical design ready: 6 stories, about $3.00');
    expect(text).not.toContain(CHECK_PASSED_TEXT);
    expect(actionIds(h.posts[1])).toEqual([`plan_confirm:${SID}`, `plan_cancel:${SID}`]);
    expect(rowOf(h)).toMatchObject({ state: 'drafted', confirm_digest: designNumbersDigest(6) });
  });

  test('Start on the re-asked numbers passes', async () => {
    const h = harness([page(...SIX), page(...SIX)], session({}, 5));
    await handlePlanAction(click('start'), h.deps);
    h.posts.length = 0;
    await handlePlanAction(click('confirm'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
  });

  test('another change before the second click asks again', async () => {
    const h = harness([page(...SIX), page(...SIX, story(7))], session({}, 5));
    await handlePlanAction(click('start'), h.deps);
    h.posts.length = 0;
    await handlePlanAction(click('confirm'), h.deps);
    expect(postedText(h)).toContain('7 stories, about $3.50');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h).confirm_digest).toBe(designNumbersDigest(7));
  });

  test('a session whose message had no numbers (page unread at delivery) asks with them first', async () => {
    const h = harness(page(story(1)), session({}, null));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain('1 story, about $0.50');
    expect(postedText(h)).not.toContain(CHECK_PASSED_TEXT);
  });
});

describe('the approval lease', () => {
  test('a second click while a check is running is told to wait and reads nothing', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockImplementationOnce(async () => {
      await handlePlanAction(click('start'), h.deps);
      return page(story(1));
    });
    await handlePlanAction(click('start'), h.deps);
    expect(h.readPlanPage).toHaveBeenCalledTimes(1);
    expect(h.ephemerals).toEqual([expect.stringContaining('already checking')]);
    expect(h.posts.filter((p) => textOf([p]).includes(CHECK_PASSED_TEXT))).toHaveLength(1);
  });

  test('Cancel is refused while a check holds the lease', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - 1 }));
    await handlePlanAction(click('cancel'), h.deps);
    expect(rowOf(h).state).toBe('approving');
    expect(h.ephemerals[0]).toContain('already checking');
  });

  test('a lease left by a crashed invocation is taken over once it expires', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - APPROVAL_LEASE_SECONDS - 1 }));
    await handlePlanAction(click('start'), h.deps);
    expect(postedText(h)).toContain(CHECK_PASSED_TEXT);
    expect(rowOf(h).state).toBe('drafted');
  });

  test('an unexpired lease is not taken over', async () => {
    const h = harness(page(story(1)), session({ state: 'approving', approving_since: NOW - APPROVAL_LEASE_SECONDS + 5 }));
    await handlePlanAction(click('start'), h.deps);
    expect(h.readPlanPage).not.toHaveBeenCalled();
    expect(rowOf(h).state).toBe('approving');
  });

  test('a stale holder finishing late does not overwrite the new holder', async () => {
    const h = harness(page(story(1)));
    h.readPlanPage.mockImplementationOnce(async () => {
      // While this check is slow, its lease expires and a second click takes over.
      h.now = NOW + APPROVAL_LEASE_SECONDS + 1;
      h.table.rows.get(SID)!.approving_since = NOW - APPROVAL_LEASE_SECONDS - 1;
      return page(...SIX);
    });
    await handlePlanAction(click('start'), h.deps);
    // The first holder's release didn't match the lease it took, so it changed nothing.
    expect(rowOf(h).state).toBe('approving');
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

  test('a cancelled design can\'t be started or cancelled again', async () => {
    const h = harness(page(story(1)), session({ state: 'cancelled' }));
    await handlePlanAction(click('start'), h.deps);
    await handlePlanAction(click('cancel'), h.deps);
    expect(h.ephemerals).toEqual([expect.stringContaining('cancelled'), expect.stringContaining('cancelled')]);
    expect(h.readPlanPage).not.toHaveBeenCalled();
  });
});
