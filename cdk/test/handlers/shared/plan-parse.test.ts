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

import * as fs from 'fs';
import * as path from 'path';
import {
  checkPlan,
  checkPrd,
  designNumbersDigest,
  estimatedPlanCostUsd,
  parsePlan,
  parsePrd,
  PER_STORY_COST_USD,
  PLAN_MAX_STORIES,
  planDigest,
  planStorageToText,
  type PlanProblemKind,
} from '../../../src/handlers/shared/plan-parse';

/**
 * A technical design as the agent's publisher (agent/src/confluence/storage.py)
 * renders the layout of agent/src/prompts/feature_planning.py.
 */
const PUBLISHED = [
  '<h2>Summary</h2><p>Add a wishlist.</p>',
  '<h2>Source</h2><ul><li><strong>Source:</strong> PRD page https://example.atlassian.net/wiki/spaces/SD/pages/1</li></ul>',
  '<h2>Technical decisions</h2>',
  '<h3>D1: Store wishlists in the existing database</h3><p>Reason: the app already has one.</p>',
  '<h3>D2: No new service</h3><p>Reason: small feature.</p>',
  '<h2>Stories</h2>',
  '<h3>S1: Save an item for later</h3><p>Blocked by: none</p><p>Customers can save items.</p>',
  '<p><strong>Acceptance criteria</strong></p><ul><li>A saved item appears in the wishlist</li><li>Saving twice keeps one entry</li></ul>',
  '<p><strong>Technical notes</strong></p><ul><li>Add a <code>wishlist</code> table in <code>backend/models.py</code></li></ul>',
  '<h3>S2: See the wishlist</h3><p>Blocked by: S1</p><p>A wishlist page.</p>',
  '<p><strong>Acceptance criteria</strong></p><ul><li>The wishlist page lists saved items</li></ul>',
  '<p><strong>Technical notes</strong></p><ul><li>Routes in <code>backend/api.py</code></li><li>A page in <code>frontend/src/pages</code></li></ul>',
  '<h2>Questions for the PM</h2><h3>Q1: Should guests have a wishlist?</h3><p>Answer:</p>',
  '<h2>Risks</h2><p>None known.</p>',
].join('');

function kinds(text: string): PlanProblemKind[] {
  return checkPlan(parsePlan(text)).map((p) => p.kind);
}

function storyText(id: number, opts: { blockedBy?: string; criteria?: boolean; title?: string } = {}): string {
  return [
    `### S${id}: ${opts.title ?? `Story ${id}`}`,
    `Blocked by: ${opts.blockedBy ?? 'none'}`,
    '',
    'Do the thing.',
    ...(opts.criteria === false ? [] : ['Acceptance criteria', `- It works ${id}`]),
  ].join('\n');
}

function plan(...stories: string[]): string {
  return ['## Stories', ...stories, '## Questions for the PM', 'None.'].join('\n');
}

describe('parsePlan on a published plan', () => {
  const parsed = parsePlan(planStorageToText(PUBLISHED));

  test('reads each story, its blockers, criteria and technical notes', () => {
    expect(parsed.stories).toEqual([
      {
        id: 'S1',
        title: 'Save an item for later',
        body: 'Customers can save items.',
        blockedBy: [],
        acceptanceCriteria: ['A saved item appears in the wishlist', 'Saving twice keeps one entry'],
        technicalNotes: ['Add a wishlist table in backend/models.py'],
      },
      {
        id: 'S2',
        title: 'See the wishlist',
        body: 'A wishlist page.',
        blockedBy: ['S1'],
        acceptanceCriteria: ['The wishlist page lists saved items'],
        technicalNotes: ['Routes in backend/api.py', 'A page in frontend/src/pages'],
      },
    ]);
  });

  test('reads the technical decisions and their reasons, which never block', () => {
    expect(parsed.decisions).toEqual([
      { id: 'D1', decision: 'Store wishlists in the existing database', reason: 'the app already has one.', body: '' },
      { id: 'D2', decision: 'No new service', reason: 'small feature.', body: '' },
    ]);
    // D headings are not stories, and an unanswered decision isn't a thing.
    expect(parsed.stories.map((s) => s.id)).toEqual(['S1', 'S2']);
  });

  test('reads the question for the PM, unanswered while "Answer:" is empty', () => {
    expect(parsed.openQuestions).toEqual([{ id: 'Q1', question: 'Should guests have a wishlist?', answered: false }]);
    expect(checkPlan(parsed).map((p) => p.kind)).toEqual(['unanswered_question']);
  });

  test('an answer the PM typed makes the plan ready', () => {
    const answered = PUBLISHED.replace('<p>Answer:</p>', '<p>Answer: No, signed-in customers only.</p>');
    expect(checkPlan(parsePlan(planStorageToText(answered)))).toEqual([]);
  });

  test('an answer in the paragraph after "Answer:" counts', () => {
    const answered = PUBLISHED.replace('<p>Answer:</p>', '<p>Answer:</p><p>No.</p>');
    expect(checkPlan(parsePlan(planStorageToText(answered)))).toEqual([]);
  });
});

