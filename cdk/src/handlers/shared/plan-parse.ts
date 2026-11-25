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
 * Parse and check the planning pages (Task 15 (fork), #82 PR 3b-1 and 3c).
 *
 * Two documents, both re-read as the PM or engineers left them:
 *
 * - **The PRD** (`agent/src/prompts/prd_draft.py`): Approve PRD reads only its
 *   `## Product questions` (`### Q<n>: <question>` with an `Answer:` line).
 * - **The technical design** (`agent/src/prompts/feature_planning.py`): Start
 *   reads the stories (`### S<n>: <title>`, a `Blocked by:` line, an
 *   `Acceptance criteria` list and a `Technical notes` list), the
 *   `## Technical decisions` (`### D<n>: <decision>` with a `Reason:` line) and
 *   `## Questions for the PM` (`### Q<n>:` with `Answer:`). "Open questions",
 *   the section's name before PR 3c, is accepted as an alias.
 *
 * The parser tolerates what the Confluence editor does to the layout (bold
 * wrappers, non-breaking spaces, `S1.` or `S1 -` instead of `S1:`, task-list
 * items, any letter case).
 *
 * Page content is untrusted: it is only ever parsed into this structure and
 * is never sent to a model. Everything here is pure.
 */

import * as crypto from 'crypto';
import { confluenceStorageToText } from './confluence-page';
import { validateDag } from './orchestration-dag';

/** Most stories a plan may have (#82 decision 16). */
export const PLAN_MAX_STORIES = 15;

/** Estimated coding cost per story, in USD (#82 decisions 11 and 20). Easy to change. */
export const PER_STORY_COST_USD = 0.5;

/** A story as the PM or engineers left it. */
export interface PlanStory {
  /** `S<n>`. */
  readonly id: string;
  readonly title: string;
  /** The story's text other than its `Blocked by:` line, criteria and notes. */
  readonly body: string;
  /** Story ids (`S<n>`) or, for anything unrecognisable, the raw text. */
  readonly blockedBy: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  /** The story's `Technical notes` items (#82 PR 3c), for PR 3b-2's filing. */
  readonly technicalNotes: readonly string[];
}

/** A technical decision under "Technical decisions" (#82 PR 3c). Never blocks Start. */
export interface PlanDecision {
  /** `D<n>`. */
  readonly id: string;
  readonly decision: string;
  /** The text after `Reason:`, empty when there is none. */
  readonly reason: string;
  /** Any other text under the heading. */
  readonly body: string;
}

/** A question for the PM: under "Questions for the PM" or "Open questions" in a design, "Product questions" in a PRD. */
export interface PlanOpenQuestion {
  /** `Q<n>`. */
  readonly id: string;
  readonly question: string;
  readonly answered: boolean;
}

/** Longest page text Start or Approve PRD reads; a longer page is rejected, never truncated. */
export const PLAN_PAGE_MAX_CHARS = 60_000;

/** The structure Start works from. */
export interface ParsedPlan {
  readonly stories: readonly PlanStory[];
  readonly decisions: readonly PlanDecision[];
  /** "Questions for the PM" (or "Open questions"). */
  readonly openQuestions: readonly PlanOpenQuestion[];
  /** The questions section has text that isn't `Q<n>` headings or "None". */
  readonly openQuestionsMalformed: boolean;
  /** The "Summary" section's text (#82 PR 3b-2: the filed parent's description). */
  readonly summary: string;
  /** The "Source" section's text: the PRD link, or "the request in Slack". */
  readonly source: string;
}

/** The structure Approve PRD works from. */
export interface ParsedPrd {
  readonly productQuestions: readonly PlanOpenQuestion[];
  /** "Product questions" has text that isn't `Q<n>` headings or "None". */
  readonly productQuestionsMalformed: boolean;
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

/** One thing to fix in Confluence before continuing. */
export interface PlanProblem {
  readonly kind: PlanProblemKind;
  /** Plain text naming the story or question; the caller escapes it for Slack. */
  readonly message: string;
}

const STORY_HEADING = /^S\s*(\d+)\s*(?:[:.)\]–—-]\s*)?(.*)$/i;
const QUESTION_HEADING = /^Q\s*(\d+)\s*(?:[:.)\]–—-]\s*)?(.*)$/i;
const DECISION_HEADING = /^D\s*(\d+)\s*(?:[:.)\]–—-]\s*)?(.*)$/i;
const BLOCKED_BY_LINE = /^(?:[-*•]\s*)?blocked\s*by\s*(?:[:–—-]\s*)?(.*)$/i;
const ANSWER_LINE = /^(?:[-*•]\s*)?answer\s*(?:[:–—-]\s*)?(.*)$/i;
const REASON_LINE = /^(?:[-*•]\s*)?reason\s*(?:[:–—-]\s*)?(.*)$/i;
const ACCEPTANCE_HEADER = /^acceptance\s+criteria\s*:?$/i;
const TECHNICAL_NOTES_HEADER = /^technical\s+notes\s*(?::\s*(.*))?$/i;
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+(.*)$/;
const STORY_REF = /^S\s*(\d+)$/i;
const BLOCKER_SEPARATOR = /\s*(?:[,;&]|\band\b)\s*/i;
const PLACEHOLDER_ANSWER = /^(?:tbd|todo|to do|\?+|[-–—]+|_+|n\/a\?|pending)\.?$/i;
const NONE_TEXT = /^(?:none|no open questions|no questions|n\/a)\.?$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `###`: a story, decision or question heading. `#` and `##` open a section. */
const ITEM_HEADING_LEVEL = 3;
const SECTION_HEADING_MAX_LEVEL = 2;

