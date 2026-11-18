"""Orchestrates one round of the two-call independent review (Task 4).

See the package docstring (``review/__init__.py``) for the design and
ADR-025 (fork) for the full rationale. ``run_review_and_fix`` is what
``workflow.runner._handle_review_and_fix`` wraps; it is also directly unit
testable with ``runner.run_agent`` mocked (it never imports ``workflow.*``,
so there is no import cycle: ``workflow.runner`` imports this module, not
the other way around).

Advisory only (Task 4): a failure anywhere in this function is caught and
turned into a neutral/NOT_READY result rather than raised — the coder's PR
must ship regardless of whether the review itself could run. The bounded
fix loop (``review_mode: adversarial``) is Task 5.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field

from shell import log, run_cmd

from .findings import Finding, ReviewOutcome, Verdict, parse_review_output
from .probes import Probe, ProbeResult, collect_probes, run_probes
from .prompts import (
    CODE_REVIEWER_SYSTEM_PROMPT,
    PROBE_WRITER_SYSTEM_PROMPT,
    code_reviewer_user_prompt,
    probe_writer_user_prompt,
)
from .signatures import extract_new_public_signatures, issue_names_interface
from .worktree import probe_writer_workspace

if TYPE_CHECKING:
    from models import AgentInvocationLedger, RepoSetup, TaskConfig
    from progress_writer import _ProgressWriter

# Distinct from the coder's default model (models.TaskConfig.anthropic_model)
# so a reviewer that doesn't override `reviewer_model` still gets a second,
# independent opinion rather than the same model reviewing itself.
DEFAULT_REVIEWER_MODEL = "global.anthropic.claude-sonnet-5-5"
DEFAULT_REVIEWER_MAX_TURNS = 15

# Duplicated from workflow/runner.py's _MIN_CALL_BUDGET_USD rather than
# imported: workflow.runner imports this module (for _handle_review_and_fix),
# so the reverse import would cycle. Keep the two values equal — both are the
# Claude Agent SDK's minimum max_budget_usd for a call.
_MIN_CALL_BUDGET_USD = 0.01

_PROBES_COMMIT_DIR = "tests/review_probes"
_PROBE_MANIFEST_LINE_RE = re.compile(r"^-\s*([A-Za-z0-9_.]+\.py)\s*:\s*(.+)\s*$", re.MULTILINE)


class ReviewAndFixResult(BaseModel):
    """What one round of the review produced, for the pipeline to report."""

    model_config = ConfigDict(frozen=True)

    ran: bool
    verdict: Verdict | None = None
    findings: list[Finding] = Field(default_factory=list)
    probe_results: list[ProbeResult] = Field(default_factory=list)
    reviewed_sha: str = ""
    committed_probe_paths: list[str] = Field(default_factory=list)
    parse_error: str | None = None
    skipped_reason: str | None = None


def _milestone(progress: _ProgressWriter | None, name: str, detail: str = "") -> None:
    if progress is None:
        return
    try:
        progress.write_agent_milestone(name, detail)
    except Exception as e:  # best-effort, never fails the review
        log("WARN", f"review milestone {name!r} emit failed (non-fatal): {type(e).__name__}: {e}")


def _issue_text(config: TaskConfig) -> str:
    if config.issue is not None:
        return f"{config.issue.title}\n\n{config.issue.body}".strip()
    return config.task_description or ""


def _git_output(repo_dir: str, *args: str) -> str:
    result = run_cmd(["git", *args], label="review-git", cwd=repo_dir, check=False)
    return result.stdout if result.returncode == 0 else ""


def _parse_probe_manifest(text: str) -> dict[str, str]:
    """Parse Call 1's ``PROBES:\\n- filename: intent`` manifest, best-effort."""
    return {m.group(1): m.group(2).strip() for m in _PROBE_MANIFEST_LINE_RE.finditer(text)}