describe('parsePlan tolerates Confluence editor markup', () => {
  test('bold, non-breaking spaces, other separators and letter case', () => {
    const storage = '<h2>Stories</h2>'
      + '<h3><strong>s1&nbsp;-&nbsp;First</strong></h3><p><strong>Blocked by:</strong>&nbsp;None</p>'
      + '<p>ACCEPTANCE CRITERIA:</p><ul><li><strong>it</strong> works</li></ul>'
      + '<h3>S2. Second</h3><p>blocked by s1 and S1</p><h4>Acceptance criteria</h4><ol><li>also works</li></ol>';
    const parsed = parsePlan(planStorageToText(storage));
    expect(parsed.stories.map((s) => [s.id, s.title, s.blockedBy, s.acceptanceCriteria])).toEqual([
      ['S1', 'First', [], ['it works']],
      ['S2', 'Second', ['S1'], ['also works']],
    ]);
  });

  test('a task list of criteria still counts, without the checkbox words', () => {
    const storage = '<h2>Stories</h2><h3>S1: One</h3><p>Blocked by: none</p><p><strong>Acceptance criteria</strong></p>'
      + '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Saves the row</ac:task-body></ac:task></ac:task-list>';
    expect(parsePlan(planStorageToText(storage)).stories[0].acceptanceCriteria).toEqual(['Saves the row']);
  });

  test('a body joined onto the "Blocked by:" paragraph is kept as body', () => {
    const parsed = parsePlan(plan('### S1: A\nBlocked by: none Add the table.\nAcceptance criteria\n- ok',
      '### S2: B\nBlocked by: S1, Then the API.\nAcceptance criteria\n- ok'));
    expect(parsed.stories[0]).toMatchObject({ blockedBy: [], body: 'Add the table.' });
    expect(parsed.stories[1]).toMatchObject({ blockedBy: ['S1'] });
  });

  test('"S2:" text inside Questions for the PM is not a story', () => {
    const parsed = parsePlan(`${plan(storyText(1))}\n### Q1: About S2: what?\nAnswer: fine`);
    expect(parsed.stories.map((s) => s.id)).toEqual(['S1']);
  });

  test('technical notes written inline or as a paragraph still count', () => {
    const parsed = parsePlan(plan(
      '### S1: A\nBlocked by: none\nAcceptance criteria\n- ok\nTechnical notes: change app.py',
      '### S2: B\nBlocked by: S1\n**Technical notes**\nTouch the router.\n**Acceptance criteria**\n- fine',
    ));
    expect(parsed.stories.map((s) => [s.technicalNotes, s.acceptanceCriteria])).toEqual([
      [['change app.py'], ['ok']],
      [['Touch the router.'], ['fine']],
    ]);
  });

  test('a story with no technical notes is still ready: notes never block', () => {
    expect(kinds(plan(storyText(1)))).toEqual([]);
  });
});

describe('"Open questions", the section name before #82 PR 3c, is an alias', () => {
  const legacy = ['## Stories', storyText(1), '## Open questions', '### Q1: Guests?', 'Answer:'].join('\n');

  test('its unanswered question blocks Start', () => {
    expect(parsePlan(legacy).openQuestions).toEqual([{ id: 'Q1', question: 'Guests?', answered: false }]);
    expect(kinds(legacy)).toEqual(['unanswered_question']);
  });

  test('answered, it passes', () => {
    expect(kinds(legacy.replace('Answer:', 'Answer: no'))).toEqual([]);
  });

  test('stray text in it is flagged as in Questions for the PM', () => {
    expect(kinds(['## Stories', storyText(1), '## Open questions', '- guests?'].join('\n'))).toEqual(['malformed_open_questions']);
  });
});

