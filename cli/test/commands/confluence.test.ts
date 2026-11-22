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

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { makeConfluenceCommand } from '../../src/commands/confluence';
import * as config from '../../src/config';
import type { StoredJiraOauthToken } from '../../src/jira-oauth';

const loadActiveRepoConfigMock = jest.fn();
jest.mock('../../src/repo-lookup', () => ({
  loadActiveRepoConfig: (...args: unknown[]) => loadActiveRepoConfigMock(...args),
}));

// child_process.execFile — `openBrowser` shells out to the OS opener.
const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  };
});

const awaitOauthCallbackMock = jest.fn();
jest.mock('../../src/oauth-callback-server', () => {
  const actual = jest.requireActual('../../src/oauth-callback-server');
  return {
    ...actual,
    awaitOauthCallback: (...args: unknown[]) => awaitOauthCallbackMock(...args),
  };
});

const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  };
});

const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});

function sampleToken(overrides: Partial<StoredJiraOauthToken> = {}): StoredJiraOauthToken {
  return {
    access_token: 'access-xyz',
    refresh_token: 'refresh-xyz',
    expires_at: '2026-06-17T01:00:00.000Z',
    scope: 'read:jira-work write:jira-work read:jira-user offline_access',
    client_id: 'client-id',
    client_secret: 'client-secret',
    cloud_id: 'cloud-123',
    site_url: 'https://acme.atlassian.net',
    installed_at: '2026-06-17T00:00:00.000Z',
    updated_at: '2026-06-17T00:00:00.000Z',
    installed_by_platform_user_id: 'sub-abc',
    ...overrides,
  };
}

function stackOutputs(outputs: Array<{ OutputKey: string; OutputValue: string }>) {
  return { Stacks: [{ Outputs: outputs }] };
}

describe('makeConfluenceCommand', () => {
  test('registers the expected subcommands', () => {
    const cmd = makeConfluenceCommand();
    expect(cmd.name()).toBe('confluence');
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['map', 'setup']);
  });
});

