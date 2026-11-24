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

/**
 * The planning draft's Approve, Confirm and Cancel buttons (Task 15 (fork),
 * #82 PR 3b-1). Runs in the Slack command processor, invoked asynchronously by
 * the interactions handler so Slack gets its answer within 3 seconds.
 *
 * - Only the requesting PM, still linked to the same platform user, may act;
 *   anyone else gets an ephemeral "only the requester" reply.
 * - Approve re-reads the plan page as it is now (never the agent's original
 *   output), parses it into a fixed structure and checks it. Each problem is
 *   posted in the thread; the PM fixes it in Confluence and clicks again.
 * - A large plan (decision 11) needs a second confirmation, bound to a digest
 *   of the stories, so an edit after the question is asked means asking again.
 * - In this PR a passing check files nothing: it says filing arrives in the
 *   next update. Cancel files nothing and leaves the page alone.
 *
 * Page content is untrusted data: it is parsed, never sent to a model, and
 * escaped before any of it is posted to Slack.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PlanPageReadResult } from './confluence-prd';
import { logger } from './logger';
import {
  checkPlan,
  estimatedPlanCostUsd,
  isLargePlan,
  parsePlan,
  PLAN_PAGE_MAX_CHARS,
  planDigest,
  planStorageToText,
  type PlanProblem,
} from './plan-parse';
import {
  cancelPlanningSession,
  claimApprovalLease,
  getPlanningSession,
  releaseApprovalLease,
  type PlanAction,
  type PlanningSession,
} from './planning-session';
import type { RepoConfig } from './repo-config';
import { renderPlanConfirmation, type SlackMessage } from './slack-blocks';
import { escapeSlackText } from './slack-format';

/** The event the interactions handler sends the command processor. */
export interface PlanActionEvent {
  readonly source: 'plan_action';
  readonly action: PlanAction;
  readonly session_id: string;
  /** From the signed interaction payload. */
  readonly team_id: string;
  /** From the signed interaction payload. */
  readonly user_id: string;
  readonly response_url: string;
}

/** The seams {@link handlePlanAction} calls out through; the processor wires the real ones. */
export interface PlanActionDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => Date;
  readonly lookupPlatformUser: (teamId: string, userId: string) => Promise<string | null>;
  readonly lookupRepoConfig: (repo: string) => Promise<Pick<RepoConfig, 'confluence_cloud_id' | 'confluence_space_key'> | null>;
  readonly readPlanPage: (
    pageId: string,
    mapping: Pick<RepoConfig, 'confluence_cloud_id' | 'confluence_space_key'> | null,
  ) => Promise<PlanPageReadResult>;
  /** Post in the plan's Slack thread. */
  readonly postInThread: (session: PlanningSession, message: SlackMessage) => Promise<void>;
  /** Reply only to the clicker. */
  readonly replyEphemeral: (responseUrl: string, text: string) => Promise<void>;
}

/** Most problems listed in one thread message. */
const MAX_LISTED_PROBLEMS = 20;

export const ONLY_REQUESTER_TEXT = ':no_entry: Only the requester can approve this plan.';
export const CHECK_PASSED_TEXT = 'Check passed — filing arrives in the next update';