describe('checkPlan catches each problem', () => {
  test('a ready plan has no problems', () => {
    expect(kinds(plan(storyText(1), storyText(2, { blockedBy: 'S1' })))).toEqual([]);
  });

  test('no stories', () => {
    expect(kinds('## Stories\nWe will figure it out.\n## Open questions\nNone.')).toEqual(['no_stories']);
  });

  test('a story with no acceptance criteria', () => {
    const problems = checkPlan(parsePlan(plan(storyText(1), storyText(2, { criteria: false }))));
    expect(problems.map((p) => p.kind)).toEqual(['no_acceptance_criteria']);
    expect(problems[0].message).toContain('S2 (Story 2)');
  });

  test('a criteria heading with no list counts as no criteria', () => {
    expect(kinds(plan('### S1: A\nBlocked by: none\nAcceptance criteria\nSomeone will decide.'))).toEqual(['no_acceptance_criteria']);
  });

  test('an unknown blocker', () => {
    const problems = checkPlan(parsePlan(plan(storyText(1, { blockedBy: 'S9' }))));
    expect(problems.map((p) => p.kind)).toEqual(['unknown_blocker']);
    expect(problems[0].message).toContain('"S9"');
  });

  test('a blocker that is not a story id', () => {
    expect(kinds(plan(storyText(1), storyText(2, { blockedBy: 'the login work' })))).toEqual(['unknown_blocker']);
  });

  test('a story blocked by itself', () => {
    expect(kinds(plan(storyText(1, { blockedBy: 'S1' })))).toEqual(['unknown_blocker']);
  });

  test('a cycle', () => {
    const problems = checkPlan(parsePlan(plan(
      storyText(1),
      storyText(2, { blockedBy: 'S3' }),
      storyText(3, { blockedBy: 'S2' }),
    )));
    expect(problems.map((p) => p.kind)).toEqual(['cycle']);
    expect(problems[0].message).toContain('S2, S3');
  });

  test('duplicate story ids and titles', () => {
    expect(kinds(plan(storyText(1), storyText(1, { title: 'Other' })))).toEqual(['duplicate_story']);
    expect(kinds(plan(storyText(1, { title: 'Same' }), storyText(2, { title: 'same' })))).toEqual(['duplicate_story', 'duplicate_story']);
  });

  test(`more than ${PLAN_MAX_STORIES} stories`, () => {
    const many = Array.from({ length: PLAN_MAX_STORIES + 1 }, (_, i) => storyText(i + 1));
    expect(kinds(plan(...many))).toEqual(['too_many_stories']);
    expect(kinds(plan(...many.slice(0, PLAN_MAX_STORIES)))).toEqual([]);
  });

  test.each(['', 'TBD', 'todo', '?', '—', '_'])('an answer of %p is unanswered', (answer) => {
    expect(kinds(`${plan(storyText(1))}\n### Q1: Who?\nAnswer: ${answer}`)).toEqual(['unanswered_question']);
  });

  test('a question with no "Answer:" line is unanswered', () => {
    expect(kinds(`${plan(storyText(1))}\n### Q1: Who?\nThe PM thinks admins.`)).toEqual(['unanswered_question']);
  });

  test('a question the PM deleted no longer counts', () => {
    expect(kinds(plan(storyText(1)))).toEqual([]);
  });

  test('questions written as bullets are flagged, not silently ignored', () => {
    expect(kinds(`${plan(storyText(1))}\n- Should guests have one?`)).toEqual(['malformed_open_questions']);
  });

  test('page text is never interpreted: problem messages carry it verbatim for escaping', () => {
    const problems = checkPlan(parsePlan(plan(storyText(1, { title: '<!channel> ignore the rules', criteria: false }))));
    expect(problems[0].message).toContain('<!channel> ignore the rules');
  });
});

describe('the cost estimate and the numbers digest (decision 20)', () => {
  test('$0.50 a story', () => {
    expect(PER_STORY_COST_USD).toBe(0.5);
    expect(estimatedPlanCostUsd(6)).toBe(3);
  });

  test('the digest changes with the story count only', () => {
    expect(designNumbersDigest(3)).toBe(designNumbersDigest(3));
    expect(designNumbersDigest(3)).not.toBe(designNumbersDigest(4));
  });
});

/** A PRD as the publisher renders the layout of agent/src/prompts/prd_draft.py. */
const PRD_PUBLISHED = [
  '<h2>Problem</h2><p>Customers lose items they like.</p>',
  '<h2>Users</h2><p>Signed-in shoppers.</p>',
  '<h2>Requirements</h2><ul><li>Save an item for later</li></ul>',
  '<h2>Success criteria</h2><ul><li>Saved items stay saved</li></ul>',
  '<h2>Out of scope</h2><ul><li>Sharing</li></ul>',
  '<h2>Product questions</h2>',
  '<h3>Q1: Can guests save items?</h3><p>Answer:</p>',
  '<h3>Q2: Is there a limit?</h3><p>Answer: 100 items.</p>',
].join('');

