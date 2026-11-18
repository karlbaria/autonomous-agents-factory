"""Tests for the probe writer's base-branch worktree + scratch directory."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from review.worktree import probe_writer_workspace


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
def repo_with_coder_commit(tmp_path):
    """A repo_dir with an origin/main ref pinned to the base commit, and a
    later, uncommitted-to-origin coder commit on HEAD — mirroring a cloned
    repo where the agent has committed work beyond the fetched default
    branch.
    """
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-b", "main")
    (repo_dir / "app.py").write_text("def power(a, b):\n    return a ** b\n", encoding="utf-8")
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "-m", "base commit")
    base_sha = _git(repo_dir, "rev-parse", "HEAD").stdout.strip()
    # Simulate the fetched remote-tracking ref for the base branch.
    _git(repo_dir, "update-ref", "refs/remotes/origin/main", base_sha)

    # The coder's new commit, beyond what origin/main knows about.
    (repo_dir / "app.py").write_text(
        "def power(a, b):\n"
        "    return a ** b\n\n\n"
        "def gcd(a, b):\n"
        "    while b:\n"
        "        a, b = b, a % b\n"
        "    return a\n",
        encoding="utf-8",
    )
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "-m", "add gcd")
    return repo_dir


class TestProbeWriterWorkspace:
    def test_worktree_checked_out_at_base_branch_not_coder_commit(
        self, repo_with_coder_commit, tmp_path
    ):
        base_dir = tmp_path / "workspace"
        base_dir.mkdir()
        with probe_writer_workspace(
            str(repo_with_coder_commit), "main", base_dir=str(base_dir)
        ) as (worktree_dir, _scratch_dir):
            content = (Path(worktree_dir) / "app.py").read_text(encoding="utf-8")
            assert "gcd" not in content, "worktree must not see the coder's new commit"
            assert "power" in content

    def test_scratch_dir_is_empty_and_writable(self, repo_with_coder_commit, tmp_path):
        base_dir = tmp_path / "workspace"
        base_dir.mkdir()
        with probe_writer_workspace(
            str(repo_with_coder_commit), "main", base_dir=str(base_dir)
        ) as (_worktree_dir, scratch_dir):
            assert list(Path(scratch_dir).iterdir()) == []
            probe_file = Path(scratch_dir) / "test_probe.py"
            probe_file.write_text("def test_x():\n    assert True\n", encoding="utf-8")
            assert probe_file.exists()

    def test_cleanup_removes_both_directories(self, repo_with_coder_commit, tmp_path):
        base_dir = tmp_path / "workspace"
        base_dir.mkdir()
        with probe_writer_workspace(
            str(repo_with_coder_commit), "main", base_dir=str(base_dir)
        ) as (worktree_dir, scratch_dir):
            worktree_path, scratch_path = Path(worktree_dir), Path(scratch_dir)
        assert not worktree_path.exists()
        assert not scratch_path.exists()

    def test_cleanup_runs_even_when_body_raises(self, repo_with_coder_commit, tmp_path):
        base_dir = tmp_path / "workspace"
        base_dir.mkdir()
        captured: dict[str, str] = {}
        with (
            pytest.raises(RuntimeError),
            probe_writer_workspace(str(repo_with_coder_commit), "main", base_dir=str(base_dir)) as (
                worktree_dir,
                scratch_dir,
            ),
        ):
            captured["worktree_dir"] = worktree_dir
            captured["scratch_dir"] = scratch_dir
            raise RuntimeError("boom")
        assert not Path(captured["worktree_dir"]).exists()
        assert not Path(captured["scratch_dir"]).exists()

    def test_worktree_removed_from_git_worktree_list(self, repo_with_coder_commit, tmp_path):
        base_dir = tmp_path / "workspace"
        base_dir.mkdir()
        with probe_writer_workspace(str(repo_with_coder_commit), "main", base_dir=str(base_dir)):
            pass
        result = _git(repo_with_coder_commit, "worktree", "list")
        assert result.stdout.strip().count("\n") == 0  # only the main worktree line
