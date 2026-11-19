"""Tests for review.backend.run_review_and_fix (Task 4 — ADR-025 (fork)).

`runner.run_agent` is mocked throughout, matching the existing
`test_pipeline_workflow_seam.py` convention (`patch("runner.run_agent", ...)`)
— `review.backend` imports it lazily inside `_call_agent`, the same seam.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, patch

import pytest

from models import AgentInvocationLedger, AgentResult, RepoSetup, TaskConfig
from review.backend import run_review_and_fix
from review.prompts import (
    CODE_REVIEWER_SYSTEM_PROMPT,
    FIXER_SYSTEM_PROMPT,
    PROBE_WRITER_SYSTEM_PROMPT,
)

_SCRATCH_RE = re.compile(r"into: `(.+)`")


def _scratch_dir_from_prompt(user_prompt: str) -> str:
    match = _SCRATCH_RE.search(user_prompt)
    assert match is not None
    return match.group(1)


def _git(repo_dir: Path, *args: str) -> subprocess.CompletedProcess:
    env = {
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    return subprocess.run(
        ["git", *args], cwd=repo_dir, capture_output=True, text=True, env=env, check=True
    )


@pytest.fixture
def repo(tmp_path):
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")
    (repo_dir / "app.py").write_text("def power(a, b):\n    return a ** b\n", encoding="utf-8")
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "-m", "base commit")
    base_sha = _git(repo_dir, "rev-parse", "HEAD").stdout.strip()
    _git(repo_dir, "update-ref", "refs/remotes/origin/main", base_sha)

    (repo_dir / "app.py").write_text(
        "def power(a, b):\n    return a ** b\n\n\n"
        "def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n",
        encoding="utf-8",
    )
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "-m", "add gcd")
    return repo_dir


@pytest.fixture
def config():
    return TaskConfig(
        aws_region="us-east-2",
        repo_url="owner/repo",
        anthropic_model="coder-model-xyz",
        task_description="Add a gcd(a, b) helper that computes the greatest common divisor.",
        max_budget_usd=None,
    )


@pytest.fixture
def setup(repo):
    return RepoSetup(repo_dir=str(repo), branch="agent-branch", default_branch="main")


async def _fake_run_agent(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
    if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
        scratch_dir = _scratch_dir_from_prompt(user_prompt)
        # A test fake standing in for a mocked SDK call, not real async I/O.
        Path(scratch_dir, "test_pass.py").write_text(  # noqa: ASYNC240
            "def test_pass():\n    assert True\n", encoding="utf-8"
        )
        Path(scratch_dir, "test_fail.py").write_text(  # noqa: ASYNC240
            "def test_fail():\n    assert False\n", encoding="utf-8"
        )
        return AgentResult(
            status="success",
            cost_usd=0.01,
            num_turns=3,
            result_text=(
                "Wrote two probes.\n\nPROBES:\n"
                "- test_pass.py: happy path\n- test_fail.py: known gap\n"
            ),
        )
    return AgentResult(
        status="success",
        cost_usd=0.02,
        num_turns=4,
        result_text=(
            "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
            '[{"type": "issue", "severity": "major", "title": "Missing validation", '
            '"description": "x", "evidence": "app.py:3"}]\n```\n'
        ),
    )


class TestRunReviewAndFixHappyPath:
    def test_full_round_reports_verdict_findings_and_probes(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=_fake_run_agent)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.ran is True
        assert result.verdict == "NOT_READY"
        assert len(result.findings) == 1
        assert result.findings[0].evidence == "app.py:3"
        assert {r.probe.filename: r.passed for r in result.probe_results} == {
            "test_pass.py": True,
            "test_fail.py": False,
        }
        assert result.reviewed_sha

    def test_only_passing_probes_committed_as_one_commit(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        head_before = _git(setup.repo_dir, "rev-parse", "HEAD").stdout.strip()
        with patch("runner.run_agent", new=AsyncMock(side_effect=_fake_run_agent)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.committed_probe_paths == ["tests/review_probes/test_pass.py"]
        log = _git(setup.repo_dir, "log", f"{head_before}..HEAD", "--oneline").stdout
        assert log.strip().count("\n") == 0  # exactly one new commit
        assert (Path(setup.repo_dir) / "tests/review_probes/test_pass.py").exists()
        assert not (Path(setup.repo_dir) / "tests/review_probes/test_fail.py").exists()

    def test_coder_and_reviewer_costs_recorded_separately(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.10, turns=5, model="coder-model-xyz")
        with patch("runner.run_agent", new=AsyncMock(side_effect=_fake_run_agent)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        stage_costs = ledger.stage_costs()
        assert stage_costs["coder"] == pytest.approx(0.10)
        assert stage_costs["probe_writer"] == pytest.approx(0.01)
        assert stage_costs["code_reviewer"] == pytest.approx(0.02)

    def test_reviewer_model_defaults_distinct_from_coder_model(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        seen_models: list[str] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            seen_models.append(call_config.anthropic_model)
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert all(m != config.anthropic_model for m in seen_models)
        assert len(set(seen_models)) == 1  # same model for both reviewer calls by default

    def test_reviewer_model_and_turns_are_configurable(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        seen: list[tuple[str, int]] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            seen.append((call_config.anthropic_model, call_config.max_turns))
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                reviewer_model="custom-reviewer-model",
                reviewer_max_turns=7,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert seen == [("custom-reviewer-model", 7), ("custom-reviewer-model", 7)]


class TestCallIsolation:
    def test_call1_never_sees_the_diff(self, config, setup, tmp_path):
        prompts_seen: list[str] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                prompts_seen.append(user_prompt)
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert len(prompts_seen) == 1
        assert "diff --git" not in prompts_seen[0]
        assert "def gcd" not in prompts_seen[0]  # the coder's new code never appears

    def test_call1_runs_with_write_allowed_and_no_bash(self, config, setup, tmp_path):
        configs_seen: list[TaskConfig] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            configs_seen.append(call_config)
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        call1_config, call2_config = configs_seen
        assert set(call1_config.allowed_tools) == {"Read", "Glob", "Grep", "Write"}
        assert call1_config.read_only is False
        assert set(call2_config.allowed_tools) == {"Read", "Glob", "Grep"}
        assert call2_config.read_only is True

    def test_call2_receives_diff_and_probe_results(self, config, setup, tmp_path):
        prompts_seen: list[str] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == CODE_REVIEWER_SYSTEM_PROMPT:
                prompts_seen.append(user_prompt)
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert len(prompts_seen) == 1
        assert "diff --git" in prompts_seen[0]
        assert "test_pass.py" in prompts_seen[0] and "PASS" in prompts_seen[0]
        assert "test_fail.py" in prompts_seen[0] and "FAIL" in prompts_seen[0]

    def test_calls_run_after_coder_sequentially(self, config, setup, tmp_path):
        """Call 1 then Call 2 — both after the coder, which this function never re-runs."""
        order: list[str] = []

        async def capture(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            is_probe_writer = system_prompt == PROBE_WRITER_SYSTEM_PROMPT
            order.append("probe_writer" if is_probe_writer else "code_reviewer")
            return await _fake_run_agent(user_prompt, system_prompt, call_config, cwd, trajectory)

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=capture)):
            run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert order == ["probe_writer", "code_reviewer"]


class TestBudgetAndModes:
    def test_review_mode_none_skips_without_any_agent_call(self, config, setup, tmp_path):
        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock()) as mock_run:
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="none",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.ran is False
        assert result.skipped_reason == "review_mode=none"
        mock_run.assert_not_called()

    def test_budget_exhausted_skips_entirely_without_blocking(self, config, setup, tmp_path):
        config = config.model_copy(update={"max_budget_usd": 0.001})
        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.001, turns=1, model="coder-model-xyz")
        with patch("runner.run_agent", new=AsyncMock()) as mock_run:
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.ran is False
        assert result.skipped_reason == "budget_exhausted"
        mock_run.assert_not_called()


class TestMalformedReviewOutputNeverBlocksDelivery:
    def test_unparseable_call2_output_still_returns(self, config, setup, tmp_path):
        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                # A test fake standing in for a mocked SDK call, not real async I/O.
                Path(scratch_dir, "test_pass.py").write_text(  # noqa: ASYNC240
                    "def test_pass():\n    assert True\n", encoding="utf-8"
                )
                return AgentResult(
                    status="success",
                    cost_usd=0.01,
                    result_text="PROBES:\n- test_pass.py: happy path\n",
                )
            return AgentResult(
                status="success", cost_usd=0.02, result_text="I looked it over, seems fine."
            )

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.ran is True
        assert result.verdict == "NOT_READY"
        assert result.parse_error is not None


class TestDefaultReviewerModelIsGranted:
    """Regression test for #17: the default reviewer model must be one
    `AgentSessionRole` actually grants `bedrock:InvokeModel*` on, or every
    review call AccessDenies on a deployed stack (the coder's own model
    never hits this because it's always a granted platform default).

    This list can't import `DEFAULT_BEDROCK_MODEL_IDS`
    (cdk/src/handlers/shared/bedrock-model-constants.ts) — it's a Python
    package — so it's duplicated here as the bare model ids that file
    grants today. Sonnet 5.5 is deliberately absent from both: it has no
    `jp.` cross-Region inference profile.
    """

    _GRANTED_BARE_MODEL_IDS: ClassVar[set[str]] = {
        "anthropic.claude-sonnet-4-6",
        "anthropic.claude-opus-4-8",
        "anthropic.claude-opus-5",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "anthropic.claude-opus-5-5",
        "anthropic.claude-haiku-5-5",
    }

    def test_default_reviewer_model_is_on_the_granted_list(self):
        from review.backend import DEFAULT_REVIEWER_MODEL

        bare_model_id = DEFAULT_REVIEWER_MODEL.removeprefix("global.")
        assert bare_model_id in self._GRANTED_BARE_MODEL_IDS

    def test_default_reviewer_model_is_not_sonnet_5_5(self):
        """Sonnet 5.5 has no `jp.` profile and must never become the default again."""
        from review.backend import DEFAULT_REVIEWER_MODEL

        assert "claude-sonnet-5-5" not in DEFAULT_REVIEWER_MODEL


# --- Task 5 (ADR-026 (fork)): the bounded adversarial fix loop ---------------


def _probe_writer_fake(scratch_dir: str, probes: dict[str, str]) -> None:
    """Write ``{filename: source}`` probes into ``scratch_dir`` for a fake Call 1."""
    for filename, source in probes.items():
        Path(scratch_dir, filename).write_text(source, encoding="utf-8")


def _manifest(probes: dict[str, str]) -> str:
    lines = "\n".join(f"- {name}: probe" for name in probes)
    return f"Wrote probes.\n\nPROBES:\n{lines}\n"


def _marker_probe_source(marker_path: Path) -> str:
    """A probe that passes iff ``marker_path`` exists — the fixer creates it."""
    return (
        "from pathlib import Path\n\n\n"
        f"def test_marker():\n    assert Path(r'{marker_path}').exists()\n"
    )


class TestAdversarialCleanOnFirstPass:
    def test_ready_on_round_one_runs_no_fixer(self, config, setup, tmp_path):
        probe_calls = 0

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            nonlocal probe_calls
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                probe_calls += 1
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                probes = {"test_pass.py": "def test_pass():\n    assert True\n"}
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            if system_prompt == FIXER_SYSTEM_PROMPT:
                raise AssertionError("fixer must not run when round one is READY")
            return AgentResult(status="success", cost_usd=0.01, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.ran is True
        assert result.mode == "adversarial"
        assert result.verdict == "READY"
        assert result.unresolved is False
        assert len(result.rounds) == 1
        assert probe_calls == 1


class TestAdversarialFixedOnSecondPass:
    def test_round_one_not_ready_fixer_runs_round_two_ready(self, config, setup, tmp_path):
        marker = Path(setup.repo_dir) / "FIXED_MARKER"
        calls: list[str] = []

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                calls.append("probe_writer")
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                round_num = sum(1 for c in calls if c == "probe_writer")
                probes = {f"test_fresh_{round_num}.py": "def test_fresh():\n    assert True\n"}
                if round_num == 1:
                    probes["test_marker.py"] = _marker_probe_source(marker)
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            if system_prompt == FIXER_SYSTEM_PROMPT:
                calls.append("fixer")
                marker.write_text("fixed", encoding="utf-8")
                return AgentResult(status="success", cost_usd=0.02, result_text="Fixed it.")
            calls.append("code_reviewer")
            round_num = sum(1 for c in calls if c == "code_reviewer")
            if round_num == 1:
                return AgentResult(
                    status="success",
                    cost_usd=0.02,
                    result_text=(
                        "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                        '[{"type": "issue", "severity": "major", "title": "Missing marker", '
                        '"description": "x", "evidence": "app.py:1"}]\n```\n'
                    ),
                )
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.verdict == "READY"
        assert result.unresolved is False
        assert len(result.rounds) == 2
        assert result.rounds[0].verdict == "NOT_READY"
        assert result.rounds[1].verdict == "READY"
        assert calls == [
            "probe_writer",
            "code_reviewer",
            "fixer",
            "probe_writer",
            "code_reviewer",
        ]

    def test_round_two_reruns_previous_failing_probe_alongside_fresh_one(
        self, config, setup, tmp_path
    ):
        """Amendment 4: round 2 must rerun round 1's failing probe (now fixed)
        alongside whatever fresh probe round 2's probe writer produces."""
        marker = Path(setup.repo_dir) / "FIXED_MARKER"
        probe_writer_calls = 0

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            nonlocal probe_writer_calls
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                probe_writer_calls += 1
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                if probe_writer_calls == 1:
                    probes = {"test_marker.py": _marker_probe_source(marker)}
                else:
                    probes = {"test_fresh_round2.py": "def test_fresh():\n    assert True\n"}
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            if system_prompt == FIXER_SYSTEM_PROMPT:
                marker.write_text("fixed", encoding="utf-8")
                return AgentResult(status="success", cost_usd=0.02, result_text="Fixed it.")
            if "test_marker.py" in user_prompt and "FAIL" in user_prompt:
                return AgentResult(
                    status="success",
                    cost_usd=0.02,
                    result_text=(
                        "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                        '[{"type": "issue", "severity": "major", "title": "Missing marker", '
                        '"description": "x", "evidence": "app.py:1"}]\n```\n'
                    ),
                )
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.verdict == "READY"
        round_two_filenames = {r.probe.filename for r in result.rounds[1].probe_results}
        assert round_two_filenames == {"test_marker.py", "test_fresh_round2.py"}
        assert all(r.passed for r in result.rounds[1].probe_results)


class TestAdversarialStillBlockedAtCap:
    def _not_ready_fake(self, calls: list[str]):
        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                calls.append("probe_writer")
                return AgentResult(status="success", cost_usd=0.01, result_text="PROBES:\n")
            if system_prompt == FIXER_SYSTEM_PROMPT:
                calls.append("fixer")
                return AgentResult(status="success", cost_usd=0.02, result_text="Tried.")
            calls.append("code_reviewer")
            return AgentResult(
                status="success",
                cost_usd=0.02,
                result_text=(
                    "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                    '[{"type": "issue", "severity": "major", "title": "Still broken", '
                    '"description": "x", "evidence": "app.py:1"}]\n```\n'
                ),
            )

        return fake

    def test_pr_with_warning_mode_reports_unresolved_without_failing(self, config, setup, tmp_path):
        calls: list[str] = []
        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=self._not_ready_fake(calls))):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=2,
                on_unresolved="pr_with_warning",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.unresolved is True
        assert result.stopped_reason == "max_iterations"
        assert len(result.rounds) == 2
        assert result.needs_unresolved_label is True
        assert result.should_fail_task is False

    def test_fail_mode_reports_unresolved_and_requests_task_failure(self, config, setup, tmp_path):
        calls: list[str] = []
        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=self._not_ready_fake(calls))):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=1,
                on_unresolved="fail",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.unresolved is True
        assert len(result.rounds) == 1
        assert calls == ["probe_writer", "code_reviewer"]  # cap=1 — no fixer call
        assert result.needs_unresolved_label is False
        assert result.should_fail_task is True


