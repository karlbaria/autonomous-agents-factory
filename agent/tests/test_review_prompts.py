"""Tests for the reviewer prompt builders."""

from __future__ import annotations

from review.findings import Finding
from review.probes import Probe, ProbeResult
from review.prompts import (
    CODE_REVIEWER_SYSTEM_PROMPT,
    code_reviewer_user_prompt,
    fixer_user_prompt,
    probe_writer_user_prompt,
)
from review.signatures import PublicSignature


class TestProbeWriterUserPrompt:
    def test_includes_issue_text_and_scratch_dir(self):
        prompt = probe_writer_user_prompt("Add a /gcd endpoint", [], "/tmp/scratch")
        assert "Add a /gcd endpoint" in prompt
        assert "/tmp/scratch" in prompt
        assert "New interface" not in prompt

    def test_includes_signatures_when_present(self):
        sigs = [PublicSignature(name="gcd", signature="def gcd(a, b):", file="app.py")]
        prompt = probe_writer_user_prompt("Add an endpoint", sigs, "/tmp/scratch")
        assert "New interface" in prompt
        assert "def gcd(a, b):" in prompt


class TestCodeReviewerUserPrompt:
    def test_includes_diff_and_issue(self):
        prompt = code_reviewer_user_prompt("Add a /gcd endpoint", "diff --git a/x\n", [])
        assert "Add a /gcd endpoint" in prompt
        assert "diff --git a/x" in prompt
        assert "no probes were written" in prompt

    def test_default_block_on_severity_is_major(self):
        prompt = code_reviewer_user_prompt("task", "diff", [])
        assert "major" in prompt

    def test_block_on_severity_is_configurable(self):
        prompt = code_reviewer_user_prompt("task", "diff", [], block_on_severity="critical")
        assert "critical" in prompt

    def test_includes_probe_pass_fail(self):
        results = [
            ProbeResult(
                probe=Probe(id="p1", intent="gcd(0,n)==n", filename="test_p1.py", source="x"),
                passed=True,
                output="1 passed",
            ),
            ProbeResult(
                probe=Probe(id="p2", intent="gcd(12,8)==4", filename="test_p2.py", source="x"),
                passed=False,
                output="1 failed",
            ),
        ]
        prompt = code_reviewer_user_prompt("task", "diff", results)
        assert "test_p1.py" in prompt and "PASS" in prompt
        assert "test_p2.py" in prompt and "FAIL" in prompt


class TestCodeReviewerSystemPromptTypeSeverityDisambiguation:
    """Regression: autonomous-agents-factory#19 — the reviewer wrote a severity
    word ("minor") into the "type" field. The system prompt must state, with an
    example, that "type" and "severity" are separate fields and that "type" is
    never a severity word."""

    def test_states_type_and_severity_are_separate_fields(self):
        assert '"type" and "severity"' in CODE_REVIEWER_SYSTEM_PROMPT
        assert "SEPARATE fields" in CODE_REVIEWER_SYSTEM_PROMPT

    def test_names_the_four_valid_types_and_excludes_severity_words_from_them(self):
        for finding_type in ("issue", "comment", "question", "good_point"):
            assert f"`{finding_type}`" in CODE_REVIEWER_SYSTEM_PROMPT
        assert "never `minor`, `medium`, `major`, or `critical`" in CODE_REVIEWER_SYSTEM_PROMPT


class TestFixerUserPrompt:
    """Task 5 amendment 3 (ADR-026 (fork)): the fixer's prompt includes the
    original issue, not just the findings and failing probes — it needs the
    same requirements Call 1 and Call 2 are grading against."""

    def test_includes_issue_text(self):
        prompt = fixer_user_prompt("Add a /divide endpoint", [], [])
        assert "Add a /divide endpoint" in prompt

    def test_includes_blocking_findings_with_evidence(self):
        finding = Finding(
            id="finding-1",
            type="issue",
            severity="major",
            title="Missing zero-division check",
            description="divide(a, 0) raises ZeroDivisionError instead of 400",
            evidence="app.py:12",
        )
        prompt = fixer_user_prompt("task", [finding], [])
        assert "Missing zero-division check" in prompt
        assert "app.py:12" in prompt

    def test_includes_failing_probe_output(self):
        result = ProbeResult(
            probe=Probe(id="p1", intent="divide by zero", filename="test_zero.py", source="x"),
            passed=False,
            output="AssertionError: expected 400, got 500",
        )
        prompt = fixer_user_prompt("task", [], [result])
        assert "test_zero.py" in prompt
        assert "AssertionError: expected 400, got 500" in prompt

    def test_states_probes_are_off_limits(self):
        prompt = fixer_user_prompt("task", [], [])
        assert "tests/review_probes" in prompt


class TestCodeReviewerSystemPromptInvalidProbes:
    """Task 5 amendment 2 (ADR-026 (fork)): Call 2 may mark a probe invalid,
    with its reasoning recorded, via an optional INVALID_PROBES: block."""

    def test_documents_invalid_probes_contract(self):
        assert "INVALID_PROBES:" in CODE_REVIEWER_SYSTEM_PROMPT
        assert "filename" in CODE_REVIEWER_SYSTEM_PROMPT
        assert "reason" in CODE_REVIEWER_SYSTEM_PROMPT
