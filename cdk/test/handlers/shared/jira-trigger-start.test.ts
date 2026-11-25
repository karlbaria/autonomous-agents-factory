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

const mockCreateTaskCore = jest.fn();
jest.mock('../../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => mockCreateTaskCore(...args),
}));
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: jest.fn(async () => ({ accessToken: 'tok', oauthSecretArn: 'arn:secret', siteUrl: 'https://example.atlassian.net' })),
}));
const mockGraphSource = jest.fn();
jest.mock('../../../src/handlers/shared/orchestration-graph-source', () => ({
  jiraGraphSource: (...args: unknown[]) => mockGraphSource(...args),
}));
const mockDiscover = jest.fn();
jest.mock('../../../src/handlers/shared/orchestration-discovery', () => ({
  discoverOrchestration: (...args: unknown[]) => mockDiscover(...args),
}));
jest.mock('../../../src/handlers/shared/orchestration-store', () => ({
  deriveOrchestrationId: (ref: string) => `orch_${ref}`,
  loadOrchestration: jest.fn(async () => null),
  setStatusCommentId: jest.fn(),
}));
jest.mock('../../../src/handlers/shared/orchestration-release', () => ({
  applyTerminalCreateFailures: jest.fn(),
  readConcurrencyBudget: jest.fn(),
  releaseReadyChildren: jest.fn(async () => []),
}));
jest.mock('../../../src/handlers/shared/orchestration-rollup', () => ({ upsertEpicPanel: jest.fn() }));
jest.mock('../../../src/handlers/shared/orchestration-channel-jira', () => ({ makeJiraChannel: jest.fn() }));
jest.mock('../../../src/handlers/shared/jira-attachments', () => ({
  cleanupPreScreenedAttachments: jest.fn(),
  downloadScreenAndStoreJiraAttachments: jest.fn(),
  fetchRecentHumanComments: jest.fn(async () => []),
  JiraAttachmentError: class extends Error {},
}));
jest.mock('../../../src/handlers/shared/repo-config', () => ({ lookupRepo: jest.fn(async () => ({ onboarded: true, config: null })) }));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { startJiraParentWork, type StartJiraParentWorkDeps, type StartJiraParentWorkInput } from '../../../src/handlers/shared/jira-trigger-start';

const reportFailure = jest.fn(async () => undefined);
const deps: StartJiraParentWorkDeps = {
  ddb: { send: jest.fn(async () => ({})) } as unknown as DynamoDBDocumentClient,
  projectMappingTable: 'Mappings',
  workspaceRegistryTable: 'Registry',
  orchestrationTable: 'Orch',
  maxConcurrent: 10,
  reportFailure,
};

function input(overrides: Partial<StartJiraParentWorkInput> = {}): StartJiraParentWorkInput {
  return {
    issue: { id: '10001', key: 'SHOP-1', fields: { summary: 'Wishlist', description: { type: 'doc', version: 1, content: [] } } },
    cloudId: 'cloud-1',
    projectKey: 'SHOP',
    mapping: { repo: 'karlbaria/factory-shop', status: 'active' },
    repo: 'karlbaria/factory-shop',
    labelFilter: 'bgagent',
    platformUserId: 'user-pm',
    ...overrides,
  };
}

beforeEach(() => {
  mockCreateTaskCore.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
  mockGraphSource.mockReset();
  mockDiscover.mockReset();
  reportFailure.mockClear();
});

describe('startJiraParentWork from Start (#82 PR 3b-2)', () => {
  test('a single Story creates one task, as the approver, on the jira channel, keyed plan-<sid>', async () => {
    const result = await startJiraParentWork(deps, input({
      idempotencyKey: 'plan-abcdefghijklmnopqrstuvwxyz',
      duplicateIsStarted: true,
      graph: async () => ({ kind: 'no_children' }),
    }));
    expect(mockGraphSource).not.toHaveBeenCalled();
    expect(mockCreateTaskCore).toHaveBeenCalledTimes(1);
    const [body, context] = mockCreateTaskCore.mock.calls[0];
    expect(body).toMatchObject({ repo: 'karlbaria/factory-shop' });
    expect(body.task_description).toContain('SHOP-1: Wishlist');
    expect(context).toMatchObject({
      userId: 'user-pm',
      channelSource: 'jira',
      idempotencyKey: 'plan-abcdefghijklmnopqrstuvwxyz',
      channelMetadata: { jira_issue_key: 'SHOP-1', jira_cloud_id: 'cloud-1' },
    });
    expect(result.kind).toBe('task_created');
  });

  test.each([200, 409])('a retry whose key already made the task (%i) counts as already started, with no failure comment', async (status) => {
    mockCreateTaskCore.mockResolvedValueOnce({ statusCode: status, body: '{}' });
    const result = await startJiraParentWork(deps, input({
      idempotencyKey: 'plan-abcdefghijklmnopqrstuvwxyz',
      duplicateIsStarted: true,
      graph: async () => ({ kind: 'no_children' }),
    }));
    expect(result).toEqual({ kind: 'task_already_started' });
    expect(reportFailure).not.toHaveBeenCalled();
  });

  test('without duplicateIsStarted (the label trigger), a 409 is still a reported failure', async () => {
    mockCreateTaskCore.mockResolvedValueOnce({ statusCode: 409, body: '{"error":{"message":"dup"}}' });
    mockGraphSource.mockReturnValue(async () => ({ kind: 'no_children' }));
    const result = await startJiraParentWork(deps, input());
    expect(result.kind).toBe('failed');
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });

  test('an Epic seeds the orchestration from the supplied graph, on the jira channel, as the approver', async () => {
    mockDiscover.mockResolvedValueOnce({ kind: 'seeded', orchestrationId: 'orch_SHOP-1', childCount: 3, rootSubIssueIds: ['SHOP-2'], alreadyExisted: false });
    const children = [
      { id: 'SHOP-2', identifier: 'SHOP-2', issue_id: '10002', title: 'S1', description: '', project_key: 'SHOP', depends_on: [] },
      { id: 'SHOP-3', identifier: 'SHOP-3', issue_id: '10003', title: 'S2', description: '', project_key: 'SHOP', depends_on: ['SHOP-2'] },
    ];
    const result = await startJiraParentWork(deps, input({ graph: async () => ({ kind: 'ok', children }) }));
    expect(mockGraphSource).not.toHaveBeenCalled();
    expect(mockCreateTaskCore).not.toHaveBeenCalled();
    const discovery = mockDiscover.mock.calls[0][0];
    expect(discovery.releaseContext).toMatchObject({ platform_user_id: 'user-pm', channel_source: 'jira', trigger_label: 'bgagent' });
    const graph = await discovery.graphSource();
    expect(graph.children.map((c: { id: string; depends_on: string[] }) => [c.id, c.depends_on])).toEqual([['SHOP-2', []], ['SHOP-3', ['SHOP-2']]]);
    expect(result).toEqual({ kind: 'orchestration_seeded', orchestrationId: 'orch_SHOP-1', childCount: 3 });
  });
});
