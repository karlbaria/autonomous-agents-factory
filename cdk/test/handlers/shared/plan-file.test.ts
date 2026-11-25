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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { JiraIssueCreateFields } from '../../../src/handlers/shared/jira-app-actor';
import { fetchJiraSubIssueGraph } from '../../../src/handlers/shared/jira-subissue-fetch';
import type { StartJiraParentWorkResult } from '../../../src/handlers/shared/jira-trigger-start';
import { discoverOrchestration } from '../../../src/handlers/shared/orchestration-discovery';
import {
  fileDesign,
  type FileDesignDeps,
  INFLIGHT_ADOPT_GRACE_SECONDS,
  planIdempotencyKey,
  planLabel,
  type StartBuildArgs,
} from '../../../src/handlers/shared/plan-file';
import type { CreateIssueOutcome, LinkIssuesOutcome, PlanJira, PlanLabelledIssue } from '../../../src/handlers/shared/plan-file-jira';
import { parsePlan, planDigest, planStorageToText } from '../../../src/handlers/shared/plan-parse';
import type { PlanningSession } from '../../../src/handlers/shared/planning-session';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The checkpoint writes, against an in-memory row that enforces the lease the
// way planning-session.ts's conditions do (planning-session.test.ts pins the
// expressions themselves).
const rows = new Map<string, Record<string, any>>();
jest.mock('../../../src/handlers/shared/planning-session', () => {
  const holds = (id: string, since: number): Record<string, any> | null => {
    const row = rows.get(id);
    return row && row.state === 'approving' && row.approving_since === since ? row : null;
  };
  return {
    beginFiling: async (_d: unknown, _t: string, id: string, since: number, f: { planDigest: string; pageVersion: number | null; approvedAt: string }) => {
      const row = holds(id, since);
      if (!row || row.filing_plan_digest !== undefined) return false;
      Object.assign(row, { filing_plan_digest: f.planDigest, filing_page_version: f.pageVersion, filing_approved_at: f.approvedAt, filing_children: {}, filing_links: {} });
      return true;
    },
    markFilingInflight: async (_d: unknown, _t: string, id: string, since: number, step: string, now: number) => {
      const row = holds(id, since);
      if (!row) return false;
      row.filing_inflight = { step, since: now };
      return true;
    },
    clearFilingInflight: async (_d: unknown, _t: string, id: string, since: number) => {
      const row = holds(id, since);
      if (!row) return false;
      delete row.filing_inflight;
      return true;
    },
    recordFiledIssue: async (_d: unknown, _t: string, id: string, since: number, step: string, issue: { key: string; id: string }) => {
      const row = holds(id, since);
      if (!row) return false;
      if (step === 'parent') row.filing_parent = issue;
      else row.filing_children[step] = issue;
      delete row.filing_inflight;
      return true;
    },
    recordFiledLink: async (_d: unknown, _t: string, id: string, since: number, linkId: string) => {
      const row = holds(id, since);
      if (!row) return false;
      row.filing_links[linkId] = true;
      delete row.filing_inflight;
      return true;
    },
    recordBuildStarted: async (_d: unknown, _t: string, id: string, since: number) => {
      const row = holds(id, since);
      if (!row) return false;
      row.filing_build_started = true;
      return true;
    },
  };
});

const SID = 'abcdefghijklmnopqrstuvwxyz';
const LABEL = 'factory-plan-abcdefgh';
const SINCE = 1_800_000_000;
const SITE = 'https://example.atlassian.net';

type CreateScript = 'ok' | 'reject' | 'unknown_created' | 'unknown_lost' | 'epic_name_required';
type LinkScript = 'ok' | 'reject' | 'unknown_linked' | 'unknown_lost';

/** A Jira project: issues and links, with scripted outcomes for the next calls. */
class FakeJira implements PlanJira {
  readonly siteUrl = SITE;
  readonly issues: Array<PlanLabelledIssue & { readonly fields: JiraIssueCreateFields }> = [];
  readonly links: Array<[string, string]> = [];
  readonly creates: JiraIssueCreateFields[] = [];
  readonly linkCalls: Array<[string, string]> = [];
  createScript: CreateScript[] = [];
  linkScript: LinkScript[] = [];
  searchVisible = true;

