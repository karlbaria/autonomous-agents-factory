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
 * What Start files in Jira (#82 PR 3b-2): the parent's and each story's
 * summary and description, built from the parsed design. Pure.
 *
 * - The parent is an Epic, or a Story when the design has one story. Its
 *   summary is the design title without the `Technical design:` prefix or a
 *   trailing `· <id>`; its description holds the design's Summary, who
 *   approved it and when (decision 18), and links to the design page and PRD.
 * - Each story's description holds its text, acceptance criteria, technical
 *   notes, the technical decisions it names (all of them when it names none),
 *   and the same links. The coding task reads it back as its brief.
 * - Text is kept within Jira's limits and trimmed with a visible marker.
 * - A tag-like `<word>` span is written as `‹word›`: the platform's sanitizer
 *   strips tags from a Jira description before the agent reads it, which
 *   dropped SHOP-45's `<number>` placeholder in the #89 demo.
 */

import type { ParsedPlan, PlanDecision, PlanStory } from './plan-parse';

/** Jira's summary limit. */
export const JIRA_SUMMARY_MAX_CHARS = 255;
/** Text kept in one description, under Jira's 32,767-character field limit. */
export const DESCRIPTION_MAX_CHARS = 30_000;
/** Ends a summary that had to be cut. */
const ELLIPSIS = '…';
/** Kept free in every description for the links, which are never trimmed. */
const LINK_RESERVE_CHARS = 2_000;
/** Ends a description that had to be cut. */
export const TRIMMED_MARKER = '… (trimmed: the full text is on the design page)';

/** Where the filed issues link to. */
export interface FilingLinks {
  readonly designPageUrl: string;
  /** The PRD the design came from, when its Source names one on the tenant's site. */
  readonly prdUrl?: string;
}

/** Who approved the design, and when (decision 18). */
export interface FilingApproval {
  readonly approverName: string;
  /** ISO UTC. */
  readonly approvedAt: string;
}

type AdfNode = Record<string, unknown>;

/** An ADF document, as Jira's `description` field takes it. */
export interface AdfDocument {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfNode[];
}

const TAG_LIKE = /<(\/?[A-Za-z][^<>]*)>/g;
const TITLE_PREFIX = /^\s*(?:technical\s+design|plan)\s*:\s*/i;
/** Every trailing `· <token>`, so a doubled `· AW7G4 · ZAW7G4` goes too (LAB_LOG Task 15 §9). */
const TRAILING_IDS = /(?:\s*·\s*[A-Za-z0-9]{1,16})+\s*$/;
const DECISION_REF = /\bD\s*(\d+)\b/g;
const HTTPS_URL = /https:\/\/[^\s)\]>"']+/g;

/** Text with every tag-like `<word …>` span written as `‹word …›`. */
export function neutralizeTags(text: string): string {
  return text.replace(TAG_LIKE, '‹$1›');
}

/** A design page title without its `Technical design:` prefix or trailing ids. */
export function designTitleText(pageTitle: string): string {
  return pageTitle.replace(TITLE_PREFIX, '').replace(TRAILING_IDS, '').trim();
}

