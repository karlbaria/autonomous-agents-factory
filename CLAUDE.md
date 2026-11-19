Lab work: read docs/lab/FACTORY_PLAN.md and docs/lab/LAB_LOG.md first.

Local agent runs (`agent/run.sh`, or anything else that invokes Bedrock or pushes to a sandbox repo from this machine) always use the Keychain PAT `factory-sandbox-pat` (`GITHUB_TOKEN="$(security find-generic-password -s factory-sandbox-pat -w)"`) and `AWS_PROFILE=factory-bedrock`, `AWS_REGION=us-east-2`. Never `gh auth token` or any other AWS profile — those resolve to broader credentials (a personal GitHub token with repo-wide scope, or an Admin AWS role) than the task needs.

Before every commit, check that the account ID from `.local.env` doesn't appear in any staged file.

Before every commit in this repo, run mise run build and mise run security (substitute for the skipped prek hooks); for docs-only changes, mise run security is enough. After finishing any change, commit and push unless told otherwise.

Never add the approved label to issues, and never merge PRs; the owner does both.

Only `bgagent` commands that accept `--stack-name` (`repo`, `jira`, `github`, `admin`, `setup`, and similar operator-AWS-credential commands) must pass `--stack-name backgroundagent-dev-factory --region us-east-2` explicitly; some of them default to the stock `backgroundagent-dev` stack. Task commands (`submit`, `list`, `watch`, `status`, `webhook`, and similar) don't take that flag at all — they use the stack baked into `~/.bgagent/config.json` at `bgagent configure` time. Before using them, verify that file's `stack_name` is `backgroundagent-dev-factory`.

@AGENTS.md

See also [README.md](./README.md) for the Claude Code plugin (`docs/abca-plugin/`), which provides interactive guided workflows for setup, deployment, repository onboarding, task submission, and troubleshooting via `/setup`, `/deploy`, `/onboard-repo`, `/submit-task`, `/status`, and `/troubleshoot` skills. Run Claude Code with `claude --plugin-dir docs/abca-plugin` to activate it.