/** The design's questions section, and its name before #82 PR 3c. */
const DESIGN_QUESTION_SECTIONS: ReadonlySet<string> = new Set(['questions for the pm', 'open questions']);
const PRD_QUESTION_SECTIONS: ReadonlySet<string> = new Set(['product questions']);
const DECISIONS_SECTION = 'technical decisions';

/** A `**\u2026**` wrapper around a whole value (raw text the editor didn't turn into bold). */
const WHOLE_BOLD = /^\*\*(?=\S)(.*\S)\*\*$/;

/**
 * A value as written (#96): whitespace normalised and a `**\u2026**` wrapper around
 * the whole value removed, nothing else. `MAX_PER_LINE`,
 * `site-header__bag-count` and `30 * 60 * 1000` survive.
 */
function contentText(text: string): string {
  const normalised = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const bold = WHOLE_BOLD.exec(normalised);
  return bold ? bold[1].trim() : normalised;
}

/**
 * Text for recognising keywords, ids and headers only: every emphasis marker
 * and code tick dropped. Never kept as a value \u2014 it strips the underscores of
 * identifiers (#96).
 */
function matchText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * An item heading (`S1: \u2026`, `Q1: \u2026`, `D1: \u2026`): its number and the rest as
 * written. Tried on the text as written first, so the rest keeps its
 * identifiers; then with emphasis dropped, for a wrapped id such as `**S1**:`.
 */
function itemHeading(pattern: RegExp, text: string): { readonly n: number; readonly rest: string } | null {
  const match = pattern.exec(contentText(text)) ?? pattern.exec(matchText(text));
  return match ? { n: Number(match[1]), rest: contentText(match[2]) } : null;
}

/**
 * Plain text of a planning page's storage body. Task-list items become list
 * items and their checkbox status words are dropped, so a PM who turns the
 * criteria into a checklist still has criteria.
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
  return match ? { level: match[1].length, text: contentText(match[2]) } : null;
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
  const text = matchText(raw);
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

type StoryList = 'body' | 'criteria' | 'notes';

interface StoryDraft {
  id: string;
  title: string;
  body: string[];
  blockedBy: string[];
  criteria: string[];
  notes: string[];
  list: StoryList;
}

interface QuestionDraft {
  id: string;
  question: string;
  answer: string[] | null;
}

interface DecisionDraft {
  id: string;
  decision: string;
  reason: string[] | null;
  body: string[];
}

function isAnswered(answer: string[] | null): boolean {
  if (answer === null) return false;
  const text = matchText(answer.join(' '));
  return text.length > 0 && !PLACEHOLDER_ANSWER.test(text);
}

/** A line inside a story: its blockers, criteria, notes or body. */
function addStoryLine(story: StoryDraft, line: string, h: Heading | null): void {
  const plain = h ? h.text : contentText(line);
  if (ACCEPTANCE_HEADER.test(matchText(plain))) {
    story.list = 'criteria';
    return;
  }
  const notesHeader = TECHNICAL_NOTES_HEADER.exec(plain) ?? TECHNICAL_NOTES_HEADER.exec(matchText(plain));
  if (notesHeader) {
    story.list = 'notes';
    const inline = contentText(notesHeader[1] ?? '');
    if (inline) story.notes.push(inline);
    return;
  }
  const blocked = h ? null : BLOCKED_BY_LINE.exec(line);
  if (blocked && story.list === 'body') {
    const { refs, rest } = parseBlockers(blocked[1]);
    story.blockedBy.push(...refs);
    if (rest) story.body.push(rest);
    return;
  }
  const item = h ? null : LIST_ITEM.exec(line);
  if (story.list === 'criteria' && item) {
    const criterion = contentText(item[1]);
    if (criterion) story.criteria.push(criterion);
    return;
  }
  if (story.list === 'notes') {
    // Notes written as a paragraph rather than a list still count as notes.
    const note = contentText(item ? item[1] : plain);
    if (note) story.notes.push(note);
    return;
  }
  story.body.push(h ? h.text : line);
}

