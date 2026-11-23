"""Probe model and the deterministic probe-run step.

Call 1 (the probe writer) writes probe test files into a scratch directory
outside the repo. This module reads them back (``collect_probes``) and runs
each one against the coder's checked-out version (``run_probes``) — a plain
deterministic step, not an agent call, so the pass/fail verdict for each
probe is never left to a model's self-report.

Two kinds of probe run (#69):

- **Python** (``test_*.py``) — ``pytest`` from a temp directory at the repo
  root, as before.
- **JavaScript / TypeScript** (``.js``/``.jsx``/``.ts``/``.tsx``) — the
  probe's package's own test runner (Vitest, else Jest, from its
  ``package.json``). The probe is copied temporarily into the package
  (``<package>/src/__probes__/``, or ``<package>/__probes__/`` when the package
  has no ``src/``) so its relative imports resolve and the runner's root and
  config (``vite.config.js``: ``environment``, ``setupFiles``) apply, then
  removed. A probe not named ``*.test.*``/``*.spec.*`` is copied in under
  ``<stem>.test<ext>``, the names the runners discover by default.

The probe's package is the scratch subdirectory the probe writer put it in
(``<scratch>/frontend/x.test.jsx`` → ``frontend``). A probe at the scratch
root goes to the repo root's package if that has a runner, otherwise to the
repo's only package that has one.

A probe that cannot be run — an unknown kind, no package or runner found, the
runner not installed — is reported **not runnable** with the reason
(``ProbeResult.runnable`` is ``False``): never silently skipped, and never
counted as passed or failed. A probe that runs and errors (a syntax error, a
bad import) is a failed probe, as before.
"""

from __future__ import annotations

import json
import re
import subprocess
import uuid
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, ConfigDict

from shell import log, run_cmd

_PROBES_TMP_DIRNAME_PREFIX = ".review_probes_tmp_"
_OUTPUT_TAIL_CHARS = 4000

#: Where a JS/TS probe runs inside its package, and where it is committed when
#: it passes (``backend._commit_passing_probes``).
JS_PROBES_DIRNAME = "__probes__"
_JS_EXTS = frozenset({".js", ".jsx", ".ts", ".tsx"})
# Source files a probe writer might plausibly leave; anything else (notes,
# manifests) is not a probe and is not collected.
_CODE_EXTS = _JS_EXTS | {".py", ".mjs", ".cjs", ".go", ".rb", ".java", ".kt", ".rs"}
# The default test-file names of Vitest and Jest.
_JS_TEST_NAME_RE = re.compile(r"\.(test|spec)\.[cm]?[jt]sx?$")
# Runners we know how to invoke, in preference order.
_JS_RUNNERS = ("vitest", "jest")
_SKIP_DIRS = frozenset({"node_modules", ".git", "__pycache__", "dist", "build", "cdk.out"})
_MAX_PACKAGE_SEARCH_DEPTH = 4


class Probe(BaseModel):
    """One probe test file the probe writer produced, plus why it exists."""

    model_config = ConfigDict(frozen=True)

    id: str
    intent: str
    filename: str
    source: str
    # #69: the scratch subdirectory the probe writer put the file in, as a
    # repo-relative package path ("" = the scratch root).
    package_dir: str = ""

    @property
    def key(self) -> str:
        """Unique within one probe set: the scratch-relative path."""
        return f"{self.package_dir}/{self.filename}" if self.package_dir else self.filename


class ProbeResult(BaseModel):
    """The deterministic verdict for one probe against one checkout."""

    model_config = ConfigDict(frozen=True)

    probe: Probe
    passed: bool
    output: str
    # #69: False when the probe could not be run at all (``output`` says why).
    # Such a probe is neither passed nor failed.
    runnable: bool = True
    # #69: repo-relative path the probe ran at, for a JS/TS probe — also where
    # it is committed if it passes. "" for a Python probe.
    run_path: str = ""

    @property
    def failed(self) -> bool:
        """Ran and did not pass."""
        return self.runnable and not self.passed


