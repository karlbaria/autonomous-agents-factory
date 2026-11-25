"""Files the runtime itself writes into the task's checkout (#100).

The runtime writes a few files into the cloned repo that are configuration
for this task, not part of the change: today only ``.mcp.json``
(``channel_mcp.configure_channel_mcp`` and ``strip_linear_mcp_servers``).
Those must never be committed. On factory-shop#67 the review fixer's
``git add -A`` committed the Jira placeholder ``.mcp.json`` as "fix: address
independent review findings".

At the moment the runtime writes such a file, :func:`mark_runtime_written`

- records it in the repository's git directory (``info/abca-runtime-written``),
  which git never versions, and
- adds it to ``info/exclude`` when the repo doesn't track it, so no
  ``git add -A`` / ``git add .`` (deterministic or the agent's own) stages it.

A tracked file the runtime merged into can't be excluded that way, so the
deterministic commits (the fixer commit and the safety-net commit) also call
:func:`unstage_runtime_written` after staging and before committing.
"""

from __future__ import annotations

import os
import subprocess

from shell import log

_RECORD_NAME = "abca-runtime-written"
_GIT_TIMEOUT_S = 30


def _git(repo_dir: str, *args: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log("WARN", f"runtime_paths: git {args[0]} failed ({type(e).__name__}: {e})")
        # nosemgrep: py-silent-success-masking -- None is the failure; every caller checks for it
        return None


def _info_dir(repo_dir: str) -> str | None:
    """The repository's ``info`` directory (works for clones and worktrees)."""
    result = _git(repo_dir, "rev-parse", "--git-path", "info")
    if result is None or result.returncode != 0 or not result.stdout.strip():
        return None
    path = result.stdout.strip()
    return path if os.path.isabs(path) else os.path.join(repo_dir, path)


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        # nosemgrep: py-silent-success-masking -- no file yet is a genuinely empty record
        return ""


def _read_lines(path: str) -> list[str]:
    return _read_text(path).splitlines()


def _append_line(path: str, line: str) -> None:
    text = _read_text(path)
    if line in text.splitlines():
        return
    # A hand-edited exclude file may not end in a newline.
    separator = "\n" if text and not text.endswith("\n") else ""
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"{separator}{line}\n")


def _is_tracked(repo_dir: str, rel_path: str) -> bool:
    result = _git(repo_dir, "ls-files", "--error-unmatch", "--", rel_path)
    return result is not None and result.returncode == 0


def mark_runtime_written(repo_dir: str, rel_path: str) -> None:
    """Record that the runtime wrote ``rel_path``; exclude it from git if untracked.

    Best-effort: a failure is logged, and the unstage step before each
    deterministic commit still keeps the file out of those commits.
    """
    info = _info_dir(repo_dir)
    if info is None:
        log("WARN", f"runtime_paths: no git directory for {repo_dir!r}; {rel_path} not recorded")
        return
    try:
        os.makedirs(info, exist_ok=True)
        _append_line(os.path.join(info, _RECORD_NAME), rel_path)
        if not _is_tracked(repo_dir, rel_path):
            _append_line(os.path.join(info, "exclude"), f"/{rel_path}")
    except OSError as e:
        log("WARN", f"runtime_paths: could not record {rel_path} ({type(e).__name__}: {e})")


def runtime_written_paths(repo_dir: str) -> list[str]:
    """The repo-relative paths :func:`mark_runtime_written` recorded, in order."""
    info = _info_dir(repo_dir)
    if info is None:
        return []
    return [p for p in _read_lines(os.path.join(info, _RECORD_NAME)) if p]


def unstage_runtime_written(repo_dir: str) -> list[str]:
    """Take every runtime-written path out of the index; return the ones recorded.

    Call after staging and before committing. The working-tree file is left
    as it is, so the runtime's configuration keeps working for the rest of
    the task.
    """
    paths = runtime_written_paths(repo_dir)
    if not paths:
        return []
    result = _git(repo_dir, "reset", "-q", "--", *paths)
    if result is None or result.returncode != 0:
        stderr = result.stderr.strip()[:200] if result is not None and result.stderr else ""
        log("WARN", f"runtime_paths: could not unstage {paths}: {stderr}")
    return paths