class TestAdversarialReviewerRetriedOnceThenNotReady:
    def test_call2_exception_retried_once_then_succeeds(self, config, setup, tmp_path):
        attempts = 0

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            nonlocal attempts
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                return AgentResult(status="success", cost_usd=0.01, result_text="PROBES:\n")
            attempts += 1
            if attempts == 1:
                raise RuntimeError("transient SDK error")
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert attempts == 2
        assert result.verdict == "READY"
        assert result.unresolved is False

    def test_call2_unparseable_twice_counts_as_not_ready(self, config, setup, tmp_path):
        attempts = 0

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            nonlocal attempts
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                return AgentResult(status="success", cost_usd=0.01, result_text="PROBES:\n")
            if system_prompt == FIXER_SYSTEM_PROMPT:
                return AgentResult(status="success", cost_usd=0.02, result_text="Tried.")
            attempts += 1
            return AgentResult(status="success", cost_usd=0.02, result_text="no verdict here")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=1,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert attempts == 2  # retried once, within round 1 alone
        assert result.rounds[0].verdict == "NOT_READY"
        assert result.rounds[0].parse_error is not None


class TestAdversarialStaleShaRefused:
    def test_head_changing_during_review_forces_not_ready(self, config, setup, tmp_path):
        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                return AgentResult(status="success", cost_usd=0.01, result_text="PROBES:\n")
            # Simulate something else committing to the repo mid-review.
            _git(setup.repo_dir, "commit", "--allow-empty", "-m", "concurrent change")
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=1,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.rounds[0].stale_sha is True
        assert result.rounds[0].verdict == "NOT_READY"
        assert result.rounds[0].parse_error is not None
        assert "stale" in result.rounds[0].parse_error.lower()


