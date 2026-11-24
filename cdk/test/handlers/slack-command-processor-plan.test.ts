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

jest.mock('../../src/handlers/shared/create-task-core', () => ({ createTaskCore: jest.fn() }));

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
