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
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { CliError } from '../errors';
import { requireDeployedFeature } from '../feature-guard';
import {
  buildAuthorizationUrl,
  CONFLUENCE_OAUTH_SCOPES,
  computeExpiresAt,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  generatePkce,
  JIRA_OAUTH_SCOPES,
  jiraOauthSecretName,
  parseStoredJiraOauthToken,
  StoredJiraOauthToken,
} from '../jira-oauth';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';
import { loadActiveRepoConfig } from '../repo-lookup';
import { getStackOutput } from '../stack-outputs';
import { makeClient, makeDocClient } from '../ua';
import { openBrowser, randomState, upsertOauthSecret } from './jira';

/** Confluence space keys: Atlassian accepts letters, digits and underscore,
 *  starting with a letter — mirrors Jira's `PROJECT_KEY_RE` but case-
 *  insensitive, since Confluence (unlike Jira) does not force uppercase. */
const SPACE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

interface JiraWorkspaceRegistryRow {
  readonly jira_cloud_id: string;
  readonly site_url?: string;
  readonly status?: string;
}

function isRegistryRow(value: unknown): value is JiraWorkspaceRegistryRow {
  return typeof value === 'object' && value !== null
    && typeof (value as { jira_cloud_id?: unknown }).jira_cloud_id === 'string';
}

