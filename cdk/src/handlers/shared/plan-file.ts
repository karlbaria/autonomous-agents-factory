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
 * Start files the technical design in Jira and starts the build (#82 PR 3b-2).
 *
 * Runs under the session's `approving` lease, after Start's check has passed
 * and the PM has confirmed the numbers:
 *
 * 1. Refuse when the repo maps to more than one Jira project (which would it
 *    be?) or when the mapping's trigger label starts with `factory-plan` (the
 *    filed issues' own marker label must never be a trigger).
 * 2. Screen every story's text with the guardrail, fail-closed and with no
 *    wrapper text (decision 14); a block names the story and files nothing.
 * 3. Freeze what is filed (the design digest, its page version and the
 *    approval time). A retry resumes only while the page still has the same
 *    digest.
 * 4. File the parent (an Epic, or a Story for a one-story design), then each
 *    story as a Story under the Epic, then "S1 blocks S2" for each
 *    `Blocked by`. Every issue carries the `factory-plan-<sid8>` label, and
 *    every write is checkpointed in the session row, with an in-flight marker
 *    set before it is sent. A write with an unknown outcome is looked for by
 *    that label before anything is sent again, so a retry never duplicates.
 * 5. Start the build through `startJiraParentWork`, as the approver's linked
 *    platform user: the orchestration for an Epic, or one task for a Story.
 *
 * Stops (and keeps its checkpoints) rather than guessing whenever Jira's
 * answer is unclear or time is running out; the PM clicks Start again.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { extractDescriptionMarkdown } from './jira-adf';
import type { JiraIssueCreateFields } from './jira-app-actor';
import type { JiraSubIssueNode } from './jira-subissue-fetch';
import type { StartJiraParentWorkResult } from './jira-trigger-start';
import { logger } from './logger';
import {
  designTitleText,
  type FilingLinks,
  issueSummary,
  parentDescription,
  prdUrlFromSource,
  storyDescription,
} from './plan-file-content';
import type { PlanJira, PlanLabelledIssue } from './plan-file-jira';
import { type ParsedPlan, planDigest } from './plan-parse';
import {
  beginFiling,
  clearFilingInflight,
  type FiledIssue,
  markFilingInflight,
  type PlanningSession,
  recordBuildStarted,
  recordFiledIssue,
  recordFiledLink,
} from './planning-session';

/** The trigger-label prefix a mapping must never have (decision 15). */
const PLAN_LABEL_PREFIX = 'factory-plan';
/** Characters of the session id in its label: `factory-plan-<sid8>`. */
const PLAN_LABEL_ID_CHARS = 8;
/** How long an in-flight create may stay unconfirmed before it counts as never made. */
export const INFLIGHT_ADOPT_GRACE_SECONDS = 60;
/** Wait before looking for a create whose outcome was unknown. */
const UNKNOWN_OUTCOME_RECHECK_MS = 3_000;
/** Stop starting new writes this long into the invocation, inside the 120 s timeout (decision 16). */
const FILING_TIME_BUDGET_MS = 90_000;

/** The Jira project the design is filed in. */
export interface FilingTarget {
  readonly cloudId: string;
  readonly projectKey: string;
  readonly mapping: Readonly<Record<string, unknown>>;
  readonly labelFilter: string;
}

export type FindTargetResult =
  | { readonly ok: true; readonly target: FilingTarget }
  | { readonly ok: false; readonly message: string };

/** The design as Start read it. */
export interface DesignToFile {
  readonly plan: ParsedPlan;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly pageVersion: number | null;
}

/** What starting the build is given. */
export interface StartBuildArgs {
  readonly session: PlanningSession;
  readonly target: FilingTarget;
  readonly parent: { readonly key: string; readonly id: string; readonly summary: string; readonly description: Record<string, unknown> };
  /** The Epic's children with their blockers; absent for a one-story design. */
  readonly children?: readonly JiraSubIssueNode[];
}

export interface FileDesignDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => Date;
  /** The repo's only active Jira project mapping, or why there isn't one. */
  readonly findTarget: (repo: string) => Promise<FindTargetResult>;
  readonly makeJira: (cloudId: string) => Promise<PlanJira | null>;
  /** Guardrail screening of the text alone; `unavailable` when it couldn't run. */
  readonly screen: (text: string) => Promise<'pass' | 'blocked' | 'unavailable'>;
  /** The approver's name as Slack shows it (falls back to the Slack id). */
  readonly approverName: (session: PlanningSession) => Promise<string>;
  readonly startBuild: (args: StartBuildArgs) => Promise<StartJiraParentWorkResult>;
  readonly sleep: (ms: number) => Promise<void>;
}

/** A filed story, for the Slack message. */
export interface FiledStory {
  readonly storyId: string;
  readonly key: string;
}

