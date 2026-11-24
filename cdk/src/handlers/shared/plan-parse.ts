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
 * Parse and check an edited plan page (Task 15 (fork), #82 PR 3b-1).
 *
 * Approve re-reads the plan page as the PM left it and reduces it to a fixed
 * structure: stories (`### S<n>: <title>`, a `Blocked by:` line, an
 * `Acceptance criteria` list) and open questions (`### Q<n>: <question>` with
 * an `Answer:` line). The layout is the one `agent/src/prompts/feature_planning.py`
 * asks for; the parser tolerates what the Confluence editor does to it (bold
 * wrappers, non-breaking spaces, `S1.` or `S1 -` instead of `S1:`, task-list
 * items, any letter case).
 *
 * Page content is untrusted: it is only ever parsed into this structure and
 * is never sent to a model. Everything here is pure.
 */

import * as crypto from 'crypto';
import { confluenceStorageToText } from './confluence-prd';
import { validateDag } from './orchestration-dag';

/** Most stories a plan may have (#82 decision 16). */
export const PLAN_MAX_STORIES = 15;

/** Above this many stories, Approve asks for a second confirmation (decision 11). */
export const LARGE_PLAN_MAX_STORIES = 5;

/** Estimated coding cost per story, in USD (decision 11). Easy to change. */
export const PER_STORY_COST_USD = 0.5;

/** Above this estimated cost, Approve asks for a second confirmation (decision 11). */
export const LARGE_PLAN_MAX_COST_USD = LARGE_PLAN_MAX_STORIES * PER_STORY_COST_USD;

/** A story as the PM left it. */
export interface PlanStory {
  /** `S<n>`. */
  readonly id: string;
  readonly title: string;
  /** The story's text other than its `Blocked by:` line and criteria. */
  readonly body: string;
  /** Story ids (`S<n>`) or, for anything unrecognisable, the raw text. */
  readonly blockedBy: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

/** An open question under "Open questions". */
export interface PlanOpenQuestion {
  /** `Q<n>`. */
  readonly id: string;
  readonly question: string;
  readonly answered: boolean;
}

/** Longest plan page text Approve reads; a longer page is rejected, never truncated. */
export const PLAN_PAGE_MAX_CHARS = 60_000;

/** The structure Approve works from. */
export interface ParsedPlan {
  readonly stories: readonly PlanStory[];
  readonly openQuestions: readonly PlanOpenQuestion[];
  /** "Open questions" has text that isn't `Q<n>` headings or "None". */
  readonly openQuestionsMalformed: boolean;
}

export type PlanProblemKind =
  | 'no_stories'
  | 'too_many_stories'
  | 'duplicate_story'
  | 'no_acceptance_criteria'
  | 'unknown_blocker'
  | 'cycle'
  | 'unanswered_question'
  | 'malformed_open_questions'
  | 'page_too_large';

/** One thing the PM must fix in Confluence before approving. */
export interface PlanProblem {
  readonly kind: PlanProblemKind;
  /** Plain text naming the story or question; the caller escapes it for Slack. */
  readonly message: string;
}

const STORY_HEADING = /^S\s*(\d+)\s*(?:[:.)\]–—-]\s*)?(.*)$/i;
const QUESTION_HEADING = /^Q\s*(\d+)\s*(?:[:.)\]–—-]\s*)?(.*)$/i;
const BLOCKED_BY_LINE = /^(?:[-*•]\s*)?blocked\s*by\s*(?:[:–—-]\s*)?(.*)$/i;
const ANSWER_LINE = /^(?:[-*•]\s*)?answer\s*(?:[:–—-]\s*)?(.*)$/i;
const ACCEPTANCE_HEADER = /^acceptance\s+criteria\s*:?$/i;
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+(.*)$/;
const STORY_REF = /^S\s*(\d+)$/i;
const BLOCKER_SEPARATOR = /\s*(?:[,;&]|\band\b)\s*/i;
const PLACEHOLDER_ANSWER = /^(?:tbd|todo|to do|\?+|[-–—]+|_+|n\/a\?|pending)\.?$/i;
const NONE_TEXT = /^(?:none|no open questions|n\/a)\.?$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `###`: a story or question heading. `#` and `##` open a section. */
const ITEM_HEADING_LEVEL = 3;
const SECTION_HEADING_MAX_LEVEL = 2;

