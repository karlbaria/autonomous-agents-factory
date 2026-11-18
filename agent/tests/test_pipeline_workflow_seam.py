"""Tests for the workflow-runner seam in pipeline._execute_agent_step (#248).

Post-cutover (task 8) the workflow runner is the sole agentic path: the single
``run_agent`` step is dispatched through ``workflow.run_workflow`` (driven by the
resolved workflow id), while clone/context/post-hooks stay inline. These tests
pin that path without standing up the full pipeline.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from models import AgentResult, RepoSetup, TaskConfig
from pipeline import _execute_agent_step


def _config(workflow_id: str = "coding/new-task-v1") -> TaskConfig:
    return TaskConfig(
        repo_url="owner/repo",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="task-1",
        resolved_workflow={"id": workflow_id, "version": "1.0.0"},
        max_turns=10,
    )


def _setup() -> RepoSetup:
    return RepoSetup(repo_dir="/workspace/repo", branch="bgagent/task-1", default_branch="main")


class TestExecuteAgentStep:
    def test_routes_through_runner_and_threads_result(self):
        # The run_agent step runs through the workflow runner; the agent result
        # threads back via ctx.agent_result. run_agent is lazily imported inside
        # the handler from the top-level `runner` module, so patch it there.
        expected = AgentResult(status="success", session_id="wf-session")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with patch("runner.run_agent", side_effect=fake):
            out = _execute_agent_step(
                "the-user-prompt", "the-system-prompt", _config(), _setup(), None, None, None
            )
        assert out is expected

    def test_only_runs_agent_step_not_post_hooks(self):
        # The seam restricts the runner to the run_agent step: deterministic
        # post-hook handlers (ensure_pr/verify_build) must NOT fire here — the
        # inline path owns them.
        expected = AgentResult(status="success")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with (
            patch("runner.run_agent", side_effect=fake),
            patch("post_hooks.ensure_pr") as mock_ensure_pr,
            patch("post_hooks.verify_build") as mock_build,
        ):
            out = _execute_agent_step("p", "s", _config(), _setup(), None, None, None)
        assert out is expected
        mock_ensure_pr.assert_not_called()
        mock_build.assert_not_called()

    def test_run_agent_failure_reraises_to_preserve_error_contract(self):
        # When the run_agent step's handler raises, run_workflow captures it into
        # a failed StepOutcome (does not propagate). _execute_agent_step must
        # RE-RAISE so run_task's `except` block restores full error fidelity
        # (log_error_cw mirror + real text) — not silently downgrade to a generic
        # AgentResult. The original error text must be carried in the raise.
        async def boom(_p, _s, _c, cwd=None, trajectory=None):
            raise RuntimeError("SDK session expired")

        with (
            patch("runner.run_agent", side_effect=boom),
            pytest.raises(RuntimeError, match="SDK session expired"),
        ):
            _execute_agent_step("p", "s", _config(), _setup(), None, None, None)


class TestExecuteAgentStepReviewAndFix:
    """Task 4 (ADR-025 (fork)): coding/new-task-verified-v1 also runs review_and_fix."""

    def test_new_task_v1_never_runs_review(self):
        """new-task-v1 has no review_and_fix step — must behave exactly as before."""
        expected = AgentResult(status="success")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with (
            patch("runner.run_agent", side_effect=fake),
            patch("review.run_review_and_fix") as mock_review,
        ):
            out = _execute_agent_step(
                "p", "s", _config("coding/new-task-v1"), _setup(), None, None, None
            )
        assert out is expected
        mock_review.assert_not_called()

    def test_verified_workflow_runs_review_and_surfaces_outcome(self):
        from review.backend import ReviewAndFixResult

        expected = AgentResult(status="success")
        review_result = ReviewAndFixResult(
            ran=True, verdict="READY", reviewed_sha="deadbeef", findings=[], probe_results=[]
        )

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with (
            patch("runner.run_agent", side_effect=fake),
            patch("review.run_review_and_fix", return_value=review_result) as mock_review,
        ):
            review_outcome: dict = {}
            out = _execute_agent_step(
                "p",
                "s",
                _config("coding/new-task-verified-v1"),
                _setup(),
                None,
                None,
                None,
                review_outcome_out=review_outcome,
            )
        assert out is expected
        mock_review.assert_called_once()
        assert review_outcome["verdict"] == "READY"
        assert review_outcome["reviewed_sha"] == "deadbeef"

    def test_review_and_coder_calls_share_the_same_ledger(self):
        from models import AgentInvocationLedger
        from review.backend import ReviewAndFixResult

        async def fake_coder(_p, _s, _c, cwd=None, trajectory=None):
            return AgentResult(status="success", cost_usd=0.10, num_turns=5)

        captured_ledgers = []

        def fake_review(*, ledger, **kwargs):
            captured_ledgers.append(ledger)
            ledger.record(stage="probe_writer", cost_usd=0.01, turns=1, model="m")
            ledger.record(stage="code_reviewer", cost_usd=0.02, turns=1, model="m")
            return ReviewAndFixResult(ran=True, verdict="READY", findings=[], probe_results=[])

        ledger = AgentInvocationLedger()
        with (
            patch("runner.run_agent", side_effect=fake_coder),
            patch("review.run_review_and_fix", side_effect=fake_review),
        ):
            _execute_agent_step(
                "p",
                "s",
                _config("coding/new-task-verified-v1"),
                _setup(),
                None,
                None,
                None,
                ledger=ledger,
            )
        assert captured_ledgers == [ledger]
        assert ledger.total_cost_usd == pytest.approx(0.13)
