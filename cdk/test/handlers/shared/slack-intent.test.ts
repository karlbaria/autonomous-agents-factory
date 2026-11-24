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

import { classifySlackIntent } from '../../../src/handlers/shared/slack-intent';

// Task 15 (fork), #82 PR 1.
describe('classifySlackIntent', () => {
  test.each([
    ['research product search UX', 'product search UX'],
    ['Research: product search UX', 'product search UX'],
    ['RESEARCH caching options in', 'caching options'],
    ['research - caching options for', 'caching options'],
  ])('routes "%s" to web research', (input, description) => {
    expect(classifySlackIntent(input)).toEqual({
      kind: 'research',
      workflowId: 'knowledge/web-research-v1',
      description,
    });
  });

  test.each([
    ['I want to build a tagging feature in', 'a tagging feature'],
    ['i want to build: product tags', 'product tags'],
    ['I  WANT TO  BUILD product tags for', 'product tags'],
    ['plan a tagging feature', 'a tagging feature'],
    ['Plan: tags for products', 'tags for products'],
  ])('routes "%s" to the PRD draft (#82 PR 3c)', (input, description) => {
    expect(classifySlackIntent(input)).toEqual({
      kind: 'plan',
      workflowId: 'knowledge/prd-draft-v1',
      description,
    });
  });

  test.each([
    'planning is broken in checkout',
    'planner page 500s',
    'researcher list is empty',
    'fix the research page title in',
    'update the plan docs',
    'I want to fix the build',
    'add a GET /api/products/count endpoint in',
    '',
  ])('leaves "%s" to the repo default, unchanged', (input) => {
    expect(classifySlackIntent(input)).toEqual({ kind: 'default', description: input });
  });

  test('matches only at the start of the message', () => {
    expect(classifySlackIntent('please research caching').kind).toBe('default');
    expect(classifySlackIntent('  research caching').kind).toBe('research');
  });

  test('a bare keyword leaves an empty description', () => {
    expect(classifySlackIntent('research').description).toBe('');
    expect(classifySlackIntent('plan for').description).toBe('');
  });

  // #82 PR 2a: `plan from <url>` is matched before the generic `plan` rule.
  describe('plan from <url>', () => {
    const PAGE = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Wishlist+PRD';

    test.each([
      [`plan from <${PAGE}>`, PAGE, ''],
      [`Plan from <${PAGE}|Wishlist PRD>`, PAGE, ''],
      [`plan  from ${PAGE}`, PAGE, ''],
      [`plan from <${PAGE}> in`, PAGE, ''],
      [`plan from <${PAGE}>, mobile first please`, PAGE, 'mobile first please'],
      [`plan from ${PAGE}, mobile first please`, PAGE, 'mobile first please'],
      ['plan from <https://karlvb.atlassian.net/wiki/spaces/SD/pages/1?a=1&amp;b=2>', 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1?a=1&b=2', ''],
    ])('"%s" → the technical design, with the URL apart from the description', (input, prdUrl, description) => {
      expect(classifySlackIntent(input)).toEqual({
        kind: 'plan',
        workflowId: 'knowledge/feature-planning-v1',
        description,
        prdUrl,
      });
    });

    test('"plan from" without a link is the generic plan rule (a PRD draft)', () => {
      expect(classifySlackIntent('plan from scratch a wishlist')).toEqual({
        kind: 'plan',
        workflowId: 'knowledge/prd-draft-v1',
        description: 'from scratch a wishlist',
      });
    });

    test('ordinary plan and i want to build messages draft a PRD (no prdUrl)', () => {
      expect(classifySlackIntent('plan a tagging feature')).toEqual({
        kind: 'plan', workflowId: 'knowledge/prd-draft-v1', description: 'a tagging feature',
      });
      expect(classifySlackIntent('I want to build a tagging feature in')).toEqual({
        kind: 'plan', workflowId: 'knowledge/prd-draft-v1', description: 'a tagging feature',
      });
    });
  });
});