/** Drop Markdown emphasis wrappers and surrounding whitespace. */
function clean(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Plain text of a plan page's storage body. Task-list items become list items
 * and their checkbox status words are dropped, so a PM who turns the criteria
 * into a checklist still has criteria.
 */
export function planStorageToText(storage: string): string {
  return confluenceStorageToText(
    storage
      .replace(/<ac:task-status>[\s\S]*?<\/ac:task-status>/gi, '')
      .replace(/<ac:task-id>[\s\S]*?<\/ac:task-id>/gi, '')
      .replace(/<ac:task(?:\s[^>]*)?>/gi, '<li>'),
  );
}

interface Heading {
  readonly level: number;
  readonly text: string;
}

function heading(line: string): Heading | null {
  const match = HEADING.exec(line);
  return match ? { level: match[1].length, text: clean(match[2]) } : null;
}

const LEADING_NONE = /^(?:none|n\/a|nothing|no|[-–—])(?=$|[\s.,;])\.?\s*(.*)$/i;
const LEADING_REFS = /^(S\s*\d+(?:\s*(?:[,;&]|\band\b)\s*S\s*\d+)*)(?=$|[\s.,;])[.,;]?\s*(.*)$/i;

/**
 * The blockers on a `Blocked by:` line, and any text after them. The
 * publisher joins adjacent lines into one paragraph, so a story body written
 * straight under the line can arrive on it ("Blocked by: S1 Add the table…").
 * Anything that is neither "none" nor a list of story ids is returned as one
 * unknown blocker, for the check to report.
 */
function parseBlockers(raw: string): { readonly refs: string[]; readonly rest: string } {
  const text = clean(raw);
  if (!text) return { refs: [], rest: '' };
  const none = LEADING_NONE.exec(text);
  if (none) return { refs: [], rest: none[1] };
  const refs = LEADING_REFS.exec(text);
  if (refs) {
    return {
      refs: refs[1].split(BLOCKER_SEPARATOR).map((part) => `S${Number(STORY_REF.exec(part.trim())![1])}`),
      rest: refs[2],
    };
  }
  return { refs: [text.replace(/\.$/, '')], rest: '' };
}

interface StoryDraft {
  id: string;
  title: string;
  body: string[];
  blockedBy: string[];
  criteria: string[];
  inCriteria: boolean;
}

interface QuestionDraft {
  id: string;
  question: string;
  answer: string[] | null;
}

function isAnswered(answer: string[] | null): boolean {
  if (answer === null) return false;
  const text = clean(answer.join(' '));
  return text.length > 0 && !PLACEHOLDER_ANSWER.test(text);
}

/** Parse a plan page's plain text (see {@link planStorageToText}). */
export function parsePlan(text: string): ParsedPlan {
  const stories: StoryDraft[] = [];
  const questions: QuestionDraft[] = [];
  let section = '';
  let story: StoryDraft | null = null;
  let question: QuestionDraft | null = null;
  let openQuestionsStray = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;
    const h = heading(line);

    if (h && h.level <= SECTION_HEADING_MAX_LEVEL) {
      section = h.text.toLowerCase().replace(/:$/, '');
      story = null;
      question = null;
      continue;
    }
    const inOpenQuestions = section === 'open questions';

    if (h && h.level === ITEM_HEADING_LEVEL) {
      story = null;
      question = null;
      const q = inOpenQuestions ? QUESTION_HEADING.exec(h.text) : null;
      if (q) {
        question = { id: `Q${Number(q[1])}`, question: clean(q[2]), answer: null };
        questions.push(question);
        continue;
      }
      const s = inOpenQuestions ? null : STORY_HEADING.exec(h.text);
      if (s) {
        story = { id: `S${Number(s[1])}`, title: clean(s[2]), body: [], blockedBy: [], criteria: [], inCriteria: false };
        stories.push(story);
        continue;
      }
      if (inOpenQuestions) openQuestionsStray = true;
      continue;
    }

    if (question) {
      const answer = ANSWER_LINE.exec(line);
      if (answer && question.answer === null) {
        question.answer = [answer[1]];
      } else if (question.answer !== null) {
        question.answer.push(h ? h.text : line);
      }
      continue;
    }

    if (inOpenQuestions) {
      if (!NONE_TEXT.test(clean(line))) openQuestionsStray = true;
      continue;
    }

    if (!story) continue;
    const plain = h ? h.text : clean(line);
    if (ACCEPTANCE_HEADER.test(plain)) {
      story.inCriteria = true;
      continue;
    }
    const blocked = h ? null : BLOCKED_BY_LINE.exec(line);
    if (blocked && !story.inCriteria) {
      const { refs, rest } = parseBlockers(blocked[1]);
      story.blockedBy.push(...refs);
      if (rest) story.body.push(rest);
      continue;
    }
    if (story.inCriteria) {
      const item = LIST_ITEM.exec(line);
      if (item) {
        const criterion = clean(item[1]);
        if (criterion) story.criteria.push(criterion);
        continue;
      }
    }
    story.body.push(h ? h.text : line);
  }

  return {
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      body: s.body.join('\n').trim(),
      blockedBy: [...new Set(s.blockedBy)],
      acceptanceCriteria: s.criteria,
    })),
    openQuestions: questions.map((q) => ({ id: q.id, question: q.question, answered: isAnswered(q.answer) })),
    openQuestionsMalformed: openQuestionsStray,
  };
}

