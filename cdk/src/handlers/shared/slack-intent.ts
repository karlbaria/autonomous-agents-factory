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
 * Slack message intent (Task 15 (fork), #82 PR 1): which workflow a Slack
 * `@mention` asks for, read from the words it starts with.
 *
 * - `research …` → `knowledge/web-research-v1`
 * - `i want to build …` / `plan …` → `knowledge/feature-planning-v1`
 * - `plan from <url> …` (#82 PR 2a) → `knowledge/feature-planning-v1`, with
 *   the link returned as {@link SlackIntent.prdUrl}: the page is the brief.
 * - anything else → no workflow of its own: the caller uses the repo's
 *   default (`resolveChannelDefaultWorkflow`), exactly as before.
 *
 * Only the START of the description counts (after the mention and the repo
 * token have been removed), case-insensitively, and only as whole words: a
 * message that merely mentions research or planning ("planning is broken in
 * checkout") stays a coding task. Pure — no I/O.
 */

import { FEATURE_PLANNING_WORKFLOW_ID, RESEARCH_WORKFLOW_ID } from './workflows';

export type SlackIntentKind = 'research' | 'plan' | 'default';

export interface SlackIntent {
  readonly kind: SlackIntentKind;
  /** The workflow the intent selects; absent for `default`. */
  readonly workflowId?: string;
  /**
   * The task description to submit. For `research` / `plan`, the text after
   * the leading keyword, with a trailing `in` / `for` (left behind when the
   * repo token was removed) stripped. For `default`, the input unchanged.
   * For `plan from <url>`, whatever follows the link (an optional note).
   */
  readonly description: string;
  /**
   * The page link of a `plan from <url>` message (#82 PR 2a), unvalidated:
   * the caller checks it against the repo's Confluence mapping before
   * reading anything.
   */
  readonly prdUrl?: string;
}

/**
 * `plan from` and a link, as Slack sends it (`<https://…>` or
 * `<https://…|label>`) or bare. Checked before the generic `plan` rule, which
 * would otherwise take `from <url>` as the feature to plan.
 */
const PLAN_FROM_URL_PATTERN = /^plan\s+from\s+(?:<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]*[^\s<>,.;:!?)]))(?=[\s:,;-]|$)[\s:,-]*/i;

/** Slack escapes `&`, `<` and `>` in message text. */
function unescapeSlackUrl(url: string): string {
  return url.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Leading keyword (whole words), then any `:` / `,` / `-` separator. */
const INTENT_PATTERNS: ReadonlyArray<{ readonly kind: Exclude<SlackIntentKind, 'default'>; readonly pattern: RegExp; readonly workflowId: string }> = [
  { kind: 'research', pattern: /^research\b[\s:,-]*/i, workflowId: RESEARCH_WORKFLOW_ID },
  { kind: 'plan', pattern: /^i\s+want\s+to\s+build\b[\s:,-]*/i, workflowId: FEATURE_PLANNING_WORKFLOW_ID },
  { kind: 'plan', pattern: /^plan\b[\s:,-]*/i, workflowId: FEATURE_PLANNING_WORKFLOW_ID },
];

/** A dangling preposition the repo token used to follow ("… in owner/repo"). */
const TRAILING_PREPOSITION = /(?:^|\s+)(?:in|for)$/i;

/** Classify a Slack task description by its leading words. */
export function classifySlackIntent(description: string): SlackIntent {
  const text = description.trim();
  const planFrom = PLAN_FROM_URL_PATTERN.exec(text);
  if (planFrom) {
    return {
      kind: 'plan',
      workflowId: FEATURE_PLANNING_WORKFLOW_ID,
      description: text.slice(planFrom[0].length).replace(TRAILING_PREPOSITION, '').trim(),
      prdUrl: unescapeSlackUrl(planFrom[1] ?? planFrom[2]),
    };
  }
  for (const { kind, pattern, workflowId } of INTENT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const rest = text.slice(match[0].length).replace(TRAILING_PREPOSITION, '').trim();
      return { kind, workflowId, description: rest };
    }
  }
  return { kind: 'default', description };
}
