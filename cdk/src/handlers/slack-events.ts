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

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { slackFetch } from './shared/slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';
import { makeClient, makeDocClient } from './shared/ua';
import type { MentionEvent, SlackFileRef } from './slack-command-processor';

const ddb = makeDocClient();
const sm = makeClient(SecretsManagerClient);
const lambdaClient = makeClient(LambdaClient);

const TABLE_NAME = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const PROCESSOR_FUNCTION_NAME = process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME;

/** Secret recovery window for revoked installations. */
const SECRET_RECOVERY_DAYS = 7;

interface SlackEventPayload {
  readonly type: string;
  readonly challenge?: string;
  readonly token?: string;
  readonly team_id?: string;
  readonly event?: {
    readonly type: string;
    readonly user?: string;
    readonly text?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly [key: string]: unknown;
  };
}

/**
 * POST /v1/slack/events — Handle Slack Events API requests.
 *
 * Handles:
 * - `url_verification` challenge (Slack sends this when the event URL is configured)
 * - `app_uninstalled` event (mark installation revoked, delete bot token)
 * - `tokens_revoked` event (same cleanup)
 */
/** Event types where retries are idempotent and must be re-processed. */
const RETRY_ALLOWED_EVENT_TYPES = new Set(['app_uninstalled', 'tokens_revoked']);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret for every request — including url_verification.
    // Slack signs all requests; skipping verification exposes the endpoint.
    // The only reason to bypass is initial setup before the signing secret is populated.
    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);

    if (!signingSecret) {
      // Secret hasn't been populated yet — allow url_verification so the Slack App can be
      // wired up during initial setup, but reject anything else.
      logger.warn('Slack signing secret not populated — bypassing verification for url_verification only');
      const payload: SlackEventPayload = JSON.parse(event.body);
      if (payload.type === 'url_verification' && payload.challenge) {
        return jsonResponse(200, { challenge: payload.challenge });
      }
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack event signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    const payload: SlackEventPayload = JSON.parse(event.body);

    // URL verification challenge — Slack sends this when configuring the event URL.
    if (payload.type === 'url_verification' && payload.challenge) {
      return jsonResponse(200, { challenge: payload.challenge });
    }

    // Slack retries events if we don't respond within 3 seconds. Ack retries
    // immediately for user-facing events (mentions, DMs) to prevent duplicate task
    // creation — the idempotency cost of processing the same app_mention twice is
    // a double-submit. For security-critical revocation events, we MUST process
    // retries so a transient failure on first delivery doesn't leave the workspace
    // with a live bot token after uninstall.
    const retryNum = event.headers['X-Slack-Retry-Num'] ?? event.headers['x-slack-retry-num'];
    const eventType = payload.type === 'event_callback' ? payload.event?.type : undefined;
    if (retryNum && !(eventType && RETRY_ALLOWED_EVENT_TYPES.has(eventType))) {
      logger.info('Acknowledging Slack retry without reprocessing', { retry_num: retryNum, event_type: eventType });
      return jsonResponse(200, { ok: true });
    }

    // Dispatch by event type.
    if (payload.type === 'event_callback' && payload.event) {
      const teamId = payload.team_id;

      if ((eventType === 'app_uninstalled' || eventType === 'tokens_revoked') && teamId) {
        await revokeInstallation(teamId);
      } else if (eventType === 'app_mention' && teamId) {
        await handleAppMention(payload.event, teamId);
      } else if (eventType === 'message' && teamId && payload.event.channel_type === 'im') {
        // DMs to the bot — skip bot's own messages to avoid loops.
        if (!payload.event.bot_id) {
          await handleAppMention(payload.event, teamId);
        }
      } else {
        logger.info('Unhandled Slack event type', { event_type: eventType, team_id: teamId });
      }
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('Slack event handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

async function handleAppMention(
  event: NonNullable<SlackEventPayload['event']>,
  teamId: string,
): Promise<void> {
  if (!PROCESSOR_FUNCTION_NAME) {
    logger.warn('SLACK_COMMAND_PROCESSOR_FUNCTION_NAME not set, ignoring app_mention');
    return;
  }

  const userId = event.user;
  const channelId = event.channel;
  const rawText = event.text ?? '';
  const messageTs = event.ts;
  const threadTs = event.thread_ts;

  if (!userId || !channelId) {
    logger.warn('app_mention missing user or channel', { event });
    return;
  }

  // Strip the @mention prefix (e.g. "<@U12345> fix the bug" → "fix the bug").
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) {
    logger.info('app_mention with empty text after stripping mention, ignoring');
    return;
  }

  // React with :eyes: immediately so the user knows the bot saw their message.
  const mentionTs = threadTs ?? messageTs;
  const botToken = mentionTs ? await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`) : null;
  if (botToken && mentionTs) {
    await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
  }

  // Build a payload compatible with the command processor.
  // Use source: 'mention' so the processor knows there's no response_url —
  // it should use chat.postMessage with the bot token instead.
  //
  // For natural language mentions like "@Shoof fix the bug in org/repo#42",
  // extract the repo pattern and reorder so submit gets "org/repo#42 fix the bug".
  // The submit handler expects: submit <repo> <description...>
  //
  // When no repo is present we still forward the mention (rather than erroring
  // here): the processor falls back to the channel's onboarded default repo
  // (`bgagent slack onboard-channel`), and only replies with guidance if no
  // default exists. Keeping that decision in one place (the processor) avoids
  // duplicating the channel-mapping lookup in the events handler.
  //
  // `extractRepoCandidates` excludes a match that's actually a deeper segment
  // of a longer path (e.g. "api/products" lifted out of the URL
  // "/api/products/count") — see its doc comment. Two or more surviving
  // candidates is genuine ambiguity (two real-looking repo names in one
  // message): rather than guess, ask in-thread which one was meant and don't
  // forward to the processor at all.
  const repoCandidates = extractRepoCandidates(text);
  if (repoCandidates.length > 1) {
    if (botToken && mentionTs) {
      await slackFetch(botToken, 'chat.postMessage', {
        channel: channelId,
        thread_ts: mentionTs,
        text: `:thinking_face: I see more than one repo-looking name in that message — which did you mean? ${repoCandidates.map((c) => `\`${c}\``).join(', ')}\nReply with \`@Shoof submit <owner/repo> <description>\` to be explicit.`,
      });
    }
    logger.info('app_mention has ambiguous repo candidates — asked for clarification instead of guessing', {
      team_id: teamId,
      channel_id: channelId,
      candidates: repoCandidates,
    });
    return;
  }

  let commandText: string;
  if (repoCandidates.length === 1) {
    const repo = repoCandidates[0];
    const description = text.replace(repo, '').replace(/\s+/g, ' ').trim();
    commandText = `submit ${repo} ${description}`.trim();
  } else {
    // No repo token — forward the whole text; the processor treats it as the
    // task description against the channel default repo (or replies with help).
    commandText = `submit ${text}`;
  }

  // Extract file references from the Slack event (if any attached)
  const rawFiles = Array.isArray(event.files) ? event.files as Array<Record<string, unknown>> : [];
  const files: SlackFileRef[] = rawFiles
    .filter(f => typeof f.url_private_download === 'string' && typeof f.name === 'string')
    .map(f => ({
      id: String(f.id ?? ''),
      name: String(f.name),
      mimetype: String(f.mimetype ?? 'application/octet-stream'),
      size: typeof f.size === 'number' ? f.size : 0,
      url_private_download: String(f.url_private_download),
    }));

  const mentionPayload: MentionEvent = {
    text: commandText,
    user_id: userId,
    team_id: teamId,
    channel_id: channelId,
    source: 'mention',
    mention_thread_ts: mentionTs,
    ...(files.length > 0 && { files }),
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: PROCESSOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(mentionPayload)),
    }));
    logger.info('app_mention forwarded to command processor', {
      team_id: teamId,
      user_id: userId,
      channel_id: channelId,
      text_length: text.length,
    });
  } catch (err) {
    logger.error('Failed to invoke command processor for app_mention', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Mirror the no-repo-found failure UX: swap :eyes: to :x: and reply in thread
    // so the user isn't left staring at a stuck :eyes: reaction forever.
    if (botToken && mentionTs) {
      await slackFetch(botToken, 'reactions.remove', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'x' });
      await slackFetch(botToken, 'chat.postMessage', {
        channel: channelId,
        thread_ts: mentionTs,
        text: ':x: Something went wrong forwarding your request. Please try again.',
      });
    }
  }
}

