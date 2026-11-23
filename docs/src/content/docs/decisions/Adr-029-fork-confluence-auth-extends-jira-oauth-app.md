---
title: "ADR-029 (fork): Confluence auth extends the Jira OAuth app, no Forge actor"
---

**Status:** accepted
**Date:** 2026-11-22
**Implementation:** [autonomous-agents-factory#57](https://github.com/karlbaria/autonomous-agents-factory/issues/57) — Factory Lab Task 14 (`docs/lab/FACTORY_PLAN.md`). "(fork)" marks this ADR as a **fork** ADR per [ADR-003](/sample-autonomous-cloud-coding-agents/decisions/adr-003-contribution-governance): it is not proposed upstream.

## Context

Task 14 adds Confluence publishing for generated documentation (ADR, PRD, epic doc, research write-up): a markdown artifact becomes a Confluence page instead of, or in addition to, its current S3/repo destination. [ADR-015](/sample-autonomous-cloud-coding-agents/decisions/adr-015-jira-integration) already put two auth mechanisms in place for Jira on the same Atlassian site:

- **Per-tenant OAuth 2.0 (3LO)**, stored as `bgagent-jira-oauth-<cloudId>` in Secrets Manager — inbound reads and human lookup.
- **A dedicated Forge app actor**, reached through a signed web-trigger proxy — outbound writes, so a Jira comment or transition is attributed to the `bgagent` app account rather than the OAuth-authorizing setup user.

Confluence Cloud is confirmed to be on the same Atlassian site as Jira (no separate tenant/site onboarding). Three questions needed a decision before implementation: whether Confluence gets its own OAuth app or widens the existing one, whether it needs a Forge actor of its own, and — surfaced only during design review, not in the original plan text — where the token this adapter uses gets refreshed, since the agent-side code that will call Confluence has never had `PutSecretValue` on any tenant's OAuth bundle.

## Decision

**Extend the existing Jira OAuth 2.0 (3LO) app with Confluence's scopes; no Forge actor for Confluence in v1.**

### One app, one secret, widened scope

Confluence authorizes through the *same* Atlassian Developer Console app entry as Jira, the *same* per-tenant secret (`bgagent-jira-oauth-<cloudId>`), the *same* `cloudId`. An Atlassian OAuth app is not product-scoped at the registration level — adding Confluence's permissions to an app that already has Jira's permissions is supported, one consent screen, one secret.

Confluence Cloud's v2 REST API rejects the "classic" content scopes; it requires the granular, product-specific set:

- `read:page:confluence` / `write:page:confluence`
- `read:space:confluence`
- `read:label:confluence` / `write:label:confluence`
- `delete:page:confluence` — added in Task 14's PR 2a: if labelling a page the factory has just created fails (once retried), the deliverer deletes that page rather than leave an unlabelled factory page that every later run would report as an ownership clash

`offline_access` is already requested for Jira and is not re-requested.

**New CLI command, `bgagent confluence setup <cloud-id>`,** reruns the Atlassian OAuth authorization-code flow against the union of the Jira and Confluence scope lists, reusing the `client_id`/`client_secret` already stored in the tenant's existing secret (no re-prompt), and overwrites that same secret via the existing `upsertOauthSecret` idempotent-upsert helper — which already preserves the Forge app-actor fields across a rerun. The command refuses to run against a `cloud-id` that is not already an active row in the Jira workspace registry: Confluence is additive to an onboarded Jira tenant, never a standalone install.

**Manual Atlassian console step (owner):** add the Confluence product and the six scopes above to the existing app entry in developer.atlassian.com → My apps → Permissions, before running `bgagent confluence setup`. An existing refresh token does not retroactively gain scopes it was never asked for.

**Rollout order:** because this widens the secret the live Jira integration already depends on, `bgagent confluence setup` prints an explicit next step to run the existing Jira smoke test (a label-triggered task against a mapped Jira project) before relying on any Confluence delivery, to confirm Jira's own resolver still round-trips the widened bundle correctly.

### No Forge actor for Confluence

Jira's Forge actor exists because a Jira board scrutinizes who posted a comment or performed a transition — the OAuth-authorizing setup user showing up on every automated write was the problem it solved. Confluence page authorship has no equivalent audit/visibility concern in this fork's use case (generated documentation, not a tracked workflow surface), so the extra moving part — a second Forge web-trigger operation, a second signed-proxy round trip — is not justified for v1. If that changes, the existing Forge app can grow a `publish_page` operation the same way `create_issue` was added as a sixth allowlisted web-trigger operation for Task 13, without a new app.

### Space + parent-page mapping lives on RepoConfig, not a new table

The repo → space/parent-page mapping is three optional fields on the existing `RepoConfig` row (`RepoTable`) — `confluence_cloud_id`, `confluence_space_key`, `confluence_parent_page_id` — set with a partial `UpdateItem` by a new `bgagent confluence map <cloud-id> <space-key> --repo owner/repo [--parent-page-id <id>]` CLI command, the same pattern Task 13 (fork) used for `default_workflow`. This was changed from an initial `ConfluenceSpaceMappingTable` (DynamoDB) design during implementation: that table added one root-stack resource, and census testing found two already-maxed-out synthesis fixtures (deliberately constructed "every feature + padded model list" stress profiles, not the real deployed stack) sitting at exactly CloudFormation's reserved 490-resource ceiling — any new root-stack resource tipped them over. Reusing `RepoConfig` adds zero new resources, matching `default_workflow`'s precedent for exactly this kind of "a GitHub repo needs one more optional setting" case, and keeping this out of a separate table was in reach the whole time — Confluence has no secondary tenant key the way Jira's `{cloudId}#{projectKey}` composite needs, since this fork supports exactly one active Atlassian tenant ([ADR-015](/sample-autonomous-cloud-coding-agents/decisions/adr-015-jira-integration)).

**A repo on a repo-less workflow (corrected by [#61](https://github.com/karlbaria/autonomous-agents-factory/issues/61)).** This design assumed a `requires_repo: false` workflow such as `knowledge/web-research-v1` could carry `repo` purely for the mapping lookup. It couldn't: as soon as a repo was set, the agent took the coding path (clone → branch → PR), skipped `deliver_artifact`, and failed the task for having no PR. Since #61, a `knowledge`-domain workflow given a repo gets a read-only context clone (shallow, no branch, push disabled, no GitHub token for the agent). It then runs its full step list, `deliver_artifact` included, and is judged by its `terminal_outcomes`. `default/agent-v1` (`hybrid`) is unchanged.

### Token refresh ownership (the gap this ADR closes)

[ADR-015](/sample-autonomous-cloud-coding-agents/decisions/adr-015-jira-integration) established the invariant that the agent runtime never refreshes an Atlassian OAuth token — only trusted Lambda code (`jira-oauth-resolver.ts`, which holds `PutSecretValue`) does, because Atlassian rotates `refresh_token` on every use and an agent-side refresh would strand the tenant on a crash. For Jira, the token happens to already be fresh by the time the agent needs it only as a side effect: `fanout-task-events.ts::dispatchToJira` calls `jira-feedback.ts`, which calls `resolveJiraOutboundAuth(..., { forceRefresh })` when posting the task-started comment — before the agent session starts.

A repo-less `knowledge/web-research-v1` task with no Jira link has no equivalent write, so nothing refreshes the shared secret before the agent's terminal `deliver_artifact` step would need it for Confluence. PR 2 closes this by extending the same `dispatchToJira` task-started hook: when the task's repo has `confluence_cloud_id`/`confluence_space_key` set on its RepoConfig row — independent of any Jira link — it also calls `resolveJiraOutboundAuth`, using the resolver's normal refresh-if-near-expiry path (not `forceRefresh`; forcing rotation on every mapped-repo task adds refresh-token race risk the warming call does not need), and only when the task's resolved workflow actually declares a `confluence`/`s3_and_confluence` deliverer — a mapped repo running a workflow with no Confluence delivery step doesn't need its token warmed. The orchestrator stamps `confluence_oauth_secret_arn`/`confluence_cloud_id` into `channel_metadata` at task-creation time, mirroring the existing Jira stamp. The agent's `resolve_confluence_oauth_token()` shares `resolve_jira_oauth_token`'s fetch/expiry/fail-closed body — read-only, fails closed (skip + log) exactly like Jira's. No new refresh code, no change to which role can write the secret.

**As implemented (Task 14 PR 2b).** Two details differ from the design text above, for reasons found while building it:

- **Where the mapping is stamped.** The orchestrator adds `confluence_cloud_id`, `confluence_space_key`, `confluence_parent_page_id`, `confluence_oauth_secret_arn` and `confluence_site_url` to the agent payload's `channel_metadata` when it builds the payload (`hydrateAndTransition` → `cdk/src/handlers/shared/confluence-publishing.ts`), not at task creation. Tasks are created by several Lambdas (API, Slack, Jira, Linear, webhooks), and only some of them can read the Jira workspace registry. The orchestrator is the one place every task passes through, and it already reads the repo's `RepoConfig` and holds registry read access. The stamp is payload-only and is not written back to the task record.
- **Which resolver warms the token.** The fan-out Lambda warms the token on `task_created`, independent of any Jira link and only when the task's workflow declares a Confluence deliverer (the CDK-side `publishesConfluence` descriptor flag; `create-task-core` now puts `resolved_workflow` on the `task_created` event so no task read is needed). It calls `resolveJiraOauthToken` (the 3LO path, normal refresh-if-near-expiry, no `forceRefresh`), not `resolveJiraOutboundAuth`. For a tenant with a Forge app actor, `resolveJiraOutboundAuth` returns the app identity and never touches the 3LO token, and the 3LO token is the one Confluence uses.

**Warming window.** The warming call uses its own near-expiry window: at task start it refreshes the token if it expires within **45 minutes** (`CONFLUENCE_WARM_REFRESH_THRESHOLD_SECONDS`, passed as the resolver's `refreshThresholdSeconds`). It is still the ordinary refresh-if-near-expiry path, not `forceRefresh`. Other Lambda resolves keep the default 60-second window, and the agent's read-side check also stays at 60 seconds: it fails closed only when the token is actually about to expire. With the resolver's default window, a task that started with a few minutes of token life left would always skip Confluence. The 45-minute window gives every task at least 45 minutes of token life from its start.

How often this refreshes: Atlassian access tokens last about an hour, so a freshly refreshed token is not refreshed again until it is inside the window. That is at most once every ~15 minutes (60 − 45), however many Confluence tasks start, and about one refresh per task when tasks are more than 15 minutes apart.

What remains: a task that runs longer than 45 minutes after it started can still find the token expired at delivery. It reports `token_unavailable` (S3 and the comment still deliver, and the skip is visible), and is never silently skipped.

`bgagent jira setup` re-requests the Confluence scopes when an active tenant's stored bundle already has them, so re-running Jira setup does not downgrade the token. `--drop-confluence` is the explicit opt-out. If Atlassian returns a token without the Confluence scopes anyway (for example, because the app entry no longer grants them), the command refuses to store it and the existing token is left unchanged.

A skipped Confluence publish (expired/missing token, no mapping, an ownership clash, a detected human edit) is surfaced in the task's final summary/status (Slack thread + `bgagent status`) with a reason, and S3 delivery still completes — a skip is never silent.

### Ownership and edit-safety, decided alongside auth

Two guards decided during design review, implemented in PR 2's deliverer but recorded here because they shape what the widened scopes must cover:

- **Ownership guard:** every factory-created page carries a `factory-generated` label (`write:label:confluence`). The create-vs-update lookup (by title, under the mapped parent page) only treats a match as "ours" — eligible for update — if it carries that label; a same-titled page without it is left untouched and reported as a clash.
- **Edit detection, no new table:** after each write, a `factory.lastWrittenVersion` content property is stored on the page itself (`write:page:confluence` covers content properties). Before updating, the current `version.number` is compared against the stored property; a human edit since the last factory write is detected and reported, never silently overwritten. This doubles as Task 15's read-back mechanism (fetch content + version, detect a PM edit by version).
- **Draft/final lifecycle is a label** (`factory-draft` → `factory-final`), not a title prefix — a title mutation would break the title-based create/update match the moment a page is finalized.

## Consequences

- (+) One Atlassian app, one consent screen, one secret bundle for both products — no second OAuth client to provision, store, or rotate.
- (+) `bgagent confluence setup` is additive: a tenant that never runs it keeps Jira working exactly as before; `JIRA_OAUTH_SCOPES` is unchanged.
- (+) Reuses the Forge app-actor preservation logic in `upsertOauthSecret` for free — no code path forgets a configured Jira app actor when Confluence scopes are added later.
- (+) The token-refresh warming hook closes a real gap (found during design review, not in the original plan) without adding a second refresh path or widening which role can write the secret.
- (-) Confluence page writes are attributed to whichever human authorized the OAuth app, not a dedicated service identity — acceptable per the no-board-visibility reasoning above, but worth revisiting if Confluence authorship audit ever matters.
- (-) Widening an already-live tenant's scope is a live-secret mutation: the explicit rollout order (Jira smoke test immediately after `confluence setup`) exists specifically to catch a regression here before it's discovered by a failed Jira write in production.
- (!) `bgagent confluence setup` requires the tenant to already be an active Jira registry row — it is not a path to configure Confluence independently of Jira in this fork.

## References

- Issue: [#57 — Task 14: Confluence publishing for generated documentation](https://github.com/karlbaria/autonomous-agents-factory/issues/57)
- [ADR-015 (Jira Cloud integration)](/sample-autonomous-cloud-coding-agents/decisions/adr-015-jira-integration) — the OAuth/Forge-actor pattern this extends, and the token-refresh-ownership invariant this ADR's §"Token refresh ownership" preserves
- [JIRA_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide) — the Jira operational walkthrough `bgagent confluence setup` builds on
- Reference implementation: `cdk/src/handlers/shared/repo-config.ts` (`confluence_cloud_id`/`confluence_space_key`/`confluence_parent_page_id`), `cli/src/commands/confluence.ts`, `cli/src/jira-oauth.ts` (`CONFLUENCE_OAUTH_SCOPES`)
