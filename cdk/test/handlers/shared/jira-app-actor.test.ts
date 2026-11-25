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
  createIssueRequest,
  createJiraIssueViaOauth,
  linkIssuesRequest,
  linkJiraIssuesViaOauth,
  requestJiraAppActor,
  signJiraAppActorRequest,
  validateJiraAppActorProxyUrl,
} from '../../../src/handlers/shared/jira-app-actor';
import { logger } from '../../../src/handlers/shared/logger';

const CONFIG = {
  proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger-id',
  sharedSecret: 's'.repeat(64),
};
const REQUEST = {
  version: 1 as const,
  operation: 'comment' as const,
  cloud_id: 'cloud-1',
  issue_key: 'ENG-42',
  body: { type: 'doc', version: 1, content: [] },
};

function response(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('validateJiraAppActorProxyUrl', () => {
  test('accepts only Forge v2 installation URLs', () => {
    expect(validateJiraAppActorProxyUrl(CONFIG.proxyUrl)).toBe(CONFIG.proxyUrl);
    expect(validateJiraAppActorProxyUrl('https://attacker.example/public/id')).toBeNull();
    expect(
      validateJiraAppActorProxyUrl(
        'https://install.webtrigger.atlassian.app/public/id?redirect=attacker',
      ),
    ).toBeNull();
  });
});

describe('signJiraAppActorRequest', () => {
  test('signs timestamp dot raw body', () => {
    expect(signJiraAppActorRequest('secret', '123', '{"x":1}')).toBe(
      'sha256=99516ddc38364f90ce28dd6d23c0c4e3d7a0da6fdf60102ebefaf343ec72116d',
    );
  });
});

describe('requestJiraAppActor', () => {
  test('sends a signed request and returns a successful body', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(201, '{"id":"10001"}'));

    const result = await requestJiraAppActor(
      CONFIG,
      REQUEST,
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ ok: true, status: 201, body: '{"id":"10001"}' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIG.proxyUrl);
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bgagent-Signature']).toBe(
      signJiraAppActorRequest(CONFIG.sharedSecret, headers['X-Bgagent-Timestamp'], body),
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test('rejects invalid local configuration without calling fetch', async () => {
    const fetchMock = jest.fn();
    const error = jest.spyOn(logger, 'error').mockImplementation();

    const result = await requestJiraAppActor(
      { proxyUrl: 'https://attacker.example/public/id', sharedSecret: 'short' },
      REQUEST,
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error_id: 'JIRA_APP_ACTOR_CONFIG_INVALID' }),
    );
  });

  test('surfaces a permanent proxy error code without logging its body', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue(
      response(401, '{"error":"invalid_signature","detail":"do-not-log"}'),
    );

    const result = await requestJiraAppActor(
      CONFIG,
      REQUEST,
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      retryable: false,
      errorCode: 'invalid_signature',
      body: '{"error":"invalid_signature","detail":"do-not-log"}',
    });
    expect(error).toHaveBeenCalledWith(
      'Jira app-actor proxy rejected request',
      expect.objectContaining({
        error_id: 'JIRA_APP_ACTOR_PROXY_REJECTED',
        proxy_error_code: 'invalid_signature',
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('do-not-log');
  });

  test('classifies proxy_not_configured as terminal despite HTTP 503', async () => {
    jest.spyOn(logger, 'error').mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue(
      response(503, '{"error":"proxy_not_configured"}'),
    );

    await expect(
      requestJiraAppActor(CONFIG, REQUEST, fetchMock as unknown as typeof fetch),
    ).resolves.toEqual({
      ok: false,
      status: 503,
      retryable: false,
      errorCode: 'proxy_not_configured',
      body: '{"error":"proxy_not_configured"}',
    });
  });

  test.each([
    [429, '{"error":"rate_limited"}', undefined],
    [502, '{"error":"jira_request_failed"}', 'jira_request_failed'],
  ])('classifies HTTP %s as retryable', async (status, body, errorCode) => {
    jest.spyOn(logger, 'warn').mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue(response(status, body));

    await expect(
      requestJiraAppActor(CONFIG, REQUEST, fetchMock as unknown as typeof fetch),
    ).resolves.toEqual({
      ok: false,
      status,
      retryable: true,
      errorCode,
      body,
    });
  });

  test('aborts a request after the timeout and classifies it as retryable', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation();
    const fetchMock = jest.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    ));

    const pending = requestJiraAppActor(
      CONFIG,
      REQUEST,
      fetchMock as unknown as typeof fetch,
    );
    await jest.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual({ ok: false, retryable: true });
  });
});

