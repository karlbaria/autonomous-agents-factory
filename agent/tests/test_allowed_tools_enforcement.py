"""#62: a workflow's ``agent_config.allowed_tools`` is enforced, not only auto-approved.

The Cedar hard-deny ``tool_outside_allowed_tools`` (agent/policies/hard_deny.cedar)
forbids any tool outside the declared list plus ``policy.PLATFORM_TOOLS``; the
runner also hides every known SDK tool outside the list from the model
(``disallowed_tools``). An empty list (legacy/batch callers) changes nothing.

The per-rule call table lives in ``test_policy_builtin_rules.py``; this module
covers the workflow-level behaviour the issue asks for: the web-research lane,
a read-only lane that lists Bash, the coding lanes (declared lists and the
tools recent coding runs actually called), the platform tools, the runner
wiring and the PreToolUse hook end to end.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from clarification_tool import CLARIFICATION_TOOL_NAME, FLAG_CONCERN_TOOL_NAME
from config import build_config
from gateway_tools import GATEWAY_SERVER_NAME
from models import TaskConfig
from policy import PLATFORM_TOOLS, Outcome, PolicyEngine, effective_allowed_tools
from runner import (
    _DISALLOWED_TOOLS,
    _KNOWN_SDK_TOOLS,
    _initialize_policy_engine_and_hooks,
    _resolve_allowed_tools,
    _resolve_disallowed_tools,
)
from workflow import load_workflow

WEB_RESEARCH = ["Read", "Glob", "Grep", "WebFetch"]
CODING_WORKFLOW_IDS = [
    "coding/new-task-v1",
    "coding/new-task-adversarial-v1",
    "coding/new-task-verified-v1",
    "coding/pr-iteration-v1",
    "coding/pr-review-v1",
    "coding/restack-v1",
]
# Every tool the coder/fixer calls of the last 41 coding tasks on
# factory-shop and factory-sandbox-py called (TaskEvents agent_tool_call,
# 2026-11-16..23). The two review calls run with their own lists
# (review/backend.py) and are enforced as declared.
OBSERVED_CODING_TOOLS = [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebFetch",
    "ToolSearch",
    CLARIFICATION_TOOL_NAME,
]


def _cfg(**overrides: Any) -> TaskConfig:
    base: dict[str, Any] = {"repo_url": "owner/repo", "aws_region": "us-east-1", "task_id": "t-62"}
    base.update(overrides)
    return TaskConfig(**base)


def _input_for(tool: str) -> dict[str, Any]:
    if tool == "Bash":
        return {"command": "git log --oneline"}
    if tool in ("Read", "Write", "Edit"):
        return {"file_path": "src/main.py", "content": "x", "old_string": "a", "new_string": "b"}
    if tool in ("Glob", "Grep"):
        return {"pattern": "*.py"}
    if tool == "WebFetch":
        return {"url": "https://example.com", "prompt": "summarize"}
    return {}


def _engine(allowed_tools: list[str] | None, *, read_only: bool = False, **kw: Any) -> PolicyEngine:
    return PolicyEngine(
        task_type="new_task",
        repo="owner/repo",
        read_only=read_only,
        allowed_tools=allowed_tools,
        **kw,
    )


class TestPlatformTools:
    def test_platform_tools_are_exactly_the_documented_five(self) -> None:
        # Widening this set widens every workflow, read-only ones included.
        # mcp__abca__flag_concern: #82 PR 3a (ADR-030 lists the rationale).
        assert {
            "ToolSearch",
            "TodoWrite",
            "mcp__abca__request_clarification",
            "mcp__abca__flag_concern",
            "mcp__abca_gateway__repo_config",
        } == PLATFORM_TOOLS

    def test_platform_names_match_the_runtime_tool_names(self) -> None:
        assert CLARIFICATION_TOOL_NAME in PLATFORM_TOOLS
        assert FLAG_CONCERN_TOOL_NAME in PLATFORM_TOOLS
        assert f"mcp__{GATEWAY_SERVER_NAME}__repo_config" in PLATFORM_TOOLS

    def test_no_patterns(self) -> None:
        assert not any(c in t for t in PLATFORM_TOOLS for c in "*?[")

    def test_effective_list_is_none_without_a_declared_list(self) -> None:
        assert effective_allowed_tools(None) is None
        assert effective_allowed_tools([]) is None
        assert effective_allowed_tools(["Read"]) == frozenset({"Read"}) | PLATFORM_TOOLS


class TestWebResearchLane:
    @pytest.mark.parametrize("tool", ["Bash", "Write", "Edit", "NotebookEdit", "MultiEdit"])
    def test_tools_outside_the_list_are_hard_denied(self, tool: str) -> None:
        decision = _engine(WEB_RESEARCH).evaluate_tool_use(tool, _input_for(tool))
        assert decision.outcome == Outcome.DENY
        assert "tool_outside_allowed_tools" in decision.reason
        assert not decision.fail_closed

    def test_repo_mcp_tool_is_hard_denied(self) -> None:
        decision = _engine(WEB_RESEARCH).evaluate_tool_use("mcp__repo-server__query", {})
        assert decision.outcome == Outcome.DENY
        assert "tool_outside_allowed_tools" in decision.reason

    @pytest.mark.parametrize("tool", [*WEB_RESEARCH, *sorted(PLATFORM_TOOLS)])
    def test_listed_and_platform_tools_are_allowed(self, tool: str) -> None:
        decision = _engine(WEB_RESEARCH).evaluate_tool_use(tool, _input_for(tool))
        assert decision.outcome == Outcome.ALLOW, decision

    def test_pre_approval_cannot_bypass_the_deny(self) -> None:
        engine = _engine(WEB_RESEARCH, initial_approvals=["all_session"])
        assert engine.evaluate_tool_use("Bash", _input_for("Bash")).outcome == Outcome.DENY

    def test_blueprint_cannot_disable_the_rule(self) -> None:
        with pytest.raises(ValueError, match="cannot disable built-in hard-deny"):
            _engine(WEB_RESEARCH, blueprint_disable=["tool_outside_allowed_tools"])


class TestReadOnlyLaneListingBash:
    # coding/pr-review-v1: read_only with Bash in its list.
    LIST = ("Bash", "Read", "Glob", "Grep", "WebFetch")

    @pytest.mark.parametrize("tool", ["Write", "Edit"])
    def test_write_and_edit_still_denied(self, tool: str) -> None:
        engine = _engine(list(self.LIST), read_only=True)
        decision = engine.evaluate_tool_use(tool, _input_for(tool))
        assert decision.outcome == Outcome.DENY
        assert "read_only_forbid_" in decision.reason

    def test_bash_allowed(self) -> None:
        engine = _engine(list(self.LIST), read_only=True)
        decision = engine.evaluate_tool_use("Bash", _input_for("Bash"))
        assert decision.outcome == Outcome.ALLOW


class TestEmptyListChangesNothing:
    @pytest.mark.parametrize(
        "tool", ["Bash", "Write", "Edit", "NotebookEdit", "Skill", "mcp__repo-server__query"]
    )
    def test_no_declared_list_keeps_the_full_surface(self, tool: str) -> None:
        for declared in (None, []):
            decision = _engine(declared).evaluate_tool_use(tool, _input_for(tool))
            assert decision.outcome == Outcome.ALLOW, (declared, decision)

    def test_runner_hides_nothing_extra(self) -> None:
        config = _cfg(allowed_tools=[])
        assert _resolve_disallowed_tools(config) == list(_DISALLOWED_TOOLS)


class TestCodingLanesUnaffected:
    @pytest.mark.parametrize("workflow_id", CODING_WORKFLOW_IDS)
    def test_every_declared_tool_is_allowed(self, workflow_id: str) -> None:
        wf = load_workflow(workflow_id)
        engine = _engine(list(wf.agent_config.allowed_tools), read_only=wf.read_only)
        for tool in wf.agent_config.allowed_tools:
            decision = engine.evaluate_tool_use(tool, _input_for(tool))
            assert decision.outcome == Outcome.ALLOW, (workflow_id, tool, decision)

    @pytest.mark.parametrize(
        "workflow_id", [w for w in CODING_WORKFLOW_IDS if w != "coding/pr-review-v1"]
    )
    def test_every_tool_recent_coding_runs_called_is_allowed(self, workflow_id: str) -> None:
        wf = load_workflow(workflow_id)
        engine = _engine(list(wf.agent_config.allowed_tools), read_only=wf.read_only)
        for tool in OBSERVED_CODING_TOOLS:
            decision = engine.evaluate_tool_use(tool, _input_for(tool))
            assert decision.outcome == Outcome.ALLOW, (workflow_id, tool, decision)

    @pytest.mark.parametrize("workflow_id", CODING_WORKFLOW_IDS)
    def test_runner_does_not_hide_a_declared_tool(self, workflow_id: str) -> None:
        wf = load_workflow(workflow_id)
        config = _cfg(allowed_tools=list(wf.agent_config.allowed_tools), read_only=wf.read_only)
        hidden = set(_resolve_disallowed_tools(config))
        assert not hidden & set(_resolve_allowed_tools(config))
        assert not hidden & PLATFORM_TOOLS


class TestRunnerSecondLayer:
    def test_web_research_hides_mutating_and_unlisted_tools(self) -> None:
        hidden = _resolve_disallowed_tools(_cfg(allowed_tools=list(WEB_RESEARCH)))
        for tool in ("Bash", "Write", "Edit", "NotebookEdit", "MultiEdit", "Skill", "WebSearch"):
            assert tool in hidden
        for tool in (*WEB_RESEARCH, "ToolSearch", "TodoWrite"):
            assert tool not in hidden
        # The off-session lock is kept, with no duplicates.
        assert hidden[: len(_DISALLOWED_TOOLS)] == list(_DISALLOWED_TOOLS)
        assert len(hidden) == len(set(hidden))

    def test_read_only_lane_hides_write_and_edit_even_if_listed(self) -> None:
        config = _cfg(allowed_tools=["Bash", "Read", "Write", "Edit"], read_only=True)
        hidden = _resolve_disallowed_tools(config)
        assert "Write" in hidden
        assert "Edit" in hidden
        assert "Bash" not in hidden

    def test_catalog_does_not_overlap_the_off_session_lock(self) -> None:
        assert not set(_KNOWN_SDK_TOOLS) & set(_DISALLOWED_TOOLS)


def _web_research_config_with_repo() -> TaskConfig:
    return build_config(
        repo_url="owner/repo",
        task_description="Research how the repo handles retries",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="t-62",
        resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
    )


class TestEndToEndThroughTheHook:
    """knowledge/web-research-v1 with a repo, through config → runner → PreToolUse."""

    def _pre_tool_use(self, config: TaskConfig):
        _engine_obj, hooks = _initialize_policy_engine_and_hooks(
            config=config, trajectory=None, progress=MagicMock()
        )
        return hooks["PreToolUse"][0].hooks[0]

    def _decide(self, hook, tool: str) -> str:
        result = asyncio.run(hook({"tool_name": tool, "tool_input": _input_for(tool)}, "tu-62", {}))
        return result["hookSpecificOutput"]["permissionDecision"]

    def test_config_carries_the_workflow_list(self) -> None:
        config = _web_research_config_with_repo()
        assert config.allowed_tools == WEB_RESEARCH
        assert config.repo_url == "owner/repo"

    @pytest.mark.parametrize("tool", ["Bash", "Write", "Edit"])
    def test_web_research_with_a_repo_cannot_run_mutating_tools(self, tool: str) -> None:
        hook = self._pre_tool_use(_web_research_config_with_repo())
        assert self._decide(hook, tool) == "deny"

    @pytest.mark.parametrize("tool", ["Read", "WebFetch", "ToolSearch"])
    def test_web_research_keeps_its_research_tools(self, tool: str) -> None:
        hook = self._pre_tool_use(_web_research_config_with_repo())
        assert self._decide(hook, tool) == "allow"

    def test_coding_lane_keeps_bash(self) -> None:
        wf = load_workflow("coding/new-task-v1")
        config = _cfg(allowed_tools=list(wf.agent_config.allowed_tools))
        hook = self._pre_tool_use(config)
        for tool in ("Bash", "Write", "Edit"):
            assert self._decide(hook, tool) == "allow", tool


class TestReviewCallsEnforcedAsDeclared:
    """The adversarial/verified review calls (review/backend.py) keep their own lists.

    Before #62 the probe writer ran Bash in nearly every run (ls, py_compile,
    `pip install pytest`, running its probes), which also side-stepped its
    ADR-025 path confinement; the code reviewer ran Bash for `ls`. Both now get
    exactly the tools they declare.
    """

    PROBE_WRITER = ("Read", "Glob", "Grep", "Write")
    CODE_REVIEWER = ("Read", "Glob", "Grep")

    def test_probe_writer_cannot_run_bash(self, tmp_path) -> None:
        scratch = str(tmp_path / "scratch")
        engine = PolicyEngine(
            task_type="probe_writer",
            repo="owner/repo",
            allowed_tools=list(self.PROBE_WRITER),
            allowed_read_roots=[str(tmp_path / "worktree"), scratch],
            scratch_write_root=scratch,
        )
        for command in ("pip install pytest -q", "python -m py_compile x.py", "ls"):
            decision = engine.evaluate_tool_use("Bash", {"command": command})
            assert decision.outcome == Outcome.DENY, command
            assert "tool_outside_allowed_tools" in decision.reason
        allowed = engine.evaluate_tool_use("Write", {"file_path": f"{scratch}/test_probe.py"})
        assert allowed.outcome == Outcome.ALLOW

    def test_code_reviewer_cannot_run_bash(self) -> None:
        engine = PolicyEngine(
            task_type="code_reviewer",
            repo="owner/repo",
            read_only=True,
            allowed_tools=list(self.CODE_REVIEWER),
        )
        assert engine.evaluate_tool_use("Bash", {"command": "ls"}).outcome == Outcome.DENY
        assert engine.evaluate_tool_use("Read", {"file_path": "a.py"}).outcome == Outcome.ALLOW


def test_missing_tool_name_fails_closed() -> None:
    """Cedar skips an erroring forbid (see the allowed-tools-missing-tool-name
    parity fixture); the engine must turn that error into a deny, not an allow."""
    engine = _engine(WEB_RESEARCH)
    with pytest.raises(RuntimeError, match="Cedar policy parse/eval errors"):
        engine._eval_tier(
            engine._hard_policies,
            "invoke_tool",
            "Agent::Tool",
            "Bash",
            {
                "task_type": "new_task",
                "repo": "owner/repo",
                "read_only": False,
                "allowed_tools": sorted(WEB_RESEARCH),
            },
        )


def _feature_planning_config() -> TaskConfig:
    return build_config(
        repo_url="owner/repo",
        task_description="a tagging feature",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="t-82",
        resolved_workflow={"id": "knowledge/feature-planning-v1", "version": "1.0.0"},
    )


class TestFeaturePlanningIsReadOnly:
    """Task 15 (fork), #82: planning reads the repo and nothing else."""

    def _pre_tool_use(self, config: TaskConfig):
        _engine_obj, hooks = _initialize_policy_engine_and_hooks(
            config=config, trajectory=None, progress=MagicMock()
        )
        return hooks["PreToolUse"][0].hooks[0]

    def _decide(self, hook, tool: str) -> str:
        result = asyncio.run(hook({"tool_name": tool, "tool_input": _input_for(tool)}, "tu-82", {}))
        return result["hookSpecificOutput"]["permissionDecision"]

    def test_workflow_declares_repo_context_only(self) -> None:
        wf = load_workflow("knowledge/feature-planning-v1")
        assert list(wf.agent_config.allowed_tools) == ["Read", "Glob", "Grep"]
        assert wf.read_only is True
        assert not [s for s in wf.steps if s.kind in ("ensure_pr", "verify_build", "verify_lint")]

    def test_config_is_read_only_with_the_workflow_list(self) -> None:
        config = _feature_planning_config()
        assert config.read_only is True
        assert config.allowed_tools == ["Read", "Glob", "Grep"]

    @pytest.mark.parametrize("tool", ["Bash", "Write", "Edit", "WebFetch"])
    def test_planning_cannot_run_shell_write_or_web_tools(self, tool: str) -> None:
        hook = self._pre_tool_use(_feature_planning_config())
        assert self._decide(hook, tool) == "deny"

    @pytest.mark.parametrize("tool", ["Read", "Glob", "Grep"])
    def test_planning_keeps_its_read_tools(self, tool: str) -> None:
        hook = self._pre_tool_use(_feature_planning_config())
        assert self._decide(hook, tool) == "allow"

    def test_runner_hides_shell_write_and_web_tools(self) -> None:
        hidden = _resolve_disallowed_tools(_feature_planning_config())
        for tool in ("Bash", "Write", "Edit", "WebFetch", "WebSearch", "NotebookEdit"):
            assert tool in hidden
