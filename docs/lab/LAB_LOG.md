# Lab Log

Session notes for the software-factory lab (see `docs/lab/FACTORY_PLAN.md` for the task breakdown and the decisions log).

## Task 1: Fork, fix local tooling, and run locally

### 1. What was done, and where it differed from the plan

- Forked and cloned `aws-samples/sample-autonomous-cloud-coding-agents` to `karlbaria/autonomous-agents-factory` — already done before this session started.
- Copied `FACTORY_PLAN.md` into `docs/lab/FACTORY_PLAN.md` — already done before this session started.
- Installed with `mise install`, `yarn install --check-files`, and `agent && mise run install`.
  - **Differed from plan:** the plan says "if `prek install` fails because `core.hooksPath` is set globally, fix it at repo scope, not in global git config." In practice `core.hooksPath` was set at **system** scope (`/usr/local/amazon/var/git-defender/hooks`, Amazon's git-defender tool), not global, and the owner chose to leave it alone rather than override it locally. `prek install` was skipped entirely for this repo. Substitute: run `mise run build` and `mise run security` manually before every commit here.
- Created a private sandbox repo, `karlbaria/factory-sandbox-py`: a minimal FastAPI service (`/health`, `/greet/{name}`) with pytest tests, build/test instructions in its README.
- Created a fine-grained PAT scoped only to `factory-sandbox-py`, stored in the macOS Keychain (service `factory-sandbox-pat`) rather than as a plain env var or file — read inline per command, never printed.
- Ran `DRY_RUN=1 ./agent/run.sh karlbaria/factory-sandbox-py 1`, then a real run.
  - **Differed from plan:** the first dry run failed — `agent/run.sh`'s local Docker build used the wrong build context. Fixed as its own issue/PR rather than folded into Task 1's direct-to-main commits (see "Open items" / problems below).
- `mise run build` and `MISE_EXPERIMENTAL=1 mise //agent:quality` both pass.

### 2. Baseline metrics (factory-sandbox-py run, issue #1 → PR #2 on the sandbox repo)

| Metric | Value |
|---|---|
| Cost | $0.1378 |
| Turns | 5 (5 attempted, 5 completed) |
| Duration | 33.1s agent loop (36.4s total incl. post-hook build/lint gate checks) |
| Docker image size | 2616 MB |
| Main model | `global.anthropic.claude-opus-5-5` |
| Pre-flight/haiku model | `global.anthropic.claude-haiku-5-5` (default, not overridden) |
| Build gate | passed (inert — sandbox repo has no mise tasks) |
| Lint gate | failed to run (inert — no linter configured in the sandbox repo) |
| Result | PR opened: `karlbaria/factory-sandbox-py#2`, closes issue #1 |

### 3. Problems hit and how each was solved

1. **`prek install` fails on `core.hooksPath`.** Root cause turned out to be **system**-scope git-defender, not global config. Decision: leave git-defender alone, skip `prek install`, substitute manual `mise run build` + `mise run security` before each commit (recorded in `FACTORY_PLAN.md`'s Lab decisions log).
2. **`yarn install --check-files` failed:** `mise ERROR yarn is not provided by the active node@22.23.4 ... yarn is provided by: node@22.23.5`. The pinned node (22.23.4) had no corepack-generated `yarn` shim yet. Fixed with `mise exec -- corepack enable`, which created the shim; `yarn install` then succeeded.
3. **`agent/run.sh`'s local Docker build failed** with missing-path errors (`"/agent/src": not found`, etc.). Root cause: `docker build` used `agent/` (the script's own directory) as the build context, but `agent/Dockerfile`'s `COPY` instructions assume repo-root context — matching how `cdk/src/stacks/agent.ts` builds the same image for deployment (`directory: repoRoot, file: 'agent/Dockerfile'`). Fixed by adding `REPO_ROOT` and passing `-f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"`. Filed as issue #1, fixed on branch `fix/run-sh-build-context`, PR #2.
4. **No least-privilege AWS credentials were initially available** — the only working local profile (`codex-bedrock`) resolved to an `Admin` role. The owner created a new profile, `factory-bedrock`, assuming a role (`factory-bedrock-invoke`) scoped to exactly `bedrock:InvokeModel`/`InvokeModelWithResponseStream` on Anthropic models/inference profiles — confirmed via `aws iam get-role-policy` and a live `aws bedrock-runtime converse` smoke test against both ABCA default models (`global.anthropic.claude-opus-5-5`, `global.anthropic.claude-haiku-5-5`) in `us-east-2`.
5. **`mise run security` failed** on `agent:security:image`: trivy found 5 HIGH/CRITICAL CVEs, all inside the vendored `/usr/local/bin/uv` rustbinary (quinn-proto, zip/zip2) copied into the image via a digest-pinned `ghcr.io/astral-sh/uv:0.11.14` layer — unrelated to any change made this session. Decision: don't block the docs-only commit on it; filed as issue #3, to be fixed first in Task 2.
6. **`git push origin main` was rejected** ("fetch first"): PR #2 had already been merged into `origin/main` (by the repo owner, directly, outside this session) while the next commit was being prepared locally. Resolved with `git fetch origin main && git rebase origin/main && git push origin main`.

### 4. Exact commands that worked

```bash
# Install
mise install
mise exec -- corepack enable        # one-time: creates the yarn shim for the pinned node version
yarn install --check-files
(cd agent && mise run install)      # uv sync --locked --all-groups

# Build / quality gates (manual substitute for the skipped prek hooks)
MISE_EXPERIMENTAL=1 mise run build
MISE_EXPERIMENTAL=1 mise run security
MISE_EXPERIMENTAL=1 mise //agent:quality

# Dry run
GITHUB_TOKEN="$(security find-generic-password -s factory-sandbox-pat -w)" \
AWS_PROFILE=factory-bedrock AWS_REGION=us-east-2 \
DRY_RUN=1 ./agent/run.sh "karlbaria/factory-sandbox-py" 1

# Demo: the real run
GITHUB_TOKEN="$(security find-generic-password -s factory-sandbox-pat -w)" \
AWS_PROFILE=factory-bedrock AWS_REGION=us-east-2 \
./agent/run.sh "karlbaria/factory-sandbox-py" 1
```

**Expected demo result:** the Docker image builds (~2.6 GB — the "exceeds AgentCore 2 GB limit" warning is expected and not a blocker in local mode), the container runs Claude Code against issue #1, and the run ends with `DONE status=success` and a `code_change_published` event. Verify with `gh pr list --repo karlbaria/factory-sandbox-py`: an open PR closing issue #1, adding the requested endpoint and a passing test.

### 5. Open items

- **[#3](https://github.com/karlbaria/autonomous-agents-factory/issues/3)** — 5 HIGH/CRITICAL CVEs in the vendored `uv` binary (`agent/Dockerfile`). Fix first in Task 2, before any deploy.
- **Branch protection** — `main` on this fork has **no branch protection** (`gh api repos/.../branches/main/protection` → 404). `.mergify.yml`'s queue conditions (`#approved-reviews-by>=1`, `status-success=build`) are therefore not enforced by GitHub itself; PR #2 merged in ~2 minutes with no recorded review. Decide whether to turn on branch protection (require the `build` check, require 1 review) for this fork, or accept solo-owner merges as-is.
- **Workflows review** — the repo's `.github/workflows/` (auto-approve, build, deploy, integ, security, security-pr, upgrade-main, monthly-repo-metrics, pull-request-lint, docs) haven't been reviewed for fit with a personal, lab-use fork (e.g. scheduled upgrade PRs, metrics reporting, deploy triggers) — worth a pass before Task 2's deploy.
- **Image size** — the local `bgagent-local` image is 2616 MB, over AgentCore's 2048 MB runtime limit. Not a blocker for local `run.sh` use, but needs addressing before Task 2 deploys to AgentCore.

### 6. Context for Task 2

- Deploy with `AWS_PROFILE=factory-base`, approving each command individually.
- Agents use `AWS_PROFILE=factory-bedrock` (Bedrock-invoke only).
- Fix **#3** (vendored `uv` CVEs) first, before deploying.
- Check `CDKToolkit` (bootstrap stack) in the target account/region before deploying.
- Stack name: `backgroundagent-dev-factory`.
- Tag: `project=software-factory`.

## Task 2: Deploy the baseline to the lab account and write a component tour

### 1. What was done, and where it differed from the plan

- **Fixed #3 before deploying, as planned**, and found a second issue along the way: with the vendored `uv` binary clean, `mise run security` still failed on 17 HIGH CVEs in the vendored `gh` CLI (`GH_VERSION=2.93.0`, 11 releases stale) — pre-existing, unrelated to #3, surfaced only because #3's fix cleared the first blocker. Filed as **#4**, fixed in the same branch (bumping `GH_VERSION` to `2.104.0` and the `golang` builder image to `1.27.4-bookworm`), with one remaining unreachable finding (`CVE-2026-78661`, `golang.org/x/net/html` — confirmed via `go mod why` that `gh` never imports it) suppressed in a dated, justified `agent/.trivyignore` entry. PR [#5](https://github.com/karlbaria/autonomous-agents-factory/pull/5), `mise run build` and `mise run security` both pass clean, merged before any deploy step ran.
- **Corrected a Task 1 assumption about the AgentCore image-size limit.** It is real and does apply to the deployed image (the CDK stack builds from the same `agent/Dockerfile`), but AWS measures it on **compressed** image size, not the uncompressed `docker images` figure `run.sh` prints. Pushed the built image to a local registry and measured the real compressed manifest: ~740 MB, comfortably under AgentCore platform-V1's 2 GB (compressed) cap — no shrinking needed, no reason to consider ECS.
- **Deployed with every optional feature, not `--features none`.** The owner ran `bgagent setup` interactively and chose Slack, Linear, Jira, deploy-preview screenshots, Agent Registry and Tool Gateway. **Differed from plan:** before that run, this session wrote `abca.deployment.backgroundagent-dev-factory.json` with `--no-deploy` to pre-stage the minimal profile for review; the wizard overwrote it with all features `true`, matching the deployed stack's `DeploymentFeatures` output. Audited the result: every route the extra features add is either `AuthorizationType.COGNITO` or `NONE` at the gateway with a real HMAC check in its Lambda handler (Slack signing secret, GitHub `X-Hub-Signature-256`, Jira/Linear webhook secrets) — none are open. Full per-route table below.
- **Reused the account's existing CDKToolkit bootstrap as-is**, after confirming it's the vanilla default (`CloudFormationExecutionRole` = `AdministratorAccess`), not ABCA's own least-privilege bundle (`cdk/src/bootstrap/policies/`, currently `BOOTSTRAP_VERSION 1.8.0`) — `bgagent setup` itself detects this (no `BootstrapPolicyVersion` output) and skips the `backgroundagent-dev[-suffix]` naming check accordingly. The stock `backgroundagent-dev` stack already deploys against the same bootstrap. Owner's call: don't touch shared account state for this task; track the gap in Open items.
- **`project=software-factory` tag not yet applied.** Every other required tag (`compute_type`, `github:*`) landed from CDK's own `Tags.of()` calls, but there's no `--tags` passthrough in `bgagent setup` — only in the underlying `mise //cdk:deploy` CDK invocation. **Differed from plan:** this session's Bash tool was denied (by Claude Code's own auto-mode permission classifier, "Blind Apply") from running `mise //cdk:deploy` directly, on the first attempt (an initial deploy) and the second (a tag-only re-deploy). The command is written up in Open items for the owner to run.
- **Reviewed every `.github/workflows/` file** for fit with a solo-owner lab fork; none enabled. See the table in Open items.

### 2. Baseline metrics

| Metric | Before (Task 1) | After (Task 2) |
|---|---|---|
| `agent/Dockerfile` image CVEs (trivy, HIGH/CRITICAL) | 5 (vendored `uv`) | 0 (uv and gh both clean; 1 justified `.trivyignore` suppression) |
| Image size, uncompressed (`docker images`) | 2616 MB | 2599.6 MB |
| Image size, compressed (actual registry/AgentCore measure) | not measured | ~740.5 MB (63% headroom under the 2 GB V1 cap) |
| Stack | none deployed | `backgroundagent-dev-factory`, `CREATE_COMPLETE`, us-east-2 |
| Deployed features | — | slack, linear, jira, deployPreviewScreenshots, agentRegistry, toolGateway (all) |
| Compute backend | — | AgentCore only (`ComputeDeploymentMode=exclusive`) |
| Est. idle cost | — | ~$149/month (~90% NAT Gateway + 7 interface VPC endpoints × 2 AZs) |
| Bedrock model access | — | all 6 required models `ACTIVE` in us-east-2, global inference profiles present; no changes needed |
| `.github/workflows/` reviewed | — | 10 reviewed, 0 enabled |

### 3. Problems hit and how each was solved

1. **Fixing #3 exposed #4** — see "What was done" above. Resolved in the same branch/PR rather than a second issue-branch-PR cycle, since both are the same root cause (a stale pinned build input) discovered in sequence while chasing one security gate.
2. **This session's Bash tool could not run `mise //cdk:deploy`.** Claude Code's auto-mode permission classifier denied it twice ("Blind Apply") — once for the initial deploy (the owner ran it themselves via the `bgagent setup` wizard instead) and once for a tag-only re-deploy to add `project=software-factory`. Did not attempt to route the same mutation through a different tool (e.g. a raw `UpdateStack` call) to work around the denial, since that would defeat the point of the restriction. Left the exact command for the owner to run.
3. **The AgentCore image-size question needed a real measurement, not a guess.** `run.sh`'s printed size is uncompressed local disk usage; AWS's limit is on compressed registry size, and the two differ by ~3.5x for this image (mixed Python/Node/binary content compresses well). Measured it directly: pushed the built image to a throwaway local `registry:2` container and read the pushed manifest's layer sizes, rather than estimating from `gzip` ratios.
4. **`mise //cdk:deploy` run directly (not through `bgagent setup`) needs `ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1`.** The deploy task's own preflight (`cdk/scripts/preflight-bootstrap.ts`) fails by default on a standard (non-ABCA) bootstrap — `bgagent setup` sets this env var automatically when it detects one (per `docs/guides/DEPLOYMENT_GUIDE.md`'s step 5), but a direct `mise //cdk:deploy` invocation (used for both the tag and the X-Ray tracing deploy) does not go through that wizard logic, so the owner had to set it by hand. Correct to set, given the deliberate choice to reuse the account's existing default bootstrap (see the bootstrap decision above) rather than install ABCA's own least-privilege one.

