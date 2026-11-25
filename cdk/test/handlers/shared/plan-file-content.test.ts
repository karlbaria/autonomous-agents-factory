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

import {
  decisionsForStory,
  DESCRIPTION_MAX_CHARS,
  designTitleText,
  issueSummary,
  JIRA_SUMMARY_MAX_CHARS,
  neutralizeTags,
  prdUrlFromSource,
  storyDescription,
  TRIMMED_MARKER,
} from '../../../src/handlers/shared/plan-file-content';
import type { ParsedPlan, PlanStory } from '../../../src/handlers/shared/plan-parse';
import { sanitizeExternalContent } from '../../../src/handlers/shared/sanitization';

const SITE = 'https://example.atlassian.net';

function storyOf(overrides: Partial<PlanStory> = {}): PlanStory {
  return {
    id: 'S1',
    title: 'Save for later',
    body: 'Add a save button.',
    blockedBy: [],
    acceptanceCriteria: ['A saved item stays saved'],
    technicalNotes: ['Edit src/save.ts'],
    ...overrides,
  };
}

function planOf(stories: PlanStory[]): ParsedPlan {
  return {
    stories,
    decisions: [
      { id: 'D1', decision: 'Reuse the table', reason: 'it exists', body: '' },
      { id: 'D2', decision: 'No new service', reason: '', body: '' },
    ],
    openQuestions: [],
    openQuestionsMalformed: false,
    summary: 'Save items.',
    source: '',
  };
}

function text(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  return [n.text ?? '', ...(n.content ?? []).map(text)].join('\n');
}

describe('the parent summary drops the prefix and any trailing ids (LAB_LOG Task 15 §9)', () => {
  test.each([
    ['Technical design: Product reviews page · 7FZZXB', 'Product reviews page'],
    ['Technical design: Product reviews page · FZZXB', 'Product reviews page'],
    ['Technical design: Product reviews page · FZZXB · 7FZZXB', 'Product reviews page'],
    ['Technical design: Product reviews page', 'Product reviews page'],
    ['Plan: Wishlist (Save for later) · NCZR7W', 'Wishlist (Save for later)'],
  ])('%s → %s', (title, expected) => {
    expect(designTitleText(title)).toBe(expected);
  });
});

describe('text the agent will read', () => {
  test('a tag-like placeholder survives the sanitizer as ‹…› (the SHOP-45 `<number>` drop)', () => {
    const written = neutralizeTags('Run it with --port <number> and keep <b>bold</b>; 2 < 3 > 1.');
    expect(written).toBe('Run it with --port ‹number› and keep ‹b›bold‹/b›; 2 < 3 > 1.');
    expect(sanitizeExternalContent(written)).toContain('--port ‹number›');
    expect(sanitizeExternalContent('--port <number>')).not.toContain('number');
  });

  test('a summary is one line, within Jira\'s limit', () => {
    expect(issueSummary('  Save\nfor   later ', 'S1')).toBe('Save for later');
    expect(issueSummary('', 'S1')).toBe('S1');
    const long = issueSummary('x'.repeat(400), 'S1');
    expect(long).toHaveLength(JIRA_SUMMARY_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the PRD link', () => {
  test('is taken from Source only when it is on the tenant\'s own Confluence', () => {
    expect(prdUrlFromSource(`- **Source:** PRD page ${SITE}/wiki/spaces/SD/pages/1/PRD.`, SITE)).toBe(`${SITE}/wiki/spaces/SD/pages/1/PRD`);
    expect(prdUrlFromSource('- **Source:** PRD page https://evil.example/wiki/x', SITE)).toBeUndefined();
    expect(prdUrlFromSource(`- **Source:** PRD page ${SITE}/browse/SHOP-1`, SITE)).toBeUndefined();
    expect(prdUrlFromSource('- **Source:** the request in Slack', SITE)).toBeUndefined();
  });
});

describe('a story\'s description', () => {
  test('has its body, criteria, notes, the decisions it names, and the links', () => {
    const story = storyOf({ technicalNotes: ['Edit src/save.ts per D2'] });
    const doc = storyDescription(story, planOf([story]), { designPageUrl: `${SITE}/wiki/d`, prdUrl: `${SITE}/wiki/p` });
    const out = text(doc);
    for (const part of ['Add a save button.', 'Acceptance criteria', 'A saved item stays saved', 'Technical notes',
      'Edit src/save.ts per D2', 'D2: No new service', `${SITE}/wiki/d`, `${SITE}/wiki/p`]) {
      expect(out).toContain(part);
    }
    expect(out).not.toContain('D1: Reuse the table');
  });

  test('has every decision when the story names none', () => {
    const story = storyOf();
    const decisions = decisionsForStory(story, planOf([story]).decisions);
    expect(decisions.map((d) => d.id)).toEqual(['D1', 'D2']);
  });

  test('is trimmed within Jira\'s limit with one visible marker, and keeps its links', () => {
    const story = storyOf({ body: Array.from({ length: 2_000 }, (_, i) => `Line ${i} ${'x'.repeat(40)}`).join('\n') });
    const doc = storyDescription(story, planOf([story]), { designPageUrl: `${SITE}/wiki/d` });
    const out = text(doc);
    expect(out.length).toBeLessThan(DESCRIPTION_MAX_CHARS);
    expect(out.split(TRIMMED_MARKER)).toHaveLength(2);
    expect(out).toContain(`${SITE}/wiki/d`);
    expect(JSON.stringify(doc)).toContain(`"href":"${SITE}/wiki/d"`);
  });
});
