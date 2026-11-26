"""The integration PR can't reach main past a held story (#99, #103).

On the shopping-bag build (factory-shop#75) the integration PR auto-merged
although story 1's PR was labelled ``needs-human``:

- the integration branch fast-forwarded onto story 3's head, so the PR carried
  story 3's ``factory/review: success`` before its own review ran;
- a linear child never inherited its predecessor's hold, because the
  predecessor list dropped ``base_branch`` whenever it equalled
  ``setup.default_branch`` — which for a linear child it always does;
- failed ``gh`` writes left no event, and a 5xx was never retried.
"""

import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import post_hooks
import repo
from models import AgentResult, RepoSetup
from tests.conftest import make_task_config

_ORCH = {"orchestration_id": "orch_abc", "orchestration_sub_issue_id": "S"}
_STACKED = {**_ORCH, "orchestration_stacked": "true"}


def _ok(stdout: str = "") -> SimpleNamespace:
    return SimpleNamespace(returncode=0, stdout=stdout, stderr="")


class FakeGitHub:
    """PRs by head branch, their labels, and the local clone's ``HEAD``.

    Serves ``gh pr list --head``, ``gh pr view``, ``gh api …/status`` and
    ``git rev-parse`` (as ``subprocess.run``) and applies ``gh pr edit
    --add-label`` (as ``run_cmd``). ``order`` records each write in sequence.
    """

    def __init__(self) -> None:
        self.prs: dict[str, dict] = {}
        self.heads: dict[str, str] = {}
        self.head = "sha-local"
        self.order: list[str] = []
        self.appended: dict[str, list[str]] = {}

    def open_pr(self, branch: str, number: int, labels: tuple[str, ...] = ()) -> str:
        url = f"https://github.com/owner/repo/pull/{number}"
        self.prs[branch] = {"number": number, "url": url, "labels": set(labels)}
        self.heads.setdefault(branch, f"sha-{branch}")
        return url

    def labels(self, branch: str) -> set[str]:
        return self.prs[branch]["labels"]

    def install(self, monkeypatch) -> None:
        monkeypatch.setattr(post_hooks.subprocess, "run", self.run)
        monkeypatch.setattr(post_hooks, "run_cmd", self.run_cmd)
        monkeypatch.setattr(post_hooks, "_append_pr_appendix", self.append)

    def run(self, cmd, **_kwargs):
        if cmd[:3] == ["gh", "pr", "list"]:
            pr = self.prs.get(cmd[cmd.index("--head") + 1])
            listed = (
                []
                if pr is None
                else [
                    {
                        "number": pr["number"],
                        "labels": [{"name": n} for n in sorted(pr["labels"])],
                        "headRefOid": "sha-pr",
                    }
                ]
            )
            return _ok(json.dumps(listed))
        if cmd[:2] == ["gh", "api"] and cmd[2].endswith("/status"):
            review = {"context": "factory/review", "state": "success", "description": "READY"}
            return _ok(json.dumps({"statuses": [review]}))
        if cmd[:3] == ["gh", "pr", "view"]:
            return _ok("main\n" if "baseRefName" in cmd else f"{self._url(cmd[3])}\n")
        if cmd[:2] == ["git", "rev-parse"]:
            ref = cmd[-1].removesuffix("^{commit}")
            if ref == "HEAD":
                return _ok(f"{self.head}\n")
            sha = self.heads.get(ref.removeprefix("origin/"))
            return _ok(f"{sha}\n") if sha else SimpleNamespace(returncode=1, stdout="", stderr="")
        return _ok()

    def _url(self, branch: str) -> str:
        return self.prs[branch]["url"]

    def run_cmd(self, cmd, label, cwd=None, timeout=600, check=True, **_kwargs):
        if "--add-label" in cmd:
            url, name = cmd[3], cmd[cmd.index("--add-label") + 1]
            next(pr for pr in self.prs.values() if pr["url"] == url)["labels"].add(name)
            self.order.append(f"label {name}")
        elif cmd[:2] == ["gh", "api"] and "/statuses/" in cmd[2]:
            self.order.append("factory/review")
        return _ok()

    def append(self, _repo_dir, _repo_url, pr_url, text) -> None:
        self.appended.setdefault(pr_url, []).append(text)