  private add(fields: JiraIssueCreateFields): PlanLabelledIssue {
    const n = this.issues.length + 1;
    const issue = {
      key: `SHOP-${n}`,
      id: String(10_000 + n),
      summary: fields.summary,
      issueTypeName: fields.issueTypeName,
      ...(fields.parentKey && { parentKey: fields.parentKey }),
      fields,
    };
    this.issues.push(issue);
    return issue;
  }

  async createIssue(fields: JiraIssueCreateFields): Promise<CreateIssueOutcome> {
    this.creates.push(fields);
    const step = this.createScript.shift() ?? 'ok';
    if (step === 'reject') return { kind: 'rejected', status: 400, detail: 'summary: too long' };
    if (step === 'epic_name_required') {
      return { kind: 'rejected', status: 400, fieldErrors: { customfield_10011: 'Epic Name is required.' }, detail: 'Epic Name is required.' };
    }
    if (step === 'unknown_lost') return { kind: 'unknown' };
    const issue = this.add(fields);
    return step === 'unknown_created' ? { kind: 'unknown' } : { kind: 'created', key: issue.key, id: issue.id };
  }

  async linkBlocks(blockerKey: string, blockedKey: string): Promise<LinkIssuesOutcome> {
    this.linkCalls.push([blockerKey, blockedKey]);
    const step = this.linkScript.shift() ?? 'ok';
    if (step === 'reject') return { kind: 'rejected', status: 400, detail: 'no' };
    if (step === 'unknown_lost') return { kind: 'unknown' };
    this.links.push([blockerKey, blockedKey]);
    return step === 'unknown_linked' ? { kind: 'unknown' } : { kind: 'linked' };
  }

  async findByLabel(label: string): Promise<readonly PlanLabelledIssue[] | null> {
    if (!this.searchVisible) return [];
    return this.issues.filter((i) => i.fields.labels?.includes(label));
  }

  async hasBlocksLink(blockerKey: string, blockedKey: string): Promise<boolean | null> {
    return this.links.some(([a, b]) => a === blockerKey && b === blockedKey);
  }

  /** How many issues were created with this summary. */
  count(summary: string): number {
    return this.issues.filter((i) => i.summary === summary).length;
  }
}

function story(n: number, blockedBy = 'none', extra = ''): string {
  return `<h3>S${n}: Story ${n}</h3><p>Blocked by: ${blockedBy}</p><p>Do part ${n}.${extra}</p>`
    + `<p><strong>Acceptance criteria</strong></p><ul><li>Part ${n} works</li></ul>`
    + `<p><strong>Technical notes</strong></p><ul><li>Edit src/part${n}.ts (see D1)</li></ul>`;
}

const DESIGN_HEAD = '<h1>Technical design: Wishlist · ABC123</h1><h2>Summary</h2><p>Save items for later.</p>'
  + `<h2>Source</h2><ul><li><strong>Source:</strong> PRD page ${SITE}/wiki/spaces/SD/pages/1048580/PRD+Wishlist</li></ul>`
  + '<h2>Technical decisions</h2><h3>D1: Reuse the products table</h3><p>Reason: it exists.</p>'
  + '<h3>D2: No new service</h3><p>Reason: small.</p>';

function design(...stories: string[]) {
  const plan = parsePlan(planStorageToText(`${DESIGN_HEAD}<h2>Stories</h2>${stories.join('')}<h2>Questions for the PM</h2><p>None.</p>`));
  return { plan, pageId: '1540118', pageTitle: 'Technical design: Wishlist · FZZXB · 7FZZXB', pageVersion: 4 };
}

const CHAIN = (): ReturnType<typeof design> => design(story(1), story(2, 'S1'), story(3, 'S2'));

function session(): PlanningSession {
  return {
    session_id: SID,
    task_id: 'task-1',
    repo: 'karlbaria/factory-shop',
    page_id: '1540118',
    kind: 'design',
    slack_team_id: 'T1',
    slack_user_id: 'UPM',
    platform_user_id: 'user-pm',
    slack_channel_id: 'C1',
    state: 'approving',
    approving_since: SINCE,
    created_at: '2026-11-24T00:00:00.000Z',
    expires_at: SINCE + 86_400,
  };
}

