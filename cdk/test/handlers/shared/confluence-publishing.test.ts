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

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const getRegistryRowMock = jest.fn();
const resolveJiraOauthTokenMock = jest.fn();
const resolveJiraOutboundAuthMock = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  getRegistryRow: (...args: unknown[]) => getRegistryRowMock(...args),
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
  resolveJiraOutboundAuth: (...args: unknown[]) => resolveJiraOutboundAuthMock(...args),
}));

const loadRepoConfigMock = jest.fn();
jest.mock('../../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...args: unknown[]) => loadRepoConfigMock(...args),
}));

import {
  resolveConfluenceChannelMetadata,
  warmConfluenceToken,
} from '../../../src/handlers/shared/confluence-publishing';

const RESEARCH = { id: 'knowledge/web-research-v1', version: '1.0.0' };
const CODING = { id: 'coding/new-task-v1', version: '1.0.0' };
const MAPPING = {
  confluence_cloud_id: 'cloud-1',
  confluence_space_key: 'ENG',
  confluence_parent_page_id: '500',
};
const ACTIVE_ROW = {
  jira_cloud_id: 'cloud-1',
  site_url: 'https://acme.atlassian.net',
  oauth_secret_arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-jira-oauth-cloud-1-AbCdEf',
  status: 'active',
};
const fakeDdb = {} as never;
const originalEnv = { ...process.env };

beforeEach(() => {
  getRegistryRowMock.mockReset();
  resolveJiraOauthTokenMock.mockReset();
  resolveJiraOutboundAuthMock.mockReset();
  loadRepoConfigMock.mockReset();
  process.env = { ...originalEnv, JIRA_WORKSPACE_REGISTRY_TABLE_NAME: 'RegTable' };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('resolveConfluenceChannelMetadata', () => {
  test('stamps mapping, secret ARN and site URL for a Confluence workflow on a mapped repo', async () => {
    getRegistryRowMock.mockResolvedValue(ACTIVE_ROW);
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: RESEARCH }, MAPPING, { dynamoDbClient: fakeDdb },
    );
    expect(meta).toEqual({
      confluence_cloud_id: 'cloud-1',
      confluence_space_key: 'ENG',
      confluence_parent_page_id: '500',
      confluence_oauth_secret_arn: ACTIVE_ROW.oauth_secret_arn,
      confluence_site_url: 'https://acme.atlassian.net',
    });
    expect(getRegistryRowMock).toHaveBeenCalledWith(fakeDdb, 'RegTable', 'cloud-1');
  });

  test('omits the parent page when the mapping has none (space root)', async () => {
    getRegistryRowMock.mockResolvedValue(ACTIVE_ROW);
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: RESEARCH },
      { confluence_cloud_id: 'cloud-1', confluence_space_key: 'ENG' },
      { dynamoDbClient: fakeDdb },
    );
    expect(meta).not.toHaveProperty('confluence_parent_page_id');
  });

  test('stamps nothing for a workflow that does not publish to Confluence', async () => {
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: CODING }, MAPPING, { dynamoDbClient: fakeDdb },
    );
    expect(meta).toEqual({});
    expect(getRegistryRowMock).not.toHaveBeenCalled();
  });

  test.each([
    ['no mapping', undefined],
    ['no space key', { confluence_cloud_id: 'cloud-1' }],
    ['no cloud id', { confluence_space_key: 'ENG' }],
  ])('stamps nothing with %s', async (_case, mapping) => {
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: RESEARCH }, mapping, { dynamoDbClient: fakeDdb },
    );
    expect(meta).toEqual({});
    expect(getRegistryRowMock).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null],
    ['revoked', { ...ACTIVE_ROW, status: 'revoked' }],
  ])('stamps the mapping but no secret when the tenant row is %s (agent reports token_unavailable)', async (_case, row) => {
    getRegistryRowMock.mockResolvedValue(row);
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: RESEARCH }, MAPPING, { dynamoDbClient: fakeDdb },
    );
    expect(meta.confluence_space_key).toBe('ENG');
    expect(meta).not.toHaveProperty('confluence_oauth_secret_arn');
  });

  test('stamps the mapping but no secret when the registry is not configured', async () => {
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    const meta = await resolveConfluenceChannelMetadata(
      { task_id: 't1', resolved_workflow: RESEARCH }, MAPPING, { dynamoDbClient: fakeDdb },
    );
    expect(meta.confluence_cloud_id).toBe('cloud-1');
    expect(meta).not.toHaveProperty('confluence_oauth_secret_arn');
    expect(getRegistryRowMock).not.toHaveBeenCalled();
  });
});

