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

const mockStart = jest.fn();
jest.mock('../../../src/handlers/shared/jira-trigger-start', () => ({
  startJiraParentWork: (...args: unknown[]) => mockStart(...args),
}));
const mockScreen = jest.fn();
jest.mock('../../../src/handlers/shared/context-hydration', () => ({
  screenWithGuardrail: (...args: unknown[]) => mockScreen(...args),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { findJiraTarget, makeFileDesignDeps, screenStoryText } from '../../../src/handlers/shared/plan-start';
import type { PlanningSession } from '../../../src/handlers/shared/planning-session';

function scanning(items: Array<Record<string, unknown>>): DynamoDBDocumentClient {
  return { send: jest.fn(async () => ({ Items: items })) } as unknown as DynamoDBDocumentClient;
}

const SHOP = { cloud_id: 'cloud-1', project_key: 'SHOP', repo: 'karlbaria/factory-shop', status: 'active', label_filter: 'bgagent' };

describe('the Jira project Start files in', () => {
  test('is the repo\'s only active mapping, with its trigger label', async () => {
    const found = await findJiraTarget(scanning([SHOP]), 'Mappings', 'karlbaria/factory-shop');
    expect(found).toEqual({ ok: true, target: { cloudId: 'cloud-1', projectKey: 'SHOP', mapping: SHOP, labelFilter: 'bgagent' } });
  });

  test('defaults the trigger label like the webhook processor does', async () => {
    const found = await findJiraTarget(scanning([{ ...SHOP, label_filter: undefined }]), 'Mappings', 'karlbaria/factory-shop');
    expect(found).toMatchObject({ ok: true, target: { labelFilter: 'bgagent' } });
  });

  test('is refused when more than one project maps to the repo', async () => {
    const found = await findJiraTarget(scanning([SHOP, { ...SHOP, project_key: 'OPS' }]), 'Mappings', 'karlbaria/factory-shop');
    expect(found).toMatchObject({ ok: false });
    expect((found as { message: string }).message).toContain('More than one Jira project is mapped to karlbaria/factory-shop (OPS, SHOP)');
  });

  test('is refused when none does', async () => {
    expect(await findJiraTarget(scanning([]), 'Mappings', 'karlbaria/factory-shop')).toMatchObject({ ok: false });
  });
});

describe('screening is fail-closed', () => {
  test.each([
    [{ action: 'NONE' }, 'pass'],
    [{ action: 'GUARDRAIL_INTERVENED' }, 'blocked'],
    [undefined, 'unavailable'],
  ])('%p → %s', async (screened, verdict) => {
    mockScreen.mockResolvedValueOnce(screened);
    expect(await screenStoryText('Save for later', 'sid')).toBe(verdict);
  });

  test('a screening error is unavailable', async () => {
    mockScreen.mockRejectedValueOnce(new Error('bedrock down'));
    expect(await screenStoryText('Save for later', 'sid')).toBe('unavailable');
  });

  test('only the story text is screened', async () => {
    mockScreen.mockResolvedValueOnce({ action: 'NONE' });
    await screenStoryText('Save for later\nIt stays saved', 'sid');
    expect(mockScreen.mock.calls.at(-1)![0]).toBe('Save for later\nIt stays saved');
  });
});

describe('starting the build', () => {
  const session = {
    session_id: 'abcdefghijklmnopqrstuvwxyz',
    repo: 'karlbaria/factory-shop',
    platform_user_id: 'user-pm',
    slack_team_id: 'T1',
    slack_user_id: 'UPM',
  } as PlanningSession;
  const target = { cloudId: 'cloud-1', projectKey: 'SHOP', mapping: SHOP, labelFilter: 'bgagent' };
  const parent = { key: 'SHOP-1', id: '10001', summary: 'Wishlist', description: { type: 'doc' } };
  const config = {
    ddb: {} as DynamoDBDocumentClient,
    planningSessionTable: 'Sessions',
    projectMappingTable: 'Mappings',
    workspaceRegistryTable: 'Registry',
    orchestrationTable: 'Orch',
    maxConcurrent: 10,
    botToken: async () => null,
  };

  beforeEach(() => mockStart.mockReset().mockResolvedValue({ kind: 'task_created', taskId: 't' }));

  test('is attributed to the approver\'s linked platform user, keyed plan-<sid>, with 409 as started', async () => {
    await makeFileDesignDeps(config).startBuild({ session, target, parent });
    const [, input] = mockStart.mock.calls[0];
    expect(input).toMatchObject({
      platformUserId: 'user-pm',
      repo: 'karlbaria/factory-shop',
      cloudId: 'cloud-1',
      projectKey: 'SHOP',
      idempotencyKey: 'plan-abcdefghijklmnopqrstuvwxyz',
      duplicateIsStarted: true,
      issue: { id: '10001', key: 'SHOP-1', fields: { summary: 'Wishlist' } },
    });
    expect(await input.graph()).toEqual({ kind: 'no_children' });
  });

  test('hands an Epic\'s filed children over as its graph', async () => {
    const children = [{ id: 'SHOP-2', issue_id: '10002', project_key: 'SHOP', depends_on: [] }];
    await makeFileDesignDeps(config).startBuild({ session, target, parent, children: children as never });
    expect(await mockStart.mock.calls[0][1].graph()).toEqual({ kind: 'ok', children });
  });

  test('refuses an Epic without the orchestration table rather than starting one task for it', async () => {
    const result = await makeFileDesignDeps({ ...config, orchestrationTable: undefined })
      .startBuild({ session, target, parent, children: [] });
    expect(result.kind).toBe('failed');
    expect(mockStart).not.toHaveBeenCalled();
  });

  test('the approver\'s name falls back to the Slack id', async () => {
    expect(await makeFileDesignDeps(config).approverName(session)).toBe('Slack user UPM');
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'Pat' } } })));
    const named = makeFileDesignDeps({ ...config, botToken: async () => 'xoxb', fetchFn: fetchFn as unknown as typeof fetch });
    expect(await named.approverName(session)).toBe('Pat (Slack user UPM)');
  });
});