def _hold(gh: FakeGitHub, branch: str, **config) -> bool:
    return post_hooks.hold_orchestration_pr(
        "/tmp/repo", make_task_config(**config), gh._url(branch), review_ran=True
    )


class TestInheritanceThroughAChain:
    def test_s1_flagged_holds_s2_s3_and_the_integration_pr(self, monkeypatch):
        gh = FakeGitHub()
        gh.install(monkeypatch)
        gh.open_pr("br-S1", 72, ("factory-stacked", "needs-human"))

        gh.open_pr("br-S2", 73)
        _hold(gh, "br-S2", channel_metadata=_STACKED, base_branch="br-S1")
        gh.open_pr("br-S3", 74)
        _hold(gh, "br-S3", channel_metadata=_STACKED, base_branch="br-S2")
        # The integration node depends on the chain's one leaf, story 3.
        gh.open_pr("br-int", 75)
        _hold(gh, "br-int", channel_metadata=_ORCH, base_branch="main", merge_branches=["br-S3"])

        assert "needs-human" in gh.labels("br-S2")
        assert "needs-human" in gh.labels("br-S3")
        assert gh.labels("br-int") == {"needs-human"}
        assert "Inherited from #74" in gh.appended[gh._url("br-int")][0]

    def test_a_linear_child_inherits_with_its_real_default_branch(self, monkeypatch):
        # The setup of a linear child sets default_branch to its base branch;
        # with default_branch == base_branch == "br-S1" the hold still applies.
        gh = FakeGitHub()
        gh.install(monkeypatch)
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda *_a: True)
        gh.open_pr("br-S1", 72, ("needs-human",))
        gh.open_pr("br-S2", 73)
        post_hooks.ensure_pr(
            make_task_config(channel_metadata=_STACKED, base_branch="br-S1"),
            RepoSetup(repo_dir="/tmp/repo", branch="br-S2", default_branch="br-S1"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert gh.labels("br-S2") == {"factory-stacked", "needs-human"}


class TestInheritanceThroughAFanOut:
    def test_a_flagged_root_holds_both_children_and_the_integration_pr(self, monkeypatch):
        gh = FakeGitHub()
        gh.install(monkeypatch)
        gh.open_pr("br-R", 70, ("factory-stacked", "needs-human"))
        gh.open_pr("br-A", 71)
        _hold(gh, "br-A", channel_metadata=_STACKED, base_branch="br-R")
        gh.open_pr("br-B", 72)
        _hold(gh, "br-B", channel_metadata=_STACKED, base_branch="br-R")
        gh.open_pr("br-int", 73)
        _hold(
            gh,
            "br-int",
            channel_metadata=_ORCH,
            base_branch="main",
            merge_branches=["br-A", "br-B"],
        )

        assert "needs-human" in gh.labels("br-A")
        assert "needs-human" in gh.labels("br-B")
        assert gh.labels("br-int") == {"needs-human"}

    def test_the_predecessors_of_a_diamond_are_its_merged_in_branches(self):
        config = make_task_config(base_branch="main", merge_branches=["br-A", "br-B", "br-A"])
        assert post_hooks.orchestration_predecessors(config) == ["br-A", "br-B"]
        assert post_hooks.orchestration_predecessors(make_task_config(base_branch="br-R")) == [
            "br-R"
        ]
        assert post_hooks.orchestration_predecessors(make_task_config()) == []


class TestSharedHeadGuard:
    """A PR whose head is a predecessor's head carries that predecessor's status."""

    def _ensure_pr(self, monkeypatch, gh: FakeGitHub) -> list[str]:
        posted: list[str] = []
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda *_a: True)
        monkeypatch.setattr(post_hooks, "post_review_status", lambda *_a: posted.append("status"))
        post_hooks.ensure_pr(
            make_task_config(channel_metadata=_ORCH, base_branch="main", merge_branches=["br-S3"]),
            RepoSetup(repo_dir="/tmp/repo", branch="br-int", default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            review_outcome={"ran": True, "verdict": "READY"},
        )
        return posted

    def test_an_integration_head_equal_to_the_last_story_head_is_held_without_a_status(
        self, monkeypatch
    ):
        gh = FakeGitHub()
        gh.install(monkeypatch)
        gh.open_pr("br-S3", 74)
        gh.open_pr("br-int", 75)
        gh.head = gh.heads["br-S3"]

        assert self._ensure_pr(monkeypatch, gh) == []
        assert gh.labels("br-int") == {"needs-human"}
        assert any("is the head of `br-S3`" in t for t in gh.appended[gh._url("br-int")])

    def test_an_integration_head_of_its_own_gets_its_status(self, monkeypatch):
        gh = FakeGitHub()
        gh.install(monkeypatch)
        gh.open_pr("br-S3", 74)
        gh.open_pr("br-int", 75)

        assert self._ensure_pr(monkeypatch, gh) == ["status"]
        assert gh.labels("br-int") == set()


class TestConcernLabelBeforeTheStatus:
    def test_the_flag_concern_label_lands_before_factory_review(self, monkeypatch):
        gh = FakeGitHub()
        gh.install(monkeypatch)
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda *_a: True)
        gh.open_pr("br-x", 12)
        post_hooks.ensure_pr(
            make_task_config(),
            RepoSetup(repo_dir="/tmp/repo", branch="br-x", default_branch="main"),
            build_passed=True,
            lint_passed=True,
            agent_result=AgentResult(status="success", concern_reason="API choices are mine"),
            strategy="create",
            review_outcome={"ran": True, "verdict": "READY"},
        )
        assert gh.order == ["label needs-human", "factory/review"]
        assert any("- API choices are mine" in t for t in gh.appended[gh._url("br-x")])


_GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **_GIT_ENV},
    ).stdout.strip()


