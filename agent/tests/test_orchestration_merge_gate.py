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
from typing import ClassVar

import post_hooks
from models import RepoSetup
from tests.conftest import FakeRunCmd, make_task_config

_PR = "https://github.com/o/r/pull/12"
_ORCH = {"orchestration_id": "orch_abc", "orchestration_sub_issue_id": "S2"}


#: ``review`` value for a commit whose status can't be read (``gh api`` fails).
_UNREADABLE = "unreadable"


def _pr_list(
    flagged: dict[str, int],
    calls: list[list[str]],
    review: dict[str, str | None] | None = None,
    labels: dict[str, list[str]] | None = None,
):
    """A ``subprocess.run`` fake: ``gh pr list --head <b>`` reports ``flagged[b]``.

    Every PR's head is ``sha-<branch>``. ``gh api …/commits/sha-<b>/status``
    reports a ``factory/review`` status with state ``review[b]`` (default
    ``success``; ``None`` for no status, :data:`_UNREADABLE` for a failed
    read). ``labels[b]`` replaces the PR's labels. Records each argv in ``calls``.
    """
    review = review or {}
    labels = labels or {}

    def run(cmd, **_kwargs):
        calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "list"]:
            branch = cmd[cmd.index("--head") + 1]
            if branch in flagged:
                number, names = flagged[branch], ["needs-human"]
            else:
                number, names = 7, ["factory-stacked"]
            prs = [
                {
                    "number": number,
                    "labels": [{"name": n} for n in labels.get(branch, names)],
                    "headRefOid": f"sha-{branch}",
                }
            ]
            return SimpleNamespace(returncode=0, stdout=json.dumps(prs), stderr="")
        if cmd[:2] == ["gh", "api"] and cmd[2].endswith("/status"):
            branch = cmd[2].split("/commits/sha-", 1)[1].removesuffix("/status")
            state = review.get(branch, "success")
            if state == _UNREADABLE:
                return SimpleNamespace(returncode=1, stdout="", stderr="HTTP 502")
            statuses = (
                []
                if state is None
                else [
                    {
                        "context": "factory/review",
                        "state": state,
                        "description": f"{'READY' if state == 'success' else 'NOT_READY'} "
                        "(reviewed abc)",
                    }
                ]
            )
            body = {"statuses": [{"context": "ci", "state": "success"}, *statuses]}
            return SimpleNamespace(returncode=0, stdout=json.dumps(body), stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return run


def _hold(monkeypatch, *, flagged=None, review=None, labels=None, review_ran=False, **config):
    run_cmd = FakeRunCmd()
    appended: list[str] = []
    sub: list[list[str]] = []
    monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
    monkeypatch.setattr(post_hooks.subprocess, "run", _pr_list(flagged or {}, sub, review, labels))
    monkeypatch.setattr(
        post_hooks, "_append_pr_appendix", lambda _d, _r, _p, text: appended.append(text)
    )
    post_hooks.hold_orchestration_pr(
        "/tmp/repo", make_task_config(**config), _PR, review_ran=review_ran
    )
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
        heads = [c[c.index("--head") + 1] for c in sub if c[:3] == ["gh", "pr", "list"]]
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
            "/tmp/repo", make_task_config(channel_metadata=_ORCH, base_branch="br-S1"), _PR
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
        monkeypatch.setattr(
            post_hooks, "hold_orchestration_pr", lambda *_a, **_k: order.append("hold")
        )
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


class TestInheritedNotReady:
    """#97: a predecessor whose review ended NOT_READY holds the integration PR.

    On the shopping-bag build, story PR factory-shop#67 ended NOT_READY and
    its ``review:unresolved`` label failed to apply, yet the integration step
    ran and posted READY on its own commit.
    """

    _INTEGRATION: ClassVar[dict] = {
        "channel_metadata": _ORCH,
        "base_branch": "main",
        "merge_branches": ["br-S1", "br-S2"],
    }

    def test_a_failure_status_holds_the_integration_pr(self, monkeypatch):
        added, appended, _ = _hold(monkeypatch, review={"br-S2": "failure"}, **self._INTEGRATION)
        assert added == ["needs-human"]
        assert (
            "Inherited from #7: this PR builds on #7, whose independent review ended "
            "NOT_READY (`factory/review`: NOT_READY (reviewed abc))." in appended[0]
        )

    def test_the_unresolved_label_holds_without_reading_the_status(self, monkeypatch):
        added, appended, sub = _hold(
            monkeypatch,
            labels={"br-S1": ["factory-stacked", "review:unresolved"]},
            **self._INTEGRATION,
        )
        assert added == ["needs-human"]
        assert "labelled `review:unresolved`" in appended[0]
        assert not any(c[:2] == ["gh", "api"] for c in sub)

    def test_success_statuses_hold_nothing(self, monkeypatch):
        added, appended, sub = _hold(monkeypatch, review_ran=True, **self._INTEGRATION)
        assert added == []
        assert appended == []
        statuses = [c[2] for c in sub if c[:2] == ["gh", "api"]]
        assert statuses == [
            "repos/owner/repo/commits/sha-br-S1/status",
            "repos/owner/repo/commits/sha-br-S2/status",
        ]

    def test_an_unreadable_status_holds(self, monkeypatch):
        added, appended, _ = _hold(monkeypatch, review={"br-S1": _UNREADABLE}, **self._INTEGRATION)
        assert added == ["needs-human"]
        assert "Could not read the independent review status of #7" in appended[0]

    def test_a_missing_status_holds_when_this_task_ran_a_review(self, monkeypatch):
        added, appended, _ = _hold(
            monkeypatch, review={"br-S1": None}, review_ran=True, **self._INTEGRATION
        )
        assert added == ["needs-human"]
        assert "which has no `factory/review` status" in appended[0]

    def test_a_missing_status_holds_nothing_without_a_review(self, monkeypatch):
        added, appended, _ = _hold(monkeypatch, review={"br-S1": None}, **self._INTEGRATION)
        assert added == []
        assert appended == []

    def test_a_pending_status_holds(self, monkeypatch):
        # Anything but success: the predecessor's review hasn't passed.
        added, _, _ = _hold(monkeypatch, review={"br-S1": "pending"}, **self._INTEGRATION)
        assert added == ["needs-human"]

    def test_a_flagged_predecessor_still_wins_over_its_status(self, monkeypatch):
        _, appended, _ = _hold(
            monkeypatch, flagged={"br-S1": 101}, review={"br-S1": "failure"}, **self._INTEGRATION
        )
        assert "which is labelled `needs-human`" in appended[0]


class TestHoldBeforeStatus:
    """#97: every hold is applied before ``factory/review`` is posted."""

    def _run(self, monkeypatch, review_outcome, **config):
        order: list[str] = []
        flagged: list[str] = []
        monkeypatch.setattr(
            post_hooks,
            "flag_pr_for_human",
            lambda _d, _r, _p, reason: (
                (order.append("needs-human"), flagged.append(reason))[0] or "labelled"
            ),
        )
        monkeypatch.setattr(
            post_hooks,
            "hold_orchestration_pr",
            lambda *_a, **k: order.append(f"orchestration review_ran={k['review_ran']}"),
        )
        post_hooks.hold_pr_before_status(
            "/tmp/repo", make_task_config(**config), _PR, review_outcome
        )
        return order, flagged

    def test_ready_with_no_independent_verification_is_held(self, monkeypatch):
        outcome = {
            "ran": True,
            "mode": "advisory",
            "verdict": "READY",
            "no_independent_verification": True,
            "probe_results": [
                {"probe": {"filename": "a.test.js"}, "passed": False, "runnable": True},
                {"probe": {"filename": "b.test.js"}, "passed": False, "runnable": True},
            ],
            "invalid_probes": {"a.test.js": "x", "b.test.js": "y"},
        }
        order, flagged = self._run(monkeypatch, outcome)
        assert order == ["needs-human", "orchestration review_ran=True"]
        assert "every probe that failed (2) was marked invalid and none passed" in flagged[0]

    def test_a_partial_waiver_is_not_held(self, monkeypatch):
        outcome = {"ran": True, "verdict": "READY", "no_independent_verification": False}
        order, flagged = self._run(monkeypatch, outcome)
        assert order == ["orchestration review_ran=True"]
        assert flagged == []

    def test_no_review_means_review_ran_false(self, monkeypatch):
        order, _ = self._run(monkeypatch, None)
        assert order == ["orchestration review_ran=False"]
