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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const resolveJiraOutboundAuthMock = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOutboundAuth: (...args: unknown[]) => resolveJiraOutboundAuthMock(...args),
}));

import { createAutoTrackedJiraIssue, findAutoTrackedJiraMapping, resolveJiraAutoTrack } from '../../../src/handlers/shared/jira-auto-track';

const originalFetch = global.fetch;

function mockResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  ddbSend.mockReset();
  resolveJiraOutboundAuthMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('findAutoTrackedJiraMapping', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  test('returns null when the Jira feature is not deployed (table names unset)', async () => {
    delete process.env.JIRA_PROJECT_MAPPING_TABLE_NAME;
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    const result = await findAutoTrackedJiraMapping('karlbaria/factory-shop');
    expect(result).toBeNull();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('scans with a filter on repo, active status, and auto_track', async () => {
    process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
    ddbSend.mockResolvedValueOnce({
      Items: [{ cloud_id: 'cloud-1', project_key: 'SHOP', repo: 'karlbaria/factory-shop', auto_track: true }],
    });

    const result = await findAutoTrackedJiraMapping('karlbaria/factory-shop');

    expect(result).toEqual({
      cloudId: 'cloud-1',
      projectKey: 'SHOP',
      registryTableName: 'JiraWorkspaceRegistry',
    });
    const scanCmd = ddbSend.mock.calls[0][0];
    expect(scanCmd.input.TableName).toBe('JiraProjects');
    expect(scanCmd.input.ExpressionAttributeValues).toEqual({
      ':repo': 'karlbaria/factory-shop',
      ':active': 'active',
      ':true': true,
    });
  });

  test('returns null when no mapping matches the filter', async () => {
    process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const result = await findAutoTrackedJiraMapping('karlbaria/factory-sandbox-py');
    expect(result).toBeNull();
  });

  test('returns null (not throws) when the scan fails', async () => {
    process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
    ddbSend.mockRejectedValueOnce(new Error('DDB throttle'));
    const result = await findAutoTrackedJiraMapping('karlbaria/factory-shop');
    expect(result).toBeNull();
  });
});

describe('createAutoTrackedJiraIssue', () => {
  const PARAMS = {
    cloudId: 'cloud-1',
    projectKey: 'SHOP',
    registryTableName: 'JiraWorkspaceRegistry',
    summary: 'Task 13 demo: add a GET /api/products/count endpoint',
  };

  test('returns skipped/unavailable when outbound auth cannot be resolved', async () => {
    resolveJiraOutboundAuthMock.mockResolvedValueOnce(null);
    const result = await createAutoTrackedJiraIssue(PARAMS);
    expect(result).toEqual({ kind: 'skipped', reason: 'unavailable' });
  });

  describe('via the Forge app actor', () => {
    const APP_AUTH = {
      kind: 'app' as const,
      appActor: {
        proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger-id',
        sharedSecret: 's'.repeat(64),
      },
      siteUrl: 'https://acme.atlassian.net',
      oauthSecretArn: 'arn:secret:acme',
    };

    test('creates the issue and returns its key', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
      const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, '{"id":"10050","key":"SHOP-7"}'));
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({ kind: 'created', issueKey: 'SHOP-7' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://install.webtrigger.atlassian.app/public/trigger-id');
      expect(JSON.parse(init.body as string)).toMatchObject({
        operation: 'create_issue',
        cloud_id: 'cloud-1',
        project_key: 'SHOP',
        issue_type_name: 'Task',
        summary: PARAMS.summary,
      });
    });

    test('converts a plain-text description to a minimal ADF document', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
      const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, '{"key":"SHOP-8"}'));
      global.fetch = fetchMock as unknown as typeof fetch;

      await createAutoTrackedJiraIssue({ ...PARAMS, description: 'Line one\n\nLine two' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string).body).toEqual({
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
        ],
      });
    });

    test('surfaces the Jira field errors on a 400 as a skip, not a throw', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
      global.fetch = jest.fn().mockResolvedValue(
        mockResponse(400, '{"errors":{"customfield_10050":"Component is required."}}'),
      ) as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({
        kind: 'skipped',
        reason: 'unknown_required_fields',
        jiraErrors: { customfield_10050: 'Component is required.' },
      });
    });

    test('a non-400 failure (e.g. Jira outage) skips as unavailable', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
      global.fetch = jest.fn().mockResolvedValue(mockResponse(503, '{"error":"jira_request_failed"}')) as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({ kind: 'skipped', reason: 'unavailable' });
    });
  });

  describe('via the legacy OAuth fallback', () => {
    const OAUTH_AUTH = {
      kind: 'oauth' as const,
      accessToken: 'jira_oauth_token',
      scope: 'write:jira-work',
      siteUrl: 'https://acme.atlassian.net',
      oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:bgagent-jira-oauth-cloud-1',
    };

    test('creates the issue against the cross-region gateway host, not the raw site host', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(OAUTH_AUTH);
      const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, '{"key":"SHOP-9"}'));
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({ kind: 'created', issueKey: 'SHOP-9' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jira_oauth_token');
      expect(JSON.parse(init.body as string)).toEqual({
        fields: {
          project: { key: 'SHOP' },
          issuetype: { name: 'Task' },
          summary: PARAMS.summary,
        },
      });
    });

    test('surfaces the Jira field errors on a 400 as a skip', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(OAUTH_AUTH);
      global.fetch = jest.fn().mockResolvedValue(
        mockResponse(400, '{"errors":{"issuetype":"Invalid issue type."}}'),
      ) as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({
        kind: 'skipped',
        reason: 'unknown_required_fields',
        jiraErrors: { issuetype: 'Invalid issue type.' },
      });
    });

    test('a network failure skips as unavailable rather than throwing', async () => {
      resolveJiraOutboundAuthMock.mockResolvedValueOnce(OAUTH_AUTH);
      global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

      const result = await createAutoTrackedJiraIssue(PARAMS);

      expect(result).toEqual({ kind: 'skipped', reason: 'unavailable' });
    });
  });
});