/** A Jira summary: one line, tags neutralized, at most {@link JIRA_SUMMARY_MAX_CHARS}. */
export function issueSummary(text: string, fallback: string): string {
  const line = neutralizeTags(text.replace(/\s+/g, ' ').trim()) || fallback;
  return line.length <= JIRA_SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, JIRA_SUMMARY_MAX_CHARS - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/**
 * The PRD URL in a design's Source section, if it is a page on the tenant's
 * own Confluence site (`siteUrl`); anything else isn't linked.
 */
export function prdUrlFromSource(source: string, siteUrl: string | undefined): string | undefined {
  if (!siteUrl) return undefined;
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    return undefined; // nosemgrep: ts-silent-success-masking -- an unparseable site URL means no PRD link is written, the documented fallback
  }
  for (const raw of source.match(HTTPS_URL) ?? []) {
    try {
      const url = new URL(raw.replace(/[.,;:]+$/, ''));
      if (url.host === site.host && url.pathname.startsWith('/wiki/')) return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The decisions a story names (`D2`), or every decision when it names none it knows. */
export function decisionsForStory(story: PlanStory, decisions: readonly PlanDecision[]): readonly PlanDecision[] {
  const text = [story.title, story.body, ...story.acceptanceCriteria, ...story.technicalNotes].join('\n');
  const named = new Set([...text.matchAll(DECISION_REF)].map((m) => `D${Number(m[1])}`));
  const known = decisions.filter((d) => named.has(d.id));
  return known.length > 0 ? known : decisions;
}

// ─── ADF ────────────────────────────────────────────────────────────────────

/** Builds an ADF document within a character budget. */
class DescriptionBuilder {
  private readonly nodes: AdfNode[] = [];
  private used = 0;
  private full = false;
  private marked = false;

  /** Room for `text`; once out of room, the rest is dropped and the marker added. */
  private take(text: string): string | null {
    if (this.full) return null;
    const room = DESCRIPTION_MAX_CHARS - LINK_RESERVE_CHARS - TRIMMED_MARKER.length - this.used;
    if (text.length <= room) {
      this.used += text.length;
      return text;
    }
    this.full = true;
    const cut = room > 0 ? text.slice(0, room).trimEnd() : '';
    this.used += cut.length;
    return cut;
  }

  private finishIfFull(): void {
    if (this.full && !this.marked) {
      this.nodes.push(paragraph([textNode(TRIMMED_MARKER)]));
      this.marked = true;
    }
  }

  heading(text: string): void {
    const kept = this.take(text);
    if (kept) this.nodes.push({ type: 'heading', attrs: { level: 3 }, content: [textNode(kept)] });
    this.finishIfFull();
  }

  paragraphs(text: string): void {
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const kept = this.take(line);
      if (kept) this.nodes.push(paragraph([textNode(kept)]));
      this.finishIfFull();
      if (this.full) return;
    }
  }

  bullets(items: readonly string[]): void {
    const listItems: AdfNode[] = [];
    for (const item of items) {
      const kept = this.take(item);
      if (kept) listItems.push({ type: 'listItem', content: [paragraph([textNode(kept)])] });
      if (this.full) break;
    }
    if (listItems.length > 0) this.nodes.push({ type: 'bulletList', content: listItems });
    this.finishIfFull();
  }

  /** A link line; links use the reserved room, so a trimmed description still has them. */
  link(label: string, href: string): void {
    this.nodes.push(paragraph([textNode(label), { type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }]));
  }

  build(): AdfDocument {
    return { type: 'doc', version: 1, content: this.nodes.length > 0 ? this.nodes : [paragraph([])] };
  }
}

function textNode(text: string): AdfNode {
  return { type: 'text', text: neutralizeTags(text) };
}

function paragraph(content: readonly AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function formatUtc(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function addLinks(b: DescriptionBuilder, links: FilingLinks): void {
  b.link('Technical design: ', links.designPageUrl);
  if (links.prdUrl) b.link('PRD: ', links.prdUrl);
}

function addParentPart(b: DescriptionBuilder, plan: ParsedPlan, approval: FilingApproval): void {
  if (plan.summary) b.paragraphs(plan.summary);
  b.paragraphs(`Approved in Slack by ${approval.approverName} on ${formatUtc(approval.approvedAt)}.`);
}

function addStoryPart(b: DescriptionBuilder, story: PlanStory, decisions: readonly PlanDecision[]): void {
  if (story.body) b.paragraphs(story.body);
  if (story.acceptanceCriteria.length > 0) {
    b.heading('Acceptance criteria');
    b.bullets(story.acceptanceCriteria);
  }
  if (story.technicalNotes.length > 0) {
    b.heading('Technical notes');
    b.bullets(story.technicalNotes);
  }
  const relevant = decisionsForStory(story, decisions);
  if (relevant.length > 0) {
    b.heading('Technical decisions');
    b.bullets(relevant.map((d) => (d.reason ? `${d.id}: ${d.decision} (Reason: ${d.reason})` : `${d.id}: ${d.decision}`)));
  }
}

/** The parent's description: an Epic's, or the only Story's (which carries the story too). */
export function parentDescription(plan: ParsedPlan, approval: FilingApproval, links: FilingLinks): AdfDocument {
  const b = new DescriptionBuilder();
  addParentPart(b, plan, approval);
  if (plan.stories.length === 1) addStoryPart(b, plan.stories[0], plan.decisions);
  addLinks(b, links);
  return b.build();
}

/** A story child's description. */
export function storyDescription(story: PlanStory, plan: ParsedPlan, links: FilingLinks): AdfDocument {
  const b = new DescriptionBuilder();
  addStoryPart(b, story, plan.decisions);
  addLinks(b, links);
  return b.build();
}
