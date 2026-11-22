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
 * Platform side of Confluence publishing (Task 14 (fork), issue #57,
 * ADR-029 (fork)). Two pieces, both gated on the task's resolved workflow
 * actually publishing to Confluence ({@link workflowPublishesConfluence}):
 *
 *   - {@link resolveConfluenceChannelMetadata} — the orchestrator stamps the
 *     repo's Confluence mapping and the tenant's OAuth secret ARN into the
 *     agent payload's ``channel_metadata``; the agent's Confluence deliverer
 *     reads exactly these keys.
 *   - {@link warmConfluenceToken} — the fan-out Lambda refreshes the tenant's
 *     shared Jira+Confluence token on ``task_created`` when it is near expiry.
 *     The agent never refreshes (ADR-015: Atlassian rotates refresh tokens and
 *     the agent has no ``PutSecretValue``), and a repo-less task with no Jira
 *     link has no other trusted writer that would refresh it before delivery.
 *
 * Both are best-effort and never throw: a missing mapping, an inactive tenant
 * or a DynamoDB/Secrets Manager error degrades to a Confluence skip the agent
 * reports (``no_mapping`` / ``token_unavailable``), never a failed task.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getRegistryRow, resolveJiraOauthToken, type ResolverOptions } from './jira-oauth-resolver';
import { logger } from './logger';
import { loadRepoConfig, type RepoConfig } from './repo-config';
import type { TaskRecord } from './types';
import { makeDocClient } from './ua';
import { workflowPublishesConfluence } from './workflows';

/** The Confluence mapping fields of a repo's RepoConfig row. */
type ConfluenceMapping = Pick<RepoConfig, 'confluence_cloud_id' | 'confluence_space_key' | 'confluence_parent_page_id'>;

/**
 * The ``channel_metadata`` entries the agent's Confluence deliverer reads.
 *
 * Empty when the workflow does not publish to Confluence or the repo has no
 * mapping (the agent then reports ``no_mapping``). The mapping is stamped
 * even when the tenant's registry row cannot be resolved — the agent then has
 * no secret ARN and reports ``token_unavailable``, which names the real
 * problem instead of hiding it behind ``no_mapping``.
 */
export async function resolveConfluenceChannelMetadata(
  task: Pick<TaskRecord, 'task_id' | 'resolved_workflow'>,
  mapping: ConfluenceMapping | undefined,
  options: { readonly dynamoDbClient?: DynamoDBDocumentClient } = {},
): Promise<Record<string, string>> {
  if (!workflowPublishesConfluence(task.resolved_workflow?.id ?? '')) return {};
  const cloudId = mapping?.confluence_cloud_id;
  const spaceKey = mapping?.confluence_space_key;
  if (!cloudId || !spaceKey) return {};

  const metadata: Record<string, string> = {
    confluence_cloud_id: cloudId,
    confluence_space_key: spaceKey,
    ...(mapping.confluence_parent_page_id && {
      confluence_parent_page_id: mapping.confluence_parent_page_id,
    }),
  };

  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    logger.warn('Confluence mapping present but the Jira workspace registry is not configured', {
      task_id: task.task_id,
      confluence_cloud_id: cloudId,
    });
    return metadata;
  }
  const ddb = options.dynamoDbClient ?? makeDocClient();
  const row = await getRegistryRow(ddb, registryTableName, cloudId);
  if (!row || row.status !== 'active') {
    logger.warn('Confluence tenant is missing or inactive in the Jira workspace registry', {
      task_id: task.task_id,
      confluence_cloud_id: cloudId,
      status: row?.status,
    });
    return metadata;
  }
  return {
    ...metadata,
    confluence_oauth_secret_arn: row.oauth_secret_arn,
    confluence_site_url: row.site_url,
  };
}

/**
 * Near-expiry window for the warming call: refresh at task start when the
 * stored token expires within 45 minutes, so a research task finds a usable
 * token at delivery. Atlassian access tokens live about an hour, so a token
 * is refreshed at most once per ~15 minutes (60 − 45) however many tasks
 * start. The agent's own read-side check stays at 60 seconds.
 */
const WARM_WINDOW_MINUTES = 45;
const SECONDS_PER_MINUTE = 60;
export const CONFLUENCE_WARM_REFRESH_THRESHOLD_SECONDS = WARM_WINDOW_MINUTES * SECONDS_PER_MINUTE;

/** What {@link warmConfluenceToken} did — returned for logs and tests. */
export type ConfluenceWarmOutcome =
  | 'not_applicable'
  | 'no_mapping'
  | 'not_configured'
  | 'warmed'
  | 'unavailable';

/**
 * Make sure the tenant's stored token will be usable when the agent's
 * Confluence deliverer reads it.
 *
 * Uses the resolver's normal refresh-if-near-expiry path with a wider,
 * warming-specific window ({@link CONFLUENCE_WARM_REFRESH_THRESHOLD_SECONDS}),
 * never ``forceRefresh``: forcing a rotation on every task would add
 * refresh-token race risk this warming call does not need. Calls
 * ``resolveJiraOauthToken`` (the 3LO path) rather than
 * ``resolveJiraOutboundAuth``: a tenant with a Forge app actor resolves to the
 * app identity there and never touches the 3LO token, which is the one
 * Confluence uses.
 */
export async function warmConfluenceToken(
  task: { readonly task_id: string; readonly repo?: string; readonly workflowId?: string },
  options: ResolverOptions = {},
): Promise<ConfluenceWarmOutcome> {
  if (!workflowPublishesConfluence(task.workflowId ?? '') || !task.repo) return 'not_applicable';
  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) return 'not_configured';

  let repoConfig: RepoConfig | null;
  try {
    repoConfig = await loadRepoConfig(task.repo);
  } catch (err) {
    logger.warn('[fanout/confluence] repo config lookup failed — token not warmed', {
      event: 'fanout.confluence.warm_failed',
      task_id: task.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unavailable';
  }
  const cloudId = repoConfig?.confluence_cloud_id;
  if (!cloudId || !repoConfig?.confluence_space_key) return 'no_mapping';

  let resolved: Awaited<ReturnType<typeof resolveJiraOauthToken>> = null;
  try {
    resolved = await resolveJiraOauthToken(cloudId, registryTableName, {
      ...options,
      refreshThresholdSeconds: CONFLUENCE_WARM_REFRESH_THRESHOLD_SECONDS,
    });
  } catch (err) {
    logger.warn('[fanout/confluence] token refresh threw', {
      event: 'fanout.confluence.warm_failed',
      task_id: task.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!resolved) {
    logger.warn('[fanout/confluence] Confluence token could not be resolved — the agent will skip publishing', {
      event: 'fanout.confluence.warm_failed',
      task_id: task.task_id,
      confluence_cloud_id: cloudId,
    });
    return 'unavailable';
  }
  logger.info('[fanout/confluence] Confluence token warmed', {
    event: 'fanout.confluence.warmed',
    task_id: task.task_id,
    confluence_cloud_id: cloudId,
  });
  return 'warmed';
}