describe('resolveJiraAutoTrack', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const BASE_PARAMS = {
    channelMetadata: { slack_team_id: 'T1' },
    taskId: 'task-1',
    taskDescription: 'Add a GET /api/products/count endpoint',
    eventsTableName: 'TaskEvents',
    now: '2026-11-19T00:00:00.000Z',
    taskRetentionDays: 90,
  };
  const APP_AUTH = {
    kind: 'app' as const,
    appActor: {
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger-id',
      sharedSecret: 's'.repeat(64),
    },
    siteUrl: 'https://acme.atlassian.net',
    oauthSecretArn: 'arn:secret:acme',
  };

  test.each(['webhook', 'linear', 'jira'] as const)(
    'leaves channelMetadata unchanged for channel_source=%s (out of scope)',
    async (channelSource) => {
      const result = await resolveJiraAutoTrack({ ...BASE_PARAMS, repo: 'karlbaria/factory-shop', channelSource });
      expect(result).toEqual({ channelMetadata: BASE_PARAMS.channelMetadata });
      expect(ddbSend).not.toHaveBeenCalled();
    },
  );

  test('leaves channelMetadata unchanged when there is no repo', async () => {
    const result = await resolveJiraAutoTrack({ ...BASE_PARAMS, channelSource: 'slack' });
    expect(result).toEqual({ channelMetadata: BASE_PARAMS.channelMetadata });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('leaves channelMetadata unchanged when the repo has no opted-in mapping', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const result = await resolveJiraAutoTrack({
      ...BASE_PARAMS,
      repo: 'karlbaria/factory-sandbox-py',
      channelSource: 'api',
    });
    expect(result).toEqual({ channelMetadata: BASE_PARAMS.channelMetadata });
  });

  test('merges jira_cloud_id/jira_issue_key into channelMetadata on a successful create', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ cloud_id: 'cloud-1', project_key: 'SHOP' }],
    });
    resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
    global.fetch = jest.fn().mockResolvedValue(mockResponse(201, '{"key":"SHOP-7"}')) as unknown as typeof fetch;

    const result = await resolveJiraAutoTrack({
      ...BASE_PARAMS,
      repo: 'karlbaria/factory-shop',
      channelSource: 'slack',
    });

    expect(result).toEqual({
      channelMetadata: { slack_team_id: 'T1', jira_cloud_id: 'cloud-1', jira_issue_key: 'SHOP-7' },
    });
    expect(ddbSend).toHaveBeenCalledTimes(1); // the Scan only — no event write on success
  });

  test('leaves channelMetadata unchanged but writes a visible skip event when fields are missing', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [{ cloud_id: 'cloud-1', project_key: 'SHOP' }] });
    ddbSend.mockResolvedValueOnce({});
    resolveJiraOutboundAuthMock.mockResolvedValueOnce(APP_AUTH);
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(400, '{"errors":{"customfield_10050":"Component is required."}}'),
    ) as unknown as typeof fetch;

    const result = await resolveJiraAutoTrack({
      ...BASE_PARAMS,
      repo: 'karlbaria/factory-shop',
      channelSource: 'slack',
    });

    expect(result).toEqual({ channelMetadata: BASE_PARAMS.channelMetadata });
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const putCmd = ddbSend.mock.calls[1][0];
    expect(putCmd.input.TableName).toBe('TaskEvents');
    expect(putCmd.input.Item).toMatchObject({
      task_id: 'task-1',
      event_type: 'jira_auto_track_skipped',
      metadata: {
        jira_project_key: 'SHOP',
        jira_errors: { customfield_10050: 'Component is required.' },
      },
    });
  });

  test('leaves channelMetadata unchanged and writes no event when Jira is simply unavailable', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [{ cloud_id: 'cloud-1', project_key: 'SHOP' }] });
    resolveJiraOutboundAuthMock.mockResolvedValueOnce(null);

    const result = await resolveJiraAutoTrack({
      ...BASE_PARAMS,
      repo: 'karlbaria/factory-shop',
      channelSource: 'slack',
    });

    expect(result).toEqual({ channelMetadata: BASE_PARAMS.channelMetadata });
    expect(ddbSend).toHaveBeenCalledTimes(1); // the Scan only — no event write for a quiet skip
  });
});