function plain(text: string): SlackMessage {
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function closedText(session: PlanningSession | null): string {
  if (!session) return ':hourglass: This plan has expired or no longer exists. Ask me to plan it again.';
  switch (session.state) {
    case 'cancelled':
      return ':no_entry_sign: This plan was cancelled.';
    case 'filed':
      return ':white_check_mark: This plan has already been filed.';
    case 'approving':
      return ':hourglass_flowing_sand: I\'m already checking this plan. Give it a moment.';
    default:
      return ':hourglass_flowing_sand: This plan is busy. Please try again in a moment.';
  }
}

/** The thread message for a failed check: each problem, escaped. */
function problemsMessage(problems: readonly PlanProblem[]): SlackMessage {
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).map((p) => `• ${escapeSlackText(p.message)}`);
  if (problems.length > MAX_LISTED_PROBLEMS) listed.push(`• …and ${problems.length - MAX_LISTED_PROBLEMS} more.`);
  const text = ':warning: *The plan isn\'t ready to file yet.* Fix these in Confluence, then click Approve again:\n'
    + listed.join('\n');
  return { text: 'The plan isn\'t ready to file yet.', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/**
 * Handle one plan button click. Never throws: every outcome is a Slack reply,
 * so the async invocation is never retried into a second check.
 */
export async function handlePlanAction(event: PlanActionEvent, deps: PlanActionDeps): Promise<void> {
  try {
    await handle(event, deps);
  } catch (err) {
    logger.error('Plan action failed', {
      action: event.action,
      session_id: event.session_id,
      error: err instanceof Error ? err.message : String(err),
    });
    await deps.replyEphemeral(event.response_url, ':x: Something went wrong while handling that. Please try again.');
  }
}

async function handle(event: PlanActionEvent, deps: PlanActionDeps): Promise<void> {
  const nowSeconds = (): number => Math.floor(deps.now().getTime() / 1000);
  const session = await getPlanningSession(deps.ddb, deps.tableName, event.session_id, nowSeconds());
  if (!session) {
    await deps.replyEphemeral(event.response_url, closedText(null));
    return;
  }

  // Only the requester, by the signed Slack identity, and still linked to the
  // same platform user as when they asked.
  if (event.team_id !== session.slack_team_id || event.user_id !== session.slack_user_id) {
    logger.info('Plan action by someone other than the requester', { session_id: session.session_id, action: event.action });
    await deps.replyEphemeral(event.response_url, ONLY_REQUESTER_TEXT);
    return;
  }
  const platformUserId = await deps.lookupPlatformUser(event.team_id, event.user_id);
  if (platformUserId !== session.platform_user_id) {
    logger.warn('Plan requester is no longer linked to the same platform user', { session_id: session.session_id });
    await deps.replyEphemeral(
      event.response_url,
      ':link: Your Slack account is no longer linked to the account that requested this plan, so I can\'t act on it.',
    );
    return;
  }

  if (event.action === 'cancel') {
    if (await cancelPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds())) {
      await deps.postInThread(session, plain(':no_entry_sign: Plan cancelled. Nothing was filed, and the Confluence page is unchanged.'));
    } else {
      const current = await getPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds());
      await deps.replyEphemeral(event.response_url, closedText(current));
    }
    return;
  }

  const leaseSince = nowSeconds();
  if (!await claimApprovalLease(deps.ddb, deps.tableName, session.session_id, leaseSince)) {
    const current = await getPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds());
    await deps.replyEphemeral(event.response_url, closedText(current));
    return;
  }

  // From here the lease is ours; give it back whatever happens, recording a
  // pending confirmation's digest when there is one.
  let confirmDigest: string | null = null;
  try {
    confirmDigest = await checkAndGate(event.action, session, deps);
  } finally {
    await releaseApprovalLease(deps.ddb, deps.tableName, session.session_id, leaseSince, confirmDigest);
  }
}

/**
 * Re-read, parse and check the plan, then either post the problems, ask for
 * the large-plan confirmation, or report a passing check. Returns the digest
 * a pending confirmation is bound to, or null.
 */
async function checkAndGate(action: PlanAction, session: PlanningSession, deps: PlanActionDeps): Promise<string | null> {
  const mapping = await deps.lookupRepoConfig(session.repo);
  const page = await deps.readPlanPage(session.page_id, mapping);
  if (!page.ok) {
    await deps.postInThread(session, plain(`:warning: ${escapeSlackText(page.message)}`));
    return null;
  }

  const text = planStorageToText(page.storage);
  if (text.length > PLAN_PAGE_MAX_CHARS) {
    await deps.postInThread(session, problemsMessage([{
      kind: 'page_too_large',
      message: `The plan page is longer than ${PLAN_PAGE_MAX_CHARS.toLocaleString('en-US')} characters, which is more than I can file from. Shorten it or split it into smaller plans.`,
    }]));
    return null;
  }

  const plan = parsePlan(text);
  const problems = checkPlan(plan);
  logger.info('Plan checked', {
    session_id: session.session_id,
    page_id: session.page_id,
    page_version: page.version,
    story_count: plan.stories.length,
    problem_kinds: problems.map((p) => p.kind),
  });
  if (problems.length > 0) {
    await deps.postInThread(session, problemsMessage(problems));
    return null;
  }

  const storyCount = plan.stories.length;
  const digest = planDigest(plan);
  if (isLargePlan(storyCount)) {
    const confirmed = action === 'confirm' && session.confirm_digest === digest;
    if (!confirmed) {
      const confirmation = renderPlanConfirmation(session.session_id, storyCount, estimatedPlanCostUsd(storyCount));
      if (action === 'confirm') {
        await deps.postInThread(session, plain(':pencil2: The stories changed since I asked you to confirm, so here are the new numbers.'));
      }
      await deps.postInThread(session, confirmation);
      return digest;
    }
  }

  const stories = storyCount === 1 ? '1 story' : `${storyCount} stories`;
  await deps.postInThread(session, plain(`:white_check_mark: ${CHECK_PASSED_TEXT}. The plan has ${stories} and nothing has been filed.`));
  return null;
}
