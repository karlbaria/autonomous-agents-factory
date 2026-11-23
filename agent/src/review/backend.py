"""Orchestrates the independent review (Task 4 — advisory; Task 5 — the
bounded adversarial fix loop).

See the package docstring (``review/__init__.py``) for the design, ADR-025
(fork) for Task 4's rationale, and ADR-026 (fork) for Task 5's.
``run_review_and_fix`` is what ``workflow.runner._handle_review_and_fix``
wraps; it is also directly unit testable with ``runner.run_agent`` mocked (it
never imports ``workflow.*``, so there is no import cycle: ``workflow.runner``
imports this module, not the other way around).

Advisory mode (Task 4): a failure anywhere in a round is caught and turned
into a neutral/NOT_READY result rather than raised — the coder's PR must
ship regardless of whether the review itself could run.

Adversarial mode (Task 5 — ADR-026 (fork)): the same round (fresh probes,
the probe run, a fresh code review) repeats up to ``max_iterations`` times,
with a fixer call between rounds that gets the failing probes and findings
as evidence and must fix the code — it cannot edit or delete the probes
(amendment 1: Cedar denies it as defense-in-depth; the deterministic
snapshot/revert in this module is what actually enforces it). A round that
reaches ``READY`` ends the loop early; a loop that exhausts
``max_iterations`` still NOT_READY is "unresolved", handled per
``on_unresolved``.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field

from shell import log, run_cmd

from .findings import Finding, ReviewOutcome, Verdict, parse_review_output
from .probes import Probe, ProbeResult, collect_probes, run_probes
from .prompts import (
    CODE_REVIEWER_SYSTEM_PROMPT,
    FIXER_SYSTEM_PROMPT,
    PROBE_WRITER_SYSTEM_PROMPT,
    code_reviewer_user_prompt,
    fixer_user_prompt,
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
#
# Must be one of `DEFAULT_BEDROCK_MODEL_IDS`
# (cdk/src/handlers/shared/bedrock-model-constants.ts) — that list is what
# `AgentSessionRole` and the runtime role actually grant `bedrock:InvokeModel*`
# on. Sonnet 5.5 is deliberately NOT on that list (no `jp.` cross-Region
# inference profile), so it was never invocable on a deployed stack: every
# review call AccessDenied there, even though local runs (which use a
# broader personal AWS profile, not the scoped AgentSessionRole) never saw
# it. `claude-sonnet-4-6` is on the list and still distinct from the coder's
# `claude-opus-5-5`.
DEFAULT_REVIEWER_MODEL = "global.anthropic.claude-sonnet-4-6"
DEFAULT_REVIEWER_MAX_TURNS = 15

# Task 5 (ADR-026 (fork)) defaults — the base spec's Settings block.
DEFAULT_MAX_ITERATIONS = 2
DEFAULT_BLOCK_ON_SEVERITY = "major"
DEFAULT_ON_UNRESOLVED = "pr_with_warning"

# Duplicated from workflow/runner.py's _MIN_CALL_BUDGET_USD rather than
# imported: workflow.runner imports this module (for _handle_review_and_fix),
# so the reverse import would cycle. Keep the two values equal — both are the
# Claude Agent SDK's minimum max_budget_usd for a call.
_MIN_CALL_BUDGET_USD = 0.01

_PROBES_COMMIT_DIR = "tests/review_probes"
# A manifest line names a probe file — Python or JS/TS (#69), optionally under
# its package's scratch subdirectory — and its intent.
_PROBE_MANIFEST_LINE_RE = re.compile(
    r"^-\s*`?([A-Za-z0-9_./-]+\.(?:py|[jt]sx?))`?\s*:\s*(.+)\s*$", re.MULTILINE
)


class RoundOutcome(BaseModel):
    """What one review round produced (Task 5 — ADR-026 (fork))."""

    model_config = ConfigDict(frozen=True)

    round_number: int
    verdict: Verdict | None = None
    findings: list[Finding] = Field(default_factory=list)
    probe_results: list[ProbeResult] = Field(default_factory=list)
    reviewed_sha: str = ""
    committed_probe_paths: list[str] = Field(default_factory=list)
    parse_error: str | None = None
    # Amendment 2: filename -> Call 2's reasoning for marking that probe
    # invalid (tests behavior the issue never asked for).
    invalid_probes: dict[str, str] = Field(default_factory=dict)
    # The reviewed SHA no longer matched HEAD when the verdict came back —
    # the verdict is refused (forced NOT_READY) regardless of what Call 2 wrote.
    stale_sha: bool = False
    # Amendment 1: probe paths the fixer call just before this round touched,
    # reverted before this round's review ran — defense-in-depth Cedar denies
    # the fixer's Write/Edit into this path too, but the fixer has Bash,
    # which that rule cannot see.
    reverted_probe_paths: list[str] = Field(default_factory=list)


class ReviewAndFixResult(BaseModel):
    """What the review produced, for the pipeline to report.

    ``verdict``/``findings``/``probe_results``/``reviewed_sha``/
    ``parse_error`` mirror the LAST round (Task 4's single advisory round, or
    Task 5's final adversarial round) for backward compatibility with
    existing callers; ``rounds`` carries the full per-round history.
    """

    model_config = ConfigDict(frozen=True)

    ran: bool
    mode: str = "advisory"
    verdict: Verdict | None = None
    findings: list[Finding] = Field(default_factory=list)
    probe_results: list[ProbeResult] = Field(default_factory=list)
    reviewed_sha: str = ""
    committed_probe_paths: list[str] = Field(default_factory=list)
    parse_error: str | None = None
    skipped_reason: str | None = None
    # Task 5 (ADR-026 (fork)):
    rounds: list[RoundOutcome] = Field(default_factory=list)
    # True when the loop ran out of iterations (or budget) still NOT_READY.
    unresolved: bool = False
    # Why the loop stopped before a READY verdict: "max_iterations" |
    # "budget_exhausted" | None (resolved, or never adversarial).
    stopped_reason: str | None = None
    on_unresolved: str = DEFAULT_ON_UNRESOLVED
    # The caller (pipeline.py) should add the `review:unresolved` label to
    # the PR — set only when unresolved and on_unresolved=="pr_with_warning".
    needs_unresolved_label: bool = False
    # The caller should fail the task instead of shipping a PR — set only
    # when unresolved and on_unresolved=="fail".
    should_fail_task: bool = False


def _milestone(progress: _ProgressWriter | None, name: str, detail: str = "") -> None:
    # Always echo to stdout too: _ProgressWriter is a silent no-op locally (no
    # TASK_EVENTS_TABLE_NAME set by run.sh), matching workflow.runner's
    # stage_costs line — without this a local run shows no review output at all.
    log("AGENT", f"{name}: {detail}" if detail else name)
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


def _probe_commit_path(result: ProbeResult) -> str:
    """Repo-relative path a passing probe is committed to.

    Python probes go to ``tests/review_probes/``. A JS/TS probe (#69) is
    committed exactly where it ran and passed — ``<package>/src/__probes__/``
    under its runner-discoverable name — so the repo's own test runner picks it
    up from the same place with the same config, and ``npm test`` runs a probe
    already known to pass there.
    """
    if result.run_path:
        return result.run_path
    return f"{_PROBES_COMMIT_DIR}/{result.probe.filename}"


def _commit_passing_probes(repo_dir: str, probe_results: list[ProbeResult]) -> list[str]:
    """Commit only the probes that pass, as one commit (see ``_probe_commit_path``).

    Failing and not-runnable probes are never written to the repo — they stay
    as unresolved findings the PR body reports instead.
    """
    passing = [r for r in probe_results if r.passed]
    if not passing:
        return []

    committed: list[str] = []
    for result in passing:
        rel = _probe_commit_path(result)
        dest = Path(repo_dir) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(result.probe.source, encoding="utf-8")
        committed.append(rel)

    run_cmd(["git", "add", "--", *committed], label="review-probes-add", cwd=repo_dir)
    unchanged = run_cmd(
        ["git", "diff", "--cached", "--quiet", "--exit-code", "--", *committed],
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


def _merge_probes(fresh: list[Probe], carried: list[Probe]) -> list[Probe]:
    """Fresh probes plus the previous round's carried-forward failing ones.

    Amendment 4: each later round reruns the previous round's failing
    probes alongside the fresh ones the probe writer just produced. Keyed
    by filename so a fresh probe that happens to reuse a carried filename
    wins (it's presumably a deliberate rewrite, not a collision).
    """
    merged = {p.key: p for p in carried}
    merged.update({p.key: p for p in fresh})
    return list(merged.values())


def _protected_probe_dirs(probe_results: list[ProbeResult], committed: list[str]) -> list[str]:
    """Repo-relative directories the fixer may not touch.

    ``tests/review_probes/`` always, plus (#69) every package's JS/TS probe
    directory a probe ran in or was committed to.
    """
    dirs = {_PROBES_COMMIT_DIR}
    dirs.update(str(PurePosixPath(r.run_path).parent) for r in probe_results if r.run_path)
    dirs.update(str(PurePosixPath(p).parent) for p in committed)
    return sorted(dirs)


def _snapshot_dirs(repo: Path, rel_dirs: list[str]) -> dict[str, bytes]:
    """Every file under ``rel_dirs``, keyed repo-relative, for tamper detection.

    Excludes ``__pycache__``: running the committed probes (the fixer's own
    build/test invocation, or this module's own ``run_probes``) recompiles
    their bytecode as a side effect, which is cache churn, not the fixer
    editing or deleting a probe (seen for real in a live demo run).
    """
    snapshot: dict[str, bytes] = {}
    for rel_dir in rel_dirs:
        path = repo / rel_dir
        if not path.is_dir():
            continue
        for p in sorted(path.rglob("*")):
            if p.is_file() and "__pycache__" not in p.relative_to(path).parts:
                snapshot[p.relative_to(repo).as_posix()] = p.read_bytes()
    return snapshot


def _restore_and_diff(repo: Path, rel_dirs: list[str], snapshot: dict[str, bytes]) -> list[str]:
    """Restore ``rel_dirs`` to ``snapshot``; return the repo-relative paths that had to change.

    Amendment 1: the fixer must not edit or delete the committed probes.
    This is the deterministic enforcement — a git-diff-and-revert step, not
    just the Cedar rule (which cannot see a Bash-written file at all).
    """
    current = _snapshot_dirs(repo, rel_dirs)
    touched: set[str] = set()
    for rel, content in snapshot.items():
        if current.get(rel) != content:
            touched.add(rel)
            (repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / rel).write_bytes(content)
    for rel in current:
        if rel not in snapshot:
            touched.add(rel)
            (repo / rel).unlink(missing_ok=True)
    return sorted(touched)


def _commit_fixer_changes(repo_dir: str) -> None:
    """Commit whatever the fixer (and any tamper revert) left in the tree.

    A deterministic step, not left to the fixer's own turn: the next
    round's diff (against the base branch) and reviewed-sha capture both
    need the fix committed, the same way the coder's own turn commits
    before the first round ever runs.
    """
    run_cmd(["git", "add", "-A"], label="review-fixer-add", cwd=repo_dir)
    unchanged = run_cmd(
        ["git", "diff", "--cached", "--quiet", "--exit-code"],
        label="review-fixer-diff-check",
        cwd=repo_dir,
        check=False,
    )
    if unchanged.returncode == 0:
        return  # fixer made no net change (e.g. a fully-reverted tamper attempt)
    run_cmd(
        ["git", "commit", "-m", "fix: address independent review findings"],
        label="review-fixer-commit",
        cwd=repo_dir,
    )


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


_CODE_REVIEWER_ATTEMPTS = 2  # one retry: "a review that doesn't finish is retried once"


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
    block_on_severity: str = DEFAULT_BLOCK_ON_SEVERITY,
) -> ReviewOutcome:
    """Run Call 2 against the full repo; return the parsed verdict + findings.

    A call that raises, or whose output doesn't fit the contract, is
    retried once before counting as ``NOT_READY`` (Task 5's "a review that
    doesn't finish" case) — each attempt that actually ran is billed to the
    ledger regardless of outcome.
    """
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
    user_prompt = code_reviewer_user_prompt(
        issue_text, diff_text, probe_results, block_on_severity=block_on_severity
    )

    outcome: ReviewOutcome | None = None
    last_error = "code reviewer call did not run"
    for attempt in range(1, _CODE_REVIEWER_ATTEMPTS + 1):
        try:
            result = asyncio.run(
                _call_agent(
                    CODE_REVIEWER_SYSTEM_PROMPT,
                    user_prompt,
                    call2_config,
                    setup.repo_dir,
                    trajectory,
                )
            )
        except Exception as e:
            last_error = f"code reviewer call failed: {e}"
            log("WARN", f"review_and_fix: code-reviewer attempt {attempt} failed: {e}")
            continue
        ledger.record(
            stage="code_reviewer",
            cost_usd=result.cost_usd,
            turns=result.num_turns or result.turns,
            model=model,
        )
        outcome = parse_review_output(result.result_text)
        if outcome.parse_error is None:
            break
        last_error = outcome.parse_error
        log(
            "WARN",
            f"review_and_fix: code-reviewer attempt {attempt} output unparseable: "
            f"{outcome.parse_error}",
        )

    if outcome is None:
        outcome = ReviewOutcome(verdict="NOT_READY", findings=[], parse_error=last_error)
    _milestone(
        progress, "review_verdict", f"verdict={outcome.verdict} findings={len(outcome.findings)}"
    )
    return outcome


def _run_fixer(
    *,
    config: TaskConfig,
    setup: RepoSetup,
    ledger: AgentInvocationLedger,
    progress: _ProgressWriter | None,
    trajectory: Any,
    issue_text: str,
    findings: list[Finding],
    failing_probes: list[ProbeResult],
    protected_dirs: list[Path],
) -> None:
    """Run the fixer against the coder's checkout (Task 5 amendment 3).

    Full coder-shaped access (the same tools, the same model) to the same
    ``setup.repo_dir`` — unlike the two reviewer calls, this one mutates the
    code. ``protected_write_roots`` is the Cedar defense-in-depth layer
    (amendment 1); the caller still snapshots/reverts ``protected_dirs`` itself,
    since a Bash-written file never reaches that rule at all.
    """
    remaining = ledger.remaining_budget(config.max_budget_usd)
    if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
        log("AGENT", "review_and_fix: skipping fixer call — budget exhausted")
        return

    fixer_config = config.model_copy(
        update={
            "max_budget_usd": ledger.remaining_budget(config.max_budget_usd),
            "read_only": False,
            "allowed_tools": config.allowed_tools
            or ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
            "policy_principal": "fixer",
            "allowed_read_roots": None,
            "scratch_write_root": None,
            "protected_write_roots": [str(d) for d in protected_dirs],
        }
    )
    user_prompt = fixer_user_prompt(issue_text, findings, failing_probes)
    result = asyncio.run(
        _call_agent(FIXER_SYSTEM_PROMPT, user_prompt, fixer_config, setup.repo_dir, trajectory)
    )
    ledger.record(
        stage="fixer",
        cost_usd=result.cost_usd,
        turns=result.num_turns or result.turns,
        model=fixer_config.anthropic_model,
    )
    _milestone(progress, "review_fixer_ran", f"status={result.status}")


def _run_one_round(
    *,
    round_number: int,
    config: TaskConfig,
    setup: RepoSetup,
    ledger: AgentInvocationLedger,
    progress: _ProgressWriter | None,
    trajectory: Any,
    model: str,
    max_turns: int,
    issue_text: str,
    block_on_severity: str,
    carried_probes: list[Probe],
    base_dir: str,
    reverted_probe_paths: list[str],
) -> RoundOutcome:
    """Run one full round: fresh probes -> the probe run -> a fresh code review.

    ``carried_probes`` (amendment 4) are the previous round's failing,
    non-invalid probes, rerun alongside this round's fresh ones.
    ``reverted_probe_paths`` (amendment 1) is what the caller's tamper
    revert, just before this round, touched — carried through only for
    reporting; it does not change this round's behavior.
    """
    reviewed_sha = _git_output(setup.repo_dir, "rev-parse", "HEAD").strip()
    diff_text = _git_output(setup.repo_dir, "diff", f"origin/{setup.default_branch}...HEAD")
    signatures = extract_new_public_signatures(diff_text)
    signatures_for_call1 = [] if issue_names_interface(issue_text, signatures) else signatures

    fresh_probes: list[Probe] = []
    try:
        fresh_probes = _run_probe_writer(
            config=config,
            setup=setup,
            ledger=ledger,
            progress=progress,
            trajectory=trajectory,
            model=model,
            max_turns=max_turns,
            issue_text=issue_text,
            signatures_for_call1=signatures_for_call1,
            base_dir=base_dir,
        )
    except Exception as e:
        log(
            "WARN",
            f"review_and_fix: probe-writer phase failed (round {round_number}): "
            f"{type(e).__name__}: {e}",
        )

    probes = _merge_probes(fresh_probes, carried_probes)
    probe_results = run_probes(probes, setup.repo_dir)
    # Always emitted (#69), even for zero probes, so "nothing ran" is visible
    # rather than inferred from a missing event. Not-runnable probes are their
    # own count: neither passed nor failed.
    _milestone(progress, "review_probes_run", _probe_counts(probe_results))

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
            block_on_severity=block_on_severity,
        )
    except Exception as e:
        log(
            "WARN",
            f"review_and_fix: code-reviewer phase failed (round {round_number}): "
            f"{type(e).__name__}: {e}",
        )
        outcome = ReviewOutcome(
            verdict="NOT_READY", findings=[], parse_error=f"code reviewer call failed: {e}"
        )

    stale_sha = False
    current_sha = _git_output(setup.repo_dir, "rev-parse", "HEAD").strip()
    if current_sha and reviewed_sha and current_sha != reviewed_sha:
        # The verdict is refused if the reviewed SHA no longer matches the
        # code — something changed the repo mid-review, so nothing Call 2
        # wrote can be trusted against what's actually there now.
        stale_sha = True
        outcome = ReviewOutcome(
            verdict="NOT_READY",
            findings=[],
            parse_error=(
                f"stale_sha: repo HEAD changed from {reviewed_sha[:12]} to "
                f"{current_sha[:12]} during review — verdict refused"
            ),
        )

    committed_paths = _commit_passing_probes(setup.repo_dir, probe_results)

    return RoundOutcome(
        round_number=round_number,
        verdict=outcome.verdict,
        findings=outcome.findings,
        probe_results=probe_results,
        reviewed_sha=reviewed_sha,
        committed_probe_paths=committed_paths,
        parse_error=outcome.parse_error,
        invalid_probes=outcome.invalid_probes,
        stale_sha=stale_sha,
        reverted_probe_paths=reverted_probe_paths,
    )


def _probe_counts(probe_results: list[ProbeResult]) -> str:
    passed = sum(1 for r in probe_results if r.passed)
    failed = sum(1 for r in probe_results if r.failed)
    not_runnable = sum(1 for r in probe_results if not r.runnable)
    return f"count={len(probe_results)} passed={passed} failed={failed} not_runnable={not_runnable}"


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
    max_iterations: int | None = None,
    block_on_severity: str | None = None,
    on_unresolved: str | None = None,
) -> ReviewAndFixResult:
    """Run the independent review against the coder's current branch.

    ``advisory`` (Task 4) runs a single round, never gating. ``adversarial``
    (Task 5 — ADR-026 (fork)) repeats the round — fresh probes, the probe
    run, a fresh code review — up to ``max_iterations`` times, with a fixer
    call between rounds, stopping early on a ``READY`` verdict. ``none``
    skips the review entirely. ``max_iterations``/``block_on_severity``/
    ``on_unresolved`` are ``None``-able the same way ``reviewer_model`` is —
    a caller that omits them (or a workflow step that doesn't set them)
    gets the Task 5 base-spec defaults below.
    """
    if review_mode == "none":
        return ReviewAndFixResult(ran=False, skipped_reason="review_mode=none")

    model = reviewer_model or DEFAULT_REVIEWER_MODEL
    max_turns = reviewer_max_turns or DEFAULT_REVIEWER_MAX_TURNS
    max_iterations = max_iterations or DEFAULT_MAX_ITERATIONS
    block_on_severity = block_on_severity or DEFAULT_BLOCK_ON_SEVERITY
    on_unresolved = on_unresolved or DEFAULT_ON_UNRESOLVED
    issue_text = _issue_text(config)

    remaining = ledger.remaining_budget(config.max_budget_usd)
    if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
        log("AGENT", f"review_and_fix skipped: ${remaining:.4f} remaining is below the SDK minimum")
        return ReviewAndFixResult(ran=False, skipped_reason="budget_exhausted")

    if review_mode != "adversarial":
        round_outcome = _run_one_round(
            round_number=1,
            config=config,
            setup=setup,
            ledger=ledger,
            progress=progress,
            trajectory=trajectory,
            model=model,
            max_turns=max_turns,
            issue_text=issue_text,
            block_on_severity=block_on_severity,
            carried_probes=[],
            base_dir=workspace_base_dir,
            reverted_probe_paths=[],
        )
        log("AGENT", f"review_and_fix stage_costs={ledger.stage_costs()}")
        return ReviewAndFixResult(
            ran=True,
            mode="advisory",
            rounds=[round_outcome],
            verdict=round_outcome.verdict,
            findings=round_outcome.findings,
            probe_results=round_outcome.probe_results,
            reviewed_sha=round_outcome.reviewed_sha,
            committed_probe_paths=round_outcome.committed_probe_paths,
            parse_error=round_outcome.parse_error,
        )

    repo = Path(setup.repo_dir)
    rounds: list[RoundOutcome] = []
    committed_so_far: list[str] = []
    carried_probes: list[Probe] = []
    reverted_paths: list[str] = []
    stopped_reason: str | None = None

    for round_number in range(1, max_iterations + 1):
        round_outcome = _run_one_round(
            round_number=round_number,
            config=config,
            setup=setup,
            ledger=ledger,
            progress=progress,
            trajectory=trajectory,
            model=model,
            max_turns=max_turns,
            issue_text=issue_text,
            block_on_severity=block_on_severity,
            carried_probes=carried_probes,
            base_dir=workspace_base_dir,
            reverted_probe_paths=reverted_paths,
        )
        rounds.append(round_outcome)
        reverted_paths = []
        committed_so_far.extend(round_outcome.committed_probe_paths)
        failed_count = sum(1 for r in round_outcome.probe_results if r.failed)
        not_runnable_count = sum(1 for r in round_outcome.probe_results if not r.runnable)
        _milestone(
            progress,
            "review_round",
            f"round {round_number}: verdict={round_outcome.verdict} "
            f"findings={len(round_outcome.findings)} probes_failed={failed_count} "
            f"probes_not_runnable={not_runnable_count}",
        )

        if round_outcome.verdict == "READY":
            break
        if round_number == max_iterations:
            break

        remaining = ledger.remaining_budget(config.max_budget_usd)
        if remaining is not None and remaining < _MIN_CALL_BUDGET_USD:
            stopped_reason = "budget_exhausted"
            break

        carried_probes = [
            r.probe
            for r in round_outcome.probe_results
            if r.failed and r.probe.filename not in round_outcome.invalid_probes
        ]
        failing_probes = [r for r in round_outcome.probe_results if r.failed]
        protected = _protected_probe_dirs(round_outcome.probe_results, committed_so_far)
        snapshot = _snapshot_dirs(repo, protected)
        try:
            _run_fixer(
                config=config,
                setup=setup,
                ledger=ledger,
                progress=progress,
                trajectory=trajectory,
                issue_text=issue_text,
                findings=round_outcome.findings,
                failing_probes=failing_probes,
                protected_dirs=[repo / d for d in protected],
            )
        except Exception as e:
            log("WARN", f"review_and_fix: fixer phase failed (round {round_number}): {e}")
        reverted_paths = _restore_and_diff(repo, protected, snapshot)
        if reverted_paths:
            log(
                "WARN",
                f"review_and_fix: fixer touched protected probes, reverted: {reverted_paths}",
            )
        _commit_fixer_changes(setup.repo_dir)

    last = rounds[-1]
    unresolved = last.verdict != "READY"
    if unresolved and stopped_reason is None:
        stopped_reason = "max_iterations"
    all_committed = [p for r in rounds for p in r.committed_probe_paths]

    log("AGENT", f"review_and_fix stage_costs={ledger.stage_costs()}")
    return ReviewAndFixResult(
        ran=True,
        mode="adversarial",
        rounds=rounds,
        verdict=last.verdict,
        findings=last.findings,
        probe_results=last.probe_results,
        reviewed_sha=last.reviewed_sha,
        committed_probe_paths=all_committed,
        parse_error=last.parse_error,
        unresolved=unresolved,
        stopped_reason=stopped_reason,
        on_unresolved=on_unresolved,
        needs_unresolved_label=unresolved and on_unresolved == "pr_with_warning",
        should_fail_task=unresolved and on_unresolved == "fail",
    )
