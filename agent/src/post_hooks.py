"""Post-agent hooks: build/lint verification, commit, push, PR creation."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from runtime_paths import unstage_runtime_written
from shell import log, redact_secrets, run_cmd

if TYPE_CHECKING:
    from collections.abc import Callable

    from models import AgentInvocationLedger, AgentResult, RepoSetup, TaskConfig

# Default verification commands. A repo that uses mise gets these for free; a
# non-mise repo sets ``pipeline.buildCommand`` / ``lintCommand`` in its
# blueprint (threaded to the agent as build_command / lint_command) so gating
# runs the repo's real command.
DEFAULT_BUILD_COMMAND = "mise run build"
DEFAULT_LINT_COMMAND = "mise run lint"

# Wall-clock ceiling for a single build/lint verification subprocess. The old
# hardcoded 600s (run_cmd's default) was too low for a real CI-parity build
# (install + compile + full test suite + synth) — a heavy repo's legitimate
# build exceeded it and was reported as a build FAILURE, which is the wrong
# diagnosis (the build didn't fail, it didn't finish in time). Raised to 30min
# and made env-overridable; well under the orchestrator's 9h durable ceiling.
# When the ceiling IS hit we now surface a distinct "timed out" reason (see
# VerifyOutcome.timed_out → pipeline error_message → platform failure copy)
# rather than a generic "build failed".
BUILD_VERIFY_TIMEOUT_S = int(os.environ.get("BUILD_VERIFY_TIMEOUT_S") or 1800)


@dataclass
class VerifyOutcome:
    """Result of a build/lint verification run.

    ``passed`` drives gating exactly as the old bare-bool return did. The two
    other flags distinguish WHY a not-passed result happened, so the platform
    can report an honest, actionable reason instead of a blanket "build failed":

    - ``timed_out`` — the command exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was
      killed (a build that never finished, not a build that failed).
    - ``inert`` — the command could not RUN at all: exit 127 (command not
      found, e.g. ``yarn`` missing) or mise "no such task". This is a CONFIG
      problem (the gate isn't actually verifying anything), NOT the agent's
      code being broken. Without this, an inert exit-127 gate was silently
      reported as ``build_passed=False`` — a false "your code is broken" for a
      repo we never managed to build. ``is_verify_command_inert`` already
      existed but was only consulted at repo SETUP; now the post-agent gate
      consults it too.

    - ``infra_failed`` — the command was KILLED by an environment fault (the
      build box ran out of disk/ENOSPC or memory/OOM), so the build could not
      complete on this host. Like ``inert`` this is NOT the agent's code being
      broken — it's an infrastructure fault that a retry (fresh host) or more
      capacity clears. This was a real failure mode: concurrent builds filled
      the Fargate root fs → ENOSPC mid-build → bogus ``build_passed=False``.

    A timeout / inert / infra_failed result still counts as not-passed for
    gating, but the pipeline surfaces each as its own reason.
    """

    passed: bool
    timed_out: bool = False
    inert: bool = False
    infra_failed: bool = False


# POSIX shell exit code for "command not found" — an inert build signal (the
# configured verify command isn't installed), not a genuine build failure.
SHELL_COMMAND_NOT_FOUND = 127


def is_verify_command_inert(returncode: int, stderr: str) -> bool:
    """True when a verify command did not actually RUN (vs ran-and-failed).

    Distinguishes the inert-gate state — the build/lint command isn't
    runnable in this repo, so gating is effectively OFF — from a genuine red
    build (command executed, exited non-zero), which IS meaningful signal.

    Heuristics (conservative — only the unambiguous "couldn't run" signals):
      - exit 127: shell "command not found" (e.g. ``gradle`` not installed).
      - mise "no tasks defined" / "no task named" / "not found": the configured
        (or default ``mise run build``) task does not exist in the repo.
    A repo that genuinely fails its build returns some other non-zero code with
    real compiler/test output, which this does NOT flag.
    """
    if returncode == SHELL_COMMAND_NOT_FOUND:
        return True
    s = (stderr or "").lower()
    return (
        "no tasks defined" in s
        or "no task named" in s
        or ("mise" in s and "not found" in s)
        or "command not found" in s
    )


# Exit code for a process killed by SIGKILL (128 + 9) — how the OOM-killer and
# some disk-full kills surface. Paired with the ENOSPC/OOM stderr signatures.
SIGKILL_EXIT = 137


def is_infra_failure(returncode: int, stderr: str) -> bool:
    """True when a verify command was killed by an ENVIRONMENT fault, not a real
    build failure — the build box ran out of disk or memory.

    Distinct from :func:`is_verify_command_inert` (the command isn't runnable —
    a CONFIG problem) and from a genuine red build (command ran, tests failed).
    An out-of-disk / OOM kill means the build *couldn't complete on this host*,
    so reporting ``build_passed=False`` is a false "your code is broken" — it's
    an infrastructure fault a retry (on a fresh host) or more capacity clears.
    This was a real failure mode: concurrent builds filled the Fargate root fs →
    ``ENOSPC: no space left on device`` mid-build → bogus build-fail.

    A bare SIGKILL (137) with no accompanying signature is ALSO treated as infra:
    the container-runtime / cgroup OOM-killer delivers SIGKILL and writes its
    "Killed process …" line to the KERNEL log, not the build process's own stderr,
    so an OOM'd `mise run build` frequently exits 137 with NO "killed"/"out of
    memory" string captured (observed: a post-agent build OOM at 137 fell through
    to the inert heuristic and was mislabeled "command not found"; a 137 with
    plain build output would fall through to a GENUINE build FAILURE → a false
    gate on healthy code). SIGKILL is never something a healthy
    `mise run build` does to itself — a real test failure exits with the runner's
    own non-zero code (1/2), not 137. So 137 ⇒ resource kill ⇒ infra, and this is
    checked BEFORE the inert/genuine-failure paths in ``_run_verify``.
    """
    s = (stderr or "").lower()
    disk_full = "no space left on device" in s or "enospc" in s or "errno 28" in s
    oom = "out of memory" in s or "oomkilled" in s or "cannot allocate memory" in s
    # A SIGKILL (137) is a resource/OOM kill by the runtime, not a build result —
    # infra regardless of what (if anything) reached the captured stderr.
    return disk_full or oom or returncode == SIGKILL_EXIT


# Shell metacharacters that mean the command can't be a single argv exec and
# must run through a shell to behave as written. Without this, a configured
# ``npm ci && npm run lint && npm test`` was shlex-split into one ``npm`` call
# with ``&&``/``npm``/… as bogus args — ``npm ci`` ran, ignored the rest, exited
# 0, and the chain's lint/test NEVER ran, so a broken build reported "OK".
_SHELL_OPERATORS = ("&&", "||", "|", ";", ">", "<", "$(", "`")

# A leading ``VAR=value`` env-assignment prefix (one or more) is shell syntax:
# ``MISE_EXPERIMENTAL=1 mise //cdk:eslint`` only sets the env when run through a
# shell. Exec'd directly (shlex-split), the FIRST token ``MISE_EXPERIMENTAL=1``
# is treated as the program name → ``FileNotFoundError``. Detect it so such a
# command is routed through ``bash -lc`` like the operator case. NAME must be a
# valid POSIX env identifier so a plain arg like ``a=b`` in a real program's
# args (unusual as a leading token, but be precise) is matched only when it truly
# leads. Without this, a configured ``lint_command`` of ``MISE_EXPERIMENTAL=1 mise
# //cdk:eslint`` crashed the whole task at exit 1 before the build ran.
_ENV_ASSIGN_PREFIX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def resolve_verify_argv(command: str | None, default: str) -> list[str]:
    """Resolve a configured verify command into an argv for :func:`run_cmd`.

    Empty/whitespace/None ``command`` → the default (mise). A plain command with
    args (``npm run build``) is ``shlex``-split and exec'd directly. A command
    that needs a shell to behave as written — it contains shell operators (``&&``,
    ``|``, ``;``, redirects, command substitution) OR begins with a ``VAR=value``
    env-assignment prefix — is wrapped as ``bash -lc '<command>'``; otherwise the
    operators/assignment are passed as literal args to (or AS) the first program
    and mis-run (chained build commands would silently no-op; an env-prefixed
    lint command would exec ``VAR=value`` as the binary and crash).
    """
    cmd = (command or "").strip() or default
    needs_shell = any(op in cmd for op in _SHELL_OPERATORS) or bool(_ENV_ASSIGN_PREFIX.match(cmd))
    if needs_shell:
        return ["bash", "-lc", cmd]
    return shlex.split(cmd)


def _run_verify(repo_dir: str, command: str, default: str, label: str) -> VerifyOutcome:
    """Run a configured verify command and classify the outcome.

    Returns a :class:`VerifyOutcome` so callers can distinguish a TIMEOUT (the
    command exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was killed — the build did
    not *fail*, it did not *finish*) from a genuine non-zero exit. Both are
    not-passed for gating, but the pipeline surfaces them as different reasons.
    """
    argv = resolve_verify_argv(command, default)
    log("POST", f"Running post-agent {label} ({' '.join(argv)})...")
    try:
        result = run_cmd(
            argv,
            label=label,
            cwd=repo_dir,
            check=False,
            timeout=BUILD_VERIFY_TIMEOUT_S,
            # Stream the build/lint output live → full log reaches CloudWatch
            # verbatim (a buffered summary would hide which sub-task failed).
            stream=True,
        )
    except subprocess.TimeoutExpired:
        log(
            "WARN",
            f"Post-agent {label} TIMED OUT after {BUILD_VERIFY_TIMEOUT_S}s "
            "— reporting as timed out (not a build failure)",
        )
        return VerifyOutcome(passed=False, timed_out=True)
    if result.returncode != 0:
        stderr = getattr(result, "stderr", "") or ""
        # An ENVIRONMENT fault (out of disk / OOM) means the build couldn't
        # complete on this host — NOT that the code is broken. Check this BEFORE
        # the inert/genuine-failure paths: it's the most specific signal, and a
        # disk-full mid-build otherwise looks like a random non-zero exit and gets
        # mis-reported as "build/tests failed" (concurrent builds filling the
        # Fargate root fs → ENOSPC → bogus build-fail). Surface as infra so the
        # platform reports "retry / needs more capacity", not the agent's code.
        if is_infra_failure(result.returncode, stderr):
            log(
                "WARN",
                f"Post-agent {label} was KILLED by an environment fault (exit "
                f"{result.returncode}: out of disk/memory) — infrastructure issue, "
                "not a build failure",
            )
            return VerifyOutcome(passed=False, infra_failed=True)
        # Distinguish "couldn't RUN" (exit 127 / no-such-task → the gate is
        # inert, a config problem) from "ran and failed" (real red build). An
        # inert gate verified nothing, so reporting it as a build FAILURE is a
        # false "your code is broken" — surface it as inert instead.
        if is_verify_command_inert(result.returncode, stderr):
            log(
                "WARN",
                f"Post-agent {label} could not RUN (exit {result.returncode}) "
                "— gate is INERT (command not found / no such task), not a build failure",
            )
            return VerifyOutcome(passed=False, inert=True)
        log("POST", f"Post-agent {label} FAILED (exit {result.returncode})")
        return VerifyOutcome(passed=False)
    log("POST", f"Post-agent {label}: OK")
    return VerifyOutcome(passed=True)


def verify_build(repo_dir: str, command: str = "") -> VerifyOutcome:
    """Run the configured build command (default ``mise run build``) to verify the build.

    Returns a :class:`VerifyOutcome` (``.passed`` for gating, ``.timed_out`` to
    distinguish "exceeded the time limit" from "ran and failed").
    """
    return _run_verify(repo_dir, command, DEFAULT_BUILD_COMMAND, "verify-build-post")


def verify_lint(repo_dir: str, command: str = "") -> VerifyOutcome:
    """Run the configured lint command (default ``mise run lint``) to verify lint passes."""
    return _run_verify(repo_dir, command, DEFAULT_LINT_COMMAND, "verify-lint-post")


def ensure_committed(repo_dir: str) -> bool:
    """Safety net: commit any uncommitted tracked changes before finalization.

    This catches work the agent wrote but forgot to commit (e.g. due to turn
    limit or timeout). Only stages tracked-but-modified files (git add -u) to
    avoid accidentally committing temp files or build artifacts.

    Returns True if a safety-net commit was created, False if nothing to commit
    or if git operations fail.
    """
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "git status timed out in safety-net commit")
        return False

    if result.returncode != 0:
        stderr = result.stderr.strip()[:200] if result.stderr else ""
        log("WARN", f"git status failed (exit {result.returncode}): {stderr}")
        return False
    if not result.stdout.strip():
        return False

    log("POST", "Uncommitted changes detected — creating safety-net commit")
    # Stage tracked-but-modified files only (not untracked files)
    try:
        add_result = subprocess.run(
            ["git", "add", "-u"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "git add -u timed out in safety-net commit")
        return False

    if add_result.returncode != 0:
        stderr = add_result.stderr.strip()[:200] if add_result.stderr else ""
        log("WARN", f"git add -u failed (exit {add_result.returncode}): {stderr}")
        return False

    # #100: a tracked file the runtime merged into (.mcp.json) is task
    # configuration, not the agent's work.
    unstage_runtime_written(repo_dir)

    # Check if there's anything staged after add -u
    staged = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo_dir,
        capture_output=True,
        timeout=30,
    )
    if staged.returncode == 0:
        # Nothing staged (changes were only untracked files) — skip
        log("POST", "No tracked file changes to commit")
        return False

    commit_result = subprocess.run(
        ["git", "commit", "-m", "chore(agent): save uncommitted work from session end"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if commit_result.returncode == 0:
        log("POST", "Safety-net commit created")
        return True
    log("POST", f"Safety-net commit failed: {commit_result.stderr.strip()[:200]}")
    return False


def _current_branch(repo_dir: str) -> str | None:
    """Return the checked-out branch name, or None if detached / git fails."""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_dir,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    name = res.stdout.strip()
    # "HEAD" is git's sentinel for a detached HEAD — not a branch name.
    return name or None if name != "HEAD" else None


def reconcile_agent_branch(repo_dir: str, branch: str) -> bool:
    """Make delivery tolerant of the agent switching off the platform-provided
    branch.

    The platform checks out ``branch`` (``config.branch_name``, e.g.
    ``bgagent/<task_id>/<slug>``) BEFORE the agent runs, and every delivery git op
    (ensure_committed / ensure_pr's commit-diff / ensure_pushed) is keyed to it.
    But the agent doesn't always stay there: it sometimes ran
    ``git checkout -b <its-own-short-branch>``, committed + opened its own PR
    there, and left the platform branch empty. ensure_pr then saw no commits on
    ``branch`` → skipped → the task looked delivered-nothing, and for a stacked
    child the successor had no branch to stack on. It is NON-deterministic (the
    same task succeeds on a retry when the agent happens to stay put), so a
    prompt tweak alone can't be relied on.

    This reconciles deterministically: if HEAD is on a DIFFERENT branch than the
    platform ``branch`` and that HEAD carries commits, fast-forward the platform
    branch to the agent's HEAD (``git branch -f`` + checkout) so all downstream
    delivery runs against the branch the platform tracks. The agent's commits are
    preserved verbatim — we only re-point the platform branch label at them.

    Returns True if it moved the platform branch, False otherwise (already on it,
    detached HEAD with no branch to adopt, or a git failure — all handled by the
    existing ensure_committed/ensure_pr/delivery-gate chain). Best-effort: never
    raises, so a reconcile failure degrades to the pre-existing behavior."""
    head_branch = _current_branch(repo_dir)
    if head_branch is None or head_branch == branch:
        # On the platform branch already (the common, healthy case) or detached
        # with nothing to adopt — nothing to reconcile.
        return False
    log(
        "POST",
        f"Agent left the platform branch: HEAD is on '{head_branch}', expected "
        f"'{branch}'. Reconciling the platform branch to the agent's commits so "
        "the work is delivered on the tracked branch.",
    )
    try:
        # Re-point the platform branch at the agent's HEAD (force: the platform
        # branch was created empty at setup, so this only ever fast-forwards it
        # to the work the agent actually did). Then check it out so ensure_committed
        # / ensure_pr / ensure_pushed all operate on the tracked branch.
        force_res = run_cmd(
            ["git", "branch", "-f", branch, "HEAD"],
            label="reconcile-branch-force",
            cwd=repo_dir,
            check=False,
        )
        if force_res.returncode != 0:
            stderr = (force_res.stderr or "").strip()[:200]
            log("WARN", f"reconcile: git branch -f failed (exit {force_res.returncode}): {stderr}")
            return False
        checkout_res = run_cmd(
            ["git", "checkout", branch],
            label="reconcile-branch-checkout",
            cwd=repo_dir,
            check=False,
        )
        if checkout_res.returncode != 0:
            stderr = (checkout_res.stderr or "").strip()[:200]
            log(
                "WARN",
                f"reconcile: checkout '{branch}' failed (exit {checkout_res.returncode}): {stderr}",
            )
            return False
    except (OSError, subprocess.SubprocessError) as e:
        log("WARN", f"reconcile: git op raised {type(e).__name__}: {e}")
        return False
    log("POST", f"Reconciled: platform branch '{branch}' now points at the agent's work")
    return True


def ensure_pushed(repo_dir: str, branch: str) -> bool:
    """Push the branch if there are unpushed commits."""
    result = subprocess.run(
        ["git", "log", f"origin/{branch}..HEAD", "--oneline"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # If the remote branch doesn't exist or there are unpushed commits
    if result.returncode != 0 or result.stdout.strip():
        log("POST", "Pushing unpushed commits...")
        push_result = run_cmd(
            ["git", "push", "-u", "origin", branch],
            label="push",
            cwd=repo_dir,
            check=False,
        )
        return push_result.returncode == 0
    return True


_UNPUSHED_COMMITS_NOTE = (
    "⚠️ **bgagent could not push its follow-up commits to this branch.** "
    "The `git push` during the `push_resolve` step failed, so the latest "
    "agent changes are committed locally but are NOT reflected in this PR. "
    "A maintainer may need to re-run the task or push manually."
)


def _note_unpushed_commits(repo_dir: str, branch: str, config: TaskConfig) -> None:
    """Post a PR comment warning that follow-up commits failed to push.

    Best-effort surface for the ``push_resolve`` push-failure path: the PR URL
    is still returned (the PR exists) but it no longer reflects the agent's
    latest work, so the reviewer must be told. Failure to post the comment is
    logged but not fatal — the WARN log line emitted by the caller is the
    fallback signal.

    ``check=False`` means ``run_cmd`` does NOT raise on a non-zero ``gh``
    exit, so the returncode is inspected explicitly — otherwise a failed
    ``gh pr comment`` (missing scope, rate limit, not-a-PR) is a silent
    no-op and the reviewer never learns the PR is stale. The ``except``
    below only covers OS-level failures (gh missing, timeout).
    """
    try:
        result = run_cmd(
            [
                "gh",
                "pr",
                "comment",
                branch,
                "--repo",
                config.repo_url,
                "--body",
                _UNPUSHED_COMMITS_NOTE,
            ],
            label="note-unpushed-commits",
            cwd=repo_dir,
            check=False,
        )
        if result.returncode != 0:
            stderr_msg = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
            log(
                "WARN",
                "Failed to post un-pushed-commits note "
                f"(gh exit {result.returncode}): {stderr_msg} — the PR does not "
                "reflect the agent's latest commits and the reviewer has NOT "
                "been notified.",
            )
    except Exception as e:
        log("WARN", f"Failed to post un-pushed-commits note: {type(e).__name__}: {e}")


def _reconcile_pr_base(repo_dir: str, branch: str, config: TaskConfig, expected_base: str) -> None:
    """Deterministically retarget an existing PR onto ``expected_base``.

    The PR is created by the AGENT (its own ``gh pr create`` in the prompt
    workflow), so the ``--base`` it chose is a model judgment call, not the
    orchestrator's. Observed on a stacked-chain stress test: a stacked child
    that branched off its predecessor's branch STILL opened its PR against
    ``main`` — the agent reasoned "this was based off the predecessor branch,
    let me open the PR against main" — and even a root whose
    ``detect_default_branch`` correctly returned a non-``main`` default was
    pointed at ``main``. Wrong base ⇒ the PR shows the whole default-branch
    divergence (100s of files) instead of the child's real delta, and a stacked
    child's PR merges onto the wrong branch.

    ``expected_base`` is ``setup.default_branch`` — which is the orchestrator's
    ``base_branch`` for a stacked child (the predecessor's branch, or ``main``
    for a diamond) and ``detect_default_branch`` for a root. This post-hook
    reads the PR's current base and, if it disagrees, retargets it via
    ``gh pr edit --base`` — removing the agent's discretion without forbidding
    it from opening the PR (which keeps the agent-authored title/body).

    Best-effort: any failure is logged, never fatal — a mis-based PR is a
    presentation/merge-target defect, not a reason to fail the whole task.
    """
    try:
        view = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "baseRefName",
                "-q",
                ".baseRefName",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"Could not read PR base to reconcile ({type(exc).__name__}) — leaving as-is")
        return
    if view.returncode != 0 or not view.stdout.strip():
        # No PR / unreadable base — nothing to reconcile (creation path handles
        # the no-PR case; a transient read error just leaves the base as-is).
        return
    current_base = view.stdout.strip()
    if current_base == expected_base:
        return
    log(
        "POST",
        f"Retargeting PR base '{current_base}' → '{expected_base}' "
        f"(deterministic; agent chose the wrong base)",
    )
    result = run_cmd(
        ["gh", "pr", "edit", branch, "--repo", config.repo_url, "--base", expected_base],
        label="reconcile-pr-base",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        stderr_msg = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
        log(
            "WARN",
            f"Failed to retarget PR base to '{expected_base}' (gh exit {result.returncode}): "
            f"{stderr_msg} — PR remains based on '{current_base}'",
        )


def _cost_line(agent_result: AgentResult | None, ledger: AgentInvocationLedger | None) -> str:
    """The PR body's cost line: a per-stage breakdown once a reviewer ran (Task 4)."""
    if ledger is not None:
        stage_costs = ledger.stage_costs()
        total = ledger.total_cost_usd
        if total is None:
            return ""
        if len(stage_costs) > 1:
            breakdown = ", ".join(f"{stage}: ${cost:.4f}" for stage, cost in stage_costs.items())
            return f"- Agent cost: **${total:.4f}** ({breakdown})\n"
        return f"- Agent cost: **${total:.4f}**\n"
    if agent_result and agent_result.cost_usd is not None:
        return f"- Agent cost: **${agent_result.cost_usd:.4f}**\n"
    return ""


def _probe_name(probe: dict) -> str:
    """A probe's key (``<package_dir>/<filename>``, or the bare filename)."""
    filename = probe.get("filename") or ""
    return f"{probe['package_dir']}/{filename}" if probe.get("package_dir") else filename


def _probe_waiver_reason(result: dict, invalid_probes: dict) -> str | None:
    """Call 2's waiver of this probe, by key or bare filename (#97)."""
    probe = result.get("probe") or {}
    return invalid_probes.get(_probe_name(probe)) or invalid_probes.get(probe.get("filename"))


def _is_failed(result: dict) -> bool:
    return result.get("runnable", True) is not False and not result.get("passed")


def waived_probe_counts(round_outcome: dict) -> tuple[int, int]:
    """``(waived, failed)``: failing probes Call 2 marked invalid, and all failing ones."""
    invalid = round_outcome.get("invalid_probes") or {}
    failed = [r for r in round_outcome.get("probe_results") or [] if _is_failed(r)]
    waived = sum(1 for r in failed if _probe_waiver_reason(r, invalid))
    return waived, len(failed)


def _render_round_probes_and_findings(round_outcome: dict) -> list[str]:
    """The probes/committed/findings/parse_error lines shared by a single
    advisory round and a single round inside the adversarial table."""
    lines: list[str] = []
    probe_results = round_outcome.get("probe_results") or []
    if probe_results:
        lines.append(
            "**Probes** (written from the issue alone, before the probe writer "
            "ever saw this diff):\n"
        )
        not_runnable = 0
        invalid = round_outcome.get("invalid_probes") or {}
        for r in probe_results:
            probe = r.get("probe", {})
            name = _probe_name(probe)
            if r.get("runnable", True) is False:
                # #69: written but never run — neither a pass nor a fail.
                not_runnable += 1
                lines.append(
                    f"- ⚠️ NOT RUNNABLE `{name}` — {probe.get('intent')} "
                    f"_({(r.get('output') or '').strip()})_"
                )
                continue
            mark = "✅ PASS" if r.get("passed") else "❌ FAIL"
            waiver = None if r.get("passed") else _probe_waiver_reason(r, invalid)
            if waiver:
                # #97: say on the line itself that the failure was waived.
                mark = f"❌ FAIL (marked invalid: {waiver})"
            lines.append(f"- {mark} `{name}` — {probe.get('intent')}")
        if not_runnable:
            lines.append(
                f"\n{not_runnable} probe(s) were written but could not be run, so they "
                "say nothing about this change."
            )
        lines.append("")

    committed = round_outcome.get("committed_probe_paths") or []
    if committed:
        places = sorted({p.rsplit("/", 1)[0] + "/" for p in committed})
        lines.append(
            f"{len(committed)} passing probe(s) committed to "
            f"{', '.join(f'`{d}`' for d in places)} in a separate commit.\n"
        )

    # Task 5 amendment 1 (ADR-026 (fork)): the fixer tried to edit/delete a
    # protected probe between the previous round and this one; reverted.
    reverted = round_outcome.get("reverted_probe_paths") or []
    if reverted:
        touched = ", ".join(f"`{p}`" for p in reverted)
        lines.append(
            f"⚠️ The fixer touched protected probes — reverted before this review: {touched}\n"
        )

    findings = round_outcome.get("findings") or []
    if findings:
        lines.append("**Findings:**\n")
        for f in findings:
            severity = f" ({f['severity']})" if f.get("severity") else ""
            lines.append(
                f"- **{f['type']}{severity}:** {f['title']} — {f['description']} "
                f"_(evidence: {f['evidence']})_"
            )
        lines.append("")
    parse_error = round_outcome.get("parse_error")
    if parse_error and parse_error.startswith("READY refused"):
        # #97: the reviewer wrote READY over a failing probe it did not waive.
        lines.append(f"⚠️ {parse_error}\n")
    elif parse_error:
        lines.append(f"_Review output could not be parsed: {parse_error}_\n")

    # Task 5 amendment 2: a probe Call 2 marked invalid (tests behavior the
    # issue never asked for) — recorded, not silently dropped.
    invalid_probes = round_outcome.get("invalid_probes") or {}
    if invalid_probes:
        lines.append("**Probes the reviewer marked invalid:**\n")
        for filename, reason in invalid_probes.items():
            lines.append(f"- `{filename}`: {reason}")
        lines.append("")

    return lines


def _review_section(review_outcome: dict | None) -> str:
    """The PR body's independent-review section (Task 4 — ADR-025 (fork);
    the adversarial table is Task 5 — ADR-026 (fork)).

    ``review_outcome`` is ``review.backend.ReviewAndFixResult.model_dump()``;
    empty/absent (every workflow but ``coding/new-task-verified-v1``, or a
    round that was skipped — budget exhausted, ``review_mode: none``) means
    no section at all, not an empty placeholder.
    """
    if not review_outcome or not review_outcome.get("ran"):
        return ""

    rounds = review_outcome.get("rounds") or []
    if review_outcome.get("mode") == "adversarial" and rounds:
        lines = ["## Independent review (adversarial)\n"]
        for round_outcome in rounds:
            lines.append(
                f"### Round {round_outcome.get('round_number')} — {round_outcome.get('verdict')}\n"
            )
            reviewed_sha = round_outcome.get("reviewed_sha") or ""
            if reviewed_sha:
                lines.append(f"Reviewed commit: `{reviewed_sha[:12]}`\n")
            if round_outcome.get("stale_sha"):
                lines.append(
                    "⚠️ Verdict refused — the reviewed commit no longer matched the "
                    "code by the time the review finished.\n"
                )
            lines.extend(_render_round_probes_and_findings(round_outcome))
        if review_outcome.get("unresolved"):
            lines.append(
                f"**Unresolved** after {len(rounds)} round(s) "
                f"(stopped: {review_outcome.get('stopped_reason')}) — "
                f"on_unresolved: `{review_outcome.get('on_unresolved')}`.\n"
            )
        return "\n".join(lines) + "\n"

    verdict = review_outcome.get("verdict")
    lines = ["## Independent review (advisory)\n", f"**Verdict:** {verdict}\n"]
    reviewed_sha = review_outcome.get("reviewed_sha") or ""
    if reviewed_sha:
        lines.append(f"Reviewed commit: `{reviewed_sha[:12]}`\n")
    lines.extend(_render_round_probes_and_findings(review_outcome))
    return "\n".join(lines) + "\n"


def _final_review_round(review_outcome: dict | None) -> dict | None:
    """The dict holding the gating ``verdict``/``reviewed_sha`` — the LAST
    round for adversarial mode (Task 5), the outcome itself for advisory
    (Task 4).

    Returns ``None`` when no review ran at all (every workflow but
    ``coding/new-task-verified-v1``/``-adversarial-v1``, or a round skipped
    outright — budget exhausted, ``review_mode: none``), matching
    ``_review_section``'s own "no section" rule.
    """
    if not review_outcome or not review_outcome.get("ran"):
        return None
    rounds = review_outcome.get("rounds") or []
    if review_outcome.get("mode") == "adversarial" and rounds:
        return rounds[-1]
    return review_outcome


def post_review_status(repo_dir: str, repo_url: str, review_outcome: dict | None) -> None:
    """Post the ``factory/review`` commit status (Task 17 (fork) / ADR-028).

    Targets the branch's CURRENT ``HEAD`` — read here, after the probes
    commit (Task 4) and any fixer-round commits (Task 5) have already
    landed and been pushed by the caller — never the SHA Call 2 originally
    reviewed, which may already be behind it. This is what lets the Task 17
    watchdog key off a single, final status per PR rather than a status per
    round. The description separately names the SHA Call 2 actually
    reviewed, which can differ from this status's own target commit.

    Best-effort and non-fatal, same as the other PR-body cosmetic steps in
    this module: a failure here must not lose the PR itself.
    """
    final_round = _final_review_round(review_outcome)
    if final_round is None:
        return
    verdict = final_round.get("verdict")
    if verdict is None:
        return
    sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if sha_result.returncode != 0 or not sha_result.stdout.strip():
        log("WARN", "could not resolve HEAD sha to post factory/review status")
        return
    sha = sha_result.stdout.strip()
    state = "success" if verdict == "READY" else "failure"
    reviewed_sha = (final_round.get("reviewed_sha") or sha)[:12]
    waived, failed = waived_probe_counts(final_round)
    # #97: a READY over waived probes says so, rather than reading as a clean pass.
    waived_note = f" — {waived}/{failed} failing probes marked invalid" if waived else ""
    # GitHub's Statuses API caps `description` at 140 characters.
    description = f"{verdict}{waived_note} (reviewed {reviewed_sha})"[:140]
    result = run_cmd(
        [
            "gh",
            "api",
            f"repos/{repo_url}/statuses/{sha}",
            "-f",
            f"state={state}",
            "-f",
            "context=factory/review",
            "-f",
            f"description={description}",
        ],
        label="post-review-status",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        error = " ".join((result.stderr or "").split()) or "(no stderr)"
        _report(
            "gh_write_failed",
            f"post factory/review on {sha[:12]} (rc={result.returncode}): {redact_secrets(error)}",
        )


#: Task 5 (ADR-026 (fork)): the adversarial loop shipped a PR still NOT_READY.
UNRESOLVED_LABEL = "review:unresolved"
#: #82 PR 3a: the agent called ``flag_concern``; factory-shop's auto-merge
#: watchdog never merges a PR carrying this label.
NEEDS_HUMAN_LABEL = "needs-human"
#: The PR-body heading the ``flag_concern`` reasons go under.
NEEDS_HUMAN_HEADING = "## ⚠️ Needs a human"
#: #89: a story PR of an orchestration that has an integration node. Only the
#: integration PR, which merges every story branch, is meant to reach the
#: default branch; factory-shop's watchdog never merges a PR carrying this.
FACTORY_STACKED_LABEL = "factory-stacked"
#: The ``channel_metadata`` flag the platform sets on such a story's task.
ORCHESTRATION_STACKED_KEY = "orchestration_stacked"


#: #99: where post-hook events go (``(milestone, details)``). The pipeline
#: points it at the task's progress writer; ``None`` (tests, local runs) logs only.
_event_sink: Callable[[str, str], None] | None = None
#: #99: the wait before the one retry of a ``gh`` write that got a 5xx.
GH_RETRY_DELAY_S = 5.0
#: A 5xx from GitHub, as ``gh`` prints it ("HTTP 502: Bad Gateway", or the
#: proxy's bare "502 Bad Gateway").
_SERVER_ERROR_RE = re.compile(
    r"\bHTTP 5\d\d\b"
    r"|\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b",
    re.IGNORECASE,
)


def set_event_sink(sink: Callable[[str, str], None] | None) -> None:
    """Route post-hook events (#99: ``gh_write_failed``, ``pr_held``) to ``sink``."""
    global _event_sink
    _event_sink = sink


def _report(milestone: str, details: str) -> None:
    """Write a post-hook event: always logged, and sent to the sink when one is set."""
    log("WARN" if milestone == "gh_write_failed" else "POST", f"{milestone}: {details}")
    if _event_sink is None:
        return
    try:
        _event_sink(milestone, details)
    except Exception as exc:  # an event must never fail the post-hooks
        log("WARN", f"could not write the {milestone} event: {type(exc).__name__}")


def _is_server_error(stderr: str | None) -> bool:
    return bool(stderr) and bool(_SERVER_ERROR_RE.search(stderr or ""))


def _gh_write(cmd: list[str], label: str, repo_dir: str, what: str) -> subprocess.CompletedProcess:
    """Run a ``gh`` write; retry it once after :data:`GH_RETRY_DELAY_S` on a 5xx (#99).

    A 4xx (or any other failure) is not retried. A write that still fails is
    reported as a ``gh_write_failed`` event naming ``what`` and the error
    text, tokens redacted.
    """
    result = run_cmd(cmd, label=label, cwd=repo_dir, check=False)
    if result.returncode != 0 and _is_server_error(result.stderr):
        log("WARN", f"{what} got a server error; retrying once in {GH_RETRY_DELAY_S:g}s")
        time.sleep(GH_RETRY_DELAY_S)
        result = run_cmd(cmd, label=label, cwd=repo_dir, check=False)
    if result.returncode != 0:
        error = " ".join((result.stderr or "").split()) or "(no stderr)"
        _report("gh_write_failed", f"{what} (rc={result.returncode}): {redact_secrets(error)}")
    return result


def apply_unresolved_label(
    repo_dir: str, repo_url: str, pr_url: str, label: str = UNRESOLVED_LABEL
) -> bool:
    """Add ``label`` to the PR (default ``review:unresolved``, Task 5 — ADR-026 (fork)).

    ``on_unresolved: pr_with_warning`` (the default) still ships the PR when
    the adversarial loop exhausts ``max_iterations`` still NOT_READY — this
    is the warning. #82 PR 3a reuses it for ``needs-human``. Best-effort and
    non-fatal, same as the other PR-body cosmetic steps: the PR itself must
    not be lost over a label. Returns whether the label was applied.
    """
    result = _gh_write(
        ["gh", "pr", "edit", pr_url, "--repo", repo_url, "--add-label", label],
        "apply-unresolved-label" if label == UNRESOLVED_LABEL else "apply-label",
        repo_dir,
        f"add label {label} to {pr_url}",
    )
    if result.returncode != 0:
        log(
            "WARN",
            f"failed to add {label} label to {pr_url} (non-fatal, rc="
            f"{result.returncode}): {result.stderr.strip() if result.stderr else '(no stderr)'}",
        )
        return False
    return True


def needs_human_section(reason: str) -> str:
    """The PR-body section for the ``flag_concern`` reason(s), one bullet each."""
    lines = [line.strip() for line in reason.splitlines() if line.strip()]
    bullets = "\n".join(f"- {line}" for line in lines) or "- (no reason given)"
    return (
        f"{NEEDS_HUMAN_HEADING}\n\n"
        "The agent flagged this for a person to check before merge, so the PR is "
        f"labelled `{NEEDS_HUMAN_LABEL}` and won't be auto-merged. Remove the label "
        "once it's checked.\n\n"
        f"{bullets}"
    )


def flag_pr_for_human(repo_dir: str, repo_url: str, pr_url: str, reason: str) -> str:
    """Hold a PR for a person (#82 PR 3a): label it ``needs-human`` and say why.

    The label is the merge gate, so a failure to apply it is not left there:
    when ``gh pr edit --add-label`` fails (typically because the label does not
    exist in the repo yet), the label is created and applied again; if that
    fails too, the PR is converted to a draft, which cannot be merged either.
    The reason is then appended to the PR body under :data:`NEEDS_HUMAN_HEADING`.

    Returns how the PR is held: ``"labelled"``, ``"draft"`` or ``"unheld"``
    (every step failed; logged as an error).
    """
    held = _hold_pr_with_label(
        repo_dir,
        repo_url,
        pr_url,
        NEEDS_HUMAN_LABEL,
        color="B60205",
        description="Flagged by the factory agent: a person must check before merge",
    )
    _append_pr_appendix(repo_dir, repo_url, pr_url, needs_human_section(reason))
    return held


def _hold_pr_with_label(
    repo_dir: str, repo_url: str, pr_url: str, label: str, *, color: str, description: str
) -> str:
    """Apply a merge-gate ``label``, creating it if needed, else draft the PR.

    Returns ``"labelled"``, ``"draft"`` or ``"unheld"`` (every step failed;
    logged as an error).
    """
    held = _apply_or_draft(repo_dir, repo_url, pr_url, label, color=color, description=description)
    # #99: its own event, so a truncated flagged_for_human can't hide how the PR is held.
    _report("pr_held", f"{held} ({label}) {pr_url}")
    return held


def _apply_or_draft(
    repo_dir: str, repo_url: str, pr_url: str, label: str, *, color: str, description: str
) -> str:
    if apply_unresolved_label(repo_dir, repo_url, pr_url, label=label):
        return "labelled"
    _gh_write(
        [
            "gh",
            "label",
            "create",
            label,
            "--repo",
            repo_url,
            "--force",
            "--color",
            color,
            "--description",
            description,
        ],
        f"create-{label}-label",
        repo_dir,
        f"create label {label}",
    )
    if apply_unresolved_label(repo_dir, repo_url, pr_url, label=label):
        return "labelled"
    draft = _gh_write(
        ["gh", "pr", "ready", pr_url, "--repo", repo_url, "--undo"],
        "draft-flagged-pr",
        repo_dir,
        f"convert {pr_url} to a draft",
    )
    held = "draft" if draft.returncode == 0 else "unheld"
    log(
        "ERROR" if held == "unheld" else "WARN",
        f"could not label {pr_url} {label}; "
        + ("converted it to a draft instead" if held == "draft" else "it is NOT held"),
    )
    return held


def _gh_json(repo_dir: str, args: list[str], what: str) -> Any:
    """Run a read-only ``gh`` command and parse its JSON; ``None`` when unreadable."""
    try:
        result = subprocess.run(
            ["gh", *args], cwd=repo_dir, capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"could not read {what} ({type(exc).__name__}) — holding")
        # nosemgrep: py-silent-success-masking -- None means unreadable; every caller holds the PR
        return None
    if result.returncode != 0:
        stderr = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
        log("WARN", f"could not read {what} (rc={result.returncode}): {stderr} — holding")
        return None
    try:
        return json.loads(result.stdout or "null")
    except json.JSONDecodeError:
        log("WARN", f"could not parse {what} — holding")
        # nosemgrep: py-silent-success-masking -- None means unreadable; every caller holds the PR
        return None


def _label_names(pr: dict[str, Any]) -> set[str]:
    labels = pr.get("labels")
    return {lbl.get("name") for lbl in labels or [] if isinstance(lbl, dict)}


def _review_status(repo_dir: str, repo_url: str, sha: str) -> tuple[bool, dict[str, Any] | None]:
    """``(readable, status)``: the ``factory/review`` status on ``sha``, or
    ``None`` when the commit has none."""
    combined = _gh_json(
        repo_dir, ["api", f"repos/{repo_url}/commits/{sha}/status"], f"the review status of {sha}"
    )
    statuses = combined.get("statuses") if isinstance(combined, dict) else None
    if not isinstance(statuses, list):
        return False, None
    for status in statuses:
        if isinstance(status, dict) and status.get("context") == "factory/review":
            return True, status
    return True, None


def _not_ready_reason(
    repo_dir: str, repo_url: str, pr: dict[str, Any], *, review_ran: bool
) -> str | None:
    """Why ``pr``'s review blocks a PR built on it, or ``None`` (#97).

    Its review ended NOT_READY when it carries ``review:unresolved`` or the
    ``factory/review`` status on its head commit is anything but ``success``.
    Fails closed: an unreadable status holds, and so does a missing one when
    the dependent task itself ran a review (its predecessors ran one too).
    """
    number = pr["number"]
    if UNRESOLVED_LABEL in _label_names(pr):
        return (
            f"Inherited from #{number}: this PR builds on #{number}, whose independent "
            f"review ended NOT_READY (labelled `{UNRESOLVED_LABEL}`)."
        )
    sha = pr.get("headRefOid")
    readable, status = (
        _review_status(repo_dir, repo_url, sha) if isinstance(sha, str) and sha else (False, None)
    )
    if not readable:
        return (
            f"Could not read the independent review status of #{number}, which this PR "
            "builds on, so this PR is held as well."
        )
    if status is None:
        if not review_ran:
            return None
        return (
            f"Inherited from #{number}: this PR builds on #{number}, which has no "
            "`factory/review` status, so its review can't be confirmed."
        )
    if status.get("state") == "success":
        return None
    description = status.get("description") or status.get("state")
    return (
        f"Inherited from #{number}: this PR builds on #{number}, whose independent "
        f"review ended NOT_READY (`factory/review`: {description})."
    )


def _inherited_hold_reason(
    repo_dir: str, repo_url: str, branch: str, *, review_ran: bool = False
) -> str | None:
    """Why this PR must be held because of ``branch``'s PR, or ``None``.

    Held when that PR is labelled ``needs-human`` (any PR state counts; a
    predecessor's PR is normally still open), or (#97) when its review ended
    NOT_READY (:func:`_not_ready_reason`, newest PR only). Fails closed: when
    the PR list or a review status can't be read, the PR is held too, with
    the reason saying so.
    """
    prs = _gh_json(
        repo_dir,
        [
            "pr",
            "list",
            "--repo",
            repo_url,
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "number,labels,headRefOid",
        ],
        f"the PRs of {branch}",
    )
    if not isinstance(prs, list):
        return (
            f"Could not check whether the PR of `{branch}`, which this PR builds on, is "
            f"labelled `{NEEDS_HUMAN_LABEL}`, so this PR is held as well."
        )
    prs: list[dict[str, Any]] = [
        pr for pr in prs if isinstance(pr, dict) and isinstance(pr.get("number"), int)
    ]
    for pr in prs:
        if NEEDS_HUMAN_LABEL in _label_names(pr):
            number = pr["number"]
            return (
                f"Inherited from #{number}: this PR builds on #{number}, which is labelled "
                f"`{NEEDS_HUMAN_LABEL}`."
            )
    if not prs:
        if not review_ran:
            return None
        return (
            f"`{branch}`, which this PR builds on, has no PR, so its independent review "
            "can't be confirmed; this PR is held."
        )
    # `gh pr list` lists the newest first: that is the story's current PR.
    return _not_ready_reason(repo_dir, repo_url, prs[0], review_ran=review_ran)


def orchestration_predecessors(config: TaskConfig) -> list[str]:
    """The branches an orchestration child builds on (#89, #103).

    A diamond (the integration node included) merges ``merge_branches`` into a
    branch off the default; a linear child stacks on ``base_branch``. Never
    compared to ``setup.default_branch``: for a linear child that IS its
    predecessor's branch, and the comparison dropped it (#103).
    """
    if config.merge_branches:
        return list(dict.fromkeys(b for b in config.merge_branches if b))
    return [config.base_branch] if config.base_branch else []


def _shared_head_branch(repo_dir: str, branches: list[str]) -> str | None:
    """The predecessor branch whose head commit is this branch's ``HEAD``, or ``None`` (#103).

    A PR whose head is a predecessor's head carries that predecessor's
    ``factory/review`` status, so it can look reviewed before its own review.
    """
    head = _rev_parse(repo_dir, "HEAD")
    if not head:
        return None
    for branch in branches:
        if _rev_parse(repo_dir, f"origin/{branch}") == head:
            return branch
    return None


def _rev_parse(repo_dir: str, ref: str) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def hold_orchestration_pr(
    repo_dir: str,
    config: TaskConfig,
    pr_url: str,
    *,
    review_ran: bool = False,
) -> bool:
    """Gate an orchestration child's new PR before its review status is posted (#89).

    - A story of an orchestration with an integration node is labelled
      ``factory-stacked``: only the integration PR is meant to reach main.
    - A child whose ``HEAD`` is a predecessor's head commit (#103) is held
      ``needs-human`` and gets no ``factory/review`` of its own: the commit
      already carries the predecessor's status. Returns ``True`` then, so the
      caller skips the status.
    - A child built on a held predecessor inherits ``needs-human``: if the
      PR of its base branch, or of any predecessor branch merged into it, is
      labelled ``needs-human``, or (#97) its review ended NOT_READY, this PR
      is labelled ``needs-human`` too, with "inherited from #N" in its body.
      That covers the integration PR, and chains transitively. ``review_ran``
      says this task ran a review, so a predecessor without one is held.

    Runs before ``post_review_status`` so the watchdog never sees a green PR
    that is about to be held. No-op for a task that isn't an orchestration child.
    """
    meta = config.channel_metadata or {}
    if not meta.get("orchestration_id"):
        return False
    if meta.get(ORCHESTRATION_STACKED_KEY) == "true":
        held = _hold_pr_with_label(
            repo_dir,
            config.repo_url,
            pr_url,
            FACTORY_STACKED_LABEL,
            color="5319E7",
            description="A story PR of a factory build: it reaches main through the integration PR",
        )
        log("POST", f"Story PR of a multi-story build — {FACTORY_STACKED_LABEL}: {held}")
    predecessors = orchestration_predecessors(config)
    shared = _shared_head_branch(repo_dir, predecessors)
    if shared is not None:
        held = flag_pr_for_human(
            repo_dir,
            config.repo_url,
            pr_url,
            f"This PR's head commit is the head of `{shared}`, which it builds on, so it "
            "carries that branch's review status rather than its own; it is held.",
        )
        log("POST", f"PR head is the head of {shared} — PR held: {held}, no factory/review")
        return True
    for branch in predecessors:
        reason = _inherited_hold_reason(repo_dir, config.repo_url, branch, review_ran=review_ran)
        if reason is None:
            continue
        held = flag_pr_for_human(repo_dir, config.repo_url, pr_url, reason)
        log("POST", f"{NEEDS_HUMAN_LABEL} inherited through {branch} — PR held: {held}")
        return False
    return False


def _unverified_review_reason(review_outcome: dict) -> str:
    final_round = _final_review_round(review_outcome) or review_outcome
    waived, _failed = waived_probe_counts(final_round)
    return (
        "The independent review wrote READY, but every probe that failed "
        f"({waived}) was marked invalid and none passed, so no probe verified this "
        "change. Check the reviewer's reasons in the review section before merging."
    )


def hold_pr_before_status(
    repo_dir: str,
    config: TaskConfig,
    pr_url: str,
    review_outcome: dict | None,
    concern: str = "",
) -> bool:
    """Every hold that must be in place before ``factory/review`` is posted.

    - #82 PR 3a / #103: the agent's ``flag_concern`` reason holds the PR
      ``needs-human``.
    - #97: a READY with no independent verification (every failing probe
      waived, none passed) is held with ``needs-human``.
    - #89/#97/#103: an orchestration child inherits its predecessors' holds
      (:func:`hold_orchestration_pr`).

    Returns whether ``factory/review`` may be posted: ``False`` when the PR's
    head is a predecessor's head (#103), whose status it would overwrite.
    """
    if concern:
        held = flag_pr_for_human(repo_dir, config.repo_url, pr_url, concern)
        log("POST", f"flag_concern — PR held: {held}")
    if review_outcome and review_outcome.get("no_independent_verification"):
        held = flag_pr_for_human(
            repo_dir, config.repo_url, pr_url, _unverified_review_reason(review_outcome)
        )
        log("POST", f"READY with no independent verification — PR held: {held}")
    shared_head = hold_orchestration_pr(
        repo_dir,
        config,
        pr_url,
        review_ran=bool(review_outcome and review_outcome.get("ran")),
    )
    return not shared_head


def _append_pr_appendix(repo_dir: str, repo_url: str, pr_url: str, appendix: str) -> None:
    """Append the cost/review appendix to a PR the coder's own turn already created.

    The coder can (and often does) run its own ``git push`` + ``gh pr create``
    inside its Bash tool calls, finishing before ``review_and_fix`` even
    starts — so the "already exists" branch below never gets to compose the
    cost line / review section into the body the normal create path builds.
    This edits it in afterward; a failure here is non-fatal (advisory
    feature, logged and swallowed) since the PR itself already exists and
    must not be lost over a cosmetic body update.
    """
    try:
        current = subprocess.run(
            ["gh", "pr", "view", pr_url, "--repo", repo_url, "--json", "body", "-q", ".body"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if current.returncode != 0:
            error = " ".join((current.stderr or "").split()) or "(no stderr)"
            _report(
                "gh_write_failed",
                f"edit the body of {pr_url}: could not read it (rc={current.returncode}): "
                f"{redact_secrets(error)}",
            )
            return
        new_body = f"{current.stdout}\n\n{appendix}"
        _gh_write(
            ["gh", "pr", "edit", pr_url, "--repo", repo_url, "--body", new_body],
            "append-review-section",
            repo_dir,
            f"edit the body of {pr_url}",
        )
    except (subprocess.SubprocessError, OSError) as e:
        log(
            "WARN",
            f"failed to append review section to {pr_url} (non-fatal): {type(e).__name__}: {e}",
        )


def ensure_pr(
    config: TaskConfig,
    setup: RepoSetup,
    build_passed: bool,
    lint_passed: bool,
    agent_result: AgentResult | None = None,
    strategy: str = "create",
    ledger: AgentInvocationLedger | None = None,
    review_outcome: dict | None = None,
) -> str | None:
    """Realize the PR per the workflow's ``ensure_pr`` strategy.

    Strategy (provider-neutral, from the workflow step — replaces the former
    ``task_type`` self-inspection):

    - ``create``: create a new PR if one doesn't exist (the new_task path).
    - ``push_resolve``: push follow-up commits, then resolve the existing PR URL
      (the pr_iteration path).
    - ``resolve``: resolve the existing PR URL without pushing (read-only;
      the pr_review path).

    Returns the PR URL, or None if there are no commits beyond the default
    branch or PR creation failed. ``build_passed`` and ``lint_passed`` control
    the verification status shown in the PR body.

    ``ledger`` (Task 3) and ``review_outcome`` (Task 4 — ADR-025 (fork),
    ``review.backend.ReviewAndFixResult.model_dump()``) are both optional: a
    caller with neither (every workflow but ``coding/new-task-verified-v1``)
    gets the pre-Task-4 PR body unchanged. ``ledger`` present but
    ``review_outcome`` absent/empty still reports a single total cost line
    (the ledger's one coder call), not a per-stage breakdown.
    """
    repo_dir = setup.repo_dir
    branch = setup.branch
    default_branch = setup.default_branch
    # #103: the flag_concern hold lands with the others, before factory/review.
    concern = (agent_result.concern_reason or "").strip() if agent_result else ""

    # push_resolve / resolve: skip PR creation — just resolve the existing URL.
    if strategy in ("push_resolve", "resolve"):
        push_failed = False
        if strategy == "push_resolve":
            if not ensure_pushed(repo_dir, branch):
                # Surface the failure rather than silently returning the stale
                # PR URL as success: the local follow-up commits never reached
                # the remote, so the PR the caller resolves below does NOT
                # reflect the agent's latest work. We note this on the PR
                # itself (below) so the reviewer is not misled.
                push_failed = True
                log("WARN", "Failed to push commits before resolving PR URL")
        else:
            log("POST", "resolve strategy — skipping push (read-only)")
        log("POST", f"ensure_pr strategy={strategy} — returning existing PR URL")
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "url",
                "-q",
                ".url",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0 and result.stdout.strip():
            pr_url = result.stdout.strip()
            log("POST", f"Existing PR: {pr_url}")
            if push_failed:
                _note_unpushed_commits(repo_dir, branch, config)
            return pr_url
        stderr_msg = result.stderr.strip() if result.stderr else "(no stderr)"
        log("WARN", f"Could not resolve existing PR URL (rc={result.returncode}): {stderr_msg}")
        return None

    # Check if the agent already created a PR for this branch
    log("POST", "Checking for existing PR...")
    result = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            branch,
            "--repo",
            config.repo_url,
            "--json",
            "url",
            "-q",
            ".url",
        ],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode == 0 and result.stdout.strip():
        pr_url = result.stdout.strip()
        log("POST", f"PR already exists: {pr_url}")
        # The agent opened this PR and picked its own --base; correct it to the
        # orchestrator-supplied / detected base if it disagrees (stacked-child
        # + root wrong-base fix).
        _reconcile_pr_base(repo_dir, branch, config, default_branch)
        # The coder's own turn commonly pushes + creates this PR itself before
        # post-hooks run (the branch this reaches at all) — so a commit made
        # AFTER that by review_and_fix's probe-commit step is still only
        # local. Push it now, or it is silently dropped when the container
        # exits (Task 4 — ADR-025 (fork)).
        ensure_pushed(repo_dir, branch)
        # Mirrors the fresh-create path's cost_line + review_section: the
        # coder's own PR body never includes either (it has no ledger/review
        # outcome to draw from), so append them here instead of losing them.
        appendix = _cost_line(agent_result, ledger) + _review_section(review_outcome)
        if appendix.strip():
            _append_pr_appendix(repo_dir, config.repo_url, pr_url, appendix)
        if hold_pr_before_status(repo_dir, config, pr_url, review_outcome, concern):
            post_review_status(repo_dir, config.repo_url, review_outcome)
        return pr_url

    # Check if there are any commits on this branch beyond the default branch
    diff_result = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--oneline"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if diff_result.returncode != 0 or not diff_result.stdout.strip():
        log("POST", "No commits to create PR from — skipping PR creation")
        return None

    # Ensure all commits are pushed
    ensure_pushed(repo_dir, branch)

    # Collect commit messages for the PR body
    log_result = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--pretty=format:%s%n%b---"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    commits = log_result.stdout.strip() if log_result.returncode == 0 else ""

    # Derive PR title from first commit message
    first_commit = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--pretty=format:%s", "--reverse"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    pr_title = (
        first_commit.stdout.strip().split("\n")[0]
        if first_commit.stdout.strip()
        else f"chore: bgagent/{config.task_id}"
    )

    # Build PR body
    task_source = ""
    if config.issue_number:
        task_source = f"Resolves #{config.issue_number}\n\n"
    elif config.task_description:
        task_source = f"**Task:** {config.task_description}\n\n"

    build_status = "PASS" if build_passed else "FAIL"
    lint_status = "PASS" if lint_passed else "FAIL"
    # Show the actual commands run (default mise), not a hardcoded label.
    build_label = (config.build_command or DEFAULT_BUILD_COMMAND).strip()
    lint_label = (config.lint_command or DEFAULT_LINT_COMMAND).strip()

    cost_line = _cost_line(agent_result, ledger)

    # When build-regression gating is inert (no runnable build command, none
    # configured), say so plainly — otherwise a green "build: PASS" misleads:
    # nothing was actually verified.
    gate_warning = ""
    if getattr(setup, "build_gate_inert", False):
        gate_warning = (
            "> ⚠️ **Build-regression gating is OFF for this repo.** No runnable "
            f"`{DEFAULT_BUILD_COMMAND}` task was found and no build command is configured, "
            "so a change that breaks the build still reports success. To enable gating, set "
            "`pipeline.buildCommand` in this repo's ABCA blueprint (e.g. `npm run build`).\n\n"
        )

    review_section = _review_section(review_outcome)

    pr_body = (
        f"## Summary\n\n"
        f"{task_source}"
        f"### Commits\n\n"
        f"```\n{commits}\n```\n\n"
        f"## Verification\n\n"
        f"{gate_warning}"
        f"- `{build_label}` (post-agent): **{build_status}**\n"
        f"- `{lint_label}` (post-agent): **{lint_status}**\n"
        f"{cost_line}\n"
        f"{review_section}"
        f"---\n\n"
        f"By submitting this pull request, I confirm that you can use, modify, copy, "
        f"and redistribute this contribution, under the terms of the [project license](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/LICENSE)."
    )

    log("POST", f"Creating PR: {pr_title}")
    pr_result = run_cmd(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            config.repo_url,
            "--head",
            branch,
            "--base",
            default_branch,
            "--title",
            pr_title,
            "--body",
            pr_body,
        ],
        label="create-pr",
        cwd=repo_dir,
        check=False,
    )
    if pr_result.returncode == 0:
        pr_url = pr_result.stdout.strip()
        log("POST", f"PR created: {pr_url}")
        if hold_pr_before_status(repo_dir, config, pr_url, review_outcome, concern):
            post_review_status(repo_dir, config.repo_url, review_outcome)
        return pr_url
    log("POST", "Failed to create PR")
    return None


def _extract_agent_notes(repo_dir: str, branch: str, config: TaskConfig) -> str | None:
    """Extract the "## Agent notes" section from the PR body.

    Checks the existing PR body via `gh pr view`. Returns the text content
    of the "## Agent notes" section, or None if not found.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "body",
                "-q",
                ".body",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None

        body = result.stdout.strip()
        # Find "## Agent notes" section
        match = re.search(
            r"##\s*Agent\s*notes\s*\n(.*?)(?=\n##\s|\Z)",
            body,
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            notes = match.group(1).strip()
            return notes or None
        return None
    except Exception as e:
        log("WARN", f"Failed to extract agent notes from PR body: {type(e).__name__}: {e}")
        # nosemgrep: py-silent-success-masking -- PR body notes optional; extraction failure logged
        return None
