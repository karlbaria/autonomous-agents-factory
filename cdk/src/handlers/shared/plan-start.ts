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
 * The real dependencies of Start's filing (#82 PR 3b-2), for the Slack
 * command processor: the repo's Jira project, the tenant's Jira client, the
 * guardrail, the approver's Slack name and the build start.
 */

import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { screenWithGuardrail } from './context-hydration';
import { reportIssueFailure } from './jira-feedback';
import { startJiraParentWork } from './jira-trigger-start';
import { logger } from './logger';
import { type FileDesignDeps, type FindTargetResult, planIdempotencyKey, type StartBuildArgs } from './plan-file';
import { makePlanJira } from './plan-file-jira';
import { DEFAULT_LABEL_FILTER } from './trigger-label';

/** Environment the processor passes in. */
export interface PlanStartConfig {
  readonly ddb: DynamoDBDocumentClient;
  readonly planningSessionTable: string;
  readonly projectMappingTable?: string;
  readonly workspaceRegistryTable?: string;
  readonly orchestrationTable?: string;
  readonly userConcurrencyTable?: string;
  readonly maxConcurrent: number;
  /** The Slack bot token for a team, or null. */
  readonly botToken: (teamId: string) => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
}

const SLACK_TIMEOUT_MS = 5_000;

/** The repo's only active Jira project mapping, or why there isn't one. */
export async function findJiraTarget(
  ddb: DynamoDBDocumentClient,
  projectMappingTable: string | undefined,
  repo: string,
): Promise<FindTargetResult> {
  if (!projectMappingTable) return { ok: false, message: 'Jira isn\'t set up on this deployment, so nothing was filed.' };
  const result = await ddb.send(new ScanCommand({
    TableName: projectMappingTable,
    FilterExpression: 'repo = :repo AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':repo': repo, ':active': 'active' },
  }));
  const rows = (result.Items ?? []).filter((r) => typeof r.cloud_id === 'string' && typeof r.project_key === 'string');
  if (rows.length === 0) {
    return { ok: false, message: `No Jira project is mapped to ${repo}, so nothing was filed. Ask an admin to map one.` };
  }
  if (rows.length > 1) {
    const keys = rows.map((r) => r.project_key as string).sort().join(', ');
    return {
      ok: false,
      message: `More than one Jira project is mapped to ${repo} (${keys}), so I won't guess which to file in. Nothing was filed. Ask an admin to leave one mapping.`,
    };
  }
  const row = rows[0];
  return {
    ok: true,
    target: {
      cloudId: row.cloud_id as string,
      projectKey: row.project_key as string,
      mapping: row,
      labelFilter: typeof row.label_filter === 'string' && row.label_filter ? row.label_filter : DEFAULT_LABEL_FILTER,
    },
  };
}

/** The guardrail's verdict on `text`, fail-closed: not configured or failing is `unavailable`. */
export async function screenStoryText(text: string, sessionId: string): Promise<'pass' | 'blocked' | 'unavailable'> {
  try {
    const result = await screenWithGuardrail(text, `plan-${sessionId}`);
    if (!result) return 'unavailable';
    return result.action === 'GUARDRAIL_INTERVENED' ? 'blocked' : 'pass';
  } catch {
    // Fail-closed: a screening error is `unavailable`, which stops the filing
    // and is reported in the thread.
    return 'unavailable';
  }
}

/** The requester's Slack display name, or their Slack id when it can't be read. */
async function slackDisplayName(
  config: PlanStartConfig,
  teamId: string,
  userId: string,
): Promise<string> {
  const fallback = `Slack user ${userId}`;
  const token = await config.botToken(teamId);
  if (!token) return fallback;
  try {
    const response = await (config.fetchFn ?? fetch)(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = await response.json() as { ok?: boolean; user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } } };
    const name = body.ok ? (body.user?.profile?.display_name || body.user?.profile?.real_name || body.user?.real_name) : undefined;
    return name?.trim() ? `${name.trim()} (${fallback})` : fallback;
  } catch (err) {
    logger.warn('Plan filing: Slack name lookup failed', { error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

/** Start the build from the filed parent, as the approver (decision 9). */
async function startBuild(config: PlanStartConfig, args: StartBuildArgs) {
  const registryTable = config.workspaceRegistryTable;
  if (!config.projectMappingTable || !registryTable || (args.children && !config.orchestrationTable)) {
    return { kind: 'failed' as const, message: 'The build can\'t be started on this deployment (Jira or orchestration isn\'t set up).' };
  }
  const children = args.children;
  return startJiraParentWork(
    {
      ddb: config.ddb,
      projectMappingTable: config.projectMappingTable,
      workspaceRegistryTable: registryTable,
      ...(config.orchestrationTable && { orchestrationTable: config.orchestrationTable }),
      ...(config.userConcurrencyTable && { userConcurrencyTable: config.userConcurrencyTable }),
      maxConcurrent: config.maxConcurrent,
      reportFailure: async (issueIdOrKey, cloudId, message) => {
        if (!cloudId) return;
        try {
          await reportIssueFailure({ cloudId, registryTableName: registryTable }, issueIdOrKey, message);
        } catch (err) {
          logger.warn('Plan build: Jira failure comment failed (non-fatal)', { issue_key: issueIdOrKey, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      issue: { id: args.parent.id, key: args.parent.key, fields: { summary: args.parent.summary, description: args.parent.description } },
      cloudId: args.target.cloudId,
      projectKey: args.target.projectKey,
      mapping: args.target.mapping,
      repo: args.session.repo,
      labelFilter: args.target.labelFilter,
      platformUserId: args.session.platform_user_id,
      idempotencyKey: planIdempotencyKey(args.session.session_id),
      duplicateIsStarted: true,
      graph: async () => (children ? { kind: 'ok', children } : { kind: 'no_children' }),
    },
  );
}

/** {@link FileDesignDeps} for the processor. */
export function makeFileDesignDeps(config: PlanStartConfig): FileDesignDeps {
  return {
    ddb: config.ddb,
    tableName: config.planningSessionTable,
    now: () => new Date(),
    findTarget: (repo) => findJiraTarget(config.ddb, config.projectMappingTable, repo),
    makeJira: async (cloudId) => (config.workspaceRegistryTable ? makePlanJira(cloudId, config.workspaceRegistryTable) : null),
    screen: (text) => screenStoryText(text, 'filing'),
    approverName: (session) => slackDisplayName(config, session.slack_team_id, session.slack_user_id),
    startBuild: (args) => startBuild(config, args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