/** A line under a `### Q<n>` heading. */
function addQuestionLine(question: QuestionDraft, line: string, h: Heading | null): void {
  const answer = ANSWER_LINE.exec(line);
  if (answer && question.answer === null) {
    question.answer = [answer[1]];
  } else if (question.answer !== null) {
    question.answer.push(h ? h.text : line);
  }
}

/** A line under a `### D<n>` heading. */
function addDecisionLine(decision: DecisionDraft, line: string, h: Heading | null): void {
  const reason = h ? null : REASON_LINE.exec(line);
  if (reason && decision.reason === null) {
    decision.reason = [reason[1]];
  } else if (decision.reason !== null) {
    decision.reason.push(h ? h.text : line);
  } else {
    decision.body.push(h ? h.text : line);
  }
}

interface ParsedPage {
  readonly stories: StoryDraft[];
  readonly decisions: DecisionDraft[];
  readonly questions: QuestionDraft[];
  readonly questionsStray: boolean;
  /** Lines of the free-text sections the filing reads, by section name. */
  readonly sections: ReadonlyMap<string, readonly string[]>;
}

/** Free-text sections of a design whose text is kept (#82 PR 3b-2). */
const TEXT_SECTIONS: ReadonlySet<string> = new Set(['summary', 'source']);

/**
 * One pass over a page's plain text. Questions are read only in
 * `questionSections`; stories anywhere else except under Technical
 * decisions, where `### D<n>` headings are read instead.
 */
function parsePage(text: string, questionSections: ReadonlySet<string>): ParsedPage {
  const stories: StoryDraft[] = [];
  const decisions: DecisionDraft[] = [];
  const questions: QuestionDraft[] = [];
  let section = '';
  let story: StoryDraft | null = null;
  let question: QuestionDraft | null = null;
  let decision: DecisionDraft | null = null;
  let questionsStray = false;
  const sections = new Map<string, string[]>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;
    const h = heading(line);

    if (h && h.level <= SECTION_HEADING_MAX_LEVEL) {
      section = matchText(h.text).toLowerCase().replace(/:$/, '');
      story = null;
      question = null;
      decision = null;
      continue;
    }
    const inQuestions = questionSections.has(section);
    const inDecisions = section === DECISIONS_SECTION;
    if (TEXT_SECTIONS.has(section)) {
      sections.set(section, [...(sections.get(section) ?? []), h ? h.text : line]);
      continue;
    }

    if (h && h.level === ITEM_HEADING_LEVEL) {
      story = null;
      question = null;
      decision = null;
      if (inQuestions) {
        const q = itemHeading(QUESTION_HEADING, h.text);
        if (q) {
          question = { id: `Q${q.n}`, question: q.rest, answer: null };
          questions.push(question);
        } else {
          questionsStray = true;
        }
        continue;
      }
      if (inDecisions) {
        const d = itemHeading(DECISION_HEADING, h.text);
        if (d) {
          decision = { id: `D${d.n}`, decision: d.rest, reason: null, body: [] };
          decisions.push(decision);
        }
        continue;
      }
      const s = itemHeading(STORY_HEADING, h.text);
      if (s) {
        story = {
          id: `S${s.n}`, title: s.rest, body: [], blockedBy: [], criteria: [], notes: [], list: 'body',
        };
        stories.push(story);
      }
      continue;
    }

    if (question) {
      addQuestionLine(question, line, h);
    } else if (inQuestions) {
      if (!NONE_TEXT.test(matchText(line))) questionsStray = true;
    } else if (decision) {
      addDecisionLine(decision, line, h);
    } else if (story) {
      addStoryLine(story, line, h);
    }
  }
  return { stories, decisions, questions, questionsStray, sections };
}

function finishQuestions(questions: readonly QuestionDraft[]): PlanOpenQuestion[] {
  return questions.map((q) => ({ id: q.id, question: q.question, answered: isAnswered(q.answer) }));
}

