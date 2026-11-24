"""#78: a clarify-and-hold stops the workflow before review/fix, end to end.

Task 01M85AKACXSZ2TKGTWPR30G1SX: on coding/new-task-adversarial-v1 the coder
correctly called request_clarification, but the runner still ran review_and_fix,
whose fixer implemented and committed the claim the coder had questioned. These
tests pin the fix through ``run_task``: a hold runs no review round, emits
``steps_skipped``, ends as a hold, and makes no PR and no commit; a normal run
still reviews; an artifact workflow still delivers. Plus the registry guard for
``_NO_CLARIFICATION_WORKFLOW_IDS`` (the stale ``web/research-v1`` id).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from clarify_hold import agent_requested_input, hold_applies
from config import NEEDS_INPUT_MARKER
from models import AgentResult, RepoSetup
from post_hooks import VerifyOutcome

_ADVERSARIAL = {"id": "coding/new-task-adversarial-v1", "version": "1.0.0"}
_QUESTION = 'The badge says "Free shipping", not "Free shipping and tracking". Which do you want?'


def _span() -> MagicMock:
    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    return span


def _milestones(progress_cls: MagicMock) -> list[tuple]:
    """Every write_agent_milestone call on the (single) mocked progress writer."""
    writer = progress_cls.return_value
    return [c.args for c in writer.write_agent_milestone.call_args_list]


def _run_adversarial(
    agent_result: AgentResult,
    monkeypatch,
    review_result=None,
    pr_url="https://github.com/o/r/pull/1",
):
    """Drive run_task on coding/new-task-adversarial-v1 with everything external mocked."""
    from review.backend import ReviewAndFixResult

    monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
    monkeypatch.setenv("AWS_REGION", "us-east-1")

    async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
        return agent_result

    review = review_result or ReviewAndFixResult(
        ran=True, verdict="READY", findings=[], probe_results=[]
    )
    mocks = {
        "review": MagicMock(return_value=review),
        "ensure_pr": MagicMock(return_value=pr_url),
        "ensure_committed": MagicMock(return_value=False),
        "verify_build": MagicMock(return_value=VerifyOutcome(passed=True)),
        "progress": MagicMock(),
    }
    with (
        patch("runner.run_agent", side_effect=fake_run_agent),
        patch(
            "repo.setup_repo",
            return_value=RepoSetup(
                repo_dir="/workspace/repo", branch="bgagent/t/branch", build_before=True
            ),
        ),
        patch("pipeline.build_system_prompt"),
        patch("pipeline.discover_project_config"),
        patch("pipeline.task_span", return_value=_span()),
        patch("pipeline._ProgressWriter", mocks["progress"]),
        patch("review.run_review_and_fix", mocks["review"]),
        patch("pipeline.ensure_committed", mocks["ensure_committed"]),
        patch("pipeline.verify_build", mocks["verify_build"]),
        patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
        patch("pipeline.ensure_pr", mocks["ensure_pr"]),
        patch("pipeline._branch_has_new_commits", return_value=True),
        patch("pipeline.get_disk_usage", return_value=0),
        patch("pipeline.print_metrics"),
        patch("pipeline._maybe_upload_trace", return_value=None),
        patch("pipeline.task_state") as mock_task_state,
    ):
        mock_task_state.get_task = MagicMock(return_value={"status": "RUNNING"})
        mock_task_state.TaskFetchError = Exception  # type: ignore[attr-defined]
        from pipeline import run_task

        result = run_task(
            repo_url="o/r",
            task_description="Add a README line about the badge",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_id="t-hold",
            resolved_workflow=_ADVERSARIAL,
        )
    return result, mocks


def _assert_held(result: dict, mocks: dict) -> None:
    # No review/probe/fix round ran (the fixer is what committed in the incident).
    mocks["review"].assert_not_called()
    # steps_skipped names the skipped review step, with reason=needs_input.
    skipped = [m for m in _milestones(mocks["progress"]) if m[0] == "steps_skipped"]
    assert skipped == [("steps_skipped", "reason=needs_input steps=review")]
    assert not any(m[0] == "step:review:start" for m in _milestones(mocks["progress"]))
    # Ends as a hold: success, nothing changed, the question is the deliverable.
    assert result["status"] == "success"
    assert result["code_changed"] is False
    assert result["answer_text"] == _QUESTION
    # No PR, no build, and no commit.
    assert result["pr_url"] is None
    mocks["ensure_pr"].assert_not_called()
    mocks["verify_build"].assert_not_called()
    mocks["ensure_committed"].assert_not_called()


class TestHoldStopsTheWorkflow:
    def test_request_clarification_tool_skips_review_and_holds(self, monkeypatch):
        """(a) the coder calls request_clarification (the incident's path)."""
        agent = AgentResult(
            status="success",
            num_turns=3,
            cost_usd=0.13,
            clarification_question=_QUESTION,
            result_text="I didn't change the README or open a PR.",
        )
        result, mocks = _run_adversarial(agent, monkeypatch)
        _assert_held(result, mocks)

    def test_text_sentinel_skips_review_and_holds(self, monkeypatch):
        """(b) the legacy fallback: the marker on the first line, no tool call."""
        agent = AgentResult(
            status="success",
            num_turns=3,
            cost_usd=0.13,
            result_text=f"{NEEDS_INPUT_MARKER}\n{_QUESTION}",
        )
        result, mocks = _run_adversarial(agent, monkeypatch)
        _assert_held(result, mocks)

    def test_without_a_hold_the_review_still_runs(self, monkeypatch):
        """(c) a normal coding run reviews, builds and opens the PR as before."""
        agent = AgentResult(
            status="success", num_turns=5, cost_usd=0.2, result_text="Added the line."
        )
        result, mocks = _run_adversarial(agent, monkeypatch)
        mocks["review"].assert_called_once()
        assert not any(m[0] == "steps_skipped" for m in _milestones(mocks["progress"]))
        mocks["ensure_pr"].assert_called_once()
        assert result["pr_url"] == "https://github.com/o/r/pull/1"


class TestArtifactWorkflowStillDelivers:
    @patch("runner.run_agent")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_research_message_opening_with_marker_still_delivers(
        self, _mock_task_state, mock_task_span, mock_run_agent, monkeypatch
    ):
        """(d) stop_on_hold stays off on the repo-less path: deliver_artifact runs."""
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(
                status="success",
                num_turns=1,
                cost_usd=0.01,
                result_text=f"{NEEDS_INPUT_MARKER}\n# Caching options\n\nFindings.",
            )

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = _span()
        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch("aws_session.tenant_client", return_value=MagicMock()),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Research caching options",
                aws_region="us-east-1",
                task_id="research-hold",
                resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
            )

        assert result["status"] == "success"
        assert result["artifact_uri"] == "s3://artifacts-bkt/artifacts/research-hold/result.md"


