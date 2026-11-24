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
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
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

// Task 13 (fork): the repo's default_workflow lookup. Mocked as its own
// module (not via ddbSend) so it doesn't shift the ddbSend call-order
// sequencing every other test in this file depends on.
const lookupRepoMock = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  lookupRepo: (...args: unknown[]) => lookupRepoMock(...args),
}));

// #82 PR 2a: the PRD page read (its own checks are in confluence-prd.test.ts).
const readPrdPageMock = jest.fn();
jest.mock('../../src/handlers/shared/confluence-prd', () => ({
  ...jest.requireActual('../../src/handlers/shared/confluence-prd'),
  readPrdPage: (...args: unknown[]) => readPrdPageMock(...args),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';

import { handler, type MentionEvent, type SlashCommandEvent } from '../../src/handlers/slack-command-processor';

function mention(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    source: 'mention',
    text: 'submit org/repo fix the bug',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    mention_thread_ts: '1000.0001',
    ...overrides,
  };
}

function slashCommand(overrides: Partial<SlashCommandEvent> = {}): SlashCommandEvent {
  return {
    source: 'slash',
    text: 'help',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    command: '/bgagent',
    user_name: 'u',
    team_domain: 'acme',
    channel_name: 'general',
    trigger_id: 'T.1',
    response_url: 'https://hooks.slack.com/cmd/X',
    ...overrides,
  };
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-command-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    createTaskCoreMock.mockReset();
    readPrdPageMock.mockReset();
    // Default: no per-repo default_workflow — tasks pin CODING_WORKFLOW_ID,
    // unchanged from before Task 13 (fork). Overridden per-case below.
    lookupRepoMock.mockReset();
    lookupRepoMock.mockResolvedValue({ onboarded: true, config: null });
    smSend.mockResolvedValue({ SecretString: 'xoxb-bot' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  test('slash command without source flag defaults to slash and falls through to default branch', async () => {
    // Legacy shape: no source field — slash ack lambda forwards raw SlackCommandPayload
    const legacy = {
      command: '/bgagent',
      text: 'unknown_sub',
      user_id: 'U1',
      team_id: 'T1',
      channel_id: 'C1',
      user_name: '',
      team_domain: '',
      channel_name: '',
      trigger_id: '',
      response_url: 'https://hooks.slack.com/cmd/X',
    };
    await handler(legacy);
    // Posted the default "Use @Shoof" hint back to the response_url
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('Use `@Shoof`'),
    );
    expect(posted).toBeTruthy();
  });

  test('slash submit tells user to use @mention', async () => {
    await handler(slashCommand({ text: 'submit org/repo fix' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Use `@Shoof` to submit tasks'),
    );
    expect(posted).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit requires linked account (prompts /bgagent link)', async () => {
    // 1. User mapping lookup: not found
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    // 2. swapReaction → getBotToken → installation lookup (for :x: swap)
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo and no channel default replies with guidance', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // channel-default lookup returns a row without a repo → no default; then
    // swapReaction → getBotToken installation lookup.
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default and uses full text as description', async () => {
    // 1. user mapping → linked
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // 2. channel-default lookup → active mapping to org/defaultrepo
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/defaultrepo' } });
    // 3. checkChannelAccess installation lookup (+ bot token secret)
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/defaultrepo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit fix the spacing on the header' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/defaultrepo');
    expect(reqBody.issue_number).toBeUndefined();
    // The whole message is the description — the first token is NOT dropped.
    expect(reqBody.task_description).toBe('fix the spacing on the header');
  });

  test('mention submit with no repo fails open when the channel lookup throws', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // channel-default lookup throws → fail open → no default → guidance reply
    ddbSend.mockRejectedValueOnce(new Error('ddb blip'));
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit fix the bug' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
  });

  test('mention submit creates task via createTaskCore', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // Installation lookup for bot token (checkChannelAccess) + bot token secret
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    // fetch: conversations.info response (public channel with bot as member)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK123', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo#42 add validation' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.issue_number).toBe(42);
    expect(reqBody.task_description).toBe('add validation');
    // Must pin the coding workflow — an absent workflow_ref falls through the
    // resolution ladder to default/agent-v1, which never opens a PR. Mirrors
    // the Jira processor.
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(ctx.channelSource).toBe('slack');
    expect(ctx.userId).toBe('cognito-1');
    // mention_thread_ts flows to channel_metadata
    expect(ctx.channelMetadata.slack_thread_ts).toBe('1000.0001');
  });

  // Task 13 (fork): the repo's own default_workflow wins over CODING_WORKFLOW_ID.
  test('mention submit pins the repo default_workflow when the repo config has one', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    lookupRepoMock.mockResolvedValueOnce({
      onboarded: true,
      config: { repo: 'org/repo', status: 'active', default_workflow: 'coding/new-task-adversarial-v1' },
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK123', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo#42 add validation' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.workflow_ref).toBe('coding/new-task-adversarial-v1');
  });

  // ─── Task 15 (fork), #82: research and planning intents ───────────────────

  function mockLinkedPublicChannel(): void {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK82', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
  }

  test.each([
    ['submit org/repo research product search UX in', 'knowledge/web-research-v1', 'product search UX'],
    ['submit org/repo Research: caching options', 'knowledge/web-research-v1', 'caching options'],
    ['submit org/repo I want to build a tagging feature in', 'knowledge/feature-planning-v1', 'a tagging feature'],
    ['submit org/repo plan product tags for', 'knowledge/feature-planning-v1', 'product tags'],
  ])('"%s" runs %s with the keyword and trailing preposition stripped', async (text, workflowRef, description) => {
    mockLinkedPublicChannel();
    // The intent's workflow wins even over a repo default_workflow.
    lookupRepoMock.mockResolvedValueOnce({
      onboarded: true,
      config: { repo: 'org/repo', status: 'active', default_workflow: 'coding/new-task-adversarial-v1' },
    });
    await handler(mention({ text }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.workflow_ref).toBe(workflowRef);
    expect(reqBody.task_description).toBe(description);
  });

  test('a near-miss ("planning is broken in checkout") stays on the repo default', async () => {
    mockLinkedPublicChannel();
    await handler(mention({ text: 'submit org/repo planning is broken in checkout' }));
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(reqBody.task_description).toBe('planning is broken in checkout');
  });

  test('planning with no repo uses the channel default', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/defaultrepo' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/defaultrepo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit I want to build a tagging feature' }));
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/defaultrepo');
    expect(reqBody.workflow_ref).toBe('knowledge/feature-planning-v1');
    expect(reqBody.task_description).toBe('a tagging feature');
  });

  test.each([
    ['submit research caching options', 'Research needs a repo'],
    ['submit I want to build a tagging feature', 'Planning needs a repo'],
    ['submit plan product tags', 'Planning needs a repo'],
  ])('"%s" with no repo and no channel default explains why a repo is needed', async (text, expected) => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes(expected),
    );
    expect(reply).toBeTruthy();
  });

  // ─── #82 PR 2a: plan from an existing Confluence PRD ──────────────────────

  const PRD_URL = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Wishlist+PRD';
  const SHOP_CONFIG = {
    repo: 'karlbaria/factory-shop', status: 'active', confluence_cloud_id: 'cloud-1', confluence_space_key: 'SD',
  };

  function postedTexts(): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).includes('chat.postMessage'))
      .map(([, opts]) => JSON.parse((opts as { body: string }).body).text as string);
  }

  test('"plan from <url>" hands the screened PRD to planning between the markers', async () => {
    mockLinkedPublicChannel();
    lookupRepoMock.mockResolvedValueOnce({ onboarded: true, config: SHOP_CONFIG });
    readPrdPageMock.mockResolvedValueOnce({
      ok: true, pageUrl: PRD_URL, title: 'Wishlist PRD', text: 'Customers lose items they like.', truncated: false,
    });
    await handler(mention({ text: `submit karlbaria/factory-shop plan from <${PRD_URL}>` }));
    expect(readPrdPageMock).toHaveBeenCalledWith(PRD_URL, SHOP_CONFIG);
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('karlbaria/factory-shop');
    expect(reqBody.workflow_ref).toBe('knowledge/feature-planning-v1');
    const description = reqBody.task_description as string;
    expect(description).toContain(`PRD page ${PRD_URL}`);
    expect(description).toMatch(/<<<BEGIN_PRD_PAGE>>>\nTitle: Wishlist PRD\n\nCustomers lose items they like\.\n<<<END_PRD_PAGE>>>$/);
    expect(postedTexts().some((t) => t.includes('longer than'))).toBe(false);
  });

  test('a note after the link travels outside the markers', async () => {
    mockLinkedPublicChannel();
    lookupRepoMock.mockResolvedValueOnce({ onboarded: true, config: SHOP_CONFIG });
    readPrdPageMock.mockResolvedValueOnce({ ok: true, pageUrl: PRD_URL, title: 'T', text: 'Body.', truncated: false });
    await handler(mention({ text: `submit karlbaria/factory-shop plan from <${PRD_URL}|PRD>, mobile first` }));
    const description = createTaskCoreMock.mock.calls[0][0].task_description as string;
    expect(description.split('<<<BEGIN_PRD_PAGE>>>')[0]).toContain("Requester's note: mobile first");
  });

  test('an oversized PRD is planned from its first part, with a visible note', async () => {
    mockLinkedPublicChannel();
    lookupRepoMock.mockResolvedValueOnce({ onboarded: true, config: SHOP_CONFIG });
    readPrdPageMock.mockResolvedValueOnce({ ok: true, pageUrl: PRD_URL, title: 'T', text: 'x'.repeat(8000), truncated: true });
    // The truncation reply looks up the bot token again.
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: `submit karlbaria/factory-shop plan from <${PRD_URL}>` }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].task_description).toContain('only the first 8,000 are included');
    expect(postedTexts().some((t) => t.includes('longer than 8,000 characters'))).toBe(true);
  });

  test.each([
    ['other_space', "I can only read PRD pages in this repo's Confluence space (SD)."],
    ['other_host', 'I can only read PRD pages on karlvb.atlassian.net.'],
    ['blocked', "That PRD page was blocked by content policy, so I didn't use it."],
    ['screening_unavailable', "Content screening is unavailable, so I can't use that PRD page right now."],
  ])('a rejected PRD (%s) creates no task and says why', async (reason, message) => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    lookupRepoMock.mockResolvedValueOnce({ onboarded: true, config: SHOP_CONFIG });
    readPrdPageMock.mockResolvedValueOnce({ ok: false, reason, message });
    await handler(mention({ text: `submit karlbaria/factory-shop plan from <${PRD_URL}>` }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(postedTexts()).toContain(`:x: Task not created. ${message}`);
    expect(fetchMock.mock.calls.some(([url, opts]) => String(url).includes('reactions.add')
      && JSON.parse((opts as { body: string }).body).name === 'x')).toBe(true);
  });

  test('an ordinary plan message reads no page', async () => {
    mockLinkedPublicChannel();
    await handler(mention({ text: 'submit org/repo plan a tagging feature' }));
    expect(readPrdPageMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock.mock.calls[0][0].task_description).toBe('a tagging feature');
  });

  test('mention submit in private channel bot is not in — replies with invite hint', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('private channel'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit fails open on transient Slack errors (ratelimited, internal_error)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    // conversations.info returns a non-hard failure — task creation should proceed.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('link subcommand persists pending mapping with a link code', async () => {
    ddbSend.mockResolvedValueOnce({}); // Put pending mapping
    await handler(slashCommand({ text: 'link' }));
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toMatch(/^pending#/);
    expect(putCall![0].input.Item.status).toBe('pending');
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('bgagent slack link'),
    );
    expect(posted).toBeTruthy();
  });

  test('help subcommand replies with usage text', async () => {
    await handler(slashCommand({ text: 'help' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Using Shoof'),
    );
    expect(posted).toBeTruthy();
    // Task 15 (fork), #82: both new forms are documented.
    const body = String((posted![1] as { body: string }).body);
    expect(body).toContain('research <topic> in org/repo');
    expect(body).toContain('I want to build <feature> in org/repo');
  });

  // ─── Slack file attachment extraction ────────────────────────────────────────

  describe('file attachments', () => {
    beforeEach(() => {
      // Standard setup: linked user, public channel
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
    });

    test('downloads Slack files and passes as inline attachments', async () => {
      // fetch for file download
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('file content')),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({
        text: 'submit org/repo fix the bug',
        files: [{
          id: 'F1',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/screenshot.png',
        }],
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0].type).toBe('image');
      expect(reqBody.attachments[0].content_type).toBe('image/png');
      expect(reqBody.attachments[0].filename).toBe('screenshot.png');
      expect(reqBody.attachments[0].data).toBe(Buffer.from('file content').toString('base64'));
    });

    test('rejects files with unsupported MIME types', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'virus.exe',
          mimetype: 'application/x-executable',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/virus.exe',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('unsupported type'),
      );
      expect(reply).toBeTruthy();
    });

    test('rejects files exceeding 10 MB size limit', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'huge.png',
          mimetype: 'image/png',
          size: 11 * 1024 * 1024, // 11 MB
          url_private_download: 'https://files.slack.com/files/F1/huge.png',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('too large'),
      );
      expect(reply).toBeTruthy();
    });

    test('reports all file errors atomically', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [
          { id: 'F1', name: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, url_private_download: 'https://files.slack.com/files/F1/big.png' },
          { id: 'F2', name: 'bad.exe', mimetype: 'application/x-executable', size: 100, url_private_download: 'https://files.slack.com/files/F2/bad.exe' },
        ],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('2 attachment errors'),
      );
      expect(reply).toBeTruthy();
    });

    test('proceeds without attachments when no files are present', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      await handler(mention({ text: 'submit org/repo fix' }));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });
  });
});