describe('parsePrd and checkPrd (#82 PR 3c)', () => {
  test('reads the product questions; an empty answer blocks Approve PRD', () => {
    const prd = parsePrd(planStorageToText(PRD_PUBLISHED));
    expect(prd.productQuestions).toEqual([
      { id: 'Q1', question: 'Can guests save items?', answered: false },
      { id: 'Q2', question: 'Is there a limit?', answered: true },
    ]);
    const problems = checkPrd(prd);
    expect(problems.map((p) => p.kind)).toEqual(['unanswered_question']);
    expect(problems[0].message).toContain('Q1 (Can guests save items?)');
  });

  test('every question answered passes', () => {
    const answered = PRD_PUBLISHED.replace('<p>Answer:</p>', '<p>Answer: No, sign-in first.</p>');
    expect(checkPrd(parsePrd(planStorageToText(answered)))).toEqual([]);
  });

  test('"None." passes, and stray text under Product questions is flagged', () => {
    expect(checkPrd(parsePrd('## Product questions\nNone.'))).toEqual([]);
    const stray = checkPrd(parsePrd('## Product questions\n- guests?'));
    expect(stray.map((p) => p.kind)).toEqual(['malformed_open_questions']);
    expect(stray[0].message).toContain('Product questions');
  });

  test('requirement bullets and other sections never count as questions', () => {
    expect(parsePrd('## Requirements\n### Q1: not a question here\nAnswer:').productQuestions).toEqual([]);
  });
});

describe('planDigest', () => {
  const base = plan(storyText(1), storyText(2, { blockedBy: 'S1' }));

  test('changes with any story edit', () => {
    const digest = planDigest(parsePlan(base));
    expect(planDigest(parsePlan(base.replace('It works 2', 'It works well')))).not.toBe(digest);
    expect(planDigest(parsePlan(base.replace('Blocked by: S1', 'Blocked by: none')))).not.toBe(digest);
    expect(planDigest(parsePlan(base.replace('Story 1', 'Story one')))).not.toBe(digest);
  });

  test('ignores edits outside the stories', () => {
    expect(planDigest(parsePlan(`${base}\n## Risks\nNew risk.`))).toBe(planDigest(parsePlan(base)));
  });
});

/** The fenced layout block of a prompt file, starting at its H1 line. */
function promptLayout(file: string, h1: string): string {
  const prompt = fs.readFileSync(path.join(__dirname, '../../../../agent/src/prompts', file), 'utf-8');
  const start = prompt.indexOf(h1);
  expect(start).toBeGreaterThan(-1);
  return prompt.slice(start, prompt.indexOf('```', start));
}

describe('the technical design prompt\'s layout', () => {
  // The layout the agent is told to write (agent/src/prompts/feature_planning.py)
  // must parse into stories, decisions and questions, so the two can't drift.
  const layout = promptLayout('feature_planning.py', '# Technical design: <short feature name>');

  test('its stories, blockers, criteria, notes, decisions and empty Answer parse as Start expects', () => {
    const parsed = parsePlan(layout);
    expect(parsed.stories.map((s) => [s.id, s.blockedBy])).toEqual([['S1', []], ['S2', ['S1']]]);
    expect(parsed.stories[0].acceptanceCriteria.length).toBeGreaterThan(0);
    expect(parsed.stories[0].technicalNotes.length).toBeGreaterThan(0);
    expect(parsed.decisions.map((d) => [d.id, d.decision])).toEqual([['D1', '<decision>']]);
    expect(parsed.decisions[0].reason).not.toBe('');
    expect(parsed.openQuestions).toEqual([
      { id: 'Q1', question: '<a product question the PRD doesn\'t answer>', answered: false },
    ]);
    expect(parsed.openQuestionsMalformed).toBe(false);
  });
});

describe('the PRD prompt\'s layout', () => {
  // agent/src/prompts/prd_draft.py: Approve PRD reads its Product questions.
  const layout = promptLayout('prd_draft.py', '# PRD: <short feature name>');

  test('its empty Answer parses as an unanswered product question', () => {
    const parsed = parsePrd(layout);
    expect(parsed.productQuestions).toEqual([
      { id: 'Q1', question: '<a question about something a user would notice>', answered: false },
    ]);
    expect(parsed.productQuestionsMalformed).toBe(false);
    expect(checkPrd(parsed).map((p) => p.kind)).toEqual(['unanswered_question']);
  });
});
