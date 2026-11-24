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
  estimatedPlanCostUsd,
  isLargePlan,
  LARGE_PLAN_MAX_COST_USD,
  LARGE_PLAN_MAX_STORIES,
  parsePlan,
  PER_STORY_COST_USD,
  PLAN_MAX_STORIES,
  planDigest,
  planStorageToText,
  type PlanProblemKind,
} from '../../../src/handlers/shared/plan-parse';

/**
 * A plan as the agent's publisher (agent/src/confluence/storage.py) renders
 * the layout of agent/src/prompts/feature_planning.py.
 */
const PUBLISHED = [
  '<h2>Summary</h2><p>Add a wishlist.</p>',
  '<h2>Stories</h2>',
  '<h3>S1: Add the wishlist table</h3><p>Blocked by: none</p><p>Create <code>wishlist</code> in <code>backend/models.py</code>.</p>',
  '<p><strong>Acceptance criteria</strong></p><ul><li>A row can be saved</li><li>Duplicates are rejected</li></ul>',
  '<h3>S2: Add the wishlist API</h3><p>Blocked by: S1</p><p>Routes in <code>backend/api.py</code>.</p>',
  '<p><strong>Acceptance criteria</strong></p><ul><li>GET returns saved items</li></ul>',
  '<h2>Open questions</h2><h3>Q1: Should guests have a wishlist?</h3><p>Answer:</p>',
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
  return ['## Stories', ...stories, '## Open questions', 'None.'].join('\n');
}

describe('parsePlan on a published plan', () => {
  const parsed = parsePlan(planStorageToText(PUBLISHED));

  test('reads each story, its blockers and criteria', () => {
    expect(parsed.stories).toEqual([
      {
        id: 'S1',
        title: 'Add the wishlist table',
        body: 'Create wishlist in backend/models.py.',
        blockedBy: [],
        acceptanceCriteria: ['A row can be saved', 'Duplicates are rejected'],
      },
      {
        id: 'S2',
        title: 'Add the wishlist API',
        body: 'Routes in backend/api.py.',
        blockedBy: ['S1'],
        acceptanceCriteria: ['GET returns saved items'],
      },
    ]);
  });

  test('reads the open question, unanswered while "Answer:" is empty', () => {
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

  test('"S2:" text inside Open questions is not a story', () => {
    const parsed = parsePlan(`${plan(storyText(1))}\n### Q1: About S2: what?\nAnswer: fine`);
    expect(parsed.stories.map((s) => s.id)).toEqual(['S1']);
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

describe('large plans (decision 11)', () => {
  test('the thresholds are 5 stories and 5 × $0.50', () => {
    expect(LARGE_PLAN_MAX_STORIES).toBe(5);
    expect(PER_STORY_COST_USD).toBe(0.5);
    expect(LARGE_PLAN_MAX_COST_USD).toBe(2.5);
  });

  test('only above the threshold', () => {
    expect(isLargePlan(5)).toBe(false);
    expect(isLargePlan(6)).toBe(true);
    expect(estimatedPlanCostUsd(6)).toBe(3);
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

describe('the planning prompt\'s layout', () => {
  // The layout the agent is told to write (agent/src/prompts/feature_planning.py)
  // must parse into stories and open questions, so the two can't drift apart.
  const prompt = fs.readFileSync(path.join(__dirname, '../../../../agent/src/prompts/feature_planning.py'), 'utf-8');
  const layout = prompt.slice(prompt.indexOf('# Plan: <short feature name>'), prompt.indexOf('## Risks'));

  test('its stories, blockers and empty Answer parse as the check expects', () => {
    const parsed = parsePlan(layout);
    expect(parsed.stories.map((s) => [s.id, s.blockedBy])).toEqual([['S1', []], ['S2', ['S1']]]);
    expect(parsed.stories[0].acceptanceCriteria.length).toBeGreaterThan(0);
    expect(parsed.openQuestions).toEqual([
      { id: 'Q1', question: '<a question the PM must answer before approving>', answered: false },
    ]);
    expect(parsed.openQuestionsMalformed).toBe(false);
  });
});