export type FileDesignResult =
  | {
    readonly kind: 'started';
    readonly parent: FiledIssue;
    readonly parentIsEpic: boolean;
    readonly stories: readonly FiledStory[];
    readonly siteUrl: string;
  }
  /** The guardrail blocked a story's text; nothing was filed. */
  | { readonly kind: 'blocked'; readonly storyId: string; readonly title: string }
  /** Filing or starting stopped; the checkpoints are kept, and `message` says what to do. */
  | { readonly kind: 'stopped'; readonly message: string };

/** The label every issue of a session's filing carries (decision 15). */
export function planLabel(sessionId: string): string {
  return `${PLAN_LABEL_PREFIX}-${sessionId.slice(0, PLAN_LABEL_ID_CHARS)}`;
}

/** The idempotency key of a one-story design's task. */
export function planIdempotencyKey(sessionId: string): string {
  return `plan-${sessionId}`;
}

/** The text of a story the guardrail screens: its title, body, criteria and notes, nothing added. */
function storyScreeningText(story: ParsedPlan['stories'][number]): string {
  return [story.title, story.body, ...story.acceptanceCriteria, ...story.technicalNotes].filter(Boolean).join('\n');
}

/** The Epic Name-like field a company-managed project said it needs, if any. */
function requiredFieldToSet(fieldErrors: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!fieldErrors) return undefined;
  const fields = Object.keys(fieldErrors).filter((f) => /^customfield_\d{1,10}$/.test(f));
  return fields.find((f) => /epic\s*name/i.test(fieldErrors[f])) ?? (fields.length === 1 ? fields[0] : undefined);
}

class FilingStopped extends Error {}

/** The message of a {@link FilingStopped} for a lost lease. */
const LEASE_LOST = 'lease_lost';