@pytest.fixture
def chain_clone(tmp_path, monkeypatch) -> Path:
    """A clone of an origin with main ← br-S1 ← br-S2, on a branch off main."""
    for key, value in _GIT_ENV.items():
        monkeypatch.setenv(key, value)
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    work = tmp_path / "work"
    _git(tmp_path, "clone", "-q", str(origin), str(work))
    for branch, name in (("main", "base"), ("br-S1", "s1"), ("br-S2", "s2")):
        if branch != "main":
            _git(work, "checkout", "-q", "-b", branch)
        (work / f"{name}.txt").write_text(f"{name}\n")
        _git(work, "add", ".")
        _git(work, "commit", "-q", "-m", name)
        _git(work, "push", "-q", "origin", branch)
    clone = tmp_path / "clone"
    _git(tmp_path, "clone", "-q", str(origin), str(clone))
    _git(clone, "checkout", "-q", "-b", "br-int", "origin/main")
    return clone


class TestIntegrationMergeCommit:
    def test_the_integration_head_is_a_merge_commit_of_its_own(self, chain_clone):
        notes: list[str] = []
        repo._merge_predecessor_branch(str(chain_clone), "br-S2", notes, no_ff=True)

        head = _git(chain_clone, "rev-parse", "HEAD")
        assert head != _git(chain_clone, "rev-parse", "origin/br-S2")
        assert len(_git(chain_clone, "rev-list", "--parents", "-n", "1", "HEAD").split()) == 3
        assert notes == ["merged predecessor branch 'br-S2'"]

    def test_without_no_ff_the_merge_fast_forwards(self, chain_clone):
        # The #99 hazard the setup's diamond merge now avoids.
        repo._merge_predecessor_branch(str(chain_clone), "br-S2", [])
        assert _git(chain_clone, "rev-parse", "HEAD") == _git(
            chain_clone, "rev-parse", "origin/br-S2"
        )

    def test_setup_merges_a_diamond_s_predecessors_with_no_ff(self, monkeypatch):
        merges: list[tuple[str, bool]] = []
        monkeypatch.setattr(
            repo,
            "_merge_predecessor_branch",
            lambda _d, branch, _n, *, no_ff=False: merges.append((branch, no_ff)),
        )
        from tests.test_repo import _config, _fake_run_cmd, _patch_common

        _patch_common(monkeypatch, _fake_run_cmd())
        monkeypatch.setattr(repo, "detect_default_branch", lambda *_a: "main")
        repo.setup_repo(_config(base_branch="main", merge_branches=["br-S3"]))
        assert merges == [("br-S3", True)]


class _ScriptedRunCmd:
    """``run_cmd`` whose results per label are a queue of ``(returncode, stderr)``."""

    def __init__(self, script: dict[str, list[tuple[int, str]]]) -> None:
        self.calls: list[str] = []
        self._script = {k: list(v) for k, v in script.items()}

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **_kwargs):
        self.calls.append(label)
        queue = self._script.get(label, [(0, "")])
        rc, stderr = queue.pop(0) if len(queue) > 1 else queue[0]
        return SimpleNamespace(returncode=rc, stdout="", stderr=stderr)


