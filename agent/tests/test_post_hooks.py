"""Unit tests for post_hooks.py — hermetic push/PR logic (no network, no git).

Covers ``ensure_pushed`` push-detection, the ``push_resolve`` push-failure
surface (``_note_unpushed_commits``), and ``ensure_pr`` body assembly basics.
The two seams are ``subprocess.run`` (read-only git/gh queries) and
``shell.run_cmd`` (mutating git/gh commands) — both faked with recorders.
"""

import os
import subprocess
from types import SimpleNamespace

import pytest

import post_hooks
from models import RepoSetup
from tests.conftest import FakeRunCmd, make_task_config

# post_hooks.py keys scripted results off the exact label (FakeRunCmd's default
# exact-match mode), so e.g. returncodes={"push": 1} does not bleed into the
# "note-unpushed-commits" label.
_RunCmdRecorder = FakeRunCmd


def _cp(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class _SubprocessRunRecorder:
    """Fake for ``subprocess.run``: dispatches on a recognizable argv fragment.

    Accepts EITHER a list of (predicate, result) pairs (first match wins) OR a
    single ``responder`` callable ``argv -> CompletedProcess-like``. Default
    result is rc=0, empty stdout.
    """

    def __init__(self, script=None, responder=None):
        self.calls: list[list[str]] = []
        self._script = script or []
        self._responder = responder

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if self._responder is not None:
            return self._responder(cmd)
        for predicate, result in self._script:
            if predicate(cmd):
                return result
        return _cp()


def _pr_view(url: str, base: str = "main") -> _SubprocessRunRecorder:
    """Recorder for the two ``gh pr view`` shapes ensure_pr issues.

    The URL query (``--json url``) returns *url*; the base query
    (``--json baseRefName``, used by ``_reconcile_pr_base``) returns *base*.
    Defaulting *base* to ``main`` matches ``_setup``'s default_branch so the
    reconcile is a no-op unless a test opts into a mismatch.
    """

    def responder(cmd):
        if "view" in cmd and "baseRefName" in cmd:
            return _cp(returncode=0, stdout=base + "\n")
        if "view" in cmd:
            return _cp(returncode=0, stdout=url + "\n")
        return _cp()

    return _SubprocessRunRecorder(responder=responder)


_config = make_task_config


def _setup(**overrides) -> RepoSetup:
    return RepoSetup(
        repo_dir=overrides.pop("repo_dir", "/tmp/repo"),
        branch=overrides.pop("branch", "bgagent/task-xyz/fix"),
        default_branch=overrides.pop("default_branch", "main"),
        **overrides,
    )


class TestEnsurePushed:
    def test_pushes_when_unpushed_commits_exist(self, monkeypatch):
        # git log shows unpushed commits (rc=0, non-empty stdout) -> push runs.
        sub = _SubprocessRunRecorder(
            script=[(lambda c: "log" in c, _cp(returncode=0, stdout="abc def\n"))]
        )
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is True
        assert "push" in run_cmd.labels()

    def test_no_push_when_up_to_date(self, monkeypatch):
        # git log rc=0 with empty stdout -> nothing to push, no push command.
        sub = _SubprocessRunRecorder(script=[(lambda c: "log" in c, _cp(returncode=0, stdout=""))])
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is True
        assert "push" not in run_cmd.labels()

    def test_push_failure_returns_false(self, monkeypatch):
        # Remote branch missing (git log rc!=0) triggers push; push fails.
        sub = _SubprocessRunRecorder(
            script=[(lambda c: "log" in c, _cp(returncode=128, stderr="no upstream"))]
        )
        run_cmd = _RunCmdRecorder(returncodes={"push": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is False
        assert "push" in run_cmd.labels()


class TestPushResolveFailureSurface:
    def test_push_failure_posts_unpushed_note_and_returns_url(self, monkeypatch):
        # ensure_pushed fails -> _note_unpushed_commits posts a PR comment, and
        # the existing PR URL is still returned (the PR exists).
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: False)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )
        assert url == "https://github.com/o/r/pull/9"
        # The un-pushed-commits note was posted as a PR comment.
        assert "note-unpushed-commits" in run_cmd.labels()
        note_cmd = run_cmd.cmd_for("note-unpushed-commits")
        assert "comment" in note_cmd

    def test_failed_note_post_warns_loudly(self, monkeypatch):
        # check=False means run_cmd never raises on a non-zero gh exit, so
        # _note_unpushed_commits must inspect the returncode itself — a
        # failed `gh pr comment` (missing scope, rate limit) was previously
        # a silent no-op while the PR quietly went stale.
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: False)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder(returncodes={"note-unpushed-commits": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        warns: list[str] = []
        monkeypatch.setattr(
            post_hooks, "log", lambda lvl, msg: warns.append(msg) if lvl == "WARN" else None
        )

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )

        # The URL is still returned (PR exists), but the failure to notify
        # the reviewer is surfaced as a WARN naming the consequence.
        assert url == "https://github.com/o/r/pull/9"
        assert any("reviewer has NOT been notified" in w for w in warns)

    def test_push_success_does_not_post_note(self, monkeypatch):
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )
        assert url == "https://github.com/o/r/pull/9"
        assert "note-unpushed-commits" not in run_cmd.labels()

    def test_resolve_strategy_skips_push(self, monkeypatch):
        calls = {"pushed": False}

        def _ensure_pushed(d, b):
            calls["pushed"] = True
            return True

        monkeypatch.setattr(post_hooks, "ensure_pushed", _ensure_pushed)
        sub = _pr_view("https://github.com/o/r/pull/3")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="resolve"
        )
        assert url == "https://github.com/o/r/pull/3"
        assert calls["pushed"] is False


