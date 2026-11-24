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
 * The planning buttons (Task 15 (fork), #82 PR 3b-1 and 3c). Runs in the
 * Slack command processor, invoked asynchronously by the interactions handler
 * so Slack gets its answer within 3 seconds.
 *
 * - Only the requesting PM, still linked to the same platform user, may act;
 *   anyone else gets an ephemeral "only the requester" reply.
 * - **Approve PRD** (a `prd` session) re-reads the PRD page as it is now,
 *   checks it is still a factory PRD in the mapped space and that every
 *   product question is answered, then starts the technical design through the
 *   same path as `plan from <url>` (page read, guardrail screening, planning
 *   task) and marks the PRD final.
 * - **Start** (a `design` session) re-reads the design page, parses it into a
 *   fixed structure and checks it. The "Technical design ready: N stories,
 *   about $X" message is the cost confirmation (decision 20): when the page no
 *   longer gives the numbers the latest message showed, Start asks again with
 *   the new ones. In this PR a passing check files nothing.
 * - Each problem is posted in the thread; the PM fixes it in Confluence and
 *   clicks again. Cancel changes nothing but the session.
 *
 * Page content is untrusted data: it is parsed, never sent to a model by this
 * module (the design task gets the PRD only after guardrail screening, as for
 * `plan from <url>`), and escaped before any of it is posted to Slack.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PlanningPageKind, PlanPageReadResult } from './confluence-page';
import { logger } from './logger';
import {
  checkPlan,
  checkPrd,
  designNumbersDigest,
  estimatedPlanCostUsd,
  parsePlan,
  parsePrd,
  PLAN_PAGE_MAX_CHARS,
  planStorageToText,
  type PlanProblem,
} from './plan-parse';
import {
  cancelPlanningSession,
  claimApprovalLease,
  completePrdApproval,
  getPlanningSession,
  releaseApprovalLease,
  type PlanAction,
  type PlanningSession,
} from './planning-session';
import type { RepoConfig } from './repo-config';
import { renderDesignConfirmation, type SlackMessage } from './slack-blocks';
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

type ConfluenceMapping = Pick<RepoConfig, 'confluence_cloud_id' | 'confluence_space_key'>;

/** What starting the design from an approved PRD did. */
export type StartDesignResult =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly message: string };

/** The seams {@link handlePlanAction} calls out through; the processor wires the real ones. */
export interface PlanActionDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => Date;
  readonly lookupPlatformUser: (teamId: string, userId: string) => Promise<string | null>;
  readonly lookupRepoConfig: (repo: string) => Promise<ConfluenceMapping | null>;
  readonly readPlanPage: (
    pageId: string,
    mapping: ConfluenceMapping | null,
    kind: PlanningPageKind,
  ) => Promise<PlanPageReadResult>;
  /**
   * Start the technical design from the approved PRD (#82 PR 3c): the
   * `plan from <url>` path's page read, screening and planning task, as the
   * requester, posting in the session's thread.
   */
  readonly startDesignFromPrd: (session: PlanningSession, mapping: ConfluenceMapping | null) => Promise<StartDesignResult>;
  /** Mark a page `factory-final`; false when that failed. */
  readonly markPageFinal: (pageId: string, mapping: ConfluenceMapping | null) => Promise<boolean>;
  /** Post in the session's Slack thread. */
  readonly postInThread: (session: PlanningSession, message: SlackMessage) => Promise<void>;
  /** Reply only to the clicker. */
  readonly replyEphemeral: (responseUrl: string, text: string) => Promise<void>;
}

/** Most problems listed in one thread message. */
const MAX_LISTED_PROBLEMS = 20;

export const ONLY_REQUESTER_TEXT = ':no_entry: Only the requester can use these buttons.';
export const CHECK_PASSED_TEXT = 'Check passed — filing arrives in the next update';
export const PRD_APPROVED_TEXT = 'PRD approved — writing the technical design';

