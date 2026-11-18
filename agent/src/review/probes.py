"""Probe model and the deterministic probe-run step.

Call 1 (the probe writer) writes probe test files into a scratch directory
outside the repo. This module reads them back (``collect_probes``) and runs
each one against the coder's checked-out version (``run_probes``) — a plain
deterministic step, not an agent call, so the pass/fail verdict for each
probe is never left to a model's self-report.

Scoped to pytest-runnable probes (the lab's sample repos are Python) — a
probe file this cannot execute is recorded as failed with its collection
error, never silently skipped.
"""

from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from shell import log, run_cmd

_PROBES_TMP_DIRNAME_PREFIX = ".review_probes_tmp_"
_OUTPUT_TAIL_CHARS = 4000


class Probe(BaseModel):
    """One probe test file the probe writer produced, plus why it exists."""

    model_config = ConfigDict(frozen=True)

    id: str
    intent: str
    filename: str
    source: str


class ProbeResult(BaseModel):
    """The deterministic pass/fail verdict for one probe against one checkout."""

    model_config = ConfigDict(frozen=True)

    probe: Probe
    passed: bool
    output: str


def collect_probes(scratch_dir: str, intents: dict[str, str] | None = None) -> list[Probe]:
    """Read back every ``test_*.py`` file the probe writer left in ``scratch_dir``.

    ``intents`` maps filename -> the probe's stated intent (parsed separately
    from the probe writer's final message, e.g. a ``PROBES:`` manifest); a
    filename with no entry gets a generic intent rather than being dropped —
    an unexplained probe still runs and still counts.
    """
    intents = intents or {}
    root = Path(scratch_dir)
    return [
        Probe(
            id=path.stem,
            intent=intents.get(path.name, f"probe from {path.name}"),
            filename=path.name,
            source=path.read_text(encoding="utf-8"),
        )
        for path in sorted(root.glob("test_*.py"))
    ]


def run_probes(probes: list[Probe], repo_dir: str, *, timeout_s: int = 300) -> list[ProbeResult]:
    """Run each probe file against ``repo_dir`` (the coder's checked-out version).

    Each probe runs in its own ``pytest`` invocation, from a temp directory
    inside ``repo_dir`` (so repo-relative imports resolve as they would for a
    real test living there), removed again once every probe has run — the
    probes are not committed here; ``backend.py`` commits only the ones that
    pass, as a separate step.
    """
    if not probes:
        return []

    tmp_dirname = f"{_PROBES_TMP_DIRNAME_PREFIX}{uuid.uuid4().hex[:8]}"
    tmp_dir = Path(repo_dir) / tmp_dirname
    tmp_dir.mkdir(parents=True, exist_ok=True)
    results: list[ProbeResult] = []
    try:
        for probe in probes:
            probe_path = tmp_dir / probe.filename
            probe_path.write_text(probe.source, encoding="utf-8")
            try:
                # Bare "pytest" (never sys.executable -m pytest): the agent's own
                # venv has no dev deps in the production image (--no-dev), so
                # sys.executable -m pytest always 404s there. PATH resolution
                # finds the TARGET REPO's pytest instead — mise shims it after
                # the repo's own build step installs it.
                result = run_cmd(
                    ["pytest", str(probe_path), "-q"],
                    label=f"review-probe:{probe.filename}",
                    cwd=repo_dir,
                    timeout=timeout_s,
                    check=False,
                )
                output = (result.stdout or "") + (result.stderr or "")
                passed = result.returncode == 0
            except subprocess.TimeoutExpired as e:
                output = f"probe timed out after {timeout_s}s"
                log("WARN", f"review probe {probe.filename} timed out: {e}")
                passed = False
            results.append(
                ProbeResult(probe=probe, passed=passed, output=output[-_OUTPUT_TAIL_CHARS:])
            )
            probe_path.unlink(missing_ok=True)
    finally:
        _remove_tree(tmp_dir)
    return results


def _remove_tree(path: Path) -> None:
    """Best-effort recursive removal of the probe scratch subdirectory."""
    try:
        for child in sorted(path.rglob("*"), reverse=True):
            if child.is_file():
                child.unlink(missing_ok=True)
            else:
                child.rmdir()
        path.rmdir()
    except OSError as e:
        log("WARN", f"failed to clean up probe temp dir {path}: {e}")