### 4. Exact commands that worked

```bash
# Issue #3/#4 fix (see agent/Dockerfile and agent/.trivyignore diffs in PR #5)
MISE_EXPERIMENTAL=1 mise run build
MISE_EXPERIMENTAL=1 mise run security

# Compressed image size measurement
docker run -d --name local-registry-check -p 5501:5000 registry:2
docker tag bgagent-local:latest localhost:5501/bgagent-check:latest
docker push localhost:5501/bgagent-check:latest
# then read the pushed OCI manifest's layer sizes (config + layers, compressed)

# Pre-stage the minimal deployment profile (later overwritten by the wizard)
AWS_PROFILE=factory-base AWS_REGION=us-east-2 node cli/lib/bin/bgagent.js setup \
  --region us-east-2 --stack-name backgroundagent-dev-factory \
  --features none --compute agentcore --yes --no-deploy

# Confirm stack status and outputs
aws cloudformation describe-stacks --stack-name backgroundagent-dev-factory --region us-east-2
```

### 5. Open items

- ~~Tag `project=software-factory` not yet applied~~ — **done.** Applied via a direct `mise //cdk:deploy -- ... --tags project=software-factory` (the owner ran it; this session's Bash tool was denied by Claude Code's own permission classifier — see Problems). Combined with the X-Ray tracing deploy below in one command.
- **Least-privilege CDK bootstrap with a separate qualifier (ADR-002)** — the account's `CDKToolkit` is the vanilla default (`AdministratorAccess` execution role); ABCA's own scoped policy bundle isn't in use. Do before team use, not needed for solo lab use today.
- ~~`docs/lab/FACTORY_TOUR.md` not yet written~~ — **done**, see `docs/lab/FACTORY_TOUR.md`.
- ~~Demo run once, but the build gate was a false positive~~ — **rerun, with a real gate this time.** See Demo results (second run) below.
- ~~X-Ray trace missing~~ — **root-caused and fixed.** `cdk/src/stacks/agent.ts`'s `agentcore.Runtime` never set `tracingEnabled` (defaults `false`); the account-level prerequisite the code's own comment worried about (`UpdateTraceSegmentDestination`) was already `ACTIVE`. Filed as #6, fixed in PR #7 (`autonomous-agents-factory`), merged and deployed. Confirmed working — see Demo results (second run).
- ~~Slack, Jira, Linear left unconnected~~ — **Slack done**, see Task 2b below. **Jira and Linear remain deferred** — no new session scheduled yet; do the same new-app-per-stack pattern when picked up.
- **`.github/workflows/` safe-to-enable-later classification** (none enabled this task):

  | Workflow | Verdict | Why |
  |---|---|---|
  | `security-pr.yml` | Safe | `contents: read` only, no AWS creds, no checkout of untrusted code with elevated perms |
  | `pull-request-lint.yml` | Safe | Title lint only, no checkout, no AWS |
  | `docs.yml` | Safe | Publishes docs to Pages, no AWS creds |
  | `security.yml` | Safe | Weekly security suite, no AWS creds |
  | `monthly-repo-metrics.yml` | Safe | Scheduled metrics report, no AWS creds |
  | `upgrade-main.yml` | Safe, but noisy | Daily dependency-bump PRs, no AWS creds, but toil for a solo repo |
  | `build.yml` | Mostly safe, one caveat | PR build/test is safe; its `workflow_dispatch` has a `deploy: agentcore` input that would actually deploy — don't invoke it until OIDC + environment approval exist |
  | `auto-approve.yml` | Not recommended yet | No AWS exposure, but auto-approves labeled PRs with no human review, and `main` has no branch protection yet |
  | `deploy.yml` | Not safe | Auto-deploys via OIDC after a build; no OIDC IAM role or environment approvers configured yet |
  | `integ.yml` | Not safe | Runs integration tests against this shared account via an OIDC deploy role; same missing prerequisites as `deploy.yml` |