class TestEnsurePrCreate:
    def test_returns_existing_pr_when_already_open(self, monkeypatch):
        # First `gh pr view` returns a URL -> short-circuit, no creation. The
        # existing PR's base ("main") already matches default_branch, so the
        # base reconcile is a no-op (no `gh pr edit`).
        sub = _pr_view("https://github.com/o/r/pull/1", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/1"
        assert "create-pr" not in run_cmd.labels()
        assert "reconcile-pr-base" not in run_cmd.labels()

    def test_pushes_pending_commits_before_returning_existing_pr(self, monkeypatch):
        """Task 4 (ADR-025 (fork)): the coder can push + create the PR itself
        before post-hooks run; a later commit (review_and_fix's probe commit)
        must still reach the remote, not be silently dropped."""

        def responder(cmd):
            if "view" in cmd and "baseRefName" in cmd:
                return _cp(returncode=0, stdout="main\n")
            if "view" in cmd:
                return _cp(returncode=0, stdout="https://github.com/o/r/pull/1\n")
            if "log" in cmd:
                # Unpushed commit exists beyond origin/<branch>.
                return _cp(returncode=0, stdout="abc1234 test: add review probes\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/1"
        assert "push" in run_cmd.labels()

    def test_appends_review_section_to_existing_pr(self, monkeypatch):
        def responder(cmd):
            if "view" in cmd and "baseRefName" in cmd:
                return _cp(returncode=0, stdout="main\n")
            if "view" in cmd and "body" in cmd:
                return _cp(returncode=0, stdout="## Summary\n\nOriginal coder body.\n")
            if "view" in cmd:
                return _cp(returncode=0, stdout="https://github.com/o/r/pull/1\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        review_outcome = {
            "ran": True,
            "verdict": "READY",
            "reviewed_sha": "abc123",
            "probe_results": [],
            "committed_probe_paths": [],
            "findings": [],
            "parse_error": None,
        }
        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            review_outcome=review_outcome,
        )
        assert url == "https://github.com/o/r/pull/1"
        edit_cmd = run_cmd.cmd_for("append-review-section")
        assert edit_cmd is not None
        body = edit_cmd[edit_cmd.index("--body") + 1]
        assert "Original coder body." in body
        assert "Independent review (advisory)" in body
        assert "**Verdict:** READY" in body

    def test_appends_cost_breakdown_with_ledger_alone(self, monkeypatch):
        from models import AgentInvocationLedger

        def responder(cmd):
            if "view" in cmd and "baseRefName" in cmd:
                return _cp(returncode=0, stdout="main\n")
            if "view" in cmd and "body" in cmd:
                return _cp(returncode=0, stdout="## Summary\n\nOriginal coder body.\n")
            if "view" in cmd:
                return _cp(returncode=0, stdout="https://github.com/o/r/pull/1\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.10, turns=5, model="m")
        ledger.record(stage="probe_writer", cost_usd=0.02, turns=2, model="r")
        post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            ledger=ledger,
        )
        edit_cmd = run_cmd.cmd_for("append-review-section")
        assert edit_cmd is not None
        body = edit_cmd[edit_cmd.index("--body") + 1]
        assert "coder: $0.1000" in body
        assert "probe_writer: $0.0200" in body
        assert "Independent review" not in body

    def test_no_review_outcome_does_not_edit_existing_pr(self, monkeypatch):
        sub = _pr_view("https://github.com/o/r/pull/1", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert "append-review-section" not in run_cmd.labels()

    def test_no_commits_means_no_pr(self, monkeypatch):
        # pr view -> empty (no existing PR); git log diff -> empty (no commits).
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd:
                return _cp(returncode=0, stdout="")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )
        assert url is None
        assert "create-pr" not in run_cmd.labels()

    def test_creates_pr_with_body_basics(self, monkeypatch):
        # No existing PR; commits present; gh pr create succeeds.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n\n---")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(issue_number="55"),
            _setup(),
            build_passed=True,
            lint_passed=False,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/42"
        create_cmd = run_cmd.cmd_for("create-pr")
        assert create_cmd is not None
        # PR title derived from first commit subject.
        assert "--title" in create_cmd
        assert create_cmd[create_cmd.index("--title") + 1] == "feat: do the thing"
        # Body carries verification statuses and the issue link.
        body = create_cmd[create_cmd.index("--body") + 1]
        assert "Resolves #55" in body
        assert "**PASS**" in body  # build passed
        assert "**FAIL**" in body  # lint failed

    def test_returns_none_when_pr_creation_fails(self, monkeypatch):
        # No existing PR; commits present; gh pr create exits non-zero.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(returncodes={"create-pr": 1})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )
        assert url is None
        assert run_cmd.cmd_for("create-pr") is not None


class TestEnsurePrReviewSummary:
    """Task 4 (ADR-025 (fork)): the PR body's cost-breakdown + review section."""

    def _create_pr(self, monkeypatch, **ensure_pr_kwargs):
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n\n---")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(),
            _setup(),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            **ensure_pr_kwargs,
        )
        create_cmd = run_cmd.cmd_for("create-pr")
        return create_cmd[create_cmd.index("--body") + 1]

    def test_no_ledger_or_review_outcome_is_unchanged_from_pre_task_4(self, monkeypatch):
        from models import AgentResult

        body = self._create_pr(monkeypatch, agent_result=AgentResult(cost_usd=0.1523))
        assert "Agent cost: **$0.1523**" in body
        assert "Independent review" not in body

    def test_ledger_with_only_coder_stage_shows_single_total(self, monkeypatch):
        from models import AgentInvocationLedger

        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.15, turns=5, model="m")
        body = self._create_pr(monkeypatch, ledger=ledger)
        assert "Agent cost: **$0.1500**" in body
        assert "coder: $" not in body  # no breakdown with only one stage
        assert "Independent review" not in body

    def test_ledger_with_reviewer_stages_shows_breakdown(self, monkeypatch):
        from models import AgentInvocationLedger

        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.10, turns=5, model="m")
        ledger.record(stage="probe_writer", cost_usd=0.01, turns=2, model="r")
        ledger.record(stage="code_reviewer", cost_usd=0.02, turns=3, model="r")
        body = self._create_pr(monkeypatch, ledger=ledger)
        assert "Agent cost: **$0.1300**" in body
        assert "coder: $0.1000" in body
        assert "probe_writer: $0.0100" in body
        assert "code_reviewer: $0.0200" in body

    def test_review_outcome_renders_probes_and_findings(self, monkeypatch):
        from models import AgentInvocationLedger

        ledger = AgentInvocationLedger()
        ledger.record(stage="coder", cost_usd=0.10, turns=5, model="m")
        review_outcome = {
            "ran": True,
            "verdict": "NOT_READY",
            "reviewed_sha": "abc123def4567890",
            "probe_results": [
                {"probe": {"filename": "test_pass.py", "intent": "happy path"}, "passed": True},
                {"probe": {"filename": "test_fail.py", "intent": "known gap"}, "passed": False},
            ],
            "committed_probe_paths": ["tests/review_probes/test_pass.py"],
            "findings": [
                {
                    "type": "issue",
                    "severity": "major",
                    "title": "Missing validation",
                    "description": "No bounds check.",
                    "evidence": "app.py:12",
                }
            ],
            "parse_error": None,
        }
        body = self._create_pr(monkeypatch, ledger=ledger, review_outcome=review_outcome)
        assert "Independent review (advisory)" in body
        assert "**Verdict:** NOT_READY" in body
        assert "abc123def456" in body
        assert "✅ PASS" in body and "test_pass.py" in body

    def test_adversarial_mode_renders_each_round(self, monkeypatch):
        """Task 5 (ADR-026 (fork)): the PR shows every round, each with its
        own fresh probes and verdict — not just the final one."""
        review_outcome = {
            "ran": True,
            "mode": "adversarial",
            "verdict": "READY",
            "unresolved": False,
            "stopped_reason": None,
            "on_unresolved": "pr_with_warning",
            "rounds": [
                {
                    "round_number": 1,
                    "verdict": "NOT_READY",
                    "reviewed_sha": "aaaaaaaaaaaaaaaa",
                    "probe_results": [
                        {
                            "probe": {"filename": "test_divide.py", "intent": "div by zero"},
                            "passed": False,
                        }
                    ],
                    "findings": [
                        {
                            "type": "issue",
                            "severity": "major",
                            "title": "Missing zero check",
                            "description": "divide(a, 0) raises instead of 400",
                            "evidence": "app.py:12",
                        }
                    ],
                    "parse_error": None,
                    "invalid_probes": {},
                    "stale_sha": False,
                    "reverted_probe_paths": [],
                },
                {
                    "round_number": 2,
                    "verdict": "READY",
                    "reviewed_sha": "bbbbbbbbbbbbbbbb",
                    "probe_results": [
                        {
                            "probe": {"filename": "test_divide.py", "intent": "div by zero"},
                            "passed": True,
                        }
                    ],
                    "findings": [],
                    "parse_error": None,
                    "invalid_probes": {},
                    "stale_sha": False,
                    "reverted_probe_paths": [],
                },
            ],
        }
        body = self._create_pr(monkeypatch, review_outcome=review_outcome)
        assert "Independent review (adversarial)" in body
        assert "Round 1" in body and "Round 2" in body
        assert body.index("Round 1") < body.index("Round 2")
        assert "NOT_READY" in body and "READY" in body
        assert "Missing zero check" in body
        assert body.count("test_divide.py") == 2  # once per round's probe list

    def test_adversarial_unresolved_notes_why_the_loop_stopped(self, monkeypatch):
        review_outcome = {
            "ran": True,
            "mode": "adversarial",
            "verdict": "NOT_READY",
            "unresolved": True,
            "stopped_reason": "max_iterations",
            "on_unresolved": "pr_with_warning",
            "rounds": [
                {
                    "round_number": 1,
                    "verdict": "NOT_READY",
                    "reviewed_sha": "aaaaaaaaaaaaaaaa",
                    "probe_results": [],
                    "findings": [],
                    "parse_error": None,
                    "invalid_probes": {},
                    "stale_sha": False,
                    "reverted_probe_paths": [],
                }
            ],
        }
        body = self._create_pr(monkeypatch, review_outcome=review_outcome)
        assert "unresolved" in body.lower()
        assert "max_iterations" in body

    def test_review_outcome_not_ran_renders_nothing(self, monkeypatch):
        body = self._create_pr(
            monkeypatch, review_outcome={"ran": False, "skipped_reason": "budget_exhausted"}
        )
        assert "Independent review" not in body

    def test_review_outcome_parse_error_surfaced_when_no_findings(self, monkeypatch):
        review_outcome = {
            "ran": True,
            "verdict": "NOT_READY",
            "reviewed_sha": "",
            "probe_results": [],
            "committed_probe_paths": [],
            "findings": [],
            "parse_error": "no VERDICT line found",
        }
        body = self._create_pr(monkeypatch, review_outcome=review_outcome)
        assert "could not be parsed: no VERDICT line found" in body