class TestAdversarialBudgetExhaustedPartway:
    def test_stops_after_round_one_when_budget_runs_out(self, config, setup, tmp_path):
        config = config.model_copy(update={"max_budget_usd": 0.021})
        calls: list[str] = []

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                calls.append("probe_writer")
                return AgentResult(status="success", cost_usd=0.01, result_text="PROBES:\n")
            if system_prompt == FIXER_SYSTEM_PROMPT:
                calls.append("fixer")
                return AgentResult(status="success", cost_usd=0.02, result_text="Tried.")
            calls.append("code_reviewer")
            return AgentResult(
                status="success",
                cost_usd=0.01,
                result_text=(
                    "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                    '[{"type": "issue", "severity": "major", "title": "x", '
                    '"description": "x", "evidence": "app.py:1"}]\n```\n'
                ),
            )

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=2,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert calls == ["probe_writer", "code_reviewer"]  # no fixer — budget ran out
        assert result.stopped_reason == "budget_exhausted"
        assert result.unresolved is True


class TestAdversarialProbesCannotBeTamperedWith:
    def test_fixer_touching_probes_dir_is_reverted_and_recorded(self, config, setup, tmp_path):
        """Amendment 1: the fixer has Bash/Write/Edit, so a Write tool call into
        tests/review_probes/ must be detected (git-diff-and-revert) and
        recorded, even though it is not blocked by the Cedar layer in this
        in-process fake (Cedar enforcement is exercised separately in
        test_review_cedar.py)."""
        marker = Path(setup.repo_dir) / "FIXED_MARKER"
        probes_dir = Path(setup.repo_dir) / "tests" / "review_probes"

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                probes = {"test_marker.py": _marker_probe_source(marker)}
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            if system_prompt == FIXER_SYSTEM_PROMPT:
                marker.write_text("fixed", encoding="utf-8")
                # Tamper: try to neutralize the probe directly.
                probes_dir.mkdir(parents=True, exist_ok=True)
                (probes_dir / "test_marker.py").write_text(
                    "def test_marker():\n    assert True\n", encoding="utf-8"
                )
                return AgentResult(status="success", cost_usd=0.02, result_text="Tampered.")
            if "test_marker.py" in user_prompt and "FAIL" in user_prompt:
                return AgentResult(
                    status="success",
                    cost_usd=0.02,
                    result_text=(
                        "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                        '[{"type": "issue", "severity": "major", "title": "x", '
                        '"description": "x", "evidence": "app.py:1"}]\n```\n'
                    ),
                )
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=2,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert len(result.rounds) == 2
        assert result.rounds[1].reverted_probe_paths == ["tests/review_probes/test_marker.py"]
        # Reverted to the committed (still-failing, pre-fix) content, not the
        # fixer's neutered version — the probe keeps grading the real fix.
        committed_content = (probes_dir / "test_marker.py").read_text(encoding="utf-8")
        assert "assert True" not in committed_content

    def test_pycache_churn_from_running_the_probes_is_not_tamper(self, config, setup, tmp_path):
        """Regression (live demo run, 2026-11-18): the fixer's own `mise run
        build`/pytest invocation recompiles the committed probes, writing
        bytecode cache under tests/review_probes/__pycache__/ as a side
        effect — that must never be reported as the fixer tampering with the
        probes."""
        marker = Path(setup.repo_dir) / "FIXED_MARKER"
        probes_dir = Path(setup.repo_dir) / "tests" / "review_probes"

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                probes = {"test_marker.py": _marker_probe_source(marker)}
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            if system_prompt == FIXER_SYSTEM_PROMPT:
                marker.write_text("fixed", encoding="utf-8")
                # Bytecode cache churn, not tampering: running the committed
                # probe writes/updates its __pycache__ entry.
                pycache_dir = probes_dir / "__pycache__"
                pycache_dir.mkdir(parents=True, exist_ok=True)
                (pycache_dir / "test_marker.cpython-313-pytest.pyc").write_bytes(b"\x00\x01")
                return AgentResult(status="success", cost_usd=0.02, result_text="Ran the probes.")
            if "test_marker.py" in user_prompt and "FAIL" in user_prompt:
                return AgentResult(
                    status="success",
                    cost_usd=0.02,
                    result_text=(
                        "VERDICT: NOT-READY\nFINDINGS:\n```json\n"
                        '[{"type": "issue", "severity": "major", "title": "x", '
                        '"description": "x", "evidence": "app.py:1"}]\n```\n'
                    ),
                )
            return AgentResult(status="success", cost_usd=0.02, result_text="VERDICT: READY\n")

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                max_iterations=2,
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.rounds[1].reverted_probe_paths == []