interface Harness {
  readonly jira: FakeJira;
  deps: FileDesignDeps;
  readonly builds: StartBuildArgs[];
  readonly screened: string[];
  now: number;
  screenVerdict: (text: string) => 'pass' | 'blocked' | 'unavailable';
  buildResult: StartJiraParentWorkResult;
}

function harness(labelFilter = 'bgagent'): Harness {
  rows.clear();
  rows.set(SID, { ...session() });
  const jira = new FakeJira();
  const h: Harness = {
    jira,
    builds: [],
    screened: [],
    now: SINCE * 1000,
    screenVerdict: () => 'pass',
    buildResult: { kind: 'orchestration_seeded', orchestrationId: 'orch_1', childCount: 4 },
    deps: undefined as unknown as FileDesignDeps,
  };
  h.deps = {
    ddb: {} as DynamoDBDocumentClient,
    tableName: 'Sessions',
    now: () => new Date(h.now),
    findTarget: async () => ({
      ok: true,
      target: { cloudId: 'cloud-1', projectKey: 'SHOP', mapping: { repo: 'karlbaria/factory-shop' }, labelFilter },
    }),
    makeJira: async () => jira,
    screen: async (text) => {
      h.screened.push(text);
      return h.screenVerdict(text);
    },
    approverName: async () => 'Pat PM (Slack user UPM)',
    startBuild: async (args) => {
      h.builds.push(args);
      return h.buildResult;
    },
    sleep: async () => undefined,
  };
  return h;
}

/** The session as the next Start would read it. */
function current(): PlanningSession {
  return { ...rows.get(SID) } as PlanningSession;
}

/** A later Start: the lease taken again at a new time. */
function retake(h: Harness, afterSeconds = INFLIGHT_ADOPT_GRACE_SECONDS + 1): number {
  h.now += afterSeconds * 1000;
  const since = Math.floor(h.now / 1000);
  Object.assign(rows.get(SID)!, { state: 'approving', approving_since: since });
  return since;
}

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[]; marks?: Array<{ attrs?: { href?: string } }> };
  return [n.text ?? '', ...(n.content ?? []).map(adfText)].join(' ');
}

