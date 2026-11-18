"""Tests for the reviewer prompt builders."""

from __future__ import annotations

from review.probes import Probe, ProbeResult
from review.prompts import code_reviewer_user_prompt, probe_writer_user_prompt
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
