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

// Task 15 (fork), #82 PR 3b-1: the command processor's wiring of plan button
// clicks. The Approve/Cancel logic itself is tested in plan-approve.test.ts.

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

// #82 PR 3c: Approve PRD's design start reads the PRD the plan-from-PRD way.
const readPrdPageByIdMock = jest.fn();
const readPlanPageMock = jest.fn();
const markPageFinalMock = jest.fn();
jest.mock('../../src/handlers/shared/confluence-prd', () => ({
  ...jest.requireActual('../../src/handlers/shared/confluence-prd'),
  readPrdPageById: (...args: unknown[]) => readPrdPageByIdMock(...args),
}));
jest.mock('../../src/handlers/shared/confluence-page', () => ({
  ...jest.requireActual('../../src/handlers/shared/confluence-page'),
  readPlanPage: (...args: unknown[]) => readPlanPageMock(...args),
  markPageFinal: (...args: unknown[]) => markPageFinalMock(...args),
}));

const handlePlanActionMock = jest.fn();
jest.mock('../../src/handlers/shared/plan-approve', () => ({
  handlePlanAction: (...args: unknown[]) => handlePlanActionMock(...args),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.PLANNING_SESSION_TABLE_NAME = 'Sessions';

import type { PlanActionDeps, PlanActionEvent } from '../../src/handlers/shared/plan-approve';
import type { PlanningSession } from '../../src/handlers/shared/planning-session';
import { handler } from '../../src/handlers/slack-command-processor';

const EVENT: PlanActionEvent = {
  source: 'plan_action',
  action: 'approve',
  session_id: 'abcdefghijklmnopqrstuvwxyz',
  team_id: 'T1',
  user_id: 'UPM',
  response_url: 'https://hooks.slack.com/r',
};

function session(overrides: Partial<PlanningSession> = {}): PlanningSession {
  return {
    session_id: EVENT.session_id,
    task_id: 't',
    repo: 'o/r',
    page_id: '9',
    slack_team_id: 'T1',
    slack_user_id: 'UPM',
    platform_user_id: 'p',
    slack_channel_id: 'C1',
    slack_thread_ts: '111.1',
    slack_message_ts: '222.2',
    state: 'drafted',
    created_at: '',
    expires_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  handlePlanActionMock.mockReset().mockResolvedValue(undefined);
  createTaskCoreMock.mockReset();
  readPrdPageByIdMock.mockReset();
  readPlanPageMock.mockReset();
  markPageFinalMock.mockReset();
  // The installation row the bot-token lookup reads.
  ddbSend.mockReset().mockResolvedValue({ Item: { status: 'active' } });
  smSend.mockReset().mockResolvedValue({ SecretString: 'xoxb-test' });
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
});

function deps(): PlanActionDeps {
  return handlePlanActionMock.mock.calls[0][1] as PlanActionDeps;
}

function postedBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('chat.postMessage'));
  return JSON.parse(call![1].body);
}

test('a plan_action event goes to the plan handler with the planning table, not to the command parser', async () => {
  await handler(EVENT);
  expect(handlePlanActionMock).toHaveBeenCalledWith(EVENT, expect.objectContaining({ tableName: 'Sessions' }));
});

test('posts in the plan\'s thread', async () => {
  await handler(EVENT);
  await deps().postInThread(session(), { text: 'hi', blocks: [] });
  expect(postedBody()).toMatchObject({ channel: 'C1', thread_ts: '111.1', text: 'hi', unfurl_links: false });
});

test('falls back to the plan message when the plan had no thread, and a DM goes to the user', async () => {
  await handler(EVENT);
  await deps().postInThread(session({ slack_thread_ts: undefined, slack_channel_id: 'D1' }), { text: 'hi', blocks: [] });
  expect(postedBody()).toMatchObject({ channel: 'UPM', thread_ts: '222.2' });
});

// ─── #82 PR 3c ───────────────────────────────────────────────────────────────

const MAPPING = { confluence_cloud_id: 'cloud-1', confluence_space_key: 'SD' };
const PRD = {
  ok: true as const,
  pageUrl: 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/9',
  title: 'PRD: Wishlist · ABC123',
  text: 'Customers lose items.',
  truncated: false,
};

test('the page reader gets the document kind', async () => {
  await handler(EVENT);
  readPlanPageMock.mockResolvedValueOnce({ ok: false, reason: 'unreadable', message: 'x' });
  await deps().readPlanPage('9', MAPPING, 'prd');
  expect(readPlanPageMock).toHaveBeenCalledWith('9', MAPPING, { kind: 'prd' });
});

test('Approve PRD starts the design through the plan-from-PRD path, as the requester, in the PRD\'s thread', async () => {
  await handler(EVENT);
  readPrdPageByIdMock.mockResolvedValueOnce(PRD);
  createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'task-design' } }) });

  const result = await deps().startDesignFromPrd(session({ kind: 'prd', repo: 'karlbaria/factory-shop' }), MAPPING);

  expect(result).toEqual({ ok: true, taskId: 'task-design' });
  expect(readPrdPageByIdMock).toHaveBeenCalledWith('9', MAPPING);
  const [body, context] = createTaskCoreMock.mock.calls[0];
  expect(body).toMatchObject({ repo: 'karlbaria/factory-shop', workflow_ref: 'knowledge/feature-planning-v1' });
  expect(body.task_description).toContain(`PRD page ${PRD.pageUrl}`);
  expect(body.task_description).toMatch(/<<<BEGIN_PRD_PAGE>>>\nTitle: PRD: Wishlist · ABC123\n\nCustomers lose items\.\n<<<END_PRD_PAGE>>>$/);
  expect(context).toEqual({
    userId: 'p',
    channelSource: 'slack',
    channelMetadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_user_id: 'UPM', slack_thread_ts: '111.1' },
  });
});

test('a PRD the reader rejects (guardrail, space) creates no task', async () => {
  await handler(EVENT);
  readPrdPageByIdMock.mockResolvedValueOnce({ ok: false, reason: 'blocked', message: 'That PRD page was blocked by content policy, so I didn\'t use it.' });
  const result = await deps().startDesignFromPrd(session({ kind: 'prd' }), MAPPING);
  expect(result).toEqual({ ok: false, message: 'That PRD page was blocked by content policy, so I didn\'t use it.' });
  expect(createTaskCoreMock).not.toHaveBeenCalled();
});

test('a design task the core refuses is reported with its message', async () => {
  await handler(EVENT);
  readPrdPageByIdMock.mockResolvedValueOnce(PRD);
  createTaskCoreMock.mockResolvedValueOnce({ statusCode: 400, body: JSON.stringify({ error: { message: 'Task description was blocked by content policy' } }) });
  const result = await deps().startDesignFromPrd(session({ kind: 'prd' }), MAPPING);
  expect(result).toEqual({ ok: false, message: 'Task description was blocked by content policy' });
});

test('marking the PRD final goes to the Confluence helper', async () => {
  await handler(EVENT);
  markPageFinalMock.mockResolvedValueOnce(true);
  expect(await deps().markPageFinal('9', MAPPING)).toBe(true);
  expect(markPageFinalMock).toHaveBeenCalledWith('9', MAPPING);
});