class TestAdversarialInvalidProbeDoesNotBlock:
    def test_call2_marks_probe_invalid_and_still_reports_ready(self, config, setup, tmp_path):
        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                scratch_dir = _scratch_dir_from_prompt(user_prompt)
                probes = {"test_out_of_scope.py": "def test_x():\n    assert False\n"}
                _probe_writer_fake(scratch_dir, probes)
                return AgentResult(status="success", cost_usd=0.01, result_text=_manifest(probes))
            return AgentResult(
                status="success",
                cost_usd=0.02,
                result_text=(
                    "VERDICT: READY\nFINDINGS:\n```json\n[]\n```\n"
                    "INVALID_PROBES:\n```json\n"
                    '[{"filename": "test_out_of_scope.py", '
                    '"reason": "tests behavior the issue never asked for"}]\n```\n'
                ),
            )

        ledger = AgentInvocationLedger()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=config,
                setup=setup,
                ledger=ledger,
                review_mode="adversarial",
                workspace_base_dir=str(tmp_path / "workspace"),
            )
        assert result.verdict == "READY"
        assert result.unresolved is False
        assert result.rounds[0].invalid_probes == {
            "test_out_of_scope.py": "tests behavior the issue never asked for"
        }
        assert len(result.rounds) == 1  # READY — no fixer, no second round