/** Pattern for an "owner/repo" or "owner/repo#N" candidate inside free text. */
const REPO_CANDIDATE_PATTERN = /\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:#\d+)?)\b/g;

/**
 * Candidate "owner/repo[#N]" tokens found in free text, in order of first
 * appearance, de-duplicated. Excludes a match that's actually a deeper
 * segment of a longer path rather than a real repo mention — e.g.
 * "api/products" lifted out of the URL path "/api/products/count" — detected
 * by the character immediately before the match being a "/".
 */
function extractRepoCandidates(text: string): string[] {
  const pattern = new RegExp(REPO_CANDIDATE_PATTERN);
  const seen = new Set<string>();
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (text[match.index - 1] === '/') continue;
    const token = match[1];
    if (seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
  }
  return candidates;
}

async function revokeInstallation(teamId: string): Promise<void> {
  const now = new Date().toISOString();

  // Mark the installation record as revoked FIRST. If this fails we must not
  // delete the bot token, or the DB will still show status=active while the
  // token is gone — every subsequent Slack call would then fail with "secret
  // not found." Let Slack retry the revocation event in that case.
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { team_id: teamId },
      UpdateExpression: 'SET #s = :revoked, updated_at = :now, revoked_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now },
    }));
  } catch (err) {
    logger.error('Failed to mark Slack installation revoked — bot token left in place for retry', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Schedule the bot token secret for deletion. Failure here is recoverable
  // on retry (the DDB row is already revoked, so the next delivery just re-tries
  // this step).
  try {
    await sm.send(new DeleteSecretCommand({
      SecretId: `${SLACK_SECRET_PREFIX}${teamId}`,
      RecoveryWindowInDays: SECRET_RECOVERY_DAYS,
    }));
    logger.info('Slack installation revoked', { team_id: teamId });
  } catch (err) {
    logger.warn('Failed to delete Slack bot token secret', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
