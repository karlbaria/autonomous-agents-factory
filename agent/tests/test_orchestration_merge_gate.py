"""Merge gate for orchestration child PRs (#89).

Only the integration PR of a multi-story build is meant to reach main:

- a story PR (``channel_metadata.orchestration_stacked == "true"``) is labelled
  ``factory-stacked``, which factory-shop's watchdog never merges;
- a child built on a flagged predecessor (its base branch's PR, or a merged-in
  predecessor's PR, is labelled ``needs-human``) inherits ``needs-human`` with
  "Inherited from #N" in its body. That includes the integration PR.

Both happen before the ``factory/review`` status is posted, so the watchdog
never sees a green PR that is about to be held.
"""

import json
from types import SimpleNamespace

import post_hooks
from models import RepoSetup
from tests.conftest import FakeRunCmd, make_task_config

_PR = "https://github.com/o/r/pull/12"
_ORCH = {"orchestration_id": "orch_abc", "orchestration_sub_issue_id": "S2"}


def _pr_list(flagged: dict[str, int], calls: list[list[str]]):
    """A ``subprocess.run`` fake: ``gh pr list --head <b>`` reports ``flagged[b]``.

    Records each argv in ``calls``.
    """

    def run(cmd, **_kwargs):
        calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "list"]:
            branch = cmd[cmd.index("--head") + 1]
            prs = (
                [{"number": flagged[branch], "labels": [{"name": "needs-human"}]}]
                if branch in flagged
                else [{"number": 7, "labels": [{"name": "factory-stacked"}]}]
            )
            return SimpleNamespace(returncode=0, stdout=json.dumps(prs), stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return run


def _hold(monkeypatch, *, flagged=None, **config):
    run_cmd = FakeRunCmd()
    appended: list[str] = []
    sub: list[list[str]] = []
    monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
    monkeypatch.setattr(post_hooks.subprocess, "run", _pr_list(flagged or {}, sub))
    monkeypatch.setattr(
        post_hooks, "_append_pr_appendix", lambda _d, _r, _p, text: appended.append(text)
    )
    post_hooks.hold_orchestration_pr("/tmp/repo", make_task_config(**config), _PR, "main")
    added = [
        c["cmd"][c["cmd"].index("--add-label") + 1]
        for c in run_cmd.calls
        if "--add-label" in c["cmd"]
    ]
    return added, appended, sub


class TestStackedLabel:
    def test_a_story_pr_is_labelled_factory_stacked(self, monkeypatch):
        added, appended, _ = _hold(
            monkeypatch, channel_metadata={**_ORCH, "orchestration_stacked": "true"}
        )
        assert added == ["factory-stacked"]
        assert appended == []

    def test_the_integration_pr_is_not_labelled(self, monkeypatch):
        added, _, _ = _hold(
            monkeypatch,
            channel_metadata={**_ORCH, "orchestration_base_branch": "main"},
            base_branch="main",
            merge_branches=["br-S1", "br-S2"],
        )
        assert added == []

    def test_a_task_outside_an_orchestration_is_untouched(self, monkeypatch):
        # The flag alone, without an orchestration id, does nothing either.
        added, _, sub = _hold(
            monkeypatch, channel_metadata={"orchestration_stacked": "true"}, base_branch="br-x"
        )
        assert added == []
        assert sub == []

    def test_a_label_that_cannot_be_applied_is_created_then_the_pr_drafted(self, monkeypatch):
        run_cmd = FakeRunCmd(returncodes={"apply-label": 1})
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        monkeypatch.setattr(post_hooks.subprocess, "run", _pr_list({}, []))
        post_hooks.hold_orchestration_pr(
            "/tmp/repo",
            make_task_config(channel_metadata={**_ORCH, "orchestration_stacked": "true"}),
            _PR,
            "main",
        )
        assert run_cmd.labels() == [
            "apply-label",
            "create-factory-stacked-label",
            "apply-label",
            "draft-flagged-pr",
        ]


class TestInheritedNeedsHuman:
    def test_s2_inherits_the_flag_on_s1_through_its_base_branch(self, monkeypatch):
        added, appended, _ = _hold(
            monkeypatch,
            flagged={"br-S1": 101},
            channel_metadata={**_ORCH, "orchestration_stacked": "true"},
            base_branch="br-S1",
        )
        assert added == ["factory-stacked", "needs-human"]
        assert len(appended) == 1
        assert "- Inherited from #101: this PR builds on #101" in appended[0]

    def test_the_integration_pr_inherits_through_a_merged_in_predecessor(self, monkeypatch):
        added, appended, sub = _hold(
            monkeypatch,
            flagged={"br-S2": 102},
            channel_metadata=_ORCH,
            base_branch="main",
            merge_branches=["br-S1", "br-S2"],
        )
        assert added == ["needs-human"]
        assert "Inherited from #102" in appended[0]
        # main is never looked up as a predecessor.
        heads = [c[c.index("--head") + 1] for c in sub]
        assert heads == ["br-S1", "br-S2"]

    def test_an_unflagged_predecessor_passes_nothing_on(self, monkeypatch):
        added, appended, _ = _hold(
            monkeypatch,
            channel_metadata=_ORCH,
            base_branch="main",
            merge_branches=["br-S1"],
        )
        assert added == []
        assert appended == []

    def test_an_unreadable_pr_list_holds_the_pr_too(self, monkeypatch):
        # Fail closed: a flagged predecessor can't be ruled out.
        run_cmd = FakeRunCmd()
        appended: list[str] = []
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        monkeypatch.setattr(
            post_hooks.subprocess,
            "run",
            lambda *_a, **_k: SimpleNamespace(returncode=1, stdout="", stderr="boom"),
        )
        monkeypatch.setattr(
            post_hooks, "_append_pr_appendix", lambda _d, _r, _p, text: appended.append(text)
        )
        post_hooks.hold_orchestration_pr(
            "/tmp/repo", make_task_config(channel_metadata=_ORCH, base_branch="br-S1"), _PR, "main"
        )
        assert run_cmd.labels() == ["apply-label"]
        assert "needs-human" in run_cmd.calls[0]["cmd"]
        assert "Could not check whether the PR of `br-S1`" in appended[0]


class TestEnsurePrHoldsBeforeTheReviewStatus:
    def test_the_hold_runs_before_post_review_status(self, monkeypatch):
        order: list[str] = []

        def run(cmd, **_kwargs):
            if "view" in cmd and "baseRefName" in cmd:
                return SimpleNamespace(returncode=0, stdout="br-S1\n", stderr="")
            if "view" in cmd:
                return SimpleNamespace(returncode=0, stdout=_PR + "\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(post_hooks.subprocess, "run", run)
        monkeypatch.setattr(post_hooks, "run_cmd", FakeRunCmd())
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda *_a: True)
        monkeypatch.setattr(post_hooks, "hold_orchestration_pr", lambda *_a: order.append("hold"))
        monkeypatch.setattr(
            post_hooks, "post_review_status", lambda *_a: order.append("review-status")
        )
        url = post_hooks.ensure_pr(
            make_task_config(channel_metadata={**_ORCH, "orchestration_stacked": "true"}),
            RepoSetup(repo_dir="/tmp/repo", branch="br-S2", default_branch="br-S1"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == _PR
        assert order == ["hold", "review-status"]