function label(story: PlanStory): string {
  return story.title ? `${story.id} (${story.title})` : story.id;
}

/** Everything the PM must fix before the plan can be filed. Empty when it is ready. */
export function checkPlan(plan: ParsedPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const { stories } = plan;

  if (stories.length === 0) {
    problems.push({ kind: 'no_stories', message: 'The plan has no stories. Add at least one `### S1: <title>` heading under Stories.' });
  }
  if (stories.length > PLAN_MAX_STORIES) {
    problems.push({
      kind: 'too_many_stories',
      message: `The plan has ${stories.length} stories; the most I can file is ${PLAN_MAX_STORIES}. Split it into smaller plans.`,
    });
  }

  const ids = new Map<string, number>();
  const titles = new Map<string, number>();
  for (const story of stories) {
    ids.set(story.id, (ids.get(story.id) ?? 0) + 1);
    const title = story.title.toLowerCase();
    if (title) titles.set(title, (titles.get(title) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) problems.push({ kind: 'duplicate_story', message: `${id} is used by ${count} stories. Give each story its own number.` });
  }
  for (const story of stories) {
    if (story.title && (titles.get(story.title.toLowerCase()) ?? 0) > 1 && ids.get(story.id) === 1) {
      problems.push({ kind: 'duplicate_story', message: `${label(story)} has the same title as another story. Give each story its own title.` });
    }
  }

  for (const story of stories) {
    if (story.acceptanceCriteria.length === 0) {
      problems.push({
        kind: 'no_acceptance_criteria',
        message: `${label(story)} has no acceptance criteria. Add an "Acceptance criteria" line followed by a bulleted list.`,
      });
    }
  }

  let edgesKnown = true;
  for (const story of stories) {
    for (const ref of story.blockedBy) {
      if (ref === story.id) {
        edgesKnown = false;
        problems.push({ kind: 'unknown_blocker', message: `${label(story)} is blocked by itself.` });
      } else if (!ids.has(ref)) {
        edgesKnown = false;
        problems.push({
          kind: 'unknown_blocker',
          message: `${label(story)} is blocked by "${ref}", which isn't a story in this plan. Use story ids such as S1, or "none".`,
        });
      }
    }
  }
  if (edgesKnown && stories.length > 0 && [...ids.values()].every((count) => count === 1)) {
    const dag = validateDag(stories.map((s) => ({ id: s.id, depends_on: [...s.blockedBy] })));
    if (!dag.ok && dag.reason === 'cycle') {
      problems.push({
        kind: 'cycle',
        message: `The "Blocked by" lines form a cycle (${dag.offendingIds.join(', ')}). Each story can only wait for stories that don't wait for it.`,
      });
    }
  }

  if (plan.openQuestionsMalformed) {
    problems.push({
      kind: 'malformed_open_questions',
      message: 'Open questions has text that isn\'t a `### Q<n>: <question>` heading. Put each question under its own heading with an "Answer:" line, or write "None."',
    });
  }
  for (const q of plan.openQuestions) {
    if (!q.answered) {
      problems.push({
        kind: 'unanswered_question',
        message: `${q.id}${q.question ? ` (${q.question})` : ''} has no answer. Write it after "Answer:" under the question.`,
      });
    }
  }

  return problems;
}

/** Whether a plan of this size needs the large-plan confirmation (decision 11). */
export function isLargePlan(storyCount: number): boolean {
  return storyCount > LARGE_PLAN_MAX_STORIES || storyCount * PER_STORY_COST_USD > LARGE_PLAN_MAX_COST_USD;
}

/** Estimated coding cost of a plan, in USD. */
export function estimatedPlanCostUsd(storyCount: number): number {
  return storyCount * PER_STORY_COST_USD;
}

/**
 * Digest of what would be filed: the stories' ids, titles, bodies, blockers
 * and criteria. A confirmation is bound to it, so an edit to any story after
 * the confirmation was asked for means asking again; an edit elsewhere in the
 * page (Risks, Repo findings) doesn't.
 */
export function planDigest(plan: ParsedPlan): string {
  const canonical = plan.stories.map((s) => [s.id, s.title, s.body, s.blockedBy, s.acceptanceCriteria]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