class TestHoldHelpers:
    def test_agent_requested_input_signals(self):
        assert agent_requested_input(AgentResult(clarification_question="Which?")) is True
        assert agent_requested_input(AgentResult(result_text=f"{NEEDS_INPUT_MARKER}\nQ")) is True
        assert agent_requested_input(AgentResult(clarification_question="   ")) is False
        assert agent_requested_input(AgentResult(result_text="Done.")) is False
        assert agent_requested_input(None) is False

    def test_hold_applies_scope(self):
        from workflow import load_workflow

        assert hold_applies(load_workflow("coding/new-task-adversarial-v1"), is_pr_workflow=False)
        assert hold_applies(None, is_pr_workflow=False)
        assert not hold_applies(load_workflow("coding/pr-iteration-v1"), is_pr_workflow=True)


class TestNoClarificationRegistry:
    """(e) every artifact or read-only workflow is excluded from request_clarification."""

    @staticmethod
    def _registry() -> dict:
        from workflow import load_workflow

        root = Path(__file__).resolve().parents[1] / "workflows"
        ids = sorted(str(p.relative_to(root).with_suffix("")) for p in root.rglob("*.yaml"))
        assert ids, f"no first-party workflows found under {root}"
        return {wid: load_workflow(wid) for wid in ids}

    def test_every_artifact_or_read_only_workflow_is_listed(self):
        from runner import _NO_CLARIFICATION_WORKFLOW_IDS

        missing = [
            wid
            for wid, wf in self._registry().items()
            if (wf.terminal_outcomes.primary == "artifact" or wf.read_only)
            and wid not in _NO_CLARIFICATION_WORKFLOW_IDS
        ]
        assert missing == [], (
            f"add {missing} to runner._NO_CLARIFICATION_WORKFLOW_IDS: an artifact or "
            "read-only workflow must not be offered request_clarification"
        )

    def test_every_listed_id_exists_in_the_registry(self):
        from runner import _NO_CLARIFICATION_WORKFLOW_IDS

        stale = sorted(set(_NO_CLARIFICATION_WORKFLOW_IDS) - set(self._registry()))
        assert stale == [], f"stale ids in runner._NO_CLARIFICATION_WORKFLOW_IDS: {stale}"

    # #82 PR 3a: flag_concern goes to exactly the writeable workflows whose
    # ensure_pr creates or pushes to a PR. The two exclusion lists can't drift:
    # this one is derived from the registry, and it stays a subset of the
    # clarification list (a workflow that can't ask can't flag either).
    def test_flag_concern_list_is_every_workflow_that_cannot_open_or_update_a_pr(self):
        from runner import _NO_FLAG_CONCERN_WORKFLOW_IDS

        expected = sorted(
            wid
            for wid, wf in self._registry().items()
            if wf.read_only
            or not any(
                s.kind == "ensure_pr" and (s.strategy or "create") in ("create", "push_resolve")
                for s in wf.steps
            )
        )
        assert sorted(_NO_FLAG_CONCERN_WORKFLOW_IDS) == expected, (
            "runner._NO_FLAG_CONCERN_WORKFLOW_IDS must list exactly the workflows that "
            "cannot open or update a PR"
        )

    def test_flag_concern_list_is_within_the_clarification_list(self):
        from runner import _NO_CLARIFICATION_WORKFLOW_IDS, _NO_FLAG_CONCERN_WORKFLOW_IDS

        extra = sorted(set(_NO_FLAG_CONCERN_WORKFLOW_IDS) - set(_NO_CLARIFICATION_WORKFLOW_IDS))
        assert extra == [], f"{extra} can't flag a concern but could ask a question"