_PR = "https://github.com/o/r/pull/75"
_502 = "HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/issues/75/labels)"


@pytest.fixture
def events(monkeypatch) -> list[tuple[str, str]]:
    written: list[tuple[str, str]] = []
    post_hooks.set_event_sink(lambda milestone, details: written.append((milestone, details)))
    return written


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(post_hooks.time, "sleep", slept.append)
    return slept


class TestGhWriteRetryAndEvents:
    def _flag(self, monkeypatch, script) -> tuple[str, _ScriptedRunCmd]:
        run_cmd = _ScriptedRunCmd(script)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        monkeypatch.setattr(post_hooks, "_append_pr_appendix", lambda *_a: None)
        return post_hooks.flag_pr_for_human("/tmp/repo", "o/r", _PR, "why"), run_cmd

    def test_a_5xx_label_add_is_retried_once_after_a_delay(self, monkeypatch, events, sleeps):
        held, run_cmd = self._flag(monkeypatch, {"apply-label": [(1, _502), (0, "")]})
        assert held == "labelled"
        assert run_cmd.calls == ["apply-label", "apply-label"]
        assert sleeps == [post_hooks.GH_RETRY_DELAY_S]
        assert events == [("pr_held", f"labelled (needs-human) {_PR}")]

    def test_a_4xx_is_not_retried(self, monkeypatch, events, sleeps):
        not_found = "HTTP 404: Not Found"
        held, run_cmd = self._flag(monkeypatch, {"apply-label": [(1, not_found), (0, "")]})
        assert held == "labelled"
        # The 404 goes straight to creating the label, with no wait.
        assert run_cmd.calls == ["apply-label", "create-needs-human-label", "apply-label"]
        assert sleeps == []
        assert events[0] == (
            "gh_write_failed",
            f"add label needs-human to {_PR} (rc=1): {not_found}",
        )

    def test_a_label_that_fails_after_the_retry_drafts_the_pr(self, monkeypatch, events, sleeps):
        held, run_cmd = self._flag(monkeypatch, {"apply-label": [(1, _502)]})
        assert held == "draft"
        assert run_cmd.calls[-1] == "draft-flagged-pr"
        assert sleeps == [post_hooks.GH_RETRY_DELAY_S] * 2
        failures = [d for m, d in events if m == "gh_write_failed"]
        assert failures == [f"add label needs-human to {_PR} (rc=1): {_502}"] * 2
        assert events[-1] == ("pr_held", f"draft (needs-human) {_PR}")

    def test_a_failed_body_edit_is_an_event_with_the_error(self, monkeypatch, events, sleeps):
        monkeypatch.setattr(post_hooks.subprocess, "run", lambda *_a, **_k: _ok("body"))
        run_cmd = _ScriptedRunCmd({"append-review-section": [(1, _502)]})
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        post_hooks._append_pr_appendix("/tmp/repo", "o/r", _PR, "## section")
        assert run_cmd.calls == ["append-review-section"] * 2
        assert events == [("gh_write_failed", f"edit the body of {_PR} (rc=1): {_502}")]

    def test_a_failed_status_post_is_an_event_with_the_error(self, monkeypatch, events):
        monkeypatch.setattr(
            post_hooks.subprocess, "run", lambda *_a, **_k: _ok("abcdef1234567890\n")
        )
        monkeypatch.setattr(
            post_hooks,
            "run_cmd",
            _ScriptedRunCmd({"post-review-status": [(1, "HTTP 422: No commit")]}),
        )
        post_hooks.post_review_status("/tmp/repo", "o/r", {"ran": True, "verdict": "READY"})
        assert events == [
            ("gh_write_failed", "post factory/review on abcdef123456 (rc=1): HTTP 422: No commit")
        ]

    def test_the_error_text_has_tokens_redacted(self, monkeypatch, events, sleeps):
        leaked = "HTTP 401: Bad credentials (token ghp_abcdefghijklmnop)"
        self._flag(monkeypatch, {"apply-label": [(1, leaked)], "draft-flagged-pr": [(1, leaked)]})
        assert events
        assert all("ghp_abcdefghijklmnop" not in details for _, details in events)
        assert events[-1] == ("pr_held", f"unheld (needs-human) {_PR}")