class TestPostReviewStatus:
    """Task 17 (fork) / ADR-028: the ``factory/review`` commit status."""

    def _post(self, monkeypatch, review_outcome, head_sha="deadbeefcafe1234567890"):
        sub = _SubprocessRunRecorder(
            script=[
                (lambda c: c[:2] == ["git", "rev-parse"], _cp(returncode=0, stdout=f"{head_sha}\n"))
            ]
        )
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        post_hooks.post_review_status("/tmp/repo", "owner/repo", review_outcome)
        return run_cmd

    def _description(self, cmd):
        return next(a for a in cmd if a.startswith("description="))

    def test_ready_posts_success_on_current_head(self, monkeypatch):
        run_cmd = self._post(
            monkeypatch,
            {"ran": True, "verdict": "READY", "reviewed_sha": "abc123"},
            head_sha="deadbeefcafe1234567890",
        )
        cmd = run_cmd.cmd_for("post-review-status")
        assert cmd is not None
        assert cmd[2] == "repos/owner/repo/statuses/deadbeefcafe1234567890"
        assert "state=success" in cmd
        assert "context=factory/review" in cmd

    def test_not_ready_posts_failure(self, monkeypatch):
        run_cmd = self._post(
            monkeypatch, {"ran": True, "verdict": "NOT_READY", "reviewed_sha": "abc123"}
        )
        cmd = run_cmd.cmd_for("post-review-status")
        assert "state=failure" in cmd

    def test_description_names_the_actually_reviewed_sha(self, monkeypatch):
        # The status targets the final (post-probes-commit) HEAD, but its
        # description should name whatever Call 2 actually reviewed — which
        # can be an earlier commit on the same branch.
        run_cmd = self._post(
            monkeypatch,
            {"ran": True, "verdict": "READY", "reviewed_sha": "abc123def456"},
            head_sha="deadbeefcafe1234567890",
        )
        cmd = run_cmd.cmd_for("post-review-status")
        assert self._description(cmd) == "description=READY (reviewed abc123def456)"

    def test_adversarial_uses_final_rounds_verdict_and_reviewed_sha(self, monkeypatch):
        review_outcome = {
            "ran": True,
            "mode": "adversarial",
            "rounds": [
                {"round_number": 1, "verdict": "NOT_READY", "reviewed_sha": "aaaaaaaaaaaa"},
                {"round_number": 2, "verdict": "READY", "reviewed_sha": "bbbbbbbbbbbb"},
            ],
        }
        run_cmd = self._post(monkeypatch, review_outcome)
        cmd = run_cmd.cmd_for("post-review-status")
        assert "state=success" in cmd
        assert self._description(cmd) == "description=READY (reviewed bbbbbbbbbbbb)"

    def test_review_not_ran_posts_nothing(self, monkeypatch):
        run_cmd = self._post(monkeypatch, {"ran": False, "skipped_reason": "budget_exhausted"})
        assert "post-review-status" not in run_cmd.labels()

    def test_none_review_outcome_posts_nothing(self, monkeypatch):
        run_cmd = self._post(monkeypatch, None)
        assert "post-review-status" not in run_cmd.labels()

    def test_unresolvable_head_sha_posts_nothing(self, monkeypatch):
        sub = _SubprocessRunRecorder(script=[(lambda c: True, _cp(returncode=128, stderr="bad"))])
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        post_hooks.post_review_status("/tmp/repo", "owner/repo", {"ran": True, "verdict": "READY"})
        assert "post-review-status" not in run_cmd.labels()

    def test_failed_post_warns_and_does_not_raise(self, monkeypatch):
        sub = _SubprocessRunRecorder(
            script=[(lambda c: c[:2] == ["git", "rev-parse"], _cp(returncode=0, stdout="abc\n"))]
        )
        run_cmd = _RunCmdRecorder(returncodes={"post-review-status": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        warns: list[str] = []
        monkeypatch.setattr(
            post_hooks, "log", lambda lvl, msg: warns.append(msg) if lvl == "WARN" else None
        )

        post_hooks.post_review_status("/tmp/repo", "owner/repo", {"ran": True, "verdict": "READY"})

        assert any("factory/review" in w for w in warns)

    def test_ready_over_waived_probes_says_so(self, monkeypatch):
        # #97: a READY whose failing probes were all waived isn't a clean pass.
        review_outcome = {
            "ran": True,
            "verdict": "READY",
            "reviewed_sha": "abc123def456",
            "probe_results": [_waivable("a.test.js", "frontend"), _waivable("b.test.js")],
            "invalid_probes": {"a.test.js": "x", "b.test.js": "y"},
        }
        run_cmd = self._post(monkeypatch, review_outcome)
        cmd = run_cmd.cmd_for("post-review-status")
        assert self._description(cmd) == (
            "description=READY — 2/2 failing probes marked invalid (reviewed abc123def456)"
        )


def _waivable(filename: str, package_dir: str = "", *, passed: bool = False) -> dict:
    return {
        "probe": {"filename": filename, "package_dir": package_dir, "intent": "does a thing"},
        "passed": passed,
        "runnable": True,
        "output": "",
    }


class TestWaiversShownInTheReviewSection:
    """#97: a waived probe says so on its own line; a refusal is shown."""

    def _section(self, round_outcome: dict) -> str:
        return post_hooks._review_section({"ran": True, "mode": "advisory", **round_outcome})

    def test_a_waived_failure_shows_its_reason_on_the_line(self):
        body = self._section(
            {
                "verdict": "READY",
                "probe_results": [
                    _waivable("a.test.js", "frontend"),
                    _waivable("ok.test.js", passed=True),
                ],
                "invalid_probes": {"frontend/a.test.js": "spec text dropped the underscores"},
            }
        )
        assert (
            "- ❌ FAIL (marked invalid: spec text dropped the underscores) `frontend/a.test.js`"
            in body
        )
        assert "- ✅ PASS `ok.test.js`" in body

    def test_an_unwaived_failure_is_a_plain_fail(self):
        body = self._section(
            {
                "verdict": "NOT_READY",
                "probe_results": [_waivable("a.test.js")],
                "invalid_probes": {},
            }
        )
        assert "- ❌ FAIL `a.test.js`" in body

    def test_a_refused_ready_is_shown_next_to_findings(self):
        body = self._section(
            {
                "verdict": "NOT_READY",
                "probe_results": [_waivable("a.test.js")],
                "findings": [
                    {"type": "comment", "title": "t", "description": "d", "evidence": "e"}
                ],
                "parse_error": "READY refused: failing probe(s) not marked invalid: `a.test.js`",
            }
        )
        assert "**Findings:**" in body
        assert "⚠️ READY refused: failing probe(s) not marked invalid: `a.test.js`" in body
        assert "could not be parsed" not in body

    def test_a_parse_error_is_shown_even_with_findings(self):
        body = self._section(
            {
                "verdict": "NOT_READY",
                "findings": [
                    {"type": "comment", "title": "t", "description": "d", "evidence": "e"}
                ],
                "parse_error": "reviewer hit the 30-turn limit before writing a verdict",
            }
        )
        assert (
            "_Review output could not be parsed: reviewer hit the 30-turn limit "
            "before writing a verdict_" in body
        )


class TestEnsurePrPostsReviewStatus:
    """``ensure_pr`` posts ``factory/review`` on both its PR paths."""

    def test_fresh_create_posts_review_status(self, monkeypatch):
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n\n---")
            if cmd[:2] == ["git", "rev-parse"]:
                return _cp(returncode=0, stdout="cafefeed1234\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(),
            _setup(),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            review_outcome={"ran": True, "verdict": "READY", "reviewed_sha": "abc123"},
        )
        status_cmd = run_cmd.cmd_for("post-review-status")
        assert status_cmd is not None
        assert "state=success" in status_cmd

    def test_existing_pr_posts_review_status(self, monkeypatch):
        def responder(cmd):
            if "view" in cmd and "baseRefName" in cmd:
                return _cp(returncode=0, stdout="main\n")
            if "view" in cmd and "body" in cmd:
                return _cp(returncode=0, stdout="## Summary\n\nOriginal coder body.\n")
            if "view" in cmd:
                return _cp(returncode=0, stdout="https://github.com/o/r/pull/1\n")
            if cmd[:2] == ["git", "rev-parse"]:
                return _cp(returncode=0, stdout="cafefeed1234\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
            review_outcome={"ran": True, "verdict": "NOT_READY", "reviewed_sha": "abc123"},
        )
        status_cmd = run_cmd.cmd_for("post-review-status")
        assert status_cmd is not None
        assert "state=failure" in status_cmd

    def test_no_review_outcome_posts_no_status(self, monkeypatch):
        sub = _pr_view("https://github.com/o/r/pull/1", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert "post-review-status" not in run_cmd.labels()


class TestApplyUnresolvedLabel:
    """Task 5 (ADR-026 (fork)): on_unresolved: pr_with_warning labels the PR."""

    def test_adds_the_label_best_effort(self, monkeypatch):
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.apply_unresolved_label(
            "/tmp/repo", "owner/repo", "https://github.com/o/r/pull/1"
        )

        cmd = run_cmd.cmd_for("apply-unresolved-label")
        assert cmd is not None
        assert "--add-label" in cmd and "review:unresolved" in cmd

    def test_failure_is_non_fatal(self, monkeypatch):
        run_cmd = _RunCmdRecorder(returncodes={"apply-unresolved-label": 1})
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        # Must not raise even though the gh call fails.
        post_hooks.apply_unresolved_label(
            "/tmp/repo", "owner/repo", "https://github.com/o/r/pull/1"
        )


class TestExtractAgentNotes:
    """``_extract_agent_notes`` reads the "## Agent notes" section of the PR body."""

    @pytest.mark.parametrize(
        ("body", "expected"),
        [
            (
                "## Summary\nDone.\n\n## Agent notes\nRetried the build once.\n\n## Tests\nok\n",
                "Retried the build once.",
            ),
            ("## Summary\nDone.\n", None),  # no such section
        ],
    )
    def test_returns_the_section_text_or_none(self, monkeypatch, body, expected):
        sub = _SubprocessRunRecorder(responder=lambda _cmd: _cp(stdout=body))
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)

        assert post_hooks._extract_agent_notes("/repo", "bgagent/t/x", _config()) == expected
        assert sub.calls, "the PR body is read with `gh pr view`"


class TestReconcileAgentBranch:
    """A leading cause of lost deliverables: reconcile the platform branch when
    the agent committed on its OWN branch instead of the pre-checked-out
    platform branch.

    Real git (tmp_path) — this is pure git plumbing, so a real repo gives far
    higher confidence than faking subprocess. The two seams (subprocess.run for
    the branch read, run_cmd for the mutating ops) both hit the tmp repo."""

    # Repo-LOCATION vars. An explicit GIT_DIR overrides repository discovery
    # outright, so it beats cwd, HOME, the GIT_CONFIG_* pins and `--local`
    # alike. Git exports these to hooks in a LINKED WORKTREE (unset in a normal
    # repo), which is exactly how this suite runs as a pre-push gate from
    # .worktrees/.
    _GIT_LOCATION_VARS = (
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
    )

    @pytest.fixture(autouse=True)
    def _clear_ambient_git_location(self, monkeypatch):
        """Strip repo-location vars for the whole class (#720).

        Not just for the fixture helpers: ``post_hooks`` itself shells out to
        git with the ambient environment (e.g. ``_current_branch``), so an
        inherited GIT_DIR would point PRODUCTION code at the real repo instead
        of the tmp one — the assertions would silently describe the wrong
        repository.
        """
        for var in self._GIT_LOCATION_VARS:
            monkeypatch.delenv(var, raising=False)

    @staticmethod
    def _isolated_env(repo):
        # Hard-isolate from the developer's real git identity (#720). `cwd` alone
        # is NOT containment: a bare `git config` walks up to the nearest
        # enclosing repo, and `git init` at a linked-worktree root re-inits the
        # SHARED .git rather than creating a nested one — so both can write
        # straight into the real .git/config. Pinning the HOME/config env vars
        # means even a transcribed `git config user.email` cannot escape tmp.
        #
        # Dropping the repo-LOCATION vars first is load-bearing, not tidiness.
        # An explicit GIT_DIR overrides repository discovery outright, so it
        # defeats cwd, HOME and the GIT_CONFIG_* pins together — and `--local`
        # resolves relative to it, so that is no defence either. Git exports
        # GIT_DIR to hooks in a LINKED WORKTREE (it is unset in a normal repo),
        # which is exactly how this suite runs as a pre-push gate from
        # .worktrees/: inheriting it re-opens #720 and additionally stamps
        # `bare = true` on the real repo.
        env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in {
                "GIT_DIR",
                "GIT_COMMON_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_PREFIX",
            }
        }
        env.update(
            {
                "HOME": str(repo),
                "XDG_CONFIG_HOME": str(repo),
                "GIT_CONFIG_GLOBAL": os.path.join(str(repo), ".gitconfig-test"),
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "ABCA Test",
                "GIT_AUTHOR_EMAIL": "abca-test@example.invalid",
                "GIT_COMMITTER_NAME": "ABCA Test",
                "GIT_COMMITTER_EMAIL": "abca-test@example.invalid",
            }
        )
        return env

    def _git(self, repo, *args):
        subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        )

    def _make_repo(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q")
        # RFC-2606 reserved domain, and --local so the write cannot escape this
        # repo even if the enclosing-repo fallback above is ever reintroduced.
        self._git(repo, "config", "--local", "user.email", "abca-test@example.invalid")
        self._git(repo, "config", "--local", "user.name", "ABCA Test")
        (repo / "f.txt").write_text("base\n")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "base")
        # Rename default branch to a stable name for the test.
        self._git(repo, "branch", "-M", "main")
        return str(repo)

    def test_fixture_cannot_touch_an_outer_repo_even_with_git_dir_set(self, tmp_path, monkeypatch):
        """Regression guard for #720: the fixture must stay contained when a
        repo-location var is present in the ambient environment.

        Git exports GIT_DIR to hooks in a linked worktree, which is how this
        suite runs as a pre-push gate. An inherited GIT_DIR overrides repository
        discovery entirely, so it beats cwd/HOME/GIT_CONFIG_* *and* `--local` —
        the fixture would re-init and rewrite the real shared repo. Fails if
        _git ever stops stripping those vars."""
        outer = tmp_path / "outer"
        outer.mkdir()
        # Build the stand-in "real" repo with the location vars still cleared by
        # the autouse fixture, so this setup lands in tmp and not the actual repo.
        subprocess.run(["git", "init", "-q"], cwd=outer, check=True, capture_output=True)
        sentinel_config = outer / ".git" / "config"
        subprocess.run(
            ["git", "config", "--local", "user.email", "sentinel@example.invalid"],
            cwd=outer,
            check=True,
            capture_output=True,
        )
        before = sentinel_config.read_text()

        # Exactly what a pre-push hook in a linked worktree hands us.
        monkeypatch.setenv("GIT_DIR", str(outer / ".git"))
        monkeypatch.setenv("GIT_WORK_TREE", str(outer))

        self._make_repo(tmp_path)

        assert sentinel_config.read_text() == before, (
            "fixture escaped into the outer repo — _git must strip GIT_DIR/"
            "GIT_WORK_TREE before overlaying its pins (#720)"
        )

    def _head_sha(self, repo):
        # Same isolated env as _git: an inherited GIT_DIR would make this read
        # the REAL repo's HEAD instead of the fixture's.
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        ).stdout.strip()

    def _sha_of(self, repo, ref):
        return subprocess.run(
            ["git", "rev-parse", ref],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        ).stdout.strip()

    def test_reconciles_when_agent_on_own_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        # Platform creates its (empty) branch, as setup_repo does.
        self._git(repo, "checkout", "-qb", platform)
        # Agent goes rogue: its own branch + a commit (the case observed in practice).
        self._git(repo, "checkout", "-qb", "agent-own-branch")
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        agent_head = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is True
        # Platform branch now points at the agent's commit …
        assert self._sha_of(repo, platform) == agent_head
        # … and it is the checked-out branch, so downstream delivery uses it.
        assert post_hooks._current_branch(repo) == platform

    def test_noop_when_already_on_platform_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\non platform\n")
        self._git(repo, "commit", "-qam", "work on platform")
        before = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is False
        assert self._sha_of(repo, platform) == before
        assert post_hooks._current_branch(repo) == platform

    def test_noop_on_detached_head(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        # Detach HEAD at the current commit.
        self._git(repo, "checkout", "-q", "--detach")

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is False  # nothing to adopt

    def test_current_branch_reports_none_when_detached(self, tmp_path):
        repo = self._make_repo(tmp_path)
        self._git(repo, "checkout", "-q", "--detach")
        assert post_hooks._current_branch(repo) is None


class TestReconcilePrBase:
    """The agent picks its own PR --base; ensure_pr corrects it deterministically
    to setup.default_branch (the orchestrator's base for a stacked child / the
    detected repo default for a root). Observed in practice on an orchestrated
    chain (#247): a stacked child + a root both opened against a wrong 'main'."""

    def test_retargets_when_base_mismatches(self, monkeypatch):
        # Existing PR is based on 'main' but the stacked child's real base is
        # the predecessor branch -> ensure_pr issues `gh pr edit --base <pred>`.
        pred = "bgagent/task-x/abca-1-predecessor"
        sub = _pr_view("https://github.com/o/r/pull/7", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert "reconcile-pr-base" in run_cmd.labels()
        edit_cmd = run_cmd.cmd_for("reconcile-pr-base")
        assert "edit" in edit_cmd
        assert edit_cmd[edit_cmd.index("--base") + 1] == pred

    def test_noop_when_base_matches(self, monkeypatch):
        # PR base already == default_branch -> no `gh pr edit`.
        sub = _pr_view("https://github.com/o/r/pull/7", base="develop")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="develop"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert "reconcile-pr-base" not in run_cmd.labels()

    def test_retarget_failure_warns_and_is_not_fatal(self, monkeypatch):
        # `gh pr edit` fails -> WARN naming the consequence, URL still returned.
        pred = "bgagent/task-x/abca-1-predecessor"
        sub = _pr_view("https://github.com/o/r/pull/7", base="main")
        run_cmd = _RunCmdRecorder(returncodes={"reconcile-pr-base": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        warns: list[str] = []
        monkeypatch.setattr(
            post_hooks, "log", lambda lvl, msg: warns.append(msg) if lvl == "WARN" else None
        )

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert any("PR remains based on 'main'" in w for w in warns)

    def test_reconcile_skipped_for_freshly_created_pr_path(self, monkeypatch):
        # When the agent did NOT pre-create the PR, ensure_pr creates it with the
        # correct --base directly; no separate reconcile needed (create path
        # already uses default_branch). Guards against double-work.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: x\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: x\n\n---")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/8\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        pred = "bgagent/task-x/abca-1-predecessor"
        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/8"
        # create path used the right base; no post-creation reconcile fired.
        create_cmd = run_cmd.cmd_for("create-pr")
        assert create_cmd[create_cmd.index("--base") + 1] == pred
        assert "reconcile-pr-base" not in run_cmd.labels()