describe('fileDesign: a chain of three stories', () => {
  test('files an Epic, its Stories under it, "S1 blocks S2" links, and starts the build', async () => {
    const h = harness();
    const result = await fileDesign(session(), SINCE, CHAIN(), h.deps);

    expect(result).toMatchObject({ kind: 'started', parent: { key: 'SHOP-1' }, parentIsEpic: true });
    const [epic, ...children] = h.jira.creates;
    expect(epic).toMatchObject({ projectKey: 'SHOP', issueTypeName: 'Epic', summary: 'Wishlist', labels: [LABEL] });
    expect(epic.parentKey).toBeUndefined();
    expect(children.map((c) => [c.issueTypeName, c.summary, c.parentKey, c.labels])).toEqual([
      ['Story', 'Story 1', 'SHOP-1', [LABEL]],
      ['Story', 'Story 2', 'SHOP-1', [LABEL]],
      ['Story', 'Story 3', 'SHOP-1', [LABEL]],
    ]);
    // "Blocked by: S1" on S2 → S1 (SHOP-2) blocks S2 (SHOP-3).
    expect(h.jira.linkCalls).toEqual([['SHOP-2', 'SHOP-3'], ['SHOP-3', 'SHOP-4']]);
    expect(planLabel(SID)).toBe(LABEL);
    expect(rows.get(SID)).toMatchObject({ filing_build_started: true, filing_links: { 'S1>S2': true, 'S2>S3': true } });
  });

  test('the Epic\'s description has the Summary, the approver and UTC time, and the links', async () => {
    const h = harness();
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const text = adfText(h.jira.creates[0].description);
    expect(text).toContain('Save items for later.');
    expect(text).toContain('Approved in Slack by Pat PM (Slack user UPM) on 2027-01-15 08:00 UTC.');
    expect(text).toContain(`${SITE}/wiki/pages/viewpage.action?pageId=1540118`);
    expect(text).toContain(`${SITE}/wiki/spaces/SD/pages/1048580/PRD+Wishlist`);
  });

  test('each child carries its text, criteria, technical notes, the decisions it names, and the links', async () => {
    const h = harness();
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const text = adfText(h.jira.creates[2].description);
    for (const part of ['Do part 2.', 'Part 2 works', 'Edit src/part2.ts (see D1)', 'D1: Reuse the products table (Reason: it exists.)',
      `${SITE}/wiki/pages/viewpage.action?pageId=1540118`, `${SITE}/wiki/spaces/SD/pages/1048580/PRD+Wishlist`]) {
      expect(text).toContain(part);
    }
    // The story names D1 only, so D2 isn't copied in.
    expect(text).not.toContain('D2: No new service');
  });

  test('the build gets the filed graph, as the approver, with blockers as depends_on', async () => {
    const h = harness();
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const build = h.builds[0];
    expect(build.session.platform_user_id).toBe('user-pm');
    expect(build.parent).toMatchObject({ key: 'SHOP-1', id: '10001', summary: 'Wishlist' });
    expect(build.children!.map((c) => [c.id, c.issue_id, c.depends_on])).toEqual([
      ['SHOP-2', '10002', []],
      ['SHOP-3', '10003', ['SHOP-2']],
      ['SHOP-4', '10004', ['SHOP-3']],
    ]);
    expect(build.children![1].description).toContain('Edit src/part2.ts');
  });

  test('the orchestration it seeds releases only the roots first', async () => {
    const h = harness();
    await fileDesign(session(), SINCE, design(story(1), story(2, 'S1'), story(3)), h.deps);
    const send = jest.fn().mockResolvedValueOnce({ Item: undefined }).mockResolvedValue({});
    const seeded = await discoverOrchestration({
      ddb: { send } as never,
      tableName: 'Orch',
      parentIssueRef: 'SHOP-1',
      credentialsRef: 'cloud-1',
      repo: 'karlbaria/factory-shop',
      now: '2027-01-15T08:00:00.000Z',
      releaseContext: { platform_user_id: 'user-pm', channel_source: 'jira' },
      graphSource: async () => ({ kind: 'ok', children: h.builds[0].children! }),
    });
    expect(seeded).toMatchObject({ kind: 'seeded' });
    if (seeded.kind === 'seeded') expect([...seeded.rootSubIssueIds].sort()).toEqual(['SHOP-2', 'SHOP-4']);
  });
});

describe('fileDesign: a single story', () => {
  test('files one Story with the design summary and the story, and starts one task', async () => {
    const h = harness();
    h.buildResult = { kind: 'task_created', taskId: 'task-9' };
    const result = await fileDesign(session(), SINCE, design(story(1)), h.deps);
    expect(h.jira.creates).toHaveLength(1);
    expect(h.jira.creates[0]).toMatchObject({ issueTypeName: 'Story', summary: 'Wishlist', labels: [LABEL] });
    const text = adfText(h.jira.creates[0].description);
    expect(text).toContain('Save items for later.');
    expect(text).toContain('Part 1 works');
    expect(h.jira.linkCalls).toEqual([]);
    expect(h.builds[0].children).toBeUndefined();
    expect(result).toMatchObject({ kind: 'started', parentIsEpic: false, stories: [{ storyId: 'S1', key: 'SHOP-1' }] });
    expect(planIdempotencyKey(SID)).toBe(`plan-${SID}`);
  });
});

