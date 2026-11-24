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

import { extractRepoCandidates, removeRepoMention } from '../../../src/handlers/shared/slack-repo-text';

const PAGE = 'https://karlvb.atlassian.net/wiki/spaces/SD/pages/1015867/Plan+Customer+wishlist';

// Task 15 (fork), #82 PR 2a.
describe('extractRepoCandidates', () => {
  test('finds owner/repo and owner/repo#N in free text', () => {
    expect(extractRepoCandidates('fix the bug in org/repo#42')).toEqual(['org/repo#42']);
    expect(extractRepoCandidates('In karlbaria/factory-shop, add X')).toEqual(['karlbaria/factory-shop']);
  });

  test('skips a deeper path segment ("/api/products/count")', () => {
    expect(extractRepoCandidates('add GET /api/products/count in karlbaria/factory-shop')).toEqual(['karlbaria/factory-shop']);
  });

  test.each([
    [`plan from <${PAGE}> in karlbaria/factory-shop`],
    [`plan from <${PAGE}|${PAGE}> in karlbaria/factory-shop`],
    [`plan from <${PAGE}|the PRD> in karlbaria/factory-shop`],
    [`plan from ${PAGE} in karlbaria/factory-shop`],
    ['plan from <https://karlvb.atlassian.net/wiki/spaces/SD/pages/123> in karlbaria/factory-shop'],
    ['plan from <https://karlvb.atlassian.net/wiki/spaces/SD/pages/edit-v2/123> in karlbaria/factory-shop'],
  ])('never takes a part of a Confluence URL as a repo: %s', (text) => {
    expect(extractRepoCandidates(text)).toEqual(['karlbaria/factory-shop']);
  });

  test('a Confluence URL alone yields no candidate', () => {
    expect(extractRepoCandidates(`plan from <${PAGE}>`)).toEqual([]);
    expect(extractRepoCandidates('see https://karlvb.atlassian.net/wiki/spaces/SD/pages/1/x for it')).toEqual([]);
  });
});

describe('removeRepoMention', () => {
  test.each([
    ['In karlbaria/factory-shop, add X', 'add X'],
    ['in karlbaria/factory-shop: add X', 'add X'],
    ['For karlbaria/factory-shop, add X', 'add X'],
    ['karlbaria/factory-shop, add X', 'add X'],
    ['karlbaria/factory-shop add X', 'add X'],
  ])('leading form: "%s" → "%s"', (text, expected) => {
    expect(removeRepoMention(text, 'karlbaria/factory-shop')).toBe(expected);
  });

  test.each([
    ['add X in karlbaria/factory-shop', 'add X'],
    ['add X for karlbaria/factory-shop.', 'add X'],
    ['I want to build a tagging feature in karlbaria/factory-shop', 'I want to build a tagging feature'],
    [`plan from <${PAGE}> in karlbaria/factory-shop`, `plan from <${PAGE}>`],
  ])('trailing form: "%s" → "%s"', (text, expected) => {
    expect(removeRepoMention(text, 'karlbaria/factory-shop')).toBe(expected);
  });

  test('inline form: "plan in owner/repo, a wishlist" → "plan a wishlist"', () => {
    expect(removeRepoMention('plan in karlbaria/factory-shop, a wishlist', 'karlbaria/factory-shop')).toBe('plan a wishlist');
  });

  test('elsewhere only the token goes', () => {
    expect(removeRepoMention('port karlbaria/factory-shop checkout to React 19', 'karlbaria/factory-shop'))
      .toBe('port checkout to React 19');
    expect(removeRepoMention('fix the bug in org/repo#42 today', 'org/repo#42')).toBe('fix the bug in today');
  });

  test('a message with no repo is left unchanged', () => {
    const text = 'In checkout,  add a coupon field';
    expect(removeRepoMention(text, 'karlbaria/factory-shop')).toBe(text);
  });

  test('never cuts the repo out of a link', () => {
    const text = 'see <https://github.com/karlbaria/factory-shop/pull/1> in karlbaria/factory-shop';
    expect(removeRepoMention(text, 'karlbaria/factory-shop')).toBe('see <https://github.com/karlbaria/factory-shop/pull/1>');
  });
});