def _commit_passing_probes(repo_dir: str, probe_results: list[ProbeResult]) -> list[str]:
    """Commit only the probes that pass, into ``tests/review_probes/``, as one commit.

    Failing probes are never written to the repo — they stay as unresolved
    findings the PR body reports instead.
    """
    passing = [r.probe for r in probe_results if r.passed]
    if not passing:
        return []

    dest_dir = Path(repo_dir) / _PROBES_COMMIT_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    committed: list[str] = []
    for probe in passing:
        (dest_dir / probe.filename).write_text(probe.source, encoding="utf-8")
        committed.append(f"{_PROBES_COMMIT_DIR}/{probe.filename}")

    run_cmd(["git", "add", _PROBES_COMMIT_DIR], label="review-probes-add", cwd=repo_dir)
    unchanged = run_cmd(
        ["git", "diff", "--cached", "--quiet", "--exit-code", "--", _PROBES_COMMIT_DIR],
        label="review-probes-diff-check",
        cwd=repo_dir,
        check=False,
    )
    if unchanged.returncode == 0:
        return []  # identical to what's already committed — nothing to add
    run_cmd(
        ["git", "commit", "-m", "test: add review probes from advisory review"],
        label="review-probes-commit",
        cwd=repo_dir,
    )
    return committed


async def _call_agent(
    system_prompt: str, user_prompt: str, call_config: TaskConfig, cwd: str, trajectory: Any
):
    """Run one reviewer-role agent call, restoring ``os.environ`` afterward.

    Mirrors ``workflow.runner._handle_run_agent``'s env snapshot/restore: this
    call's model/Bedrock env must not leak into the next call in the same
    task (the coder already ran; another reviewer call follows).
    """
    from runner import run_agent

    env_snapshot = dict(os.environ)
    try:
        return await run_agent(
            user_prompt, system_prompt, call_config, cwd=cwd, trajectory=trajectory
        )
    finally:
        os.environ.clear()
        os.environ.update(env_snapshot)


def _run_probe_writer(
    *,
    config: TaskConfig,
    setup: RepoSetup,
    ledger: AgentInvocationLedger,
    progress: _ProgressWriter | None,
    trajectory: Any,
    model: str,
    max_turns: int,
    issue_text: str,
    signatures_for_call1: list,
    base_dir: str,
) -> list[Probe]:
    """Run Call 1 in its own worktree + scratch dir; return the probes it wrote."""
    remaining = ledger.remaining_budget(config.max_budget_usd)
    if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
        log("AGENT", "review_and_fix: skipping probe-writer call — budget exhausted")
        return []

    with probe_writer_workspace(setup.repo_dir, setup.default_branch, base_dir=base_dir) as (
        worktree_dir,
        scratch_dir,
    ):
        call1_config = config.model_copy(
            update={
                "max_budget_usd": ledger.remaining_budget(config.max_budget_usd),
                "anthropic_model": model,
                "max_turns": max_turns,
                "read_only": False,
                "allowed_tools": ["Read", "Glob", "Grep", "Write"],
                "policy_principal": "probe_writer",
                "allowed_read_roots": [worktree_dir, scratch_dir],
                "scratch_write_root": scratch_dir,
            }
        )
        user_prompt = probe_writer_user_prompt(issue_text, signatures_for_call1, scratch_dir)
        result = asyncio.run(
            _call_agent(
                PROBE_WRITER_SYSTEM_PROMPT, user_prompt, call1_config, worktree_dir, trajectory
            )
        )
        ledger.record(
            stage="probe_writer",
            cost_usd=result.cost_usd,
            turns=result.num_turns or result.turns,
            model=model,
        )
        _milestone(progress, "review_probes_written", f"status={result.status}")
        intents = _parse_probe_manifest(result.result_text)
        return collect_probes(scratch_dir, intents=intents)


def _run_code_reviewer(
    *,
    config: TaskConfig,
    setup: RepoSetup,
    ledger: AgentInvocationLedger,
    progress: _ProgressWriter | None,
    trajectory: Any,
    model: str,
    max_turns: int,
    issue_text: str,
    diff_text: str,
    probe_results: list[ProbeResult],
) -> ReviewOutcome:
    """Run Call 2 against the full repo; return the parsed verdict + findings."""
    remaining = ledger.remaining_budget(config.max_budget_usd)
    if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
        log("AGENT", "review_and_fix: skipping code-reviewer call — budget exhausted")
        return ReviewOutcome(
            verdict="NOT_READY",
            findings=[],
            parse_error="budget exhausted before code review",
        )

    call2_config = config.model_copy(
        update={
            "max_budget_usd": ledger.remaining_budget(config.max_budget_usd),
            "anthropic_model": model,
            "max_turns": max_turns,
            "read_only": True,
            "allowed_tools": ["Read", "Glob", "Grep"],
            "policy_principal": "code_reviewer",
            "allowed_read_roots": None,
            "scratch_write_root": None,
        }
    )
    user_prompt = code_reviewer_user_prompt(issue_text, diff_text, probe_results)
    result = asyncio.run(
        _call_agent(
            CODE_REVIEWER_SYSTEM_PROMPT, user_prompt, call2_config, setup.repo_dir, trajectory
        )
    )
    ledger.record(
        stage="code_reviewer",
        cost_usd=result.cost_usd,
        turns=result.num_turns or result.turns,
        model=model,
    )
    outcome = parse_review_output(result.result_text)
    _milestone(
        progress, "review_verdict", f"verdict={outcome.verdict} findings={len(outcome.findings)}"
    )
    return outcome