/** Parse a technical design page's plain text (see {@link planStorageToText}). */
export function parsePlan(text: string): ParsedPlan {
  const page = parsePage(text, DESIGN_QUESTION_SECTIONS);
  return {
    stories: page.stories.map((s) => ({
      id: s.id,
      title: s.title,
      body: s.body.join('\n').trim(),
      blockedBy: [...new Set(s.blockedBy)],
      acceptanceCriteria: s.criteria,
      technicalNotes: s.notes,
    })),
    decisions: page.decisions.map((d) => ({
      id: d.id,
      decision: d.decision,
      reason: contentText((d.reason ?? []).join(' ')),
      body: d.body.join('\n').trim(),
    })),
    openQuestions: finishQuestions(page.questions),
    openQuestionsMalformed: page.questionsStray,
    summary: (page.sections.get('summary') ?? []).join('\n').trim(),
    source: (page.sections.get('source') ?? []).join('\n').trim(),
  };
}

/** Parse a PRD page's plain text (see {@link planStorageToText}). */
export function parsePrd(text: string): ParsedPrd {
  const page = parsePage(text, PRD_QUESTION_SECTIONS);
  return {
    productQuestions: finishQuestions(page.questions),
    productQuestionsMalformed: page.questionsStray,
  };
}

function label(story: PlanStory): string {
  return story.title ? `${story.id} (${story.title})` : story.id;
}

/** The problems with a questions section: stray text, and each unanswered question. */
function questionProblems(sectionName: string, questions: readonly PlanOpenQuestion[], malformed: boolean): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (malformed) {
    problems.push({
      kind: 'malformed_open_questions',
      message: `${sectionName} has text that isn't a \`### Q<n>: <question>\` heading. Put each question under its own heading with an "Answer:" line, or write "None."`,
    });
  }
  for (const q of questions) {
    if (!q.answered) {
      problems.push({
        kind: 'unanswered_question',
        message: `${q.id}${q.question ? ` (${q.question})` : ''} has no answer. Write it after "Answer:" under the question.`,
      });
    }
  }
  return problems;
}

/** Everything the PM must fix before Approve PRD starts the design. Empty when it is ready. */
export function checkPrd(prd: ParsedPrd): PlanProblem[] {
  return questionProblems('Product questions', prd.productQuestions, prd.productQuestionsMalformed);
}

/** Everything to fix before the design can be built. Empty when it is ready. */
export function checkPlan(plan: ParsedPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const { stories } = plan;

  if (stories.length === 0) {
    problems.push({ kind: 'no_stories', message: 'The design has no stories. Add at least one `### S1: <title>` heading under Stories.' });
  }
  if (stories.length > PLAN_MAX_STORIES) {
    problems.push({
      kind: 'too_many_stories',
      message: `The design has ${stories.length} stories; the most I can file is ${PLAN_MAX_STORIES}. Split it into smaller designs.`,
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
          message: `${label(story)} is blocked by "${ref}", which isn't a story in this design. Use story ids such as S1, or "none".`,
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

  problems.push(...questionProblems('Questions for the PM', plan.openQuestions, plan.openQuestionsMalformed));
  return problems;
}

/**
 * Estimated coding cost of a design, in USD: one task per story, plus the
 * integration task an orchestration of two or more stories ends with (#89).
 */
export function estimatedPlanCostUsd(storyCount: number): number {
  const tasks = storyCount >= 2 ? storyCount + 1 : storyCount;
  return tasks * PER_STORY_COST_USD;
}

/**
 * Digest of the numbers a Start confirmation showed: the story count and the
 * estimated cost (#82 decision 20). The design message and every re-ask
 * record it; Start goes ahead only while the page still gives the same
 * numbers, and asks again otherwise.
 */
export function designNumbersDigest(storyCount: number): string {
  const canonical = [storyCount, estimatedPlanCostUsd(storyCount).toFixed(2)];
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Digest of what would be filed: the stories' ids, titles, bodies, blockers,
 * criteria and technical notes, the technical decisions, the Summary and the
 * Source. PR 3b-2's filing freezes it before the first Jira write, so a retry
 * resumes only while the page still says the same thing: an edit to any of
 * those changes it; an edit elsewhere in the page (Risks, Repo findings)
 * doesn't.
 */
export function planDigest(plan: ParsedPlan): string {
  const canonical = [
    plan.stories.map((s) => [s.id, s.title, s.body, s.blockedBy, s.acceptanceCriteria, s.technicalNotes]),
    plan.decisions.map((d) => [d.id, d.decision, d.reason, d.body]),
    plan.summary,
    plan.source,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