// #82 PR 3b-2: the requests Start's filing sends, through the proxy or OAuth.
describe('filing requests (#82 PR 3b-2)', () => {
  const fields = {
    projectKey: 'SHOP',
    issueTypeName: 'Story',
    summary: 'Save for later',
    description: { type: 'doc', version: 1, content: [] },
    parentKey: 'SHOP-1',
    labels: ['factory-plan-abcdefgh'],
  };

  test('the proxy create request carries the parent and the plan label', () => {
    expect(createIssueRequest('cloud-1', fields)).toEqual({
      version: 1,
      operation: 'create_issue',
      cloud_id: 'cloud-1',
      project_key: 'SHOP',
      issue_type_name: 'Story',
      summary: 'Save for later',
      body: fields.description,
      parent_key: 'SHOP-1',
      labels: ['factory-plan-abcdefgh'],
    });
  });

  test('the proxy link request is Blocks: the blocker outward, the blocked inward', () => {
    expect(linkIssuesRequest('cloud-1', 'SHOP-2', 'SHOP-3')).toEqual({
      version: 1,
      operation: 'link_issues',
      cloud_id: 'cloud-1',
      link_type: 'Blocks',
      outward_issue_key: 'SHOP-2',
      inward_issue_key: 'SHOP-3',
    });
  });

  test('the OAuth twins send what the proxy sends to Jira', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{"id":"10002","key":"SHOP-2"}', { status: 201 });
    });
    const created = await createJiraIssueViaOauth('tok', 'cloud-1', { ...fields, issueTypeName: 'Epic', epicNameField: 'customfield_10011' }, fetchImpl as unknown as typeof fetch);
    await linkJiraIssuesViaOauth('tok', 'cloud-1', 'SHOP-2', 'SHOP-3', fetchImpl as unknown as typeof fetch);
    expect(created).toEqual({ ok: true, status: 201, body: '{"id":"10002","key":"SHOP-2"}' });
    expect(calls[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue');
    expect(calls[0].body).toEqual({
      fields: {
        project: { key: 'SHOP' },
        issuetype: { name: 'Epic' },
        summary: 'Save for later',
        description: fields.description,
        parent: { key: 'SHOP-1' },
        labels: ['factory-plan-abcdefgh'],
        customfield_10011: 'Save for later',
      },
    });
    expect(calls[1].url).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issueLink');
    expect(calls[1].body).toEqual({ type: { name: 'Blocks' }, outwardIssue: { key: 'SHOP-2' }, inwardIssue: { key: 'SHOP-3' } });
  });

  test('an OAuth 5xx or network error is retryable (an unknown outcome); a 4xx is not', async () => {
    const respond = (status: number) => jest.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await linkJiraIssuesViaOauth('tok', 'c', 'A-1', 'A-2', respond(502))).toMatchObject({ ok: false, retryable: true });
    expect(await linkJiraIssuesViaOauth('tok', 'c', 'A-1', 'A-2', respond(400))).toMatchObject({ ok: false, retryable: false });
    const broken = jest.fn(async () => { throw new Error('reset'); }) as unknown as typeof fetch;
    expect(await linkJiraIssuesViaOauth('tok', 'c', 'A-1', 'A-2', broken)).toEqual({ ok: false, retryable: true });
  });

  test('the proxy\'s filing error codes are recognised', async () => {
    for (const code of ['invalid_parent_key', 'invalid_plan_label', 'invalid_epic_name_field', 'invalid_link_issues_request']) {
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ error: code }), { status: 400 })) as unknown as typeof fetch;
      const result = await requestJiraAppActor(CONFIG, linkIssuesRequest('cloud-1', 'SHOP-2', 'SHOP-3'), fetchImpl);
      expect(result).toMatchObject({ ok: false, retryable: false, errorCode: code });
    }
  });
});