describe('warmConfluenceToken', () => {
  const task = { task_id: 't1', repo: 'acme/docs', workflowId: RESEARCH.id };

  test('warms through the normal refresh-if-near-expiry path, never forceRefresh', async () => {
    loadRepoConfigMock.mockResolvedValue(MAPPING);
    resolveJiraOauthTokenMock.mockResolvedValue({ accessToken: 'x' });
    await expect(warmConfluenceToken(task)).resolves.toBe('warmed');
    expect(loadRepoConfigMock).toHaveBeenCalledWith('acme/docs');
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(1);
    const [cloudId, table, options] = resolveJiraOauthTokenMock.mock.calls[0];
    expect([cloudId, table]).toEqual(['cloud-1', 'RegTable']);
    expect(options?.forceRefresh).toBeUndefined();
    // The 3LO path, not the outbound-identity resolver (which would pick the
    // Forge app actor and never touch the token Confluence uses).
    expect(resolveJiraOutboundAuthMock).not.toHaveBeenCalled();
  });

  test('needs no Jira link: only the repo and the workflow decide', async () => {
    loadRepoConfigMock.mockResolvedValue(MAPPING);
    resolveJiraOauthTokenMock.mockResolvedValue({ accessToken: 'x' });
    await expect(warmConfluenceToken({ task_id: 't2', repo: 'acme/docs', workflowId: RESEARCH.id }))
      .resolves.toBe('warmed');
  });

  test('does not warm for a mapped repo on a workflow with no Confluence deliverer', async () => {
    loadRepoConfigMock.mockResolvedValue(MAPPING);
    await expect(warmConfluenceToken({ ...task, workflowId: CODING.id })).resolves.toBe('not_applicable');
    expect(loadRepoConfigMock).not.toHaveBeenCalled();
    expect(resolveJiraOauthTokenMock).not.toHaveBeenCalled();
  });

  test('does not warm a task without a repo', async () => {
    await expect(warmConfluenceToken({ task_id: 't1', workflowId: RESEARCH.id })).resolves.toBe('not_applicable');
    expect(resolveJiraOauthTokenMock).not.toHaveBeenCalled();
  });

  test('does not warm an unmapped repo', async () => {
    loadRepoConfigMock.mockResolvedValue({ repo: 'acme/docs' });
    await expect(warmConfluenceToken(task)).resolves.toBe('no_mapping');
    expect(resolveJiraOauthTokenMock).not.toHaveBeenCalled();
  });

  test('does nothing when the registry is not configured', async () => {
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    await expect(warmConfluenceToken(task)).resolves.toBe('not_configured');
    expect(loadRepoConfigMock).not.toHaveBeenCalled();
  });

  test('a repo-config error is reported, not thrown', async () => {
    loadRepoConfigMock.mockRejectedValue(new Error('throttled'));
    await expect(warmConfluenceToken(task)).resolves.toBe('unavailable');
  });

  test('a failed or throwing refresh is reported, not thrown', async () => {
    loadRepoConfigMock.mockResolvedValue(MAPPING);
    resolveJiraOauthTokenMock.mockResolvedValueOnce(null);
    await expect(warmConfluenceToken(task)).resolves.toBe('unavailable');
    resolveJiraOauthTokenMock.mockRejectedValueOnce(new Error('network'));
    await expect(warmConfluenceToken(task)).resolves.toBe('unavailable');
  });
});