@pytest.mark.parametrize("stop_on_hold", [False, True])
def test_run_workflow_stop_on_hold_defaults_off(stop_on_hold):
    """stop_on_hold only takes effect when the caller turns it on."""
    from models import TaskConfig
    from workflow import StepContext, load_workflow, run_workflow

    wf = load_workflow("coding/new-task-adversarial-v1")
    ctx = StepContext(
        workflow=wf,
        config=TaskConfig(
            repo_url="o/r",
            github_token="t",
            aws_region="us-east-1",
            task_id="t",
            resolved_workflow=_ADVERSARIAL,
            max_turns=10,
        ),
        setup=RepoSetup(repo_dir="/w", branch="b", default_branch="main"),
        system_prompt="s",
        user_prompt="p",
    )
    calls: list[str] = []

    def fake_agent(step, c):
        from workflow.runner import StepOutcome

        c.agent_result = AgentResult(clarification_question="Which?")
        calls.append(step.kind)
        return StepOutcome(kind=step.kind, name="implement", status="succeeded")

    def fake_review(step, c):
        from workflow.runner import StepOutcome

        calls.append(step.kind)
        return StepOutcome(kind=step.kind, name="review", status="succeeded")

    kwargs = {"stop_on_hold": True} if stop_on_hold else {}
    run_workflow(
        wf,
        ctx,
        handlers={"run_agent": fake_agent, "review_and_fix": fake_review},
        only_kinds={"run_agent", "review_and_fix"},
        **kwargs,
    )
    assert calls == (["run_agent"] if stop_on_hold else ["run_agent", "review_and_fix"])