describe('fileDesign: refusals and the guardrail', () => {
  test('a guardrail block names the story and files nothing', async () => {
    const h = harness();
    h.screenVerdict = (text) => (text.includes('Story 2') ? 'blocked' : 'pass');
    const result = await fileDesign(session(), SINCE, CHAIN(), h.deps);
    expect(result).toEqual({ kind: 'blocked', storyId: 'S2', title: 'Story 2' });
    expect(h.jira.creates).toEqual([]);
    expect(rows.get(SID)!.filing_plan_digest).toBeUndefined();
  });

  test('screening that can\'t run files nothing (fail-closed)', async () => {
    const h = harness();
    h.screenVerdict = () => 'unavailable';
    const result = await fileDesign(session(), SINCE, CHAIN(), h.deps);
    expect(result.kind).toBe('stopped');
    expect(h.jira.creates).toEqual([]);
  });

  test('the guardrail sees only the story\'s own text, with no wrapper', async () => {
    const h = harness();
    await fileDesign(session(), SINCE, design(story(1)), h.deps);
    expect(h.screened).toEqual(['Story 1\nDo part 1.\nPart 1 works\nEdit src/part1.ts (see D1)']);
  });

  test('a trigger label that starts with factory-plan is refused', async () => {
    const h = harness('factory-plan-zzzzzzzz');
    const result = await fileDesign(session(), SINCE, CHAIN(), h.deps);
    expect(result.kind).toBe('stopped');
    expect(h.jira.creates).toEqual([]);
  });

  test('a repo with no single Jira project is refused', async () => {
    const h = harness();
    const deps = { ...h.deps, findTarget: async () => ({ ok: false as const, message: 'More than one Jira project is mapped' }) };
    expect(await fileDesign(session(), SINCE, CHAIN(), deps)).toEqual({ kind: 'stopped', message: 'More than one Jira project is mapped' });
    expect(h.jira.creates).toEqual([]);
  });
});

describe('fileDesign: resume without duplicates', () => {
  test('a failure at the parent, then Start again: one Epic', async () => {
    const h = harness();
    h.jira.createScript = ['reject'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('stopped');
    expect(h.jira.issues).toHaveLength(0);
    const since = retake(h);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.count('Wishlist')).toBe(1);
    expect(h.jira.issues).toHaveLength(4);
  });

  test('a failure at child 2, then Start again: each issue once', async () => {
    const h = harness();
    h.jira.createScript = ['ok', 'ok', 'reject'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('stopped');
    expect(h.jira.issues.map((i) => i.summary)).toEqual(['Wishlist', 'Story 1']);
    const since = retake(h);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.issues.map((i) => i.summary)).toEqual(['Wishlist', 'Story 1', 'Story 2', 'Story 3']);
    expect(h.jira.links).toEqual([['SHOP-2', 'SHOP-3'], ['SHOP-3', 'SHOP-4']]);
  });

  test('a failure mid-links, then Start again: each link once', async () => {
    const h = harness();
    h.jira.linkScript = ['ok', 'reject'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('stopped');
    const since = retake(h);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.issues).toHaveLength(4);
    expect(h.jira.links).toEqual([['SHOP-2', 'SHOP-3'], ['SHOP-3', 'SHOP-4']]);
    expect(h.jira.linkCalls).toEqual([['SHOP-2', 'SHOP-3'], ['SHOP-3', 'SHOP-4'], ['SHOP-3', 'SHOP-4']]);
  });

  test('a link whose outcome was unknown but which exists is recorded, not sent again', async () => {
    const h = harness();
    h.jira.linkScript = ['unknown_linked'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.links).toEqual([['SHOP-2', 'SHOP-3'], ['SHOP-3', 'SHOP-4']]);
  });

  test('a build that didn\'t start is retried alone on the next Start', async () => {
    const h = harness();
    h.buildResult = { kind: 'failed', message: '❌ ABCA is temporarily unavailable (status 503).' };
    const first = await fileDesign(session(), SINCE, CHAIN(), h.deps);
    expect(first).toMatchObject({ kind: 'stopped' });
    expect((first as { message: string }).message).toContain('Everything is filed, but I couldn\'t start the build. ABCA is temporarily unavailable');
    h.buildResult = { kind: 'orchestration_seeded', orchestrationId: 'orch_1', childCount: 4 };
    const since = retake(h);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.issues).toHaveLength(4);
    expect(h.builds).toHaveLength(2);
  });

  test('a design edited after filing began is not filed further', async () => {
    const h = harness();
    h.jira.createScript = ['ok', 'reject'];
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const since = retake(h);
    const edited = design(story(1, 'none', ' Also export.'), story(2, 'S1'), story(3, 'S2'));
    const result = await fileDesign(current(), since, edited, h.deps);
    expect(result).toMatchObject({ kind: 'stopped' });
    expect((result as { message: string }).message).toContain('changed after I started filing it');
    expect(h.jira.issues).toHaveLength(1);
    expect(rows.get(SID)!.filing_plan_digest).toBe(planDigest(CHAIN().plan));
  });
});

