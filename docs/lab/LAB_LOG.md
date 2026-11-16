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
