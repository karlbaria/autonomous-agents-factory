"""Cedar confinement for the probe writer (Task 4 — ADR-025 (fork)).

Call 1 runs in a dedicated worktree pinned to the base-branch commit and may
read only there and in its scratch directory, and write only in the scratch
directory. These tests exercise the two new hard-deny rules
(``review_probe_writer_write_outside_scratch`` /
``review_probe_writer_read_outside_allowed_roots``) directly against
``PolicyEngine``, matching the rules to the exact context fields
``policy.py`` sets (``outside_scratch_dir`` / ``outside_allowed_read_roots``).
"""

from __future__ import annotations

from policy import Outcome, PolicyEngine


def _probe_writer_engine(worktree_dir: str, scratch_dir: str) -> PolicyEngine:
    return PolicyEngine(
        task_type="review_probe_writer",
        repo="owner/repo",
        read_only=False,
        allowed_read_roots=[worktree_dir, scratch_dir],
        scratch_write_root=scratch_dir,
    )


class TestProbeWriterWriteConfinement:
    def test_write_inside_scratch_allowed(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Write", {"file_path": str(scratch / "test_probe.py")})
        assert decision.outcome == Outcome.ALLOW

    def test_write_in_worktree_denied(self, tmp_path):
        """The worktree is read-only for Call 1 — it must not write the coder's checkout."""
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use(
            "Write", {"file_path": str(worktree / "app" / "main.py")}
        )
        assert decision.outcome == Outcome.DENY
        assert "review_probe_writer_write_outside_scratch" in decision.reason

    def test_write_elsewhere_denied(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Write", {"file_path": "/etc/passwd"})
        assert decision.outcome == Outcome.DENY

    def test_edit_outside_scratch_also_denied(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Edit", {"file_path": str(worktree / "x.py")})
        assert decision.outcome == Outcome.DENY


class TestProbeWriterReadConfinement:
    def test_read_inside_worktree_allowed(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use(
            "Read", {"file_path": str(worktree / "app" / "main.py")}
        )
        assert decision.outcome == Outcome.ALLOW

    def test_read_inside_scratch_allowed(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Read", {"file_path": str(scratch / "test_probe.py")})
        assert decision.outcome == Outcome.ALLOW

    def test_read_coders_checkout_denied(self, tmp_path):
        """Call 1 must not be able to read the coder's branch/diff."""
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        coder_repo = tmp_path / "coder_repo"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use(
            "Read", {"file_path": str(coder_repo / "app" / "main.py")}
        )
        assert decision.outcome == Outcome.DENY
        assert "review_probe_writer_read_outside_allowed_roots" in decision.reason

    def test_grep_path_outside_allowed_roots_denied(self, tmp_path):
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        coder_repo = tmp_path / "coder_repo"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Grep", {"pattern": "TODO", "path": str(coder_repo)})
        assert decision.outcome == Outcome.DENY

    def test_glob_without_path_not_affected(self, tmp_path):
        """No explicit path — nothing to confine; the normal tool allowlist still applies."""
        worktree = tmp_path / "worktree"
        scratch = tmp_path / "scratch"
        engine = _probe_writer_engine(str(worktree), str(scratch))
        decision = engine.evaluate_tool_use("Glob", {"pattern": "**/*.py"})
        assert decision.outcome == Outcome.ALLOW


class TestRulesAreDormantWithoutConfinement:
    """Every other caller never sets allowed_read_roots/scratch_write_root."""

    def test_ordinary_write_unaffected(self, tmp_path):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=False)
        decision = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert decision.outcome == Outcome.ALLOW

    def test_ordinary_read_unaffected(self, tmp_path):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=False)
        decision = engine.evaluate_tool_use("Read", {"file_path": "/anywhere/at/all.py"})
        assert decision.outcome == Outcome.ALLOW

    def test_code_reviewer_call_has_no_roots_and_reads_freely(self, tmp_path):
        """Call 2 sees the full diff — no path confinement, just read_only (no Write tool)."""
        engine = PolicyEngine(task_type="review_code_reviewer", repo="owner/repo", read_only=True)
        decision = engine.evaluate_tool_use(
            "Read", {"file_path": str(tmp_path / "coder_repo" / "x.py")}
        )
        assert decision.outcome == Outcome.ALLOW