function plain(text: string): SlackMessage {
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function isPrd(session: PlanningSession): boolean {
  return session.kind === 'prd';
}

function noun(session: PlanningSession | null): string {
  return session && isPrd(session) ? 'PRD' : 'design';
}

function closedText(session: PlanningSession | null): string {
  if (!session) return ':hourglass: This has expired or no longer exists. Ask me to plan it again.';
  switch (session.state) {
    case 'cancelled':
      return `:no_entry_sign: This ${noun(session)} was cancelled.`;
    case 'approved':
      return ':white_check_mark: This PRD has already been approved, and its technical design is on the way.';
    case 'filed':
      return ':white_check_mark: This design has already been filed.';
    case 'approving':
      return `:hourglass_flowing_sand: I'm already checking this ${noun(session)}. Give it a moment.`;
    default:
      return `:hourglass_flowing_sand: This ${noun(session)} is busy. Please try again in a moment.`;
  }
}

/** The thread message for a failed check: each problem, escaped. */
function problemsMessage(problems: readonly PlanProblem[], what: 'PRD' | 'design'): SlackMessage {
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).map((p) => `• ${escapeSlackText(p.message)}`);
  if (problems.length > MAX_LISTED_PROBLEMS) listed.push(`• …and ${problems.length - MAX_LISTED_PROBLEMS} more.`);
  const [headline, button] = what === 'PRD'
    ? ['The PRD isn\'t ready to approve yet.', 'Approve PRD']
    : ['The technical design isn\'t ready to start yet.', 'Start'];
  const text = `:warning: *${headline}* Fix these in Confluence, then click ${button} again:\n${listed.join('\n')}`;
  return { text: headline, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/**
 * Handle one planning button click. Never throws: every outcome is a Slack
 * reply, so the async invocation is never retried into a second check.
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
      ':link: Your Slack account is no longer linked to the account that made this request, so I can\'t act on it.',
    );
    return;
  }

  if (event.action === 'cancel') {
    if (await cancelPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds())) {
      const text = isPrd(session)
        ? ':no_entry_sign: PRD cancelled. No technical design will be written, and the Confluence page is unchanged.'
        : ':no_entry_sign: Technical design cancelled. Nothing was filed, and the Confluence page is unchanged.';
      await deps.postInThread(session, plain(text));
    } else {
      const current = await getPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds());
      await deps.replyEphemeral(event.response_url, closedText(current));
    }
    return;
  }

  // A PRD has only Approve PRD; Start and Confirm belong to a design.
  if (isPrd(session) && event.action !== 'approve') {
    logger.warn('Ignoring a design action on a PRD session', { session_id: session.session_id, action: event.action });
    return;
  }

  const leaseSince = nowSeconds();
  if (!await claimApprovalLease(deps.ddb, deps.tableName, session.session_id, leaseSince)) {
    const current = await getPlanningSession(deps.ddb, deps.tableName, session.session_id, nowSeconds());
    await deps.replyEphemeral(event.response_url, closedText(current));
    return;
  }

  // From here the lease is ours; give it back whatever happens (an approved
  // PRD has already moved the session on, so the release is then a no-op),
  // recording the digest of the numbers a new Start message showed.
  let confirmDigest: string | undefined;
  try {
    confirmDigest = isPrd(session)
      ? await approvePrd(session, leaseSince, deps)
      : await checkAndGateDesign(event.action, session, deps);
  } finally {
    await releaseApprovalLease(deps.ddb, deps.tableName, session.session_id, leaseSince, confirmDigest);
  }
}

/** The page's plain text, or null (with the problem posted) when it can't be used. */
async function readPageText(
  session: PlanningSession,
  mapping: ConfluenceMapping | null,
  kind: PlanningPageKind,
  deps: PlanActionDeps,
): Promise<string | null> {
  const page = await deps.readPlanPage(session.page_id, mapping, kind);
  if (!page.ok) {
    await deps.postInThread(session, plain(`:warning: ${escapeSlackText(page.message)}`));
    return null;
  }
  const text = planStorageToText(page.storage);
  if (text.length > PLAN_PAGE_MAX_CHARS) {
    const what = kind === 'prd' ? 'PRD' : 'design';
    await deps.postInThread(session, problemsMessage([{
      kind: 'page_too_large',
      message: `The ${what} page is longer than ${PLAN_PAGE_MAX_CHARS.toLocaleString('en-US')} characters, which is more than I can use. Shorten it or split it up.`,
    }], what));
    return null;
  }
  logger.info('Planning page read', { session_id: session.session_id, page_id: session.page_id, kind, page_version: page.version });
  return text;
}

/**
 * Approve PRD: re-read and check the PRD, then start the technical design and
 * mark the PRD final. Returns undefined: a PRD session records no digest.
 */
async function approvePrd(session: PlanningSession, leaseSince: number, deps: PlanActionDeps): Promise<undefined> {
  const mapping = await deps.lookupRepoConfig(session.repo);
  const text = await readPageText(session, mapping, 'prd', deps);
  if (text === null) return undefined;

  const prd = parsePrd(text);
  const problems = checkPrd(prd);
  logger.info('PRD checked', {
    session_id: session.session_id,
    question_count: prd.productQuestions.length,
    problem_kinds: problems.map((p) => p.kind),
  });
  if (problems.length > 0) {
    await deps.postInThread(session, problemsMessage(problems, 'PRD'));
    return undefined;
  }

  const started = await deps.startDesignFromPrd(session, mapping);
  if (!started.ok) {
    await deps.postInThread(session, plain(`:x: I couldn't start the technical design. ${escapeSlackText(started.message)}`));
    return undefined;
  }
  if (!await completePrdApproval(deps.ddb, deps.tableName, session.session_id, leaseSince, started.taskId)) {
    logger.warn('PRD approval lease was taken over after the design task was created', {
      session_id: session.session_id,
      design_task_id: started.taskId,
    });
  }
  await deps.postInThread(session, plain(`:white_check_mark: ${PRD_APPROVED_TEXT}.`));
  if (!await deps.markPageFinal(session.page_id, mapping)) {
    await deps.postInThread(session, plain(':warning: I couldn\'t mark the PRD page final in Confluence; it still has the `factory-draft` label.'));
  }
  return undefined;
}

/**
 * Start: re-read, parse and check the design, then either post the problems,
 * ask again when the numbers changed, or report a passing check. Returns the
 * digest of the numbers a new message showed, or undefined to keep the one
 * the session has.
 */
async function checkAndGateDesign(action: PlanAction, session: PlanningSession, deps: PlanActionDeps): Promise<string | undefined> {
  const mapping = await deps.lookupRepoConfig(session.repo);
  const text = await readPageText(session, mapping, 'design', deps);
  if (text === null) return undefined;

  const plan = parsePlan(text);
  const problems = checkPlan(plan);
  logger.info('Design checked', {
    session_id: session.session_id,
    action,
    story_count: plan.stories.length,
    problem_kinds: problems.map((p) => p.kind),
  });
  if (problems.length > 0) {
    await deps.postInThread(session, problemsMessage(problems, 'design'));
    return undefined;
  }

  const storyCount = plan.stories.length;
  const digest = designNumbersDigest(storyCount);
  if (session.confirm_digest !== digest) {
    await deps.postInThread(session, plain(':pencil2: The number of stories changed since I last asked, so here are the new numbers.'));
    await deps.postInThread(session, renderDesignConfirmation(session.session_id, storyCount, estimatedPlanCostUsd(storyCount)));
    return digest;
  }

  const stories = storyCount === 1 ? '1 story' : `${storyCount} stories`;
  await deps.postInThread(session, plain(`:white_check_mark: ${CHECK_PASSED_TEXT}. The design has ${stories} and nothing has been filed.`));
  return undefined;
}