describe('confluence setup action', () => {
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;

  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    awaitOauthCallbackMock.mockReset();
    execFileMock.mockReset();
    cfnSend.mockReset();
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
  });

  afterEach(() => loadConfigSpy.mockRestore());

  test('throws a clear error when JiraWorkspaceRegistryTableName is missing (Jira not deployed)', async () => {
    cfnSend.mockResolvedValue(stackOutputs([]));
    const program = makeConfluenceCommand();
    program.exitOverride();
    await expect(
      program.parseAsync(['node', 'bgagent', 'setup', 'cloud-123']),
    ).rejects.toThrow(/JiraWorkspaceRegistryTableName/);
  });

  test('refuses when the tenant is not an active Jira registry row', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
    ]));
    ddbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });
    const program = makeConfluenceCommand();
    program.exitOverride();
    await expect(
      program.parseAsync(['node', 'bgagent', 'setup', 'cloud-123']),
    ).rejects.toThrow(/No active Jira tenant 'cloud-123'.*bgagent jira setup/s);
    expect(smSend).not.toHaveBeenCalled();
  });

  test('widens an existing tenant secret with the Jira+Confluence scope union', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
    ]));
    ddbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({ Item: { jira_cloud_id: 'cloud-123', status: 'active' } });
      }
      return Promise.resolve({});
    });
    const existing = sampleToken();
    smSend
      // 1. this action's own read of the existing secret (client_id/secret, site_url)
      .mockResolvedValueOnce({ SecretString: JSON.stringify(existing) })
      // 2. upsertOauthSecret: CreateSecret rejects because the secret already exists
      .mockRejectedValueOnce(new ResourceExistsException({ message: 'exists', $metadata: {} }))
      // 3. upsertOauthSecret: re-reads the existing bundle to preserve app_actor_* fields
      .mockResolvedValueOnce({ SecretString: JSON.stringify(existing) })
      // 4. upsertOauthSecret: PutSecretValue with the widened bundle
      .mockResolvedValueOnce({ ARN: 'arn:jira-oauth' });

    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'widened-access-token',
        refresh_token: 'widened-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read:jira-work write:jira-work read:jira-user offline_access read:page:confluence write:page:confluence read:space:confluence read:label:confluence write:label:confluence delete:page:confluence',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 'cloud-123',
        name: 'Acme',
        url: 'https://acme.atlassian.net',
        scopes: ['read:jira-work'],
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    let completeOauth!: (value: { kind: 'direct-oauth'; code: string; state: string }) => void;
    awaitOauthCallbackMock.mockReturnValueOnce(new Promise((resolve) => {
      completeOauth = resolve;
    }));
    execFileMock.mockImplementationOnce(
      (_command: string, args: string[], callback: (err: Error | null) => void) => {
        const state = new URL(args[0]).searchParams.get('state');
        completeOauth({ kind: 'direct-oauth', code: 'auth-code', state: state! });
        callback(null);
      },
    );

    try {
      const program = makeConfluenceCommand();
      await program.parseAsync(['node', 'bgagent', 'setup', 'cloud-123']);

      // Authorization URL carries the Jira+Confluence scope union.
      const authUrl = new URL(String(execFileMock.mock.calls[0][1][0]));
      const requestedScopes = authUrl.searchParams.get('scope')!.split(' ');
      expect(requestedScopes).toEqual(expect.arrayContaining([
        'read:jira-work',
        'write:jira-work',
        'read:page:confluence',
        'write:page:confluence',
        'read:space:confluence',
        'read:label:confluence',
        'write:label:confluence',
        'delete:page:confluence',
      ]));

      // Token exchange reused the existing app's client_id/client_secret —
      // no re-prompt for credentials.
      const exchangeBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { client_id: string };
      expect(exchangeBody.client_id).toBe('client-id');

      expect(smSend.mock.calls[1][0]).toBeInstanceOf(CreateSecretCommand);
      expect(smSend.mock.calls[2][0]).toBeInstanceOf(GetSecretValueCommand);
      const put = smSend.mock.calls[3][0] as PutSecretValueCommand;
      expect(put.input.SecretId).toBe('bgagent-jira-oauth-cloud-123');
      const stored = JSON.parse(put.input.SecretString as string) as StoredJiraOauthToken;
      expect(stored).toMatchObject({
        access_token: 'widened-access-token',
        refresh_token: 'widened-refresh-token',
        // Preserved from the existing bundle — confirms this is a widen, not
        // a fresh re-authorization that would have re-prompted for them.
        client_id: 'client-id',
        client_secret: 'client-secret',
        site_url: 'https://acme.atlassian.net',
        installed_at: '2026-06-17T00:00:00.000Z',
        installed_by_platform_user_id: 'sub-abc',
      });
      expect(stored.scope).toContain('write:page:confluence');
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('rejects when the authorized account cannot access the requested tenant', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
    ]));
    ddbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({ Item: { jira_cloud_id: 'cloud-123', status: 'active' } });
      }
      return Promise.resolve({});
    });
    smSend.mockResolvedValueOnce({ SecretString: JSON.stringify(sampleToken()) });

    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'tok',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read:jira-work',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 'some-other-cloud',
        name: 'Other',
        url: 'https://other.atlassian.net',
        scopes: ['read:jira-work'],
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    let completeOauth!: (value: { kind: 'direct-oauth'; code: string; state: string }) => void;
    awaitOauthCallbackMock.mockReturnValueOnce(new Promise((resolve) => {
      completeOauth = resolve;
    }));
    execFileMock.mockImplementationOnce(
      (_command: string, args: string[], callback: (err: Error | null) => void) => {
        const state = new URL(args[0]).searchParams.get('state');
        completeOauth({ kind: 'direct-oauth', code: 'auth-code', state: state! });
        callback(null);
      },
    );

    try {
      const program = makeConfluenceCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'setup', 'cloud-123']),
      ).rejects.toThrow(/does not have access to tenant 'cloud-123'/);
      expect(smSend).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('confluence map action', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    cfnSend.mockReset();
    loadActiveRepoConfigMock.mockReset();
    jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
  });

  afterEach(() => jest.restoreAllMocks());

  test('updates the repo\'s RepoTable row with cloud id, space key, and parent page', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'RepoTableName', OutputValue: 'RepoTable' },
    ]));
    loadActiveRepoConfigMock.mockResolvedValue({ repo: 'owner/repo' });
    ddbSend.mockResolvedValue({});

    const program = makeConfluenceCommand();
    await program.parseAsync([
      'node', 'bgagent', 'map', 'cloud-123', 'ENG',
      '--repo', 'owner/repo',
      '--parent-page-id', '98765',
    ]);

    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.TableName).toBe('RepoTable');
    expect(update.input.Key).toEqual({ repo: 'owner/repo' });
    expect(update.input.UpdateExpression).toContain('confluence_cloud_id = :cloudId');
    expect(update.input.UpdateExpression).toContain('confluence_space_key = :spaceKey');
    expect(update.input.UpdateExpression).toContain('confluence_parent_page_id = :parentPageId');
    expect(update.input.UpdateExpression).not.toContain('REMOVE');
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':cloudId': 'cloud-123',
      ':spaceKey': 'ENG',
      ':parentPageId': '98765',
    });
  });

  test('clears confluence_parent_page_id (REMOVE) when the flag is omitted', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'RepoTableName', OutputValue: 'RepoTable' },
    ]));
    loadActiveRepoConfigMock.mockResolvedValue({ repo: 'owner/repo' });
    ddbSend.mockResolvedValue({});

    const program = makeConfluenceCommand();
    await program.parseAsync(['node', 'bgagent', 'map', 'cloud-123', 'ENG', '--repo', 'owner/repo']);

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.UpdateExpression).toContain('REMOVE confluence_parent_page_id');
    expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':parentPageId');
  });

  // `process.exit` throws so execution stops where it would in production;
  // mocking it as a no-op would let these handlers fall through to the
  // DynamoDB write the assertion is checking never happened.
  function mockExitThrows(): jest.SpiedFunction<typeof process.exit> {
    return jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  }

  test('rejects an invalid --repo value before writing', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'RepoTableName', OutputValue: 'RepoTable' },
    ]));
    const exitSpy = mockExitThrows();
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    const program = makeConfluenceCommand();
    await expect(
      program.parseAsync(['node', 'bgagent', 'map', 'cloud-123', 'ENG', '--repo', 'not-a-repo']),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --repo value'));
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('rejects an invalid space key before writing', async () => {
    cfnSend.mockResolvedValue(stackOutputs([
      { OutputKey: 'RepoTableName', OutputValue: 'RepoTable' },
    ]));
    const exitSpy = mockExitThrows();
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    const program = makeConfluenceCommand();
    await expect(
      program.parseAsync(['node', 'bgagent', 'map', 'cloud-123', '1NVALID', '--repo', 'owner/repo']),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Confluence space key'));
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('exits when a required stack output is missing', async () => {
    cfnSend.mockResolvedValue(stackOutputs([]));
    const exitSpy = mockExitThrows();
    jest.spyOn(console, 'error').mockImplementation();

    const program = makeConfluenceCommand();
    await expect(
      program.parseAsync(['node', 'bgagent', 'map', 'cloud-123', 'ENG', '--repo', 'owner/repo']),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
