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

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// --- Mocks ---
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-XYZ';
process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME = 'cmd-processor';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-events';

const SIGNING_SECRET = 'test-signing-secret';

function sign(body: string, timestamp: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
}

function currentTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeEvent(body: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function signedEvent(body: string, retryNum?: string): APIGatewayProxyEvent {
  const ts = currentTs();
  const headers: Record<string, string> = {
    'X-Slack-Signature': sign(body, ts),
    'X-Slack-Request-Timestamp': ts,
  };
  if (retryNum) headers['X-Slack-Retry-Num'] = retryNum;
  return makeEvent(body, headers);
}

describe('slack-events handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    // Default: signing secret fetched on demand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      return Promise.resolve({});
    });
  });

  test('400s when body is missing', async () => {
    const event = makeEvent(null as unknown as string);
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('answers url_verification challenge with valid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'abc123' });
  });

  test('rejects url_verification with invalid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const ts = currentTs();
    const event = makeEvent(body, {
      'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
      'X-Slack-Request-Timestamp': ts,
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('answers url_verification during initial setup when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'initial' });
    // No signature provided — pre-setup flow
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'initial' });
  });

  test('rejects non-url_verification when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(500);
  });

  test('drops non-critical retries without reprocessing', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> hi', ts: '1.0' },
    });
    const result = await handler(signedEvent(body, '1'));
    expect(result.statusCode).toBe(200);
    // No lambda invocation because the retry is short-circuited
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('reprocesses retries for app_uninstalled (security-critical)', async () => {
    ddbSend.mockResolvedValueOnce({}); // UpdateCommand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      if (cmd._type === 'DeleteSecret') return Promise.resolve({});
      return Promise.resolve({});
    });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'app_uninstalled' },
    });
    const result = await handler(signedEvent(body, '2'));
    expect(result.statusCode).toBe(200);
    // DDB was updated (status→revoked) even though this is a retry
    expect(ddbSend).toHaveBeenCalledTimes(1);
    // And the secret deletion happened
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(true);
  });

  test('does not delete bot token if DDB revocation update failed', async () => {
    ddbSend.mockRejectedValueOnce(new Error('ddb throttle'));
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'tokens_revoked' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(500);
    // Critical invariant: don't delete secret if install is still "active" in DDB
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(false);
  });

  test('forwards app_mention to command processor with :eyes: reaction', async () => {
    // First fetch is reactions.add for :eyes:, returns { ok: true }
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      // Bot token lookup
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix the bug in org/repo#42',
        ts: '1234.0001',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.source).toBe('mention');
    expect(payload.text).toContain('submit');
    expect(payload.text).toContain('org/repo#42');
    expect(payload.channel_id).toBe('C1');
    // Reactions.add was called
    const reactionCall = fetchMock.mock.calls.find(([url]) => String(url).includes('reactions.add'));
    expect(reactionCall).toBeTruthy();
  });

  // Regression: the repo-extraction regex was unanchored and first-match-wins,
  // so it lifted "api/products" out of the URL path "/api/products/count"
  // instead of reaching "karlbaria/factory-shop" later in the message.
  test('picks the real repo, not a URL path segment that looks like one', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> add a GET /api/products/count endpoint in karlbaria/factory-shop',
        ts: '1234.0002',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    // #82 PR 2a: the trailing `in` that pointed at the repo goes with it.
    expect(payload.text).toBe('submit karlbaria/factory-shop add a GET /api/products/count endpoint');
  });

  // #82 PR 2a: description cleanup and Confluence links.
  describe('repo removal (#82 PR 2a)', () => {
    async function forwardedText(text: string): Promise<string> {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
      lambdaSend.mockResolvedValueOnce({});
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: { type: 'app_mention', user: 'U1', channel: 'C1', text: `<@BOT> ${text}`, ts: '1234.0100' },
      });
      const result = await handler(signedEvent(body));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const [invokeCmd] = lambdaSend.mock.calls[0];
      return JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload)).text;
    }

    test('leading form: "In owner/repo, add X" becomes "add X"', async () => {
      expect(await forwardedText('In karlbaria/factory-shop, add a coupon field'))
        .toBe('submit karlbaria/factory-shop add a coupon field');
    });

    test('trailing form: "I want to build X in owner/repo" keeps PR 1 behaviour', async () => {
      expect(await forwardedText('I want to build a tagging feature in karlbaria/factory-shop'))
        .toBe('submit karlbaria/factory-shop I want to build a tagging feature');
    });

    test('a Confluence page URL is never taken as owner/repo', async () => {
      const url = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Wishlist+PRD';
      expect(await forwardedText(`plan from <${url}> in karlbaria/factory-shop`))
        .toBe(`submit karlbaria/factory-shop plan from <${url}>`);
    });

    test('a Confluence page URL with no repo forwards the whole text (channel default)', async () => {
      const url = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867';
      expect(await forwardedText(`plan from <${url}>`)).toBe(`submit plan from <${url}>`);
    });
  });

  // #92: file paths are never repo candidates, and `submit <owner/repo>` wins.
  describe('repo detection with file paths (#92)', () => {
    function mockSlack(): void {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
    }

    async function mention(text: string): Promise<void> {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: { type: 'app_mention', user: 'U1', channel: 'C1', text: `<@BOT> ${text}`, ts: '1234.0200' },
      });
      const result = await handler(signedEvent(body));
      expect(result.statusCode).toBe(200);
    }

    async function forwardedText(text: string): Promise<string> {
      mockSlack();
      lambdaSend.mockResolvedValueOnce({});
      await mention(text);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const [invokeCmd] = lambdaSend.mock.calls[0];
      return JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload)).text;
    }

    function clarifyReply(): string | undefined {
      const call = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage')
          && String((opts as { body: string }).body).includes('more than one repo-looking name'),
      );
      return call ? JSON.parse((call[1] as { body: string }).body).text : undefined;
    }

    const FAILING = 'In karlbaria/factory-shop, add a product detail page: the component goes in '
      + 'frontend/src/pages/ProductDetail.jsx and the build output in frontend/dist/';

    test('reported message 1: one repo plus frontend/src and frontend/dist paths resolves to the repo', async () => {
      expect(await forwardedText(FAILING)).toBe(
        'submit karlbaria/factory-shop add a product detail page: the component goes in '
        + 'frontend/src/pages/ProductDetail.jsx and the build output in frontend/dist/',
      );
      expect(clarifyReply()).toBeUndefined();
    });

    test('reported message 2: the same message with a submit karlbaria/factory-shop prefix', async () => {
      expect(await forwardedText(`submit karlbaria/factory-shop ${FAILING}`))
        .toBe(`submit karlbaria/factory-shop ${FAILING}`);
      expect(clarifyReply()).toBeUndefined();
    });

    test('submit <owner/repo> wins over bare two-segment paths and other repo names', async () => {
      expect(await forwardedText('submit karlbaria/factory-shop move frontend/src to frontend/dist, like org/other does'))
        .toBe('submit karlbaria/factory-shop move frontend/src to frontend/dist, like org/other does');
      expect(clarifyReply()).toBeUndefined();
    });

    test('one real repo plus several paths resolves to that repo', async () => {
      expect(await forwardedText('In karlbaria/factory-shop, update backend/app/main.py, ./scripts/build and frontend/index.html'))
        .toBe('submit karlbaria/factory-shop update backend/app/main.py, ./scripts/build and frontend/index.html');
    });

    test('two real repos plus paths still ask which one, and do not forward', async () => {
      mockSlack();
      await mention('port frontend/src/App.jsx from karlbaria/factory-sandbox-py to karlbaria/factory-shop');
      expect(lambdaSend).not.toHaveBeenCalled();
      const reply = clarifyReply();
      expect(reply).toContain('`karlbaria/factory-sandbox-py`, `karlbaria/factory-shop`');
      expect(reply).not.toContain('frontend/src');
    });

    test('only paths, no repo, falls back to the channel default', async () => {
      expect(await forwardedText('fix the layout in frontend/src/App.jsx and frontend/dist/'))
        .toBe('submit fix the layout in frontend/src/App.jsx and frontend/dist/');
    });

    test('plan from <Confluence URL> in owner/repo resolves the repo and never reads the URL', async () => {
      const url = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Wishlist+PRD';
      expect(await forwardedText(`plan from <${url}> in karlbaria/factory-shop`))
        .toBe(`submit karlbaria/factory-shop plan from <${url}>`);
      expect(clarifyReply()).toBeUndefined();
    });
  });

  // Two real, non-URL-path candidates — don't guess; ask in-thread instead.
  test('asks for clarification in-thread when more than one repo candidate remains, and does not forward', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> port the fix from karlbaria/factory-sandbox-py to karlbaria/factory-shop',
        ts: '1234.0003',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    // Not forwarded to the processor — the ambiguity is resolved (or not) in-thread.
    expect(lambdaSend).not.toHaveBeenCalled();
    const clarifyCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage')
        && String((opts as { body: string }).body).includes('more than one repo-looking name'),
    );
    expect(clarifyCall).toBeTruthy();
    const clarifyBody = JSON.parse((clarifyCall![1] as { body: string }).body);
    expect(clarifyBody.text).toContain('karlbaria/factory-sandbox-py');
    expect(clarifyBody.text).toContain('karlbaria/factory-shop');
  });

  // A URL path with no real repo mention — zero candidates after exclusion,
  // same "forward the whole text" fallback as the no-repo case.
  test('a message with only a URL path and no real repo falls back like the no-repo case', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix the bug described at /api/products/count',
        ts: '1234.0004',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.text).toBe('submit fix the bug described at /api/products/count');
  });

  test('app_mention without repo is forwarded to the processor (channel-default fallback)', async () => {
    // The events handler no longer answers no-repo mentions inline — it forwards
    // them so the processor can apply the channel's onboarded default repo (and,
    // only if there is none, reply with guidance). The whole text is forwarded
    // as the submit description.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> just a question', ts: '1.0' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    // Forwarded to the processor rather than answered inline.
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const invokePayload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(invokePayload.text).toBe('submit just a question');
    // No inline "Please include a repo" reply from the events handler.
    const postedReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(postedReply).toBeFalsy();
  });

  test('app_mention with Lambda invoke failure swaps :eyes: to :x:', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockRejectedValueOnce(new Error('lambda outage'));
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix org/repo',
        ts: '1.0',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200); // Still 200 — Slack retries give a second chance
    // Should have swapped reaction: remove :eyes:, add :x:, then post error message
    const removeCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.remove') && String((opts as { body: string }).body).includes('eyes'),
    );
    const addCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.add') && String((opts as { body: string }).body).includes('"name":"x"'),
    );
    const errorReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Something went wrong'),
    );
    expect(removeCall).toBeTruthy();
    expect(addCall).toBeTruthy();
    expect(errorReply).toBeTruthy();
  });
});
