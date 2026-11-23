---
title: "ADR-030 (fork): A workflow's `allowed_tools` is enforced by a Cedar hard-deny"
---

**Status:** accepted
**Date:** 2026-11-23
**Implementation:** [autonomous-agents-factory#62](https://github.com/karlbaria/autonomous-agents-factory/issues/62). "(fork)" marks this ADR as a **fork** ADR per [ADR-003](/sample-autonomous-cloud-coding-agents/decisions/adr-003-contribution-governance): it is not proposed upstream.

## Context

A workflow declares its tool surface in `agent_config.allowed_tools` ([ADR-014](/sample-autonomous-cloud-coding-agents/decisions/adr-014-workflow-driven-tasks)). The runner passed that list to the Agent SDK as `allowed_tools`, which only **auto-approves** tools. A tool missing from the list fell through to `permission_mode`, and the agent runs under `bypassPermissions`, so it was allowed. The Cedar PreToolUse engine default-permits when no rule matches, so it did not close the gap either. The only hard lock was `disallowed_tools`, which listed the off-session tools (`Workflow`, `Task`, `Agent`, `Monitor`, `SendMessage`, `Cron*`).

Observed: every one of the five `knowledge/web-research-v1` runs on record (`allowed_tools: [Read, Glob, Grep, WebFetch]`) ran `Bash`. One of them, task `01M830XPP5T3M5TPSRF9TPVVZ1`, ran `git log`, `find` and `cat` in a cloned repo ([#61](https://github.com/karlbaria/autonomous-agents-factory/issues/61)). The adversarial review's probe writer (`[Read, Glob, Grep, Write]`) ran `Bash` in 22 of 23 runs (`ls`, `find`, `py_compile`, `pip install pytest`, running its own probes). That also side-stepped the [ADR-025](/sample-autonomous-cloud-coding-agents/decisions/adr-025-fork-two-call-reviewer) path confinement, which only sees `Read`/`Glob`/`Grep`/`Write`/`Edit`. Task 15's `knowledge/feature-planning-v1` will run read-only against a repo checkout, and without a lock it could run `Bash`, write files, or use a token found in its environment.

## Decision

**Once a workflow declares `allowed_tools`, any tool outside that list plus a short fixed platform list is hard-denied.**

### The rule

`agent/policies/hard_deny.cedar` gains `tool_outside_allowed_tools`:

```cedar
@tier("hard")
@rule_id("tool_outside_allowed_tools")
forbid (principal, action == Agent::Action::"invoke_tool", resource)
when {
    context has allowed_tools &&
    !(context.allowed_tools.contains(context.tool_name))
};
```

`PolicyEngine` takes the declared list (`allowed_tools=`). For the `invoke_tool` request it adds `context.allowed_tools` (the declared list plus the platform tools, as a Cedar set) and `context.tool_name`. The list is data in the request, not text baked into a policy. It is a hard deny: `--pre-approve` (including `all_session`) cannot bypass it, because hard-deny is evaluated first, and a blueprint `disable:` cannot name it, because it is a built-in hard rule.

- **No list declared** (legacy/batch callers that never resolved a workflow): the engine leaves both attributes out, `context has allowed_tools` is false, and the rule is dormant. These tasks keep the surface they had before.
- **`read_only`** is unchanged: the runner still drops `Write`/`Edit` from the SDK list and `read_only_forbid_write`/`_edit` still deny them. A read-only workflow that lists `Bash` (`coding/pr-review-v1`) keeps `Bash`. One that does not list it can no longer reach it.
- **Missing `tool_name`** with `allowed_tools` present makes the forbid error, and Cedar skips an erroring policy (parity fixture `allowed-tools-missing-tool-name`). `policy.py` always sets the two attributes together, and `_eval_tier` turns any evaluation error into a fail-closed DENY.

### The platform tools

`policy.PLATFORM_TOOLS` lists the tools that are allowed in every workflow on top of its list. It uses exact names only, no patterns:

| Tool | Why every workflow needs it |
|------|-----------------------------|
| `ToolSearch` | Loads deferred tools into the session; `WebFetch` is one. No side effects. |
| `TodoWrite` | In-session plan bookkeeping. No side effects outside the session. |
| `mcp__abca__request_clarification` | The runner's clarify-before-spend tool (`clarification_tool.py`). The runner only registers it for writeable PR-producing workflows. |
| `mcp__abca_gateway__repo_config` | The AgentCore Gateway's read-only repo-config tool (`gateway_tools.py`). It is registered only when the gateway is deployed. |

Adding a name widens every workflow's surface, read-only ones included, so it needs the same review as loosening a hard-deny rule. `agent/tests/test_allowed_tools_enforcement.py` pins the set.

### Second layer: hide what the workflow can't use

When a list is declared, `runner._resolve_disallowed_tools` also passes to `disallowed_tools` every name in `_KNOWN_SDK_TOOLS` (the built-in tools of the pinned Claude Code CLI) that is outside the effective surface. The model then never sees, for example, `Bash` in a web-research run. Cedar stays the enforcement of record, because the catalog only knows the names written into it. The Cedar rule also denies a tool from a repo's `.mcp.json`, or one a newer CLI adds.

### Coding workflows

The `coding/*` lists are unchanged. They were checked against evidence, not memory: across the last 41 coding tasks on `factory-shop` and `factory-sandbox-py` (TaskEvents `agent_tool_call`, 2026-11-16 to 23), the coder and fixer calls used only `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `ToolSearch` and `mcp__abca__request_clarification`. All of these are in the lists or in the platform tools. No run called `TodoWrite`, `Skill`, `Task`/`Agent`, `MultiEdit`, `WebSearch` or `TaskOutput`/`TaskStop`.

A repo's `.mcp.json` tools are now denied in coding runs. Neither lab repo has one. Each denial is logged with the tool name (`POLICY DENIED: <tool> — Hard-deny: tool_outside_allowed_tools`) and recorded as a trajectory `policy_decision`, so a future repo that needs an MCP tool shows up directly. The fix is to add the tool to that workflow's list, not to `PLATFORM_TOOLS`.

### Review calls are enforced as declared

The two review calls in `review/backend.py` keep their declared lists:

- **Probe writer:** `[Read, Glob, Grep, Write]`, with `Write` confined to its scratch directory.
- **Code reviewer:** `[Read, Glob, Grep]`, read-only.

Both lose the `Bash` they used before, which closes the ADR-025 confinement bypass described above. The probe-writer prompt now says it has no shell and that the deterministic step runs its probes. The fixer keeps the coding workflow's list.

## Consequences

- (+) A workflow's `allowed_tools` is now a hard boundary. `knowledge/web-research-v1`, `default/agent-v1` and the upcoming `knowledge/feature-planning-v1` cannot run `Bash`, `Write`, `Edit` or `NotebookEdit`.
- (+) The probe writer's path confinement now holds: it has no shell to escape through.
- (+) Agent-side only. No CDK resource changes. The CDK copy of the built-in policies (`cdk/src/handlers/shared/builtin-policies.ts`) is updated byte-for-byte. The `contracts/cedar-parity/` fixtures `allowed-tools-*` pin `Set.contains` on a context set in both `cedarpy` and `cedar-wasm`.
- (−) The probe writer can no longer compile or run its probes before handing off. The deterministic probe run still happens afterwards. The owner will compare the invalid-probe rate of an adversarial run after merge with recent runs. If it rises sharply, the fix is a narrow allowance (for example, one `py_compile` check), not general `Bash`.
- (−) A repo that relies on `.mcp.json` tools in a coding run loses them until its workflow lists them.
- (−) A tool that a newer CLI adds is denied by Cedar but still shown to the model until `_KNOWN_SDK_TOOLS` names it. The model then wastes a turn on a denied call.