def run_review_and_fix(
    *,
    config: TaskConfig,
    setup: RepoSetup,
    ledger: AgentInvocationLedger,
    progress: _ProgressWriter | None = None,
    trajectory: Any = None,
    review_mode: str = "advisory",
    reviewer_model: str | None = None,
    reviewer_max_turns: int | None = None,
    workspace_base_dir: str,
) -> ReviewAndFixResult:
    """Run one round of the two-call review against the coder's current branch.

    Task 4 ships ``advisory`` (and, until Task 5's loop lands, treats
    ``adversarial`` the same way — a single round, never gating). ``none``
    skips the review entirely.
    """
    if review_mode == "none":
        return ReviewAndFixResult(ran=False, skipped_reason="review_mode=none")
    if review_mode == "adversarial":
        log(
            "WARN",
            "review_and_fix: review_mode=adversarial has no fix loop yet (Task 5) — "
            "running a single advisory round",
        )

    model = reviewer_model or DEFAULT_REVIEWER_MODEL
    max_turns = reviewer_max_turns or DEFAULT_REVIEWER_MAX_TURNS

    remaining = ledger.remaining_budget(config.max_budget_usd)
    if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
        log("AGENT", f"review_and_fix skipped: ${remaining:.4f} remaining is below the SDK minimum")
        return ReviewAndFixResult(ran=False, skipped_reason="budget_exhausted")

    reviewed_sha = _git_output(setup.repo_dir, "rev-parse", "HEAD").strip()
    diff_text = _git_output(setup.repo_dir, "diff", f"origin/{setup.default_branch}...HEAD")
    issue_text = _issue_text(config)
    signatures = extract_new_public_signatures(diff_text)
    signatures_for_call1 = [] if issue_names_interface(issue_text, signatures) else signatures

    probes: list[Probe] = []
    try:
        probes = _run_probe_writer(
            config=config,
            setup=setup,
            ledger=ledger,
            progress=progress,
            trajectory=trajectory,
            model=model,
            max_turns=max_turns,
            issue_text=issue_text,
            signatures_for_call1=signatures_for_call1,
            base_dir=workspace_base_dir,
        )
    except Exception as e:
        log(
            "WARN",
            f"review_and_fix: probe-writer phase failed (advisory only): {type(e).__name__}: {e}",
        )

    probe_results: list[ProbeResult] = []
    if probes:
        probe_results = run_probes(probes, setup.repo_dir)
        passed = sum(1 for r in probe_results if r.passed)
        _milestone(progress, "review_probes_run", f"count={len(probe_results)} passed={passed}")

    try:
        outcome = _run_code_reviewer(
            config=config,
            setup=setup,
            ledger=ledger,
            progress=progress,
            trajectory=trajectory,
            model=model,
            max_turns=max_turns,
            issue_text=issue_text,
            diff_text=diff_text,
            probe_results=probe_results,
        )
    except Exception as e:
        log(
            "WARN",
            f"review_and_fix: code-reviewer phase failed (advisory only): {type(e).__name__}: {e}",
        )
        outcome = ReviewOutcome(
            verdict="NOT_READY", findings=[], parse_error=f"code reviewer call failed: {e}"
        )

    committed_paths = _commit_passing_probes(setup.repo_dir, probe_results)

    return ReviewAndFixResult(
        ran=True,
        verdict=outcome.verdict,
        findings=outcome.findings,
        probe_results=probe_results,
        reviewed_sha=reviewed_sha,
        committed_probe_paths=committed_paths,
        parse_error=outcome.parse_error,
    )
