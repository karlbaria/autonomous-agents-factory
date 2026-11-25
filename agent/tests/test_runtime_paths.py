"""The runtime's own files never reach a commit (#100).

On factory-shop#67 the review fixer's ``git add -A`` committed the Jira
placeholder ``.mcp.json`` that ``channel_mcp`` writes for Jira tasks. These
tests use real git repositories under ``tmp_path``.
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest

import post_hooks
import runtime_paths
from channel_mcp import configure_channel_mcp, strip_linear_mcp_servers
from review.backend import _commit_fixer_changes

if TYPE_CHECKING:
    from pathlib import Path

_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, env=_ENV, check=True
    ).stdout


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    # The code under test commits without the test's env: give the repo an identity.
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "app.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "app.py")
    _git(repo, "commit", "-m", "base")
    return repo


def _committed_files(repo: Path) -> list[str]:
    return _git(repo, "show", "--name-only", "--format=", "HEAD").split()


def _head(repo: Path) -> str:
    return _git(repo, "rev-parse", "HEAD").strip()


def _track_mcp_json(repo: Path) -> None:
    (repo / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"docs": {"type": "http", "url": "https://example.com"}}}),
        encoding="utf-8",
    )
    _git(repo, "add", ".mcp.json")
    _git(repo, "commit", "-m", "repo's own mcp config")


class TestMarkedAtWriteTime:
    def test_an_untracked_mcp_json_is_excluded_when_written(self, repo):
        assert configure_channel_mcp(str(repo), "jira") is True
        exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
        assert "/.mcp.json" in exclude.splitlines()
        assert _git(repo, "status", "--porcelain") == ""
        assert runtime_paths.runtime_written_paths(str(repo)) == [".mcp.json"]

    def test_a_tracked_mcp_json_is_recorded_but_not_excluded(self, repo):
        _track_mcp_json(repo)
        configure_channel_mcp(str(repo), "jira")
        exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
        assert "/.mcp.json" not in exclude.splitlines()
        assert runtime_paths.runtime_written_paths(str(repo)) == [".mcp.json"]

    def test_marking_twice_records_once(self, repo):
        configure_channel_mcp(str(repo), "jira")
        configure_channel_mcp(str(repo), "jira")
        exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
        assert exclude.splitlines().count("/.mcp.json") == 1
        assert runtime_paths.runtime_written_paths(str(repo)) == [".mcp.json"]

    def test_an_exclude_file_without_a_final_newline_is_appended_cleanly(self, repo):
        (repo / ".git" / "info" / "exclude").write_text("*.log", encoding="utf-8")
        configure_channel_mcp(str(repo), "jira")
        exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
        assert exclude == "*.log\n/.mcp.json\n"

    def test_the_linear_scrub_is_recorded_too(self, repo):
        (repo / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "linear-server": {"url": "https://mcp.linear.app/sse"},
                        "docs": {"url": "https://example.com"},
                    }
                }
            ),
            encoding="utf-8",
        )
        _git(repo, "add", ".mcp.json")
        _git(repo, "commit", "-m", "mcp")
        assert strip_linear_mcp_servers(str(repo)) == 1
        assert runtime_paths.runtime_written_paths(str(repo)) == [".mcp.json"]

    def test_a_directory_that_is_not_a_repo_is_harmless(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()
        assert configure_channel_mcp(str(plain), "jira") is True
        assert runtime_paths.runtime_written_paths(str(plain)) == []


class TestTheFixerCommit:
    def test_a_round_whose_only_change_is_the_runtime_file_commits_nothing(self, repo):
        configure_channel_mcp(str(repo), "jira")
        before = _head(repo)
        _commit_fixer_changes(str(repo))
        assert _head(repo) == before

    def test_the_runtime_merge_into_a_tracked_file_stays_out(self, repo):
        _track_mcp_json(repo)
        configure_channel_mcp(str(repo), "jira")
        (repo / "app.py").write_text("x = 2\n", encoding="utf-8")
        _commit_fixer_changes(str(repo))
        assert _committed_files(repo) == ["app.py"]
        # The runtime's config keeps working: still in the working tree.
        assert "jira-server" in (repo / ".mcp.json").read_text(encoding="utf-8")

    def test_the_untracked_runtime_file_stays_out_of_a_real_fix(self, repo):
        configure_channel_mcp(str(repo), "jira")
        (repo / "new_module.py").write_text("y = 1\n", encoding="utf-8")
        _commit_fixer_changes(str(repo))
        assert _committed_files(repo) == ["new_module.py"]


class TestTheSafetyNetCommit:
    def test_ensure_committed_keeps_the_runtime_merge_out(self, repo):
        _track_mcp_json(repo)
        configure_channel_mcp(str(repo), "jira")
        (repo / "app.py").write_text("x = 3\n", encoding="utf-8")
        assert post_hooks.ensure_committed(str(repo)) is True
        assert _committed_files(repo) == ["app.py"]

    def test_ensure_committed_with_only_the_runtime_merge_commits_nothing(self, repo):
        _track_mcp_json(repo)
        configure_channel_mcp(str(repo), "jira")
        before = _head(repo)
        assert post_hooks.ensure_committed(str(repo)) is False
        assert _head(repo) == before

    def test_a_runtime_file_the_agent_staged_itself_is_unstaged(self, repo):
        _track_mcp_json(repo)
        configure_channel_mcp(str(repo), "jira")
        _git(repo, "add", ".mcp.json")
        (repo / "app.py").write_text("x = 4\n", encoding="utf-8")
        assert post_hooks.ensure_committed(str(repo)) is True
        assert _committed_files(repo) == ["app.py"]
