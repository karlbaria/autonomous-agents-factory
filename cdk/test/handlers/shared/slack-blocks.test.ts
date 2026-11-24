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

import { TaskStatus, type TaskStatusType } from '../../../src/constructs/task-status';
import { type ActionsBlock, renderPlanConfirmation, renderSlackBlocks, type SlackBlock } from '../../../src/handlers/shared/slack-blocks';

/** Narrow to a section block and return its text; throws if block isn't a section. */
function sectionText(block: SlackBlock): string {
  if (block.type !== 'section') {
    throw new Error(`expected section block, got ${block.type}`);
  }
  return block.text.text;
}

/** Narrow to an actions block; throws if block isn't one. */
function actionsBlock(block: SlackBlock): ActionsBlock {
  if (block.type !== 'actions') {
    throw new Error(`expected actions block, got ${block.type}`);
  }
  return block;
}

describe('renderSlackBlocks', () => {
  const baseTask = {
    task_id: '01HXYZ123',
    repo: 'org/repo',
    task_description: 'Fix the login bug',
    pr_url: undefined as string | undefined,
    error_message: undefined as string | undefined,
    cost_usd: undefined as number | undefined,
    duration_s: undefined as number | undefined,
    status: TaskStatus.SUBMITTED as TaskStatusType,
  };

  test('renders task_created message', () => {
    const msg = renderSlackBlocks('task_created', baseTask);
    expect(msg.text).toContain('org/repo');
    expect(msg.blocks).toHaveLength(1);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rocket:');
    expect(text).toContain('Fix the login bug');
    expect(text).toContain('01HXYZ123');
  });

  test('renders task_completed message with PR URL', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, pr_url: 'https://github.com/org/repo/pull/42', cost_usd: 0.47, duration_s: 272 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.text).toContain('completed');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain('$0.47');
    expect(text).toContain('4m 32s');
    // PR link is in the button, not inline text (avoids Slack unfurl cards)
    const actions = actionsBlock(msg.blocks[1]);
    const button = actions.elements[0];
    expect(button.text.text).toContain('#42');
    if (!('url' in button)) throw new Error('expected link button with url');
    expect(button.url).toBe('https://github.com/org/repo/pull/42');
  });

  test('renders task_failed message with error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType, error_message: 'Repo not found' };
    const msg = renderSlackBlocks('task_failed', task);
    expect(msg.text).toContain('failed');
    expect(sectionText(msg.blocks[0])).toContain('Repo not found');
  });

  test('renders task_failed message with metadata error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType };
    const msg = renderSlackBlocks('task_failed', task, { error: 'timeout' });
    expect(sectionText(msg.blocks[0])).toContain('timeout');
  });

  test('renders task_cancelled message', () => {
    const msg = renderSlackBlocks('task_cancelled', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':no_entry_sign:');
  });

  test('renders task_timed_out message with duration', () => {
    const task = { ...baseTask, duration_s: 28800 };
    const msg = renderSlackBlocks('task_timed_out', task);
    expect(sectionText(msg.blocks[0])).toContain('8h');
  });

  test('renders session_started message', () => {
    const msg = renderSlackBlocks('session_started', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':hourglass_flowing_sand:');
  });

  test('renders unknown event type gracefully', () => {
    const msg = renderSlackBlocks('hydration_complete', baseTask);
    expect(sectionText(msg.blocks[0])).toContain('hydration_complete');
  });

  test('truncates long descriptions', () => {
    const task = { ...baseTask, task_description: 'A'.repeat(300) };
    const msg = renderSlackBlocks('task_created', task);
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(350);
    expect(text).toContain('...');
  });

  test('formats duration in hours', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 3661 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('1h 1m');
  });

  // Task 14 (fork), #57 — the Confluence outcome on the completion message.
  test('task_completed shows a Confluence page button when published', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      confluence_status: 'published',
      confluence_page_url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/9',
    };
    const msg = renderSlackBlocks('task_completed', task);
    const buttons = actionsBlock(msg.blocks[1]).elements;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      text: { text: 'View Confluence page' },
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/9',
    });
    expect(sectionText(msg.blocks[0])).not.toContain('Confluence not published');
  });

  // Task 15 (fork), #82: a planning task reports its draft.
  test('task_completed for a planning task says the planning draft is ready, with the page button', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      resolved_workflow: { id: 'knowledge/feature-planning-v1', version: '1.0.0' },
      confluence_status: 'published',
      confluence_page_url: 'https://acme.atlassian.net/wiki/x/9',
    };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.text).toBe('Planning draft ready for org/repo');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':memo: *Planning draft ready* for `org/repo`');
    expect(text).not.toContain('Task completed');
    expect(actionsBlock(msg.blocks[1]).elements[0]).toMatchObject({
      text: { text: 'View Confluence page' },
      url: 'https://acme.atlassian.net/wiki/x/9',
    });
  });

  test('task_completed for a planning task still reports a Confluence skip', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      resolved_workflow: { id: 'knowledge/feature-planning-v1', version: '1.0.0' },
      confluence_status: 'skipped',
      confluence_skip_reason: 'no_mapping',
    };
    const text = sectionText(renderSlackBlocks('task_completed', task).blocks[0]);
    expect(text).toContain('Planning draft ready');
    expect(text).toContain('Confluence not published');
  });

  test.each(['knowledge/web-research-v1', 'coding/new-task-v1'])(
    'task_completed for %s keeps the generic headline',
    (id) => {
      const task = {
        ...baseTask,
        status: TaskStatus.COMPLETED as TaskStatusType,
        resolved_workflow: { id, version: '1.0.0' },
      };
      const msg = renderSlackBlocks('task_completed', task);
      expect(msg.text).toBe('Task completed for org/repo');
      expect(sectionText(msg.blocks[0])).toContain(':white_check_mark: *Task completed*');
    },
  );

  test('task_completed puts the Confluence button beside the PR button', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      pr_url: 'https://github.com/org/repo/pull/42',
      confluence_status: 'published',
      confluence_page_url: 'https://acme.atlassian.net/wiki/x/9',
    };
    const buttons = actionsBlock(renderSlackBlocks('task_completed', task).blocks[1]).elements;
    expect(buttons.map((b) => (b as { url?: string }).url)).toEqual([
      'https://github.com/org/repo/pull/42',
      'https://acme.atlassian.net/wiki/x/9',
    ]);
  });

  test('task_completed never links a non-https Confluence URL', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      confluence_status: 'published',
      confluence_page_url: 'javascript:alert(1)',
    };
    expect(renderSlackBlocks('task_completed', task).blocks).toHaveLength(1);
  });

  test.each([
    'no_mapping', 'token_unavailable', 'no_title', 'space_not_found',
    'ownership_clash', 'human_edit_detected', 'api_error',
  ])('task_completed shows the Confluence skip reason %s', (reason) => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      confluence_status: 'skipped',
      confluence_skip_reason: reason,
      confluence_skip_detail: 'the detail',
    };
    const msg = renderSlackBlocks('task_completed', task);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(`Confluence not published_ (\`${reason}\`): the detail`);
    expect(msg.blocks).toHaveLength(1);
  });

  test('task_completed truncates a long skip detail', () => {
    const task = {
      ...baseTask,
      status: TaskStatus.COMPLETED as TaskStatusType,
      confluence_status: 'skipped',
      confluence_skip_reason: 'api_error',
      confluence_skip_detail: 'x'.repeat(1000),
    };
    expect(sectionText(renderSlackBlocks('task_completed', task).blocks[0]).length).toBeLessThan(500);
  });

  test('task_completed without Confluence fields is unchanged', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.blocks).toHaveLength(1);
    expect(sectionText(msg.blocks[0])).not.toContain('Confluence');
  });

  test('formats duration in minutes and seconds', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 125 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('2m 5s');
  });

  // -------------------------------------------------------------------
  // PR #79 test gap #32 — task_stranded + agent_error renderers
  // -------------------------------------------------------------------

  test('renders task_stranded message with prior_status from event metadata', () => {
    // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
    // ``prior_status`` on the event metadata (see
    // reconcile-stranded-tasks.ts). The renderer must surface
    // prior_status so operators can tell whether the task hung in
    // HYDRATING vs RUNNING at a glance — without it, the reviewer's
    // "generic Event: ..." UX regression would resurface.
    const msg = renderSlackBlocks('task_stranded', baseTask, {
      code: 'STRANDED_NO_HEARTBEAT',
      prior_status: 'RUNNING',
      age_seconds: 1800,
    });
    expect(msg.text).toBe('Task stranded for org/repo');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).toContain('org/repo');
    expect(text).toContain('last status: RUNNING');
  });

  test('renders task_stranded message gracefully without metadata', () => {
    // Missing prior_status (e.g. legacy event written before the
    // reconciler started stamping it) must not crash; the renderer
    // omits the parenthetical and produces a clean message.
    const msg = renderSlackBlocks('task_stranded', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).not.toContain('last status:');
  });

  test('renders agent_error message with error_type and message_preview', () => {
    // ``agent/src/progress_writer.py::write_agent_error`` carries
    // ``error_type`` and ``message_preview`` on the event metadata.
    // Pre-PR-#79 this fell to the default branch
    // (``Event: agent_error for org/repo``) — a UX regression.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'TimeoutError',
      message_preview: 'Tool call timed out after 30s',
    });
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).toContain('org/repo');
    expect(text).toContain('TimeoutError');
    expect(text).toContain('Tool call timed out after 30s');
  });

  test('renders agent_error message without metadata (legacy event shape)', () => {
    // Defense-in-depth: an agent_error event with no metadata at all
    // must still produce a sensible Slack message. The error_type and
    // preview fields drop out cleanly without leaking ``undefined``.
    const msg = renderSlackBlocks('agent_error', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('_Type:_');
  });

  test('agent_error truncates long message_preview to keep Slack message readable', () => {
    // The preview cap is 200 chars — protects channel UX from a
    // pathological agent that emits a 4 KB error message.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'BigError',
      message_preview: 'X'.repeat(500),
    });
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain('...');
  });
});

