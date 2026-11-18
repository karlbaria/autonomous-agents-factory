"""Reviewer findings model and parser.

Call 2 (the code reviewer) answers in plain text: a ``VERDICT:`` line plus a
``FINDINGS:`` JSON array citing evidence per finding (file/line or command
output — never a bare assertion). The code, not the model, assigns each
finding's ``id``. Output that doesn't fit the contract is never silently
dropped or guessed at: it is forced to ``NOT_READY`` with ``parse_error``
explaining why, per the Task 4 spec ("output that can't be parsed is treated
as NOT-READY").

Task 5 (ADR-026 (fork)) amendment 2: Call 2 may also mark a probe invalid —
testing behavior the issue never asked for — via an optional
``INVALID_PROBES:`` JSON block, same fenced-or-bare shape and the same
"doesn't fit the contract -> NOT_READY" rule as ``FINDINGS:``. Absent
entirely, it is valid and empty: blocking stays Call 2's verdict, not raw
probe failures, so a review that never needs this still reports normally.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

FindingType = Literal["issue", "comment", "question", "good_point"]
Severity = Literal["minor", "medium", "major", "critical"]
Verdict = Literal["READY", "NOT_READY"]

_REQUIRED_KEYS = ("type", "title", "description", "evidence")
_VALID_TYPES = frozenset({"issue", "comment", "question", "good_point"})
_VALID_SEVERITIES = frozenset({"minor", "medium", "major", "critical"})

_VERDICT_LINE_RE = re.compile(r"^\s*VERDICT:\s*(READY|NOT-READY)\s*$", re.MULTILINE)
# A fenced ```json block following FINDINGS: is the expected shape; a bare
# array (no fence) is accepted too, for a model that drops the fence.
_FENCED_FINDINGS_RE = re.compile(r"FINDINGS:\s*```(?:json)?\s*(\[.*?\])\s*```", re.DOTALL)
_BARE_FINDINGS_RE = re.compile(r"FINDINGS:\s*(\[.*\])", re.DOTALL)
# Task 5 amendment 2: same fenced-or-bare shape, under its own marker.
_FENCED_INVALID_PROBES_RE = re.compile(
    r"INVALID_PROBES:\s*```(?:json)?\s*(\[.*?\])\s*```", re.DOTALL
)
_BARE_INVALID_PROBES_RE = re.compile(r"INVALID_PROBES:\s*(\[.*\])", re.DOTALL)


class Finding(BaseModel):
    """One evidence-citing finding, with an ID the code (not the model) assigned."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    type: FindingType
    severity: Severity | None = None
    title: str
    description: str
    evidence: str
    proposed_fix: str | None = None


class ReviewOutcome(BaseModel):
    """The parsed result of Call 2's review output."""

    model_config = ConfigDict(frozen=True)

    verdict: Verdict
    findings: list[Finding] = Field(default_factory=list)
    # Set only when the raw text didn't fit the contract — `verdict` is then
    # always NOT_READY regardless of what the model wrote.
    parse_error: str | None = None
    # Task 5 amendment 2: filename -> Call 2's reasoning for marking that
    # probe invalid (tests behavior the issue never asked for). Empty when
    # Call 2 never wrote an INVALID_PROBES: block.
    invalid_probes: dict[str, str] = Field(default_factory=dict)


def _not_ready(reason: str) -> ReviewOutcome:
    return ReviewOutcome(verdict="NOT_READY", findings=[], parse_error=reason)


def _parse_finding(raw: Any, index: int) -> Finding | str:
    """Return a ``Finding``, or a string describing why ``raw`` is invalid."""
    if not isinstance(raw, dict):
        return f"finding {index} was not an object"
    missing = [k for k in _REQUIRED_KEYS if not raw.get(k)]
    if missing:
        return f"finding {index} missing required field(s): {missing}"
    finding_type = raw["type"]
    if finding_type not in _VALID_TYPES:
        return f"finding {index} has unknown type {finding_type!r}"
    severity = raw.get("severity")
    if finding_type == "issue":
        if severity not in _VALID_SEVERITIES:
            return f"finding {index} is type 'issue' but missing a valid severity"
    else:
        severity = None
    return Finding(
        id=f"finding-{index}",
        type=finding_type,
        severity=severity,
        title=raw["title"],
        description=raw["description"],
        evidence=raw["evidence"],
        proposed_fix=raw.get("proposed_fix"),
    )


def _parse_invalid_probes(text: str) -> dict[str, str] | str:
    """Return the ``INVALID_PROBES:`` map, or a string describing why it's invalid.

    Absent entirely is valid and empty — this block is optional (Task 5
    amendment 2), unlike ``FINDINGS:`` which must be present once the
    ``FINDINGS:`` marker itself appears.
    """
    if "INVALID_PROBES:" not in text:
        return {}

    match = _FENCED_INVALID_PROBES_RE.search(text) or _BARE_INVALID_PROBES_RE.search(text)
    if match is None:
        return "INVALID_PROBES: present but no JSON array found"

    try:
        raw = json.loads(match.group(1))
    except json.JSONDecodeError as e:
        return f"INVALID_PROBES JSON did not parse: {e}"
    if not isinstance(raw, list):
        return "INVALID_PROBES JSON was not a list"

    invalid_probes: dict[str, str] = {}
    for i, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            return f"INVALID_PROBES entry {i} was not an object"
        filename, reason = entry.get("filename"), entry.get("reason")
        if (
            not isinstance(filename, str)
            or not filename
            or not isinstance(reason, str)
            or not reason
        ):
            return f"INVALID_PROBES entry {i} missing required field(s): filename, reason"
        invalid_probes[filename] = reason
    return invalid_probes


def parse_review_output(text: str) -> ReviewOutcome:
    """Parse Call 2's raw text into a verdict plus evidence-citing findings."""
    verdict_match = _VERDICT_LINE_RE.search(text)
    if verdict_match is None:
        return _not_ready("no 'VERDICT: READY' or 'VERDICT: NOT-READY' line found")
    verdict: Verdict = "READY" if verdict_match.group(1) == "READY" else "NOT_READY"

    invalid_probes = _parse_invalid_probes(text)
    if isinstance(invalid_probes, str):
        return _not_ready(invalid_probes)

    if "FINDINGS:" not in text:
        # No FINDINGS marker at all is valid — nothing to report.
        return ReviewOutcome(verdict=verdict, findings=[], invalid_probes=invalid_probes)

    findings_match = _FENCED_FINDINGS_RE.search(text) or _BARE_FINDINGS_RE.search(text)
    if findings_match is None:
        return _not_ready("FINDINGS: present but no JSON array found")

    try:
        raw_findings = json.loads(findings_match.group(1))
    except json.JSONDecodeError as e:
        return _not_ready(f"FINDINGS JSON did not parse: {e}")
    if not isinstance(raw_findings, list):
        return _not_ready("FINDINGS JSON was not a list")

    findings: list[Finding] = []
    for i, raw in enumerate(raw_findings, start=1):
        parsed = _parse_finding(raw, i)
        if isinstance(parsed, str):
            return _not_ready(parsed)
        findings.append(parsed)
    return ReviewOutcome(verdict=verdict, findings=findings, invalid_probes=invalid_probes)