- **Endpoint security audit (done, for reference):** every route this stack exposes beyond the Task API's Cognito-gated core is either Cognito-authenticated or HMAC-verified in-handler — GitHub (`X-Hub-Signature-256`), Slack (signing secret, 3 routes + OAuth callback), Jira and Linear webhook secrets, and the generic `/webhooks/tasks` custom `X-Webhook-Id`/`X-Webhook-Signature` authorizer. The public CloudFront screenshot domain is intentionally anonymous (serves preview-deploy images to GitHub PR / Linear renders) with a private S3 origin behind Origin Access Control. No gaps found.

### 7. Demo results (first run)

`factory-sandbox-py` had no mise tasks (confirmed: no `mise.toml` in the repo), so a real bug was needed to demo a bug-fix task meaningfully. Introduced one directly (`app/main.py`'s `subtract` handler changed from `a - b` to `a + b`, committed straight to the sandbox repo's `main` — it's a disposable lab target, not a reviewed codebase), then filed two issues and submitted two tasks.

| | Bug-fix task | Feature task |
|---|---|---|
| Task ID | `01M7JTQ5SYTCC7G5TT30RB19S1` | `01M7JTQCS1Y18S6YW5D590FGGY` |
| Issue | [factory-sandbox-py#3](https://github.com/karlbaria/factory-sandbox-py/issues/3) — `/subtract` regression | [factory-sandbox-py#4](https://github.com/karlbaria/factory-sandbox-py/issues/4) — add `/multiply` |
| PR | [factory-sandbox-py#5](https://github.com/karlbaria/factory-sandbox-py/pull/5) | [factory-sandbox-py#6](https://github.com/karlbaria/factory-sandbox-py/pull/6) |
| Turns | 5 | 9 |
| Cost | $0.1362 | $0.1073 |
| Duration | 33.5s | 43.6s |
| `build_passed` | `True` | `True` |

- `bgagent watch` streamed both live; `bgagent budget status --me` showed `$0.24` spent this UTC month (matches the two costs), no limit configured.
- CloudWatch dashboard `BackgroundAgent-Tasks-backgroundagent-dev-factory` exists and is populated.
- **`build_passed: True` on both is a false positive** — confirms the predicted gap exactly: with no `mise run build` task in the target repo, the gate is inert and reports green regardless of test results. The agent noticed this itself: in the feature task it ran `pytest` by hand via a throwaway venv (rather than relying on the gate) and correctly reported in its final message that `test_subtract` was failing before its change.
- A good side-effect: the feature-task agent **saw the pre-existing bug and explicitly declined to touch it** ("deliberate bug ... left in for a separate demo ... I'll leave it alone"), confirming per-task scope isolation holds even with two tasks running against overlapping code.
- **X-Ray trace not found** for either task's `otel_trace_id` (converted to X-Ray's `1-{8hex}-{24hex}` form) — `xray:GetTraceSummaries` returned zero traces in `us-east-2` over a 3-hour window. Not a transient ingestion-lag read: checked twice, no results either time. Not yet root-caused.

### 8. Demo results (second run, with a real build gate and X-Ray enabled)

`factory-sandbox-py` PR #7 (the `mise.toml` build-gate fix) and PR #6 (the first run's `/multiply` feature) were merged; PR #5 (the first run's bug fix) deliberately left unmerged so `main` still had the real bug to resubmit against. Filed a fresh feature issue (#8, `/divide`) since #4 had already shipped. Resubmitted both task types against the now-gated repo, after merging and deploying #6 (`autonomous-agents-factory`, X-Ray tracing).

| | Bug-fix task | Feature task |
|---|---|---|
| Task ID | `01M7K9DTDJGGPFTFQT1S6733VZ` | `01M7K9DZHJ1C872SEX3ZYE09N7` |
| Issue | [factory-sandbox-py#3](https://github.com/karlbaria/factory-sandbox-py/issues/3) (resubmitted) | [factory-sandbox-py#8](https://github.com/karlbaria/factory-sandbox-py/issues/8) — add `/divide` |
| PR | [factory-sandbox-py#9](https://github.com/karlbaria/factory-sandbox-py/pull/9) | [factory-sandbox-py#10](https://github.com/karlbaria/factory-sandbox-py/pull/10) |
| Turns | 6 | 7 |
| Cost | $0.1318 | $0.1173 |
| Duration | 37.6s | 44.7s |
| `build_passed` | **`True`** (agent ran `mise run build` directly this time, not a manual venv) | **`False`** |
| X-Ray span (`aws/spans`, `AgentCore.Runtime.Invoke`) | ✅ found | ✅ found |

- **The gate is real now.** The bug-fix task's `build_passed: True` reflects an actual `mise run build` run inside the agent's turn (visible in its transcript), not a bypass. The feature task's `build_passed: False` is genuine, unplanned proof the gate catches real failures: `test_subtract` was still broken (PR #9 unmerged at the time), the agent correctly left it alone as out of scope for a `/divide` feature, and the gate recorded the failure honestly rather than reporting green.
- **X-Ray tracing confirmed working**, with a caveat on how to look: `xray:BatchGetTraces` on the converted trace ID still returns nothing for either task — that's not the right path once Transaction Search's destination is `CloudWatchLogs` (this account's setting). A CloudWatch Logs Insights query against the `aws/spans` log group, filtering on the raw `otel_trace_id`, finds both: a real `AgentCore.Runtime.Invoke` span each. Use Transaction Search / the GenAI Observability console page, or `aws/spans` directly — not the classic X-Ray trace-summary API — when the destination is `CloudWatchLogs`.
- `bgagent budget status --me` now shows the running UTC-month total across all four lab demo tasks (~$0.49).

### 9. Learning: a no-op coding task is marked FAILED by design

After merging PR #9 (`test_subtract` fix) and PR #10 (`/divide`), submitted a fresh task asking the agent to fix `test_subtract` on `main` — by then already fixed. The agent correctly found all 6 tests passing, made no change, and the task was marked **FAILED**, not a quiet success.

This is intentional, not a bug: `agent/src/pipeline.py:664`'s `_apply_delivery_gate` forces any `new_task`/create-strategy coding task that reports `agent_status=success` but ships **no commit and no PR** into `overall_status="error"`, `deliverable=lost`. The docstring's own rationale: a silently-successful no-op is indistinguishable from the bug this gate was built to catch (a stacked sub-task that edited files in a nested working tree, so the platform reported success for work that no longer existed anywhere) — "a task that reports success but ships nothing must FAIL, or the platform reports success for work that no longer exists anywhere." The gate has no carve-out for "I checked and it was already correct": that outcome and the lost-work bug look identical from the pipeline's point of view, so both get the same loud, retryable FAILED. The sanctioned no-op exceptions are narrow and don't include this case: read-only/`pr_review` and artifact workflows (no PR expected by design), `pr_iteration`'s question-only "answered" path, and `clarify-and-hold`.

Practical takeaway for this lab: before resubmitting a task against an issue, check whether it's already fixed on `main` — a correctly-behaving agent will still report FAILED, not a clean no-op success, and that's load-bearing behavior (it protects against silently losing real work), not something to "fix" by special-casing it away.

## Task 2b: Connect Slack to `backgroundagent-dev-factory` only

### 1. What was done, and where it differed from the plan

- Ran `bgagent slack setup --stack-name backgroundagent-dev-factory` (explicit flag — the CLI's own default is `backgroundagent-dev`, the stock stack). This reads the manifest JSON and the three Slack secret ARNs from the **factory stack's own** CloudFormation outputs (`SlackAppManifestJson`, `SlackSigningSecretArn`, `SlackClientSecretArn`, `SlackClientIdSecretArn`) — confirmed distinct from the stock stack's by inspecting the outputs directly before starting.
- **Created a brand-new Slack app, named "Jarvis," not "Shoof."** The stock stack's existing Slack app lives in the **same workspace**, so beyond just being a separate app, the default manifest-provided name (`"Shoof"`) and slash command (`/bgagent`) would have collided with it. Renamed before/after creation: app name, App Home bot display name, app icon, and the slash command (`/bgagent` → `/jarvis`) — each followed by **Reinstall to Workspace** so the rename actually took effect (a bot display-name change does not apply retroactively without reinstalling).
- **App icon:** generated locally with PIL (no AI image model, no network) — a robot-coder glyph (`</>` badge on the chest) in the lab's existing cyan/navy palette, 512×512 PNG. Not committed to the repo; it's a one-off Slack-dashboard upload.
- Verified Event Subscriptions (Retry → green checkmark → Save), installed via the wizard-printed OAuth URL (not the dashboard's "Install App" button, which doesn't connect to the backend), then `/jarvis link` in Slack + `node cli/lib/bin/bgagent.js slack link <code>` in the terminal — confirmed linked (`Workspace: T0CJ127D9J5`, `User: U0CHYVBNEAW`).
- **Credential-entry step is inherently interactive** (pasting a signing secret, client secret, and client ID into a live wizard prompt after creating the app in a browser) — done by the account owner in their own terminal, not scripted or run on their behalf.

### 2. Problems hit and how each was solved

1. **Slack's "create app from manifest" flow skipped the expected manifest-review/edit screen** and went straight to an "App is ready!" screen showing a Bot token (`xoxb-...`) and an App token (`xapp-...`) — Socket Mode / Slack CLI credentials. These are **not** what ABCA's OAuth-based integration uses (the manifest requests `socket_mode_enabled: false`); ignored both tokens entirely and went to **App Settings → Basic Information → App Credentials** for the actual Signing Secret / Client ID / Client Secret the wizard needed.
2. **Renaming the app name and icon (Basic Information) did not update the App Home bot display name** — Slack treats `display_information.name` and `bot_user.display_name` as separate fields; the mention picker kept showing "Shoof" until App Home's "App Display Name" was edited directly and the app reinstalled.
3. **After that fix, the Slack client's mention-picker/search index still showed "Shoof" for a while.** Confirmed via the bot's profile card (which correctly showed "Jarvis") that this was Slack-side search-index cache lag, not a real misconfiguration — not blocking, and not something a reinstall forces to refresh sooner.
4. **`/jarvis help` works; a plain `@Jarvis help` mention does not.** "help" and "link" are only recognized as keywords on the dedicated slash-command path (`cdk/src/handlers/slack-commands.ts`); a natural-language `@mention` or DM goes through the task-submission parser instead, which doesn't recognize "help" and falls back to "Please include a repo..." This is existing ABCA behavior, not specific to the rename.
5. **Found real cross-cutting hardcoding: "Shoof" and `/bgagent` are baked into ABCA source, not derived from the installed Slack app's actual name.** The manifest itself (`cdk/src/stacks/agent.ts:1444-1446`) hardcodes `display_information.name`, `bot_user.display_name`, and the `/bgagent` command. Lambda reply text hardcodes "Shoof" independently of the Slack App's configured name, in three places: `cdk/src/handlers/slack-command-processor.ts` (lines 120, 128-132, 139, 219), `cdk/src/handlers/slack-commands.ts` (`HELP_TEXT`, lines 135-141), and a comment in `slack-events.ts:176`. This means every reply from the bot — `/jarvis help`, the "DM Shoof directly" text, the "Please include a repo" fallback — still says "Shoof" regardless of the Slack-side rename, because none of it is config-driven per stack. **Not fixed this session** — flagged as a follow-up issue (parameterize the bot name, or at minimum fix the copy), to be filed and approved through the normal issue-first flow ([AGENTS.md](../../AGENTS.md#boundaries)) rather than edited ad hoc.

### 3. Demo result

Filed a trivial feature issue on the already-onboarded sandbox repo — [factory-sandbox-py#11](https://github.com/karlbaria/factory-sandbox-py/issues/11), "Add `/power/{a}/{b}` endpoint" (same pattern as the existing `/multiply`, `/divide`) — then submitted it from Slack:

```
@Jarvis add the /power endpoint in karlbaria/factory-sandbox-py#11
```

| Metric | Value |
|---|---|
| Task ID | `01M7PERVVDSNC73DJAS09X2V8Y` |
| Channel | `slack` (confirmed in `bgagent status` output — proves the Slack submission path end to end, not just a CLI/API submission) |
| Status | `COMPLETED` |
| Turns | 6 |
| Duration | 49s |
| Cost | $0.15 |
| PR | [factory-sandbox-py#12](https://github.com/karlbaria/factory-sandbox-py/pull/12) |

Reactions and thread messages (:eyes: → :hourglass_flowing_sand: → :white_check_mark: + View PR button) matched the guide's documented flow.

### 4. Open items

- ~~Jira and Linear remain deferred~~ — **Jira done**, see Task 2b (continued) below. **Linear remains deferred** — no new session scheduled yet; do the same new-app-per-stack pattern when picked up.
- **"Shoof"/`/bgagent` hardcoding (see Problems #5 above)** — real ABCA bug, not a lab-specific issue. Worth its own approved GitHub issue before editing; not done this session.
- **Generated Slack app icon** is a local-only PNG (`/tmp/jarvis-icon/jarvis-icon-v2.png`), not committed anywhere — re-generate if needed, or save a copy outside `/tmp` if it should survive a reboot.

## Task 2b (continued): Connect Jira to `backgroundagent-dev-factory` only

### 1. What was done, and where it differed from the plan

- **Pre-flight audit, before touching anything:** confirmed via `aws cloudformation describe-stacks` that `backgroundagent-dev-factory` and the stock `backgroundagent-dev` stack have fully distinct Jira resources (separate `JiraWebhookSecretArn`, `JiraProjectMappingTable`, `JiraUserMappingTable`, `JiraWorkspaceRegistryTable` — different CloudFormation outputs per stack, since each is its own stack). A `dynamodb scan --select COUNT` on both stacks' `JiraWorkspaceRegistryTable` confirmed `Count: 0` on both — this genuinely is the first Jira connection on the site, with no risk of colliding with a stock-stack registration.
- **Created a brand-new Atlassian OAuth 2.0 (3LO) integration**, named `bgagent — ABCA` (per `bgagent jira app-template`'s printed fields), with only the three classic Jira platform scopes `read:jira-work`, `write:jira-work`, `read:jira-user` (left `manage:jira-project`, `manage:jira-configuration`, `manage:jira-webhook`, `manage:jira-data-provider`, and the entire Jira Service Management API unchecked — none needed). Callback URL `http://localhost:8080/oauth/callback` (the CLI's own loopback listener for the 3LO redirect, not a real server).
- Ran `bgagent jira setup --region us-east-2 --stack-name backgroundagent-dev-factory`: authorized via browser, picked the one accessible site (`https://karlvb.atlassian.net`), got tenant `cloud_id = 05c31df8-daa2-42f3-a976-d0d5037a2e42`. Generated the webhook signing secret with `openssl rand -hex 32` and pasted it at the `setup` prompt.
- **Configured the Jira admin-console webhook** (`Settings → System → Webhooks`, reached via Jira's in-app search rather than a guessed URL — see Problems #1): named `bgagent-factory`, URL `https://3yer7yxhae.execute-api.us-east-2.amazonaws.com/v1/jira/webhook` (derived from the stack's `ApiUrl` output + the `/v1/jira/webhook` route in `cdk/src/stacks/agent.ts:506`, since `setup`'s own printed URL scrolled out of the visible terminal buffer), same `openssl`-generated secret pasted into the webhook's **Secret** field (not Jira's own "Generate secret" button), events **Issue: created**, **Issue: updated**, **Comment: created** only — all other event groups (sprint/board, worklog, attachment, user, project/version/issue-type/config) left unchecked, since ABCA's webhook processor only handles those three event types and gives everything else a silent `200`; attachments are pulled via REST at task-admission time instead of pushed.
- **Installed a brand-new, dedicated Forge app named `bgagent`** (matching the Slack task's one-app-per-stack precedent) under `integrations/jira-forge-app`: `forge login` (new Forge CLI scoped token), `forge register bgagent --accept-terms` (first use on this machine, so it also created a new Atlassian Developer Space, named `backgroundagent-dev-factory`), generated `BGAGENT_PROXY_SECRET` via `openssl rand -hex 32`, stored it with `forge variables set --encrypt ... --environment production`, then `forge deploy --environment production`, `forge install --product Jira --site karlvb.atlassian.net --environment production --confirm-scopes`, and `forge webtrigger create --functionKey bgagent-outbound ...` to mint the v2 webtrigger URL.
- Registered that URL and secret with ABCA: `bgagent jira app-setup 05c31df8-daa2-42f3-a976-d0d5037a2e42 --proxy-url <forge-v2-url> --region us-east-2 --stack-name backgroundagent-dev-factory`. The identity probe passed: `Jira outbound app identity configured`, `identity: bgagent (712020:9f7de35c-c47a-43f9-bcd0-baa93dac3002)`. Confirmed with `forge install list` (`Up-to-date`) and `bgagent platform doctor` (`Jira outbound app identity` — 1 active tenant using the dedicated app identity — alongside every other check passing).
- **Mapped a Jira project to the sandbox repo**: `bgagent jira map 05c31df8-daa2-42f3-a976-d0d5037a2e42 SCRUM --repo karlbaria/factory-sandbox-py --region us-east-2 --stack-name backgroundagent-dev-factory`, default trigger label `bgagent` (not customized). `SCRUM` is the owner's pre-existing "Software Factory Agents" Jira Scrum board.
- **Linked the owner's own Jira and ABCA identities** so triggered tasks attribute correctly: `bgagent jira invite-user <cloud-id> karl10.it@gmail.com`, then redeemed with `bgagent jira link <code>` — same person acting as both admin and teammate, same pattern as any solo-owner lab step.

### 2. Problems hit and how each was solved

1. **Guessing the admin-console webhook URL (`/jira/settings/system/webhooks`) 404'd.** Not a permissions issue (a 403 would mean that) — Atlassian's settings URLs vary by site/plan/nav version. Found the real page via Jira's own in-app search ("webhooks"), landing on **Settings → System → Webhooks** correctly.
2. **zsh does not treat `#` as a comment character in interactive shells by default** (`interactive_comments` is off; bash's default differs). Pasting a multi-line command block that included `#`-prefixed explanatory comments (standard for a bash-oriented guide) caused zsh to parse the comment text as literal shell syntax — an unmatched `(` inside comment prose (e.g. `"bgagent" (dedicated to this stack,`) left the shell hanging in a `>` continuation prompt indefinitely, silently swallowing every subsequent pasted line (including `forge login`) without executing anything. Root-caused by checking that `integrations/jira-forge-app/manifest.yml`'s `app.id` was still the placeholder and that no `~/.forge`/`~/.config/forge` directory existed yet — proof nothing in the stuck block had actually run. Fixed with Ctrl+C, then re-pasting commands one at a time with no `#` comments mixed in.
3. **Compounding #2: the owner twice substituted the actual generated hex secret literally inside `$(openssl rand -hex 32)`** when retyping that line by hand (e.g. `$(b2711b998...)`) instead of leaving the command text in place. `$( )` always executes its contents as a command, so this produced `zsh: command not found: b2711b998...` and left the shell variable empty both times (confirmed via `echo "${#BGAGENT_PROXY_SECRET}"` printing blank). Fixed by typing the line exactly as documented, with the literal command `openssl rand -hex 32` inside the substitution, not its output.
4. **`forge install list --environment production` failed**: `Error: unknown option '--environment'`. The installed Forge CLI version (15.1.0) doesn't accept that flag on the `list` subcommand (confirmed via `forge install list --help`); dropped it and ran `forge install list` alone.
5. **Clipboard collision while relaying the Forge proxy secret into the hidden `bgagent jira app-setup` prompt.** The secret was copied to the clipboard via `echo -n "$BGAGENT_PROXY_SECRET" | pbcopy` for pasting at the hidden prompt, but a subsequent copy of the `app-setup` command itself (to re-run it) silently overwrote the clipboard, so the next paste attempt had nothing useful. Fixed by re-running the `pbcopy` step immediately before the paste every time, and using shell history (up-arrow) rather than copy-paste to recall commands whenever the clipboard needs to stay reserved for a pending secret.

### 3. Demo result

Filed a new issue directly on the owner's existing "Software Factory Agents" Jira Scrum board (project `SCRUM`, already mapped to `karlbaria/factory-sandbox-py`): **SCRUM-5**, "Add a GET `/mod/{a}/{b}` endpoint" — chosen because `/health`, `/greet`, `/subtract`, `/multiply`, `/divide`, and `/power` already existed on the sandbox repo (confirmed via `gh api .../contents/app/main.py` before filing), so `/mod` was a genuinely new, unimplemented case. Added the `bgagent` label.

| Metric | Value |
|---|---|
| Task ID | `01M7PNAJ93HXK1DG0SBWX9FW3M` |
| Channel | `jira` (confirmed in `bgagent status` output — proves the Jira submission path end to end) |
| Status | `COMPLETED` |
| Turns | 8 |
| Duration | 58s |
| Cost | $0.16 |
| PR | [factory-sandbox-py#13](https://github.com/karlbaria/factory-sandbox-py/pull/13) |
| Build gate | `mise run build` → 10 passed |
| Lint gate | Inert — no `lint` task in the sandbox repo's `mise.toml`, `ruff` never installed there either; pre-existing gap, same category as the Task 1/2 build-gate gaps, not something this task introduced. The agent itself flagged it as a suggestion in the PR body rather than silently ignoring it. |

- The originating Jira issue moved to **In Progress** automatically when the task started, matching the documented board-transition behavior.
- The `bgagent` Forge app posted a progress comment and a terminal comment (with cost/turns/PR link) directly on the SCRUM-5 issue — confirmed by the owner reading it on the card, author shown as `bgagent`, not the owner's own Atlassian identity.
- After the owner merged PR #13 on GitHub, SCRUM-5 correctly **stayed in "In Review"** rather than auto-advancing to Done — matches the guide's documented behavior exactly ("Humans still move the card to Done after merging the PR — ABCA never closes issues," and ABCA has no GitHub-merge listener for Jira board transitions).

### 4. Open items

- **Linear remains deferred.** Already deployed on `backgroundagent-dev-factory` (Task 2's all-features install), no app/connection created yet. Same new-app-per-stack pattern applies when picked up.
- **The stock `backgroundagent-dev` stack must never be connected to this Jira site (`karlvb.atlassian.net`, `cloud_id = 05c31df8-daa2-42f3-a976-d0d5037a2e42`).** The trigger label defaults to plain `bgagent` and is not stack-qualified — `bgagent jira map` lets the operator override it per project mapping, but nothing forces a different label across stacks, so a second stack mapped on this same site could trigger ambiguously or collide on a shared label. Separately, admin-console webhooks (the kind created here) carry no `cloudId` in their payload, and `bgagent jira setup` already refuses to configure a second *active* tenant through this flow for exactly that reason — but that refusal is a safety net, not a substitute for the rule itself: treat this Jira site as exclusively bound to `backgroundagent-dev-factory`, the same way Slack's workspace is shared but each stack got its own distinctly-named app (Task 2b above).