def collect_probes(scratch_dir: str, intents: dict[str, str] | None = None) -> list[Probe]:
    """Read back every probe file the probe writer left in ``scratch_dir``.

    ``intents`` maps a filename (or a scratch-relative path) to the probe's
    stated intent, parsed from the probe writer's ``PROBES:`` manifest; a
    probe with no entry gets a generic intent rather than being dropped — an
    unexplained probe still runs and still counts. Files that are not source
    code (notes, manifests) are not probes and are skipped.
    """
    intents = intents or {}
    root = Path(scratch_dir)
    probes = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if not path.is_file() or path.suffix not in _CODE_EXTS:
            continue
        if any(part in _SKIP_DIRS or part.startswith(".") for part in rel.parts):
            continue
        package_dir = rel.parent.as_posix() if rel.parent != Path(".") else ""
        probes.append(
            Probe(
                id=path.stem,
                intent=intents.get(rel.as_posix())
                or intents.get(path.name, f"probe from {path.name}"),
                filename=path.name,
                source=path.read_text(encoding="utf-8"),
                package_dir=package_dir,
            )
        )
    return probes


def run_probes(probes: list[Probe], repo_dir: str, *, timeout_s: int = 300) -> list[ProbeResult]:
    """Run each probe against ``repo_dir`` (the coder's checked-out version).

    Python probes run in their own ``pytest`` invocation from a temp directory
    inside ``repo_dir`` (so repo-relative imports resolve as they would for a
    real test living there), removed once every probe has run. JS/TS probes run
    with their package's own runner from ``<package>/src/__probes__/``. Nothing
    here is committed: ``backend.py`` commits only the probes that pass, as a
    separate step.
    """
    if not probes:
        return []

    tmp_dirname = f"{_PROBES_TMP_DIRNAME_PREFIX}{uuid.uuid4().hex[:8]}"
    tmp_dir = Path(repo_dir) / tmp_dirname
    results: list[ProbeResult] = []
    try:
        for probe in probes:
            suffix = Path(probe.filename).suffix
            if suffix == ".py" and probe.filename.startswith("test_"):
                tmp_dir.mkdir(parents=True, exist_ok=True)
                results.append(_run_pytest_probe(probe, repo_dir, tmp_dir, timeout_s))
            elif suffix in _JS_EXTS:
                results.append(_run_js_probe(probe, Path(repo_dir), timeout_s))
            elif suffix == ".py":
                results.append(_not_runnable(probe, "pytest only runs files named test_*.py"))
            else:
                results.append(_not_runnable(probe, f"no probe runner for {suffix} files"))
    finally:
        if tmp_dir.exists():
            _remove_tree(tmp_dir)
    return results


def _not_runnable(probe: Probe, reason: str) -> ProbeResult:
    log("WARN", f"review probe {probe.key} not runnable: {reason}")
    return ProbeResult(probe=probe, passed=False, output=reason, runnable=False)


