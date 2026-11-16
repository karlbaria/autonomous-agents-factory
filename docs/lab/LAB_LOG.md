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

- **Tag `project=software-factory` not yet applied** to `backgroundagent-dev-factory` — run (Admin, `factory-base`):
  ```bash
  MISE_EXPERIMENTAL=1 AWS_PROFILE=factory-base AWS_REGION=us-east-2 mise //cdk:deploy -- \
    -c stackName=backgroundagent-dev-factory \
    --all --require-approval never --progress events \
    --tags project=software-factory
  ```
  Should be a tag-only changeset — `abca.deployment.backgroundagent-dev-factory.json` already matches the deployed (all-features) state.
- **Least-privilege CDK bootstrap with a separate qualifier (ADR-002)** — the account's `CDKToolkit` is the vanilla default (`AdministratorAccess` execution role); ABCA's own scoped policy bundle isn't in use. Do before team use, not needed for solo lab use today.
- **`docs/lab/FACTORY_TOUR.md` not yet written** — depends on the demo (component-to-code-to-AWS-resource-to-dashboard mapping is clearest after a real task has run end to end). Now unblocked; see Demo results below.
- **Demo run once, but the build gate was a false positive** — see Demo results below. Rerun needed once `factory-sandbox-py` has a real `mise run build` task.
- **X-Ray trace missing** — `otel_trace_id` is recorded on both tasks, but `xray:GetTraceSummaries` found zero traces in this account/region over 3 hours. Needs investigation (Transaction Search? ADOT config?), not yet done.
- **Slack, Jira, Linear left unconnected** until the demo works cleanly, then walked through separately with new apps scoped to this stack only — deferred to a new session.
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