describe('fileDesign: an unknown outcome is adopted through the label', () => {
  test('a create that timed out but landed is found by its label and not created again', async () => {
    const h = harness();
    h.jira.createScript = ['ok', 'unknown_created'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.count('Story 1')).toBe(1);
    expect(h.jira.issues).toHaveLength(4);
  });

  test('a create that isn\'t in search yet pauses; the next Start adopts it once search lists it', async () => {
    const h = harness();
    h.jira.createScript = ['unknown_created'];
    h.jira.searchVisible = false;
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('stopped');
    expect(rows.get(SID)!.filing_inflight).toMatchObject({ step: 'parent' });
    h.jira.searchVisible = true;
    const since = retake(h, 10);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.count('Wishlist')).toBe(1);
  });

  test('a recent in-flight create still not found pauses instead of creating again', async () => {
    const h = harness();
    h.jira.createScript = ['unknown_lost'];
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const since = retake(h, 10);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('stopped');
    expect(h.jira.creates).toHaveLength(1);
  });

  test('an in-flight create still not found after the grace period is created again', async () => {
    const h = harness();
    h.jira.createScript = ['unknown_lost'];
    await fileDesign(session(), SINCE, CHAIN(), h.deps);
    const since = retake(h, INFLIGHT_ADOPT_GRACE_SECONDS + 1);
    expect((await fileDesign(current(), since, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.count('Wishlist')).toBe(1);
  });
});

describe('fileDesign: a company-managed Epic that needs Epic Name', () => {
  test('the named required field is set to the summary and the create retried once', async () => {
    const h = harness();
    h.jira.createScript = ['epic_name_required'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('started');
    expect(h.jira.creates[0].epicNameField).toBeUndefined();
    expect(h.jira.creates[1]).toMatchObject({ issueTypeName: 'Epic', summary: 'Wishlist', epicNameField: 'customfield_10011' });
    expect(h.jira.count('Wishlist')).toBe(1);
  });

  test('a second rejection stops rather than retrying again', async () => {
    const h = harness();
    h.jira.createScript = ['epic_name_required', 'epic_name_required'];
    expect((await fileDesign(session(), SINCE, CHAIN(), h.deps)).kind).toBe('stopped');
    expect(h.jira.creates).toHaveLength(2);
  });
});

describe('link direction round trip', () => {
  test('"blocker blocks blocked", as Jira shows it, reads back as the blocked story depending on the blocker', async () => {
    // The link Start creates for "S2 is blocked by S1": outward SHOP-2 (S1) blocks inward SHOP-3 (S2).
    const h = harness();
    await fileDesign(session(), SINCE, design(story(1), story(2, 'S1')), h.deps);
    const [blocker, blocked] = h.jira.linkCalls[0];
    // The parent's children as Jira's search returns them, each showing the link from its own side.
    const jiraView = {
      issues: [
        {
          id: '10002',
          key: blocker,
          fields: {
            summary: 'Story 1',
            project: { key: 'SHOP' },
            issuelinks: [
              { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: blocked } },
            ],
          },
        },
        {
          id: '10003',
          key: blocked,
          fields: {
            summary: 'Story 2',
            project: { key: 'SHOP' },
            issuelinks: [
              { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: blocker } },
            ],
          },
        },
      ],
      isLast: true,
    };
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(jiraView), { status: 200 }));
    const graph = await fetchJiraSubIssueGraph('token', 'cloud-1', 'SHOP-1', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(graph.kind).toBe('ok');
    if (graph.kind === 'ok') {
      expect(graph.children.map((c) => [c.id, c.depends_on])).toEqual([[blocker, []], [blocked, [blocker]]]);
    }
  });
});