export function makeConfluenceCommand(): Command {
  const confluence = new Command('confluence')
    .description('Manage Confluence publishing for generated documentation');

  // ─── setup ────────────────────────────────────────────────────────────────
  confluence.addCommand(
    new Command('setup')
      .description(
        'Widen an already-onboarded Jira tenant\'s OAuth consent to include Confluence scopes '
        + '(same Atlassian app, same secret — run `bgagent jira setup` first)',
      )
      .argument('<cloud-id>', 'Atlassian tenant cloudId (UUID) — must already be onboarded via `bgagent jira setup`')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .action(async (cloudId: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        const registryTableName = await getStackOutput(region, stackName, 'JiraWorkspaceRegistryTableName');
        if (!registryTableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output JiraWorkspaceRegistryTableName. `
            + 'Re-deploy with the JiraIntegration CDK changes (mise //cdk:deploy).',
          );
        }

        const ddb = makeDocClient({ region });
        const registryResult = await ddb.send(new GetCommand({
          TableName: registryTableName,
          Key: { jira_cloud_id: cloudId },
        }));
        if (!isRegistryRow(registryResult.Item) || registryResult.Item.status !== 'active') {
          throw new CliError(
            `No active Jira tenant '${cloudId}' in the workspace registry. `
            + 'Run `bgagent jira setup` first — Confluence shares that tenant\'s OAuth app and secret.',
          );
        }

        const sm = makeClient(SecretsManagerClient, { region });
        const secretName = jiraOauthSecretName(cloudId);
        const existingSecret = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
        const existing = parseStoredJiraOauthToken(existingSecret.SecretString, secretName);
        if (existing.cloud_id !== cloudId) {
          throw new CliError(
            `OAuth secret '${secretName}' cloud_id '${existing.cloud_id}' does not match requested tenant '${cloudId}'.`,
          );
        }

        console.log('bgagent confluence setup');
        console.log(`  region: ${region}`);
        console.log(`  tenant: ${existing.site_url} (${cloudId})`);
        console.log(
          '\nThis reuses the Atlassian OAuth app already configured for Jira, reauthorizing with '
          + 'Confluence scopes added. Add the Confluence product + these scopes to that app in '
          + 'developer.atlassian.com → My apps → Permissions before continuing:',
        );
        console.log(`    ${CONFLUENCE_OAUTH_SCOPES.join(', ')}`);
        console.log();

        const pkce = generatePkce();
        const state = randomState();
        const authorizationUrl = buildAuthorizationUrl({
          clientId: existing.client_id,
          redirectUri: CALLBACK_URL,
          state,
          codeChallenge: pkce.codeChallenge,
          scopes: [...JIRA_OAUTH_SCOPES, ...CONFLUENCE_OAUTH_SCOPES],
        });

        const callbackPromise = awaitOauthCallback();

        if (opts.browser !== false) {
          const opened = await openBrowser(authorizationUrl);
          if (opened) {
            console.log('  → Opened your browser to the Atlassian consent screen.');
          } else {
            console.log('  → Could not open browser automatically. Open this URL manually:');
            console.log(`    ${authorizationUrl}`);
          }
        } else {
          console.log('  → --no-browser: open this URL manually:');
          console.log(`    ${authorizationUrl}`);
        }

        process.stdout.write('  → Waiting for browser callback...');
        const callback = await callbackPromise;
        console.log(' ✓');

        if (callback.kind !== 'direct-oauth') {
          throw new CliError(
            'Localhost callback returned an AgentCore session_id, not a direct OAuth code. '
            + 'Verify Atlassian\'s redirect URI is set to http://localhost:8080/oauth/callback and re-run.',
          );
        }
        if (callback.state !== state) {
          throw new CliError(
            `OAuth state mismatch (expected '${state}', got '${callback.state}'). `
            + 'Possible CSRF attack or stale tab — re-run setup.',
          );
        }

        process.stdout.write('  → Exchanging code for access token...');
        const tokenResponse = await exchangeAuthorizationCode({
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: CALLBACK_URL,
          clientId: existing.client_id,
          clientSecret: existing.client_secret,
        });
        console.log(' ✓');

        if (!tokenResponse.refresh_token) {
          throw new CliError(
            'Atlassian did not return a refresh_token. Verify the app still requests offline_access '
            + '(it does by default; this scope is not shown in the dev-console scope list).',
          );
        }

        process.stdout.write('  → Confirming the authorized token still covers this tenant...');
        const resources = await fetchAccessibleResources(tokenResponse.access_token);
        if (!resources.some((r) => r.id === cloudId)) {
          throw new CliError(
            `The authorized Atlassian account does not have access to tenant '${cloudId}'. `
            + 'Re-run and authorize with an account that has access to the same site Jira uses.',
          );
        }
        console.log(' ✓');

        process.stdout.write('  → Storing widened OAuth token...');
        const now = new Date().toISOString();
        const stored: StoredJiraOauthToken = {
          ...existing,
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          expires_at: computeExpiresAt(tokenResponse.expires_in),
          scope: tokenResponse.scope,
          updated_at: now,
        };
        await upsertOauthSecret(sm, secretName, stored, cloudId);
        console.log(` ✓ (${secretName})`);

        console.log();
        console.log('✅ Setup complete. The Jira and Confluence integrations now share one token.');
        console.log();
        console.log('Before relying on Confluence delivery, confirm Jira still works with the widened token:');
        console.log('  1. Trigger the existing Jira smoke test (a label-triggered task on a mapped project).');
        console.log('Then map a repo to a Confluence space:');
        console.log(
          `  2. bgagent confluence map ${cloudId} <SPACE-KEY> --repo owner/repo `
          + `--region ${region} --stack-name ${stackName}`,
        );
      }),
  );

  // ─── map ──────────────────────────────────────────────────────────────────
  // Writes onto the repo's existing RepoTable row — same pattern as
  // `default_workflow` (Task 13 (fork)) — rather than a dedicated mapping
  // table: three optional RepoConfig fields, set/cleared with a partial
  // UpdateItem so every other field on the row (default_workflow,
  // build_command, …) is left untouched.
  confluence.addCommand(
    new Command('map')
      .description('Map a Confluence space (+ optional parent page) onto a GitHub repository\'s config (admin IAM required)')
      .argument('<cloud-id>', 'Atlassian tenant cloudId (UUID)')
      .argument('<space-key>', 'Confluence space key (e.g. ENG)')
      .requiredOption('--repo <owner/repo>', 'GitHub repository whose generated write-ups should publish to this space')
      .option('--parent-page-id <id>', 'Confluence page id to create pages under (else the space root). Omit on a later `map` to clear it.')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (cloudId: string, spaceKey: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const repoTableName = await getStackOutput(region, opts.stackName, 'RepoTableName');
        if (!repoTableName) {
          console.error('Could not find RepoTableName in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) {
          console.error(`Invalid --repo value: ${opts.repo}. Expected owner/repo.`);
          process.exit(1);
        }

        if (!SPACE_KEY_RE.test(spaceKey)) {
          console.error(`Invalid Confluence space key: ${spaceKey}`);
          console.error('Space keys start with a letter and contain only letters/digits/underscore.');
          process.exit(1);
        }

        await loadActiveRepoConfig(region, repoTableName!, opts.repo);

        const parentPageId = opts.parentPageId?.trim() || undefined;
        const now = new Date().toISOString();
        const setClauses = [
          'confluence_cloud_id = :cloudId',
          'confluence_space_key = :spaceKey',
          'updated_at = :updatedAt',
        ];
        const values: Record<string, unknown> = {
          ':cloudId': cloudId,
          ':spaceKey': spaceKey,
          ':updatedAt': now,
        };
        // A full REMOVE when the flag is omitted mirrors `jira map`'s
        // --auto-track convention: a later `map` without the flag turns it
        // back off rather than silently carrying forward a stale value.
        const removeClauses: string[] = [];
        if (parentPageId) {
          setClauses.push('confluence_parent_page_id = :parentPageId');
          values[':parentPageId'] = parentPageId;
        } else {
          removeClauses.push('confluence_parent_page_id');
        }

        const ddb = makeDocClient({ region });
        await ddb.send(new UpdateCommand({
          TableName: repoTableName,
          Key: { repo: opts.repo },
          UpdateExpression: `SET ${setClauses.join(', ')}`
            + (removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(', ')}` : ''),
          ExpressionAttributeValues: values,
        }));

        console.log(`✓ Mapped Confluence space ${cloudId}#${spaceKey} → ${opts.repo}`);
        console.log(parentPageId ? `  Parent page: ${parentPageId}` : '  Parent page: (space root)');
      }),
  );

  return requireDeployedFeature(confluence, 'jira');
}
