"""Git worktree + scratch directory lifecycle for the probe writer (Task 4).

Call 1 must see only the base-branch code, never the coder's diff (ADR-025
(fork)). ``probe_writer_workspace`` gives it a detached worktree checked out
at ``origin/<default_branch>`` — a separate directory tree from the coder's
``repo_dir``, so there is nothing to traverse into even before Cedar's
scratch/worktree confinement rules (``policy.py``) are applied. Both the
worktree and the scratch directory are removed on exit, including on error.
"""

from __future__ import annotations

import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

from shell import run_cmd

if TYPE_CHECKING:
    from collections.abc import Iterator


@contextmanager
def probe_writer_workspace(
    repo_dir: str, default_branch: str, *, base_dir: str
) -> Iterator[tuple[str, str]]:
    """Yield ``(worktree_dir, scratch_dir)`` for Call 1, under ``base_dir``.

    ``worktree_dir`` is a detached checkout of ``origin/<default_branch>``
    (the base-branch commit, not the coder's branch). ``scratch_dir`` is an
    empty directory outside any git repository. Both are removed on exit.
    """
    base = Path(base_dir)
    suffix = uuid.uuid4().hex[:8]
    worktree_dir = base / f"review_worktree_{suffix}"
    scratch_dir = base / f"review_scratch_{suffix}"

    run_cmd(
        ["git", "worktree", "add", "--detach", str(worktree_dir), f"origin/{default_branch}"],
        label="review-worktree-add",
        cwd=repo_dir,
    )
    scratch_dir.mkdir(parents=True, exist_ok=True)
    try:
        yield str(worktree_dir), str(scratch_dir)
    finally:
        run_cmd(
            ["git", "worktree", "remove", "--force", str(worktree_dir)],
            label="review-worktree-remove",
            cwd=repo_dir,
            check=False,
        )
        shutil.rmtree(worktree_dir, ignore_errors=True)
        shutil.rmtree(scratch_dir, ignore_errors=True)
