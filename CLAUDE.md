Lab work: read docs/lab/FACTORY_PLAN.md and docs/lab/LAB_LOG.md first.

Before every commit in this repo, run mise run build and mise run security (substitute for the skipped prek hooks); for docs-only changes, mise run security is enough. After finishing any change, commit and push unless told otherwise.

@AGENTS.md

See also [README.md](./README.md) for the Claude Code plugin (`docs/abca-plugin/`), which provides interactive guided workflows for setup, deployment, repository onboarding, task submission, and troubleshooting via `/setup`, `/deploy`, `/onboard-repo`, `/submit-task`, `/status`, and `/troubleshoot` skills. Run Claude Code with `claude --plugin-dir docs/abca-plugin` to activate it.
