"""#82 PR 3a: the ``flag_concern`` platform tool and the ``needs-human`` merge gate.

A rerun of the Task 14 §13 README task wrote a false line, flagged it only in
the PR body, and auto-merge merged it (factory-shop PR #48). ``flag_concern``
makes the flag a tool call: the runner captures it, and after ``ensure_pr``
opens a PR the pipeline labels it ``needs-human`` (factory-shop's watchdog never
merges such a PR) and adds the reason under "⚠️ Needs a human".
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

import post_hooks
from clarification_tool import (
    CLARIFICATION_SERVER_NAME,
    CLARIFICATION_TOOL_NAME,
    FLAG_CONCERN_TOOL_NAME,
    build_clarification_server,
)
from models import AgentResult, TaskConfig
from policy import PLATFORM_TOOLS, Outcome, PolicyEngine
from runner import _capture_platform_tool_call, _platform_tool_offers
from tests.test_clarify_hold import _milestones, _run_adversarial
from workflow import load_workflow

_PR = "https://github.com/o/r/pull/1"
_REASON = (
    "README says the badge reads 'Free shipping and tracking'; "
    "App.jsx line 96 says 'Free shipping'."
)

_WORKFLOW_ROOT = Path(__file__).resolve().parents[1] / "workflows"
_ALL_WORKFLOW_IDS = sorted(
    str(p.relative_to(_WORKFLOW_ROOT).with_suffix("")) for p in _WORKFLOW_ROOT.rglob("*.yaml")
)


def _config(workflow_id: str, *, read_only: bool | None = None) -> TaskConfig:
    wf = load_workflow(workflow_id)
    return TaskConfig(
        repo_url="o/r",
        aws_region="us-east-1",
        task_id="t-82",
        resolved_workflow={"id": workflow_id, "version": "1.0.0"},
        read_only=wf.read_only if read_only is None else read_only,
    )


def _opens_or_updates_a_pr(workflow_id: str) -> bool:
    """A writeable workflow whose ensure_pr creates a PR or pushes to one."""
    wf = load_workflow(workflow_id)
    return not wf.read_only and any(
        s.kind == "ensure_pr" and (s.strategy or "create") in ("create", "push_resolve")
        for s in wf.steps
    )


class TestTheTool:
    def test_name_is_the_mcp_qualified_form_on_the_abca_server(self):
        assert f"mcp__{CLARIFICATION_SERVER_NAME}__flag_concern" == FLAG_CONCERN_TOOL_NAME

    def test_is_a_platform_tool_so_allowed_tools_does_not_deny_it(self):
        assert FLAG_CONCERN_TOOL_NAME in PLATFORM_TOOLS

    @pytest.mark.parametrize(
        ("clarification", "flag_concern", "expected"),
        [
            (True, True, {"request_clarification", "flag_concern"}),
            (True, False, {"request_clarification"}),
            (False, True, {"flag_concern"}),
        ],
    )
    def test_server_carries_the_requested_tools(self, clarification, flag_concern, expected):
        server = build_clarification_server(clarification=clarification, flag_concern=flag_concern)
        assert server is not None
        assert server["name"] == CLARIFICATION_SERVER_NAME
        tools = asyncio.run(_list_tools(server))
        assert tools == expected

    def test_no_tools_requested_builds_no_server(self):
        assert build_clarification_server(clarification=False, flag_concern=False) is None

    def test_default_is_unchanged(self):
        assert asyncio.run(_list_tools(build_clarification_server())) == {"request_clarification"}


async def _list_tools(server: dict[str, Any]) -> set[str]:
    from mcp.types import ListToolsRequest

    handler = server["instance"].request_handlers[ListToolsRequest]
    response = await handler(ListToolsRequest(method="tools/list"))
    return {t.name for t in response.root.tools}


class TestCapture:
    def test_flag_concern_reason_is_captured(self):
        result = AgentResult()
        assert _capture_platform_tool_call(
            result, FLAG_CONCERN_TOOL_NAME, {"reason": f"  {_REASON} "}
        )
        assert result.concern_reason == _REASON
        assert result.clarification_question == ""

    def test_every_reason_is_kept_once(self):
        result = AgentResult()
        for reason in ("first", "second", "first"):
            _capture_platform_tool_call(result, FLAG_CONCERN_TOOL_NAME, {"reason": reason})
        assert result.concern_reason == "first\nsecond"

    def test_a_blank_reason_still_flags(self):
        result = AgentResult()
        _capture_platform_tool_call(result, FLAG_CONCERN_TOOL_NAME, {})
        assert result.concern_reason == " "
        assert result.concern_reason  # truthy: the pipeline sees a flag

    def test_request_clarification_is_still_captured(self):
        result = AgentResult()
        assert _capture_platform_tool_call(result, CLARIFICATION_TOOL_NAME, {"question": "Which?"})
        assert result.clarification_question == "Which?"
        assert result.concern_reason == ""

    def test_other_tools_are_not_captured(self):
        result = AgentResult()
        assert not _capture_platform_tool_call(result, "Bash", {"command": "ls"})
        assert result == AgentResult()


class TestWhoGetsTheTool:
    @pytest.mark.parametrize("workflow_id", _ALL_WORKFLOW_IDS)
    def test_offered_exactly_to_the_pr_producing_coding_workflows(self, workflow_id):
        _clarification, flag = _platform_tool_offers(_config(workflow_id))
        assert flag is _opens_or_updates_a_pr(workflow_id), workflow_id

    @pytest.mark.parametrize(
        "workflow_id",
        [
            "coding/pr-review-v1",
            "knowledge/feature-planning-v1",
            "knowledge/web-research-v1",
            "default/agent-v1",
        ],
    )
    def test_read_only_knowledge_and_artifact_workflows_do_not_get_it(self, workflow_id):
        assert _platform_tool_offers(_config(workflow_id))[1] is False

    def test_a_read_only_task_gets_neither_tool(self):
        assert _platform_tool_offers(_config("coding/new-task-v1", read_only=True)) == (
            False,
            False,
        )

    @pytest.mark.parametrize(
        "workflow_id", [w for w in _ALL_WORKFLOW_IDS if _opens_or_updates_a_pr(w)]
    )
    def test_the_allowed_tools_hard_deny_allows_it_where_offered(self, workflow_id):
        wf = load_workflow(workflow_id)
        engine = PolicyEngine(
            task_type="new_task",
            repo="owner/repo",
            read_only=wf.read_only,
            allowed_tools=list(wf.agent_config.allowed_tools or []) or None,
        )
        decision = engine.evaluate_tool_use(FLAG_CONCERN_TOOL_NAME, {"reason": _REASON})
        assert decision.outcome == Outcome.ALLOW, decision.reason


class _SequencedRunCmd:
    """``run_cmd`` fake: per-label queues of return codes (last one repeats)."""

    def __init__(self, returncodes: dict[str, list[int]] | None = None):
        self.calls: list[tuple[str, list[str]]] = []
        self._rcs = {k: list(v) for k, v in (returncodes or {}).items()}

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
        self.calls.append((label, cmd))
        queue = self._rcs.get(label, [0])
        rc = queue.pop(0) if len(queue) > 1 else queue[0]
        return SimpleNamespace(returncode=rc, stdout="", stderr="")

    def labels(self) -> list[str]:
        return [label for label, _ in self.calls]


class TestFlagPrForHuman:
    def _run(self, monkeypatch, returncodes=None):
        run_cmd = _SequencedRunCmd(returncodes)
        appended: list[str] = []
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        monkeypatch.setattr(
            post_hooks,
            "_append_pr_appendix",
            lambda _d, _r, _p, appendix: appended.append(appendix),
        )
        held = post_hooks.flag_pr_for_human("/tmp/repo", "o/r", _PR, _REASON)
        return held, run_cmd, appended

    def test_labels_the_pr_and_adds_the_section(self, monkeypatch):
        held, run_cmd, appended = self._run(monkeypatch)
        assert held == "labelled"
        assert run_cmd.labels() == ["apply-label"]
        cmd = run_cmd.calls[0][1]
        assert cmd[:3] == ["gh", "pr", "edit"]
        assert cmd[cmd.index("--add-label") + 1] == "needs-human"
        assert len(appended) == 1
        assert appended[0].startswith("## ⚠️ Needs a human\n")
        assert f"- {_REASON}" in appended[0]

    def test_creates_the_label_when_it_is_missing(self, monkeypatch):
        held, run_cmd, _ = self._run(monkeypatch, {"apply-label": [1, 0]})
        assert held == "labelled"
        assert run_cmd.labels() == ["apply-label", "create-needs-human-label", "apply-label"]

    def test_falls_back_to_a_draft_when_it_cannot_label(self, monkeypatch):
        held, run_cmd, appended = self._run(monkeypatch, {"apply-label": [1]})
        assert held == "draft"
        assert run_cmd.labels()[-1] == "draft-flagged-pr"
        assert run_cmd.calls[-1][1] == ["gh", "pr", "ready", _PR, "--repo", "o/r", "--undo"]
        assert appended  # the reason is still recorded on the PR

    def test_reports_unheld_when_every_step_fails(self, monkeypatch):
        held, _, _ = self._run(monkeypatch, {"apply-label": [1], "draft-flagged-pr": [1]})
        assert held == "unheld"

    def test_each_reason_is_its_own_bullet(self):
        section = post_hooks.needs_human_section("first\n\nsecond")
        assert section.endswith("- first\n- second")
        assert "`needs-human`" in section

    def test_the_unresolved_label_is_unchanged(self, monkeypatch):
        run_cmd = _SequencedRunCmd()
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        assert post_hooks.apply_unresolved_label("/tmp/repo", "o/r", _PR) is True
        label, cmd = run_cmd.calls[0]
        assert label == "apply-unresolved-label"
        assert cmd[cmd.index("--add-label") + 1] == "review:unresolved"


class TestPipeline:
    def _agent(self, **kw) -> AgentResult:
        return AgentResult(
            status="success", num_turns=5, cost_usd=0.2, result_text="Added the line.", **kw
        )

    def test_a_flagged_run_labels_the_pr_and_emits_the_milestone(self, monkeypatch):
        with patch("pipeline.flag_pr_for_human", return_value="labelled") as flag:
            result, mocks = _run_adversarial(self._agent(concern_reason=_REASON), monkeypatch)
        assert result["pr_url"] == _PR
        flag.assert_called_once_with("/workspace/repo", "o/r", _PR, _REASON)
        milestones = _milestones(mocks["progress"])
        assert ("flagged_for_human", f"{_REASON} (PR held: labelled)") in milestones
        # The milestone follows pr_created.
        names = [m[0] for m in milestones]
        assert names.index("flagged_for_human") > names.index("pr_created")

    def test_an_unflagged_run_applies_no_label(self, monkeypatch):
        with patch("pipeline.flag_pr_for_human") as flag:
            result, mocks = _run_adversarial(self._agent(), monkeypatch)
        assert result["pr_url"] == _PR
        flag.assert_not_called()
        assert not any(m[0] == "flagged_for_human" for m in _milestones(mocks["progress"]))

    def test_with_no_pr_the_flag_changes_nothing_else(self, monkeypatch):
        with patch("pipeline.flag_pr_for_human") as flag:
            result, mocks = _run_adversarial(
                self._agent(concern_reason=_REASON), monkeypatch, pr_url=None
            )
        assert result["pr_url"] is None
        flag.assert_not_called()
        assert not any(m[0] == "flagged_for_human" for m in _milestones(mocks["progress"]))
