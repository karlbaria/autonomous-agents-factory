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
 * Design markdown → Confluence page → parsed story → Jira description (#96).
 *
 * The page is `agent/tests/fixtures/confluence/identifiers.storage.xml`, which
 * the agent's storage tests pin as the publisher's exact output for
 * `identifiers.input.txt`, so this round trip runs through both converters.
 */

import * as fs from 'fs';
import * as path from 'path';
import { storyDescription } from '../../../src/handlers/shared/plan-file-content';
import { parsePlan, planStorageToText } from '../../../src/handlers/shared/plan-parse';

const STORAGE = fs.readFileSync(
  path.join(__dirname, '../../../../agent/tests/fixtures/confluence/identifiers.storage.xml'),
  'utf-8',
);

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  return [n.text ?? '', ...(n.content ?? []).map(adfText)].join('\n');
}

describe('a design round trip keeps identifiers verbatim', () => {
  const plan = parsePlan(planStorageToText(STORAGE));
  const story = plan.stories[0];

  test('the story is read', () => {
    expect(plan.stories.map((s) => s.id)).toEqual(['S1']);
    expect(story.title).toBe('Add MAX_PER_LINE items to the bag');
  });

  test('acceptance criteria keep underscores', () => {
    expect(story.acceptanceCriteria).toEqual([
      'Adding a line already at MAX_PER_LINE shows LIMIT_MESSAGE.',
      'The header badge .site-header__bag-count shows the total.',
    ]);
  });

  test('technical notes keep underscores and multiplication', () => {
    expect(story.technicalNotes).toEqual([
      'MAX_PER_LINE = 3, LIMIT_MESSAGE, TTL_MS = 30 * 60 * 1000',
      'Bare names too: MAX_PER_LINE, TTL_MS = 30 * 60 * 1000',
      'Bare BEM classes: site-header__bag-count next to site-header__bag',
      'Real emphasis still renders: bold, italic, italic and bold',
    ]);
  });

  test('decisions keep underscores', () => {
    expect(plan.decisions[0]).toMatchObject({
      id: 'D1',
      decision: 'Keep the bag in localStorage under factory_shop.bag',
      reason: 'it survives a refresh; TTL_MS expires it.',
    });
  });

  test('the Jira description keeps them', () => {
    const description = adfText(storyDescription(story, plan, { designPageUrl: 'https://example.atlassian.net/wiki/d' }));
    for (const kept of ['MAX_PER_LINE', 'LIMIT_MESSAGE', 'TTL_MS = 30 * 60 * 1000', 'site-header__bag-count']) {
      expect(description).toContain(kept);
    }
    expect(description).not.toMatch(/MAXPERLINE|LIMITMESSAGE|TTLMS|site-headerbag/);
  });
});

describe('text the editor left as raw markdown', () => {
  const text = [
    '## Stories',
    '### **S1**: Add to bag',
    'Blocked by: none',
    '**Acceptance criteria**',
    '- **Never more than MAX_PER_LINE**',
    '**Technical notes**',
    '- `TTL_MS` lives in bag.js',
  ].join('\n');
  const story = parsePlan(text).stories[0];

  test('a bold-wrapped id and bold headers are still recognised', () => {
    expect(story).toMatchObject({ id: 'S1', title: 'Add to bag' });
  });

  test('a bold wrapper around a whole value is dropped, identifiers are kept', () => {
    expect(story.acceptanceCriteria).toEqual(['Never more than MAX_PER_LINE']);
    expect(story.technicalNotes).toEqual(['`TTL_MS` lives in bag.js']);
  });
});