def _run(cmd: list[str], label: str, cwd: str, timeout_s: int) -> tuple[bool, str]:
    try:
        result = run_cmd(cmd, label=label, cwd=cwd, timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired as e:
        log("WARN", f"{label} timed out: {e}")
        return False, f"probe timed out after {timeout_s}s"
    output = (result.stdout or "") + (result.stderr or "")
    return result.returncode == 0, output[-_OUTPUT_TAIL_CHARS:]


def _run_pytest_probe(probe: Probe, repo_dir: str, tmp_dir: Path, timeout_s: int) -> ProbeResult:
    probe_path = tmp_dir / probe.filename
    probe_path.write_text(probe.source, encoding="utf-8")
    try:
        # Bare "pytest" (never sys.executable -m pytest): the agent's own
        # venv has no dev deps in the production image (--no-dev), so
        # sys.executable -m pytest always 404s there. PATH resolution
        # finds the TARGET REPO's pytest instead — mise shims it after
        # the repo's own build step installs it.
        passed, output = _run(
            ["pytest", str(probe_path), "-q"],
            f"review-probe:{probe.filename}",
            repo_dir,
            timeout_s,
        )
    finally:
        probe_path.unlink(missing_ok=True)
    return ProbeResult(probe=probe, passed=passed, output=output)


# ---- JS/TS probes (#69) -----------------------------------------------------


def _package_runner(package: Path) -> str | None:
    """The first of ``_JS_RUNNERS`` that ``package/package.json`` depends on."""
    try:
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(manifest, dict):
        return None
    deps: set[str] = set()
    for field in ("devDependencies", "dependencies"):
        value = manifest.get(field)
        if isinstance(value, dict):
            deps.update(value)
    return next((r for r in _JS_RUNNERS if r in deps), None)


def _packages_with_runner(repo: Path) -> list[Path]:
    found = []
    for manifest in sorted(repo.rglob("package.json")):
        rel = manifest.parent.relative_to(repo)
        if len(rel.parts) > _MAX_PACKAGE_SEARCH_DEPTH or any(p in _SKIP_DIRS for p in rel.parts):
            continue
        if _package_runner(manifest.parent):
            found.append(manifest.parent)
    return found


def _resolve_package(probe: Probe, repo: Path) -> tuple[Path | None, str]:
    """The probe's package directory, or ``None`` and the reason."""
    if probe.package_dir:
        rel = PurePosixPath(probe.package_dir)
        if rel.is_absolute() or ".." in rel.parts:
            return None, f"package path {probe.package_dir!r} is outside the repo"
        package = repo / rel
        if not _package_runner(package):
            return None, (
                f"`{probe.package_dir}` has no package.json that depends on "
                f"{' or '.join(_JS_RUNNERS)}"
            )
        return package, ""
    if _package_runner(repo):
        return repo, ""
    candidates = _packages_with_runner(repo)
    if len(candidates) == 1:
        return candidates[0], ""
    if not candidates:
        return None, f"no package in the repo depends on {' or '.join(_JS_RUNNERS)}"
    names = ", ".join(f"`{c.relative_to(repo).as_posix()}`" for c in candidates)
    return None, (
        f"several packages have a test runner ({names}); the probe must be written "
        "into a scratch subdirectory named after its package"
    )


def _runner_binary(package: Path, repo: Path, runner: str) -> Path | None:
    """``node_modules/.bin/<runner>`` in the package or an ancestor up to the repo root."""
    current = package
    while True:
        candidate = current / "node_modules" / ".bin" / runner
        if candidate.exists():
            return candidate
        if current == repo or repo not in current.parents:
            return None
        current = current.parent


def js_probe_dir(package: Path) -> Path:
    """Where a JS/TS probe runs (and is committed) inside its package."""
    base = package / "src" if (package / "src").is_dir() else package
    return base / JS_PROBES_DIRNAME


def js_run_name(filename: str) -> str:
    """``filename`` as the runners discover it: ``x.test.jsx`` stays, ``x.jsx`` → ``x.test.jsx``."""
    if _JS_TEST_NAME_RE.search(filename):
        return filename
    path = PurePosixPath(filename)
    return f"{path.stem}.test{path.suffix}"


def _run_js_probe(probe: Probe, repo: Path, timeout_s: int) -> ProbeResult:
    package, reason = _resolve_package(probe, repo)
    if package is None:
        return _not_runnable(probe, reason)
    runner = _package_runner(package) or ""
    binary = _runner_binary(package, repo, runner)
    package_label = package.relative_to(repo).as_posix() if package != repo else "."
    if binary is None:
        return _not_runnable(
            probe,
            f"`{runner}` is not installed for `{package_label}` (no node_modules/.bin/{runner}); "
            "the repo's build step must install its dependencies",
        )

    probe_dir = js_probe_dir(package)
    created_dir = not probe_dir.exists()
    probe_dir.mkdir(parents=True, exist_ok=True)
    probe_path = probe_dir / js_run_name(probe.filename)
    # A committed probe from an earlier round may already sit at this path:
    # restore it afterwards instead of deleting it.
    previous = probe_path.read_bytes() if probe_path.exists() else None
    probe_path.write_text(probe.source, encoding="utf-8")
    rel_to_package = probe_path.relative_to(package).as_posix()
    cmd = (
        [str(binary), "run", rel_to_package]
        if runner == "vitest"
        else [str(binary), "--ci", "--runTestsByPath", rel_to_package]
    )
    try:
        passed, output = _run(cmd, f"review-probe:{probe.key}", str(package), timeout_s)
    finally:
        if previous is None:
            probe_path.unlink(missing_ok=True)
        else:
            probe_path.write_bytes(previous)
        if created_dir and not any(probe_dir.iterdir()):
            probe_dir.rmdir()
    return ProbeResult(
        probe=probe,
        passed=passed,
        output=output,
        run_path=probe_path.relative_to(repo).as_posix(),
    )


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
