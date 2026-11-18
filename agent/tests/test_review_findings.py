"""Tests for the reviewer findings parser (Task 4 — ADR-025 (fork))."""

from __future__ import annotations

from review.findings import parse_review_output


class TestParseReviewOutputValid:
    def test_ready_with_no_findings(self):
        out = parse_review_output("VERDICT: READY\n")
        assert out.verdict == "READY"
        assert out.findings == []
        assert out.parse_error is None

    def test_not_ready_with_findings_block(self):
        text = (
            "Some reasoning text.\n"
            "VERDICT: NOT-READY\n"
            "FINDINGS:\n"
            "```json\n"
            "[\n"
            '  {"type": "issue", "severity": "major", "title": "No input validation", '
            '"description": "The handler trusts the body.", "evidence": "handler.py:12"}\n'
            "]\n"
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.parse_error is None
        assert len(out.findings) == 1
        finding = out.findings[0]
        assert finding.id == "finding-1"
        assert finding.type == "issue"
        assert finding.severity == "major"
        assert finding.title == "No input validation"
        assert finding.evidence == "handler.py:12"

    def test_ids_assigned_sequentially_by_code_not_model(self):
        text = (
            "VERDICT: READY\n"
            "FINDINGS:\n"
            "```json\n"
            "[\n"
            '  {"type": "good_point", "title": "Clear naming", "description": "x", '
            '"evidence": "a.py:1"},\n'
            '  {"type": "comment", "title": "Consider a docstring", "description": "y", '
            '"evidence": "a.py:2"}\n'
            "]\n"
            "```\n"
        )
        out = parse_review_output(text)
        assert [f.id for f in out.findings] == ["finding-1", "finding-2"]
        # good_point / comment never require severity.
        assert out.findings[0].severity is None
        assert out.findings[1].severity is None

    def test_bare_json_array_without_fence_also_parses(self):
        text = (
            'VERDICT: READY\nFINDINGS: [{"type": "comment", "title": "t", '
            '"description": "d", "evidence": "e"}]'
        )
        out = parse_review_output(text)
        assert out.verdict == "READY"
        assert len(out.findings) == 1


class TestParseReviewOutputIncomplete:
    def test_missing_verdict_line_forces_not_ready(self):
        out = parse_review_output("I reviewed the diff and it looks fine.")
        assert out.verdict == "NOT_READY"
        assert out.findings == []
        assert out.parse_error is not None

    def test_good_point_missing_evidence_forces_not_ready_even_if_ready(self):
        """Regression: seen for real in the Task 4 demo — a model wrote VERDICT:
        READY but omitted "evidence" on a good_point finding (reasonably
        assuming only `issue` findings need it); the contract requires it on
        every finding type, so this must still force NOT_READY."""
        text = (
            "VERDICT: READY\n"
            "FINDINGS:\n"
            "```json\n"
            '[{"type": "good_point", "title": "Clean error handling", "description": "d"}]\n'
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.findings == []
        assert out.parse_error is not None
        assert "evidence" in out.parse_error

    def test_issue_finding_missing_severity_forces_not_ready(self):
        text = (
            "VERDICT: READY\n"
            "FINDINGS:\n"
            "```json\n"
            '[{"type": "issue", "title": "Bug", "description": "d", "evidence": "e"}]\n'
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.findings == []
        assert out.parse_error is not None
        assert "severity" in out.parse_error

    def test_finding_missing_evidence_forces_not_ready(self):
        text = (
            "VERDICT: READY\n"
            "FINDINGS:\n"
            "```json\n"
            '[{"type": "comment", "title": "t", "description": "d"}]\n'
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.parse_error is not None
        assert "evidence" in out.parse_error


class TestParseReviewOutputMalformed:
    def test_unparseable_json_forces_not_ready(self):
        text = "VERDICT: READY\nFINDINGS:\n```json\n[{not valid json\n```\n"
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.findings == []
        assert out.parse_error is not None

    def test_findings_not_a_list_forces_not_ready(self):
        text = 'VERDICT: READY\nFINDINGS:\n```json\n{"not": "a list"}\n```\n'
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.parse_error is not None

    def test_finding_element_not_an_object_forces_not_ready(self):
        text = 'VERDICT: READY\nFINDINGS:\n```json\n["just a string"]\n```\n'
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.parse_error is not None

    def test_unknown_finding_type_forces_not_ready(self):
        text = (
            "VERDICT: READY\n"
            "FINDINGS:\n"
            "```json\n"
            '[{"type": "nitpick", "title": "t", "description": "d", "evidence": "e"}]\n'
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.parse_error is not None
        assert "type" in out.parse_error

    def test_severity_word_in_type_field_forces_not_ready(self):
        """Regression: seen for real on factory-sandbox-py#32 (autonomous-agents-factory#19)
        — the reviewer confused the `type` field (issue/comment/question/good_point)
        with `severity` (minor/medium/major/critical) and wrote a third finding with
        "type": "minor", so findings again failed to parse even though probes and the
        cost split rendered correctly."""
        text = (
            "VERDICT: NOT-READY\n"
            "FINDINGS:\n"
            "```json\n"
            "[\n"
            '  {"type": "issue", "severity": "major", "title": "Missing input validation", '
            '"description": "d1", "evidence": "handler.py:10"},\n'
            '  {"type": "good_point", "title": "Clear naming", "description": "d2", '
            '"evidence": "handler.py:20"},\n'
            '  {"type": "minor", "title": "Inconsistent spacing", "description": "d3", '
            '"evidence": "handler.py:30"}\n'
            "]\n"
            "```\n"
        )
        out = parse_review_output(text)
        assert out.verdict == "NOT_READY"
        assert out.findings == []
        assert out.parse_error is not None
        assert "finding 3 has unknown type 'minor'" in out.parse_error