/** File the design and start the build. Never throws for an expected stop; see the module comment. */
export async function fileDesign(
  session: PlanningSession,
  leaseSince: number,
  design: DesignToFile,
  deps: FileDesignDeps,
): Promise<FileDesignResult> {
  const startedAt = deps.now().getTime();
  const { plan } = design;
  const nowSeconds = (): number => Math.floor(deps.now().getTime() / 1000);

  const found = await deps.findTarget(session.repo);
  if (!found.ok) return { kind: 'stopped', message: found.message };
  const { target } = found;
  if (target.labelFilter.trim().toLowerCase().startsWith(PLAN_LABEL_PREFIX)) {
    return {
      kind: 'stopped',
      message: `The Jira trigger label for ${target.projectKey} starts with "${PLAN_LABEL_PREFIX}", the label I put on the issues I file, so filing would start them. Nothing was filed. Ask an admin to change the mapping's label.`,
    };
  }
  const jira = await deps.makeJira(target.cloudId);
  if (!jira) return { kind: 'stopped', message: 'The Jira connection for this repo isn\'t available right now, so nothing was filed. Try Start again later.' };

  const digest = planDigest(plan);
  const lostLease = (): FileDesignResult => ({ kind: 'stopped', message: 'Someone else picked this up while I was filing. Check the thread for their result.' });

  // Local view of the checkpoints, kept in step with every write below.
  let approvedAt = session.filing_approved_at;
  let parent = session.filing_parent;
  const children: Record<string, FiledIssue> = { ...(session.filing_children ?? {}) };
  const links: Record<string, boolean> = { ...(session.filing_links ?? {}) };
  let inflight = session.filing_inflight;

  if (session.filing_plan_digest === undefined) {
    // Nothing filed yet: screen first (decision 14), then freeze.
    for (const story of plan.stories) {
      const verdict = await deps.screen(storyScreeningText(story));
      if (verdict === 'blocked') return { kind: 'blocked', storyId: story.id, title: story.title };
      if (verdict === 'unavailable') {
        return { kind: 'stopped', message: 'I couldn\'t screen the stories right now, so nothing was filed. Try Start again in a few minutes.' };
      }
    }
    approvedAt = deps.now().toISOString();
    if (!await beginFiling(deps.ddb, deps.tableName, session.session_id, leaseSince, {
      planDigest: digest, pageVersion: design.pageVersion, approvedAt,
    })) return lostLease();
  } else if (session.filing_plan_digest !== digest) {
    return {
      kind: 'stopped',
      message: `The design's stories, decisions or summary changed after I started filing it, so I stopped. ${filedSoFar(parent, children)} Put the design back as it was and click Start again, or remove the filed issues (search Jira for the label ${planLabel(session.session_id)}).`,
    };
  }

  const label = planLabel(session.session_id);
  const isEpic = plan.stories.length > 1;
  const designLinks: FilingLinks = {
    designPageUrl: `${jira.siteUrl.replace(/\/$/, '')}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(design.pageId)}`,
    ...(() => {
      const prdUrl = prdUrlFromSource(plan.source, jira.siteUrl);
      return prdUrl ? { prdUrl } : {};
    })(),
  };
  const approval = { approverName: await deps.approverName(session), approvedAt: approvedAt ?? deps.now().toISOString() };
  const parentSummary = issueSummary(designTitleText(design.pageTitle), 'Technical design');
  const parentFields: JiraIssueCreateFields = {
    projectKey: target.projectKey,
    issueTypeName: isEpic ? 'Epic' : 'Story',
    summary: parentSummary,
    description: { ...parentDescription(plan, approval, designLinks) },
    labels: [label],
  };

  const checkBudget = (): void => {
    if (deps.now().getTime() - startedAt > FILING_TIME_BUDGET_MS) {
      throw new FilingStopped(`Filing is taking longer than usual, so I paused. ${filedSoFar(parent, children)} Click Start again to carry on; nothing will be filed twice.`);
    }
  };

  /** Create one issue (`step` = `parent` or a story id), resuming or adopting as needed. */
  const fileIssue = async (
    step: string,
    fields: JiraIssueCreateFields,
    matches: (issue: PlanLabelledIssue) => boolean,
  ): Promise<FiledIssue> => {
    // Already filed and recorded by an earlier Start: never sent again.
    const recorded = step === 'parent' ? parent : children[step];
    if (recorded) return recorded;
    const taken = new Set([parent?.key, ...Object.values(children).map((c) => c.key)].filter(Boolean));
    const adopt = async (): Promise<FiledIssue | null> => {
      const issues = await jira.findByLabel(label);
      if (issues === null) {
        throw new FilingStopped(`I couldn't check Jira for what I already filed, so I stopped. ${filedSoFar(parent, children)} Click Start again in a minute.`);
      }
      const hit = issues.find((i) => !taken.has(i.key) && matches(i));
      return hit ? { key: hit.key, id: hit.id } : null;
    };
    const record = async (issue: FiledIssue): Promise<FiledIssue> => {
      if (!await recordFiledIssue(deps.ddb, deps.tableName, session.session_id, leaseSince, step, issue)) throw new FilingStopped(LEASE_LOST);
      inflight = undefined;
      return issue;
    };

    if (inflight?.step === step) {
      const adopted = await adopt();
      if (adopted) {
        logger.info('Plan filing adopted an issue whose create had an unknown outcome', { session_id: session.session_id, step, issue_key: adopted.key });
        return record(adopted);
      }
      if (nowSeconds() - inflight.since < INFLIGHT_ADOPT_GRACE_SECONDS) {
        throw new FilingStopped(`Jira hasn't confirmed one of the issues yet, so I paused rather than risk a duplicate. ${filedSoFar(parent, children)} Click Start again in a minute.`);
      }
      logger.warn('Plan filing: an in-flight create was never confirmed; creating it again', { session_id: session.session_id, step });
    }

    checkBudget();
    let sent = fields;
    for (let attempt = 0; attempt < 2; attempt++) {
      const marked = await markFilingInflight(deps.ddb, deps.tableName, session.session_id, leaseSince, step, nowSeconds());
      if (!marked) throw new FilingStopped(LEASE_LOST);
      inflight = { step, since: nowSeconds() };
      const outcome = await jira.createIssue(sent);
      if (outcome.kind === 'created') return record({ key: outcome.key, id: outcome.id });
      if (outcome.kind === 'unknown') {
        await deps.sleep(UNKNOWN_OUTCOME_RECHECK_MS);
        const adopted = await adopt();
        if (adopted) return record(adopted);
        throw new FilingStopped(`Jira didn't confirm creating an issue, so I paused rather than risk a duplicate. ${filedSoFar(parent, children)} Click Start again in a minute.`);
      }
      // Rejected: nothing was written.
      await clearFilingInflight(deps.ddb, deps.tableName, session.session_id, leaseSince);
      inflight = undefined;
      const field = sent.issueTypeName === 'Epic' && sent.epicNameField === undefined
        ? requiredFieldToSet(outcome.fieldErrors)
        : undefined;
      if (attempt === 0 && field) {
        logger.info('Plan filing: the Epic needs a required field; retrying once with it set to the summary', { session_id: session.session_id, field });
        sent = { ...sent, epicNameField: field };
        continue;
      }
      throw new FilingStopped(`Jira wouldn't create ${step === 'parent' ? `the ${sent.issueTypeName}` : `story ${step}`}: ${outcome.detail}. ${filedSoFar(parent, children)}`);
    }
    throw new FilingStopped(`Jira wouldn't create ${step === 'parent' ? 'the parent issue' : `story ${step}`}. ${filedSoFar(parent, children)}`);
  };

  try {
    parent = await fileIssue(
      'parent',
      parentFields,
      (i) => !i.parentKey && i.issueTypeName === parentFields.issueTypeName && i.summary === parentSummary,
    );
    const parentKey = parent.key;

    const childNodes: JiraSubIssueNode[] = [];
    if (isEpic) {
      const fieldsByStory = new Map(plan.stories.map((story) => [story.id, {
        projectKey: target.projectKey,
        issueTypeName: 'Story',
        summary: issueSummary(story.title, story.id),
        description: { ...storyDescription(story, plan, designLinks) },
        parentKey,
        labels: [label],
      } satisfies JiraIssueCreateFields]));
      for (const story of plan.stories) {
        const fields = fieldsByStory.get(story.id)!;
        children[story.id] = await fileIssue(story.id, fields, (i) => i.parentKey === parentKey && i.summary === fields.summary);
      }

      for (const story of plan.stories) {
        for (const blocker of story.blockedBy) {
          const linkId = `${blocker}>${story.id}`;
          if (links[linkId]) continue;
          const blockerKey = children[blocker].key;
          const blockedKey = children[story.id].key;
          const recordLink = async (): Promise<void> => {
            if (!await recordFiledLink(deps.ddb, deps.tableName, session.session_id, leaseSince, linkId)) throw new FilingStopped(LEASE_LOST);
            links[linkId] = true;
            inflight = undefined;
          };
          if (inflight?.step === linkId && await jira.hasBlocksLink(blockerKey, blockedKey)) {
            await recordLink();
            continue;
          }
          checkBudget();
          const marked = await markFilingInflight(deps.ddb, deps.tableName, session.session_id, leaseSince, linkId, nowSeconds());
          if (!marked) throw new FilingStopped(LEASE_LOST);
          inflight = { step: linkId, since: nowSeconds() };
          const outcome = await jira.linkBlocks(blockerKey, blockedKey);
          if (outcome.kind === 'linked') {
            await recordLink();
          } else if (outcome.kind === 'unknown') {
            await deps.sleep(UNKNOWN_OUTCOME_RECHECK_MS);
            if (await jira.hasBlocksLink(blockerKey, blockedKey)) {
              await recordLink();
            } else {
              throw new FilingStopped(`Jira didn't confirm linking ${blocker} to ${story.id}, so I paused. ${filedSoFar(parent, children)} Click Start again in a minute.`);
            }
          } else {
            await clearFilingInflight(deps.ddb, deps.tableName, session.session_id, leaseSince);
            inflight = undefined;
            throw new FilingStopped(`Jira wouldn't link ${blocker} to ${story.id} (${outcome.detail}). ${filedSoFar(parent, children)}`);
          }
        }
      }

      for (const story of plan.stories) {
        const fields = fieldsByStory.get(story.id)!;
        childNodes.push({
          id: children[story.id].key,
          identifier: children[story.id].key,
          issue_id: children[story.id].id,
          title: fields.summary,
          description: extractDescriptionMarkdown(fields.description),
          project_key: target.projectKey,
          depends_on: story.blockedBy.map((b) => children[b].key).sort(),
        });
      }
    }

    if (!session.filing_build_started) {
      const started = await deps.startBuild({
        session,
        target,
        parent: { key: parent.key, id: parent.id, summary: parentSummary, description: parentFields.description! },
        ...(isEpic && { children: childNodes }),
      });
      if (started.kind === 'failed' || started.kind === 'dropped') {
        const why = started.kind === 'failed' ? ` ${started.message.replace(/^❌\s*/, '')}` : ' The Jira connection wasn\'t available.';
        return { kind: 'stopped', message: `Everything is filed, but I couldn't start the build.${why} Click Start again to retry; nothing will be filed twice.` };
      }
      if (!await recordBuildStarted(deps.ddb, deps.tableName, session.session_id, leaseSince)) return lostLease();
      logger.info('Plan build started', { session_id: session.session_id, parent_key: parent.key, result: started.kind });
    }

    return {
      kind: 'started',
      parent,
      parentIsEpic: isEpic,
      stories: isEpic
        ? plan.stories.map((s) => ({ storyId: s.id, key: children[s.id].key }))
        : [{ storyId: plan.stories[0].id, key: parent.key }],
      siteUrl: jira.siteUrl,
    };
  } catch (err) {
    if (err instanceof FilingStopped) {
      if (err.message === LEASE_LOST) return lostLease();
      logger.warn('Plan filing stopped', { session_id: session.session_id, reason: err.message });
      return { kind: 'stopped', message: err.message };
    }
    throw err;
  }
}

/** "Filed so far: SHOP-1, SHOP-2." or "Nothing has been filed yet." */
function filedSoFar(parent: FiledIssue | undefined, children: Readonly<Record<string, FiledIssue>>): string {
  const keys = [parent?.key, ...Object.values(children).map((c) => c.key)].filter((k): k is string => Boolean(k));
  return keys.length > 0 ? `Filed so far: ${keys.join(', ')}.` : 'Nothing has been filed yet.';
}