// Task 15 (fork), #82 PR 3b-1.
describe('planning buttons', () => {
  const SID = 'abcdefghijklmnopqrstuvwxyz';
  const planTask = {
    task_id: 'task-1',
    repo: 'org/repo',
    task_description: 'plan a wishlist',
    pr_url: undefined as string | undefined,
    error_message: undefined as string | undefined,
    cost_usd: 0.2 as number | undefined,
    duration_s: 47 as number | undefined,
    status: TaskStatus.COMPLETED as TaskStatusType,
    resolved_workflow: { id: 'knowledge/feature-planning-v1', version: '1.0.0' },
    confluence_status: 'published',
    confluence_page_url: 'https://acme.atlassian.net/wiki/spaces/SD/pages/9/Plan',
  };

  function actionIds(blocks: readonly SlackBlock[]): string[] {
    return blocks
      .filter((b): b is ActionsBlock => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => ('action_id' in e ? e.action_id : '')))
      .filter(Boolean);
  }

  test('a delivered plan with a session gets Approve and Cancel carrying only the session id', () => {
    const msg = renderSlackBlocks('task_completed', planTask, undefined, { planningSessionId: SID });
    expect(actionIds(msg.blocks)).toEqual([`plan_approve:${SID}`, `plan_cancel:${SID}`]);
    const cancel = msg.blocks
      .filter((b): b is ActionsBlock => b.type === 'actions')
      .flatMap((b) => b.elements)
      .find((e) => 'action_id' in e && e.action_id.startsWith('plan_cancel'));
    expect(cancel).toMatchObject({ style: 'danger', confirm: { title: { text: 'Cancel this plan?' } } });
  });

  test.each([
    ['no session', planTask, undefined],
    ['a skipped page', { ...planTask, confluence_status: 'skipped' }, SID],
    ['a coding task', { ...planTask, resolved_workflow: { id: 'coding/new-task-v1', version: '1' } }, SID],
  ])('no plan buttons for %s', (_name, task, sid) => {
    const msg = renderSlackBlocks('task_completed', task, undefined, sid ? { planningSessionId: sid } : {});
    expect(actionIds(msg.blocks)).toEqual([]);
  });

  test('the large-plan confirmation shows the count and cost, with Confirm and Cancel', () => {
    const msg = renderPlanConfirmation(SID, 6, 3);
    expect(sectionText(msg.blocks[0])).toContain('6 stories, about $3.00');
    expect(actionIds(msg.blocks)).toEqual([`plan_confirm:${SID}`, `plan_cancel:${SID}`]);
  });
});
