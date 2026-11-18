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
from review.prompts import CODE_REVIEWER_SYSTEM_PROMPT, PROBE_WRITER_SYSTEM_PROMPT

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
