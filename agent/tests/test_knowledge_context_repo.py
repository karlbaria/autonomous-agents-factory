"""#61: a knowledge workflow given a repo gets a read-only context clone and runs
its full step list (incl. deliver_artifact) — no branch, no commit, no push, no PR."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import repo as repo_mod
from models import AgentResult, TaskConfig
from shell import run_cmd as real_run_cmd

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env={**GIT_ENV}
    ).stdout.strip()


@pytest.fixture
def origin(tmp_path, monkeypatch) -> Path:
    """A local 'GitHub' repository with two commits and a README."""
    for k, v in GIT_ENV.items():
        monkeypatch.setenv(k, v)
    src = tmp_path / "origin"
    src.mkdir()
    _git("init", "-q", "-b", "main", cwd=src)
    (src / "README.md").write_text("# factory-shop\n\nProducts, cart, checkout.\n")
    _git("add", ".", cwd=src)
    _git("commit", "-q", "-m", "first", cwd=src)
    (src / "NOTES.md").write_text("search is keyword-only\n")
    _git("add", ".", cwd=src)
    _git("commit", "-q", "-m", "second", cwd=src)
    return src


@pytest.fixture
def gh_clone_is_local_git(origin, tmp_path, monkeypatch):
    """Route `gh repo clone <slug> <dir> -- <git args>` to a real local git clone,
    and the safe.directory call to a no-op (it writes global git config)."""
    clones: list[list[str]] = []

    def fake_backoff(cmd, label, on_retry=None, **_kw):
        assert cmd[:3] == ["gh", "repo", "clone"], cmd
        clones.append(cmd)
        dest, extra = cmd[4], cmd[6:] if len(cmd) > 5 and cmd[5] == "--" else []
        return subprocess.run(
            ["git", "clone", "-q", *extra, f"file://{origin}", dest],
            capture_output=True,
            text=True,
        )

    def fake_run_cmd(cmd, label, **kw):
        if label == "safe-directory":
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return real_run_cmd(cmd, label, **kw)

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(repo_mod, "run_cmd_with_backoff", fake_backoff)
    monkeypatch.setattr(repo_mod, "run_cmd", fake_run_cmd)
    monkeypatch.setattr(repo_mod, "AGENT_WORKSPACE", str(workspace))
    return clones


def _config(task_id="ctx-1") -> TaskConfig:
    return TaskConfig(
        repo_url="karlbaria/factory-shop",
        aws_region="us-east-1",
        task_id=task_id,
        requires_repo=False,
        workflow_domain="knowledge",
        github_token="ghp_secret",
    )


class TestCloneForContext:
    def test_shallow_clone_readable_no_branch_push_disabled(self, gh_clone_is_local_git):
        setup = repo_mod.clone_for_context(_config())
        repo_dir = Path(setup.repo_dir)
        # Readable repo files.
        assert (repo_dir / "README.md").read_text().startswith("# factory-shop")
        # Shallow (depth 1) and on the default branch: no task branch made.
        assert gh_clone_is_local_git[0][-2:] == ["--depth", "1"]
        assert _git("rev-list", "--count", "HEAD", cwd=repo_dir) == "1"
        assert _git("branch", "--show-current", cwd=repo_dir) == "main"
        assert setup.branch == ""
        # Pushes are disabled.
        assert _git("remote", "get-url", "--push", "origin", cwd=repo_dir) == (
            repo_mod.CONTEXT_CLONE_PUSH_URL
        )
        push = subprocess.run(
            ["git", "push", "origin", "HEAD"], cwd=repo_dir, capture_output=True, text=True
        )
        assert push.returncode != 0

    def test_failed_clone_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(repo_mod, "AGENT_WORKSPACE", str(tmp_path))
        monkeypatch.setattr(
            repo_mod, "run_cmd", lambda cmd, label, **kw: subprocess.CompletedProcess(cmd, 0)
        )
        monkeypatch.setattr(
            repo_mod,
            "run_cmd_with_backoff",
            lambda cmd, label, **kw: subprocess.CompletedProcess(cmd, 1, "", "not found"),
        )
        with pytest.raises(RuntimeError):
            repo_mod.clone_for_context(_config())


def _mock_span() -> MagicMock:
    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    return span


@patch("runner.run_agent")
@patch("repo.setup_repo")
@patch("pipeline.task_span")
@patch("pipeline.task_state")
class TestWebResearchWithRepo:
    """End to end through pipeline.run_task with knowledge/web-research-v1 + a repo."""

    def _run(self, monkeypatch, run_agent, *, channel_metadata=None):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        milestones: list[tuple[str, str]] = []
        from confluence.publish import ConfluenceOutcome

        published = ConfluenceOutcome(
            status="published",
            action="created",
            page_id="9",
            page_url="https://acme.atlassian.net/wiki/x/9",
            version=1,
        )
        s3 = MagicMock()
        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch("aws_session.tenant_client", return_value=s3),
            patch("confluence.publish.publish_markdown", return_value=published) as publish,
            patch("pipeline.ensure_committed") as ensure_committed,
            patch("pipeline.ensure_pr") as ensure_pr,
            patch(
                "progress_writer._ProgressWriter.write_agent_milestone",
                lambda _self, name, details="": milestones.append((name, details)),
            ),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="karlbaria/factory-shop",
                task_description="Research product search UX for factory-shop",
                github_token="ghp_secret",
                aws_region="us-east-1",
                task_id="research-repo-1",
                resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
                channel_metadata=channel_metadata
                or {"confluence_cloud_id": "c", "confluence_space_key": "ENG"},
            )
        return result, milestones, publish, ensure_committed, ensure_pr, s3

    def test_deliver_artifact_runs_in_a_read_only_checkout(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
        gh_clone_is_local_git,
    ):
        mock_task_span.return_value = _mock_span()
        seen: dict = {}

        async def fake_run_agent(_prompt, system_prompt, config, cwd=None, trajectory=None):
            import os

            seen["cwd"] = cwd
            assert cwd is not None
            seen["readme"] = (Path(cwd) / "README.md").read_text()
            seen["token"] = config.github_token
            seen["env_token"] = os.environ.get("GITHUB_TOKEN")
            seen["system_prompt"] = system_prompt
            return AgentResult(
                status="success",
                turns=3,
                cost_usd=0.05,
                num_turns=3,
                result_text="# Product search UX\n\nFindings for factory-shop.",
            )

        mock_run_agent.side_effect = fake_run_agent
        result, milestones, publish, ensure_committed, ensure_pr, s3 = self._run(
            monkeypatch, mock_run_agent
        )

        # The coding clone/branch path never ran; the context clone did.
        mock_setup_repo.assert_not_called()
        assert len(gh_clone_is_local_git) == 1
        # The agent ran inside the checkout and could read the repo's files.
        assert seen["readme"].startswith("# factory-shop")
        assert "Repository context (read-only)" in seen["system_prompt"]
        # ...without the GitHub token, in its config or its environment.
        assert seen["token"] == ""
        assert not seen["env_token"]
        # deliver_artifact ran: S3, Confluence and the comment.
        s3.put_object.assert_called_once()
        publish.assert_called_once()
        names = [m[0] for m in milestones]
        assert "step:deliver:start" in names
        assert "step:deliver:succeeded" in names
        comment = next(d for n, d in milestones if n == "delivered_comment")
        assert comment.startswith("Confluence: created https://acme.atlassian.net/wiki/x/9")
        # Success judged by terminal_outcomes (primary: artifact), no PR.
        assert result["status"] == "success"
        assert result["artifact_uri"] == "s3://artifacts-bkt/artifacts/research-repo-1/result.md"
        assert result["pr_url"] is None
        assert result["confluence_status"] == "published"
        # Nothing committed or pushed.
        ensure_committed.assert_not_called()
        ensure_pr.assert_not_called()
        repo_dir = Path(seen["cwd"])
        assert _git("rev-list", "--count", "HEAD", cwd=repo_dir) == "1"
        assert _git("status", "--porcelain", cwd=repo_dir) == ""

    def test_failed_context_clone_still_delivers(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        mock_task_span.return_value = _mock_span()
        seen: dict = {}

        async def fake_run_agent(_prompt, system_prompt, config, cwd=None, trajectory=None):
            seen["system_prompt"] = system_prompt
            return AgentResult(
                status="success",
                turns=1,
                cost_usd=0.01,
                num_turns=1,
                result_text="# Report\n\nBody.",
            )

        mock_run_agent.side_effect = fake_run_agent
        with patch("repo.clone_for_context", side_effect=RuntimeError("repo not found")):
            result, milestones, *_ = self._run(monkeypatch, mock_run_agent)

        mock_setup_repo.assert_not_called()
        assert ("repo_context_unavailable", "repo not found") in milestones
        assert "Repository context (read-only)" not in seen["system_prompt"]
        assert result["status"] == "success"
        assert result["artifact_uri"] is not None


class TestBuildConfigWorkflowDomain:
    """build_config threads the resolved workflow's domain onto TaskConfig."""

    @pytest.mark.parametrize(
        ("workflow_id", "domain"),
        [
            ("knowledge/web-research-v1", "knowledge"),
            ("default/agent-v1", "hybrid"),
            ("coding/new-task-v1", "coding"),
        ],
    )
    def test_domain(self, workflow_id, domain):
        from config import build_config

        config = build_config(
            repo_url="owner/repo",
            task_description="x",
            github_token="ghp_x",
            aws_region="us-east-1",
            resolved_workflow={"id": workflow_id, "version": "1.0.0"},
        )
        assert config.workflow_domain == domain
