"""Reviewer findings model and parser.

Call 2 (the code reviewer) answers in plain text: a ``VERDICT:`` line plus a
``FINDINGS:`` JSON array citing evidence per finding (file/line or command
output — never a bare assertion). The code, not the model, assigns each
finding's ``id``. Output that doesn't fit the contract is never silently
dropped or guessed at: it is forced to ``NOT_READY`` with ``parse_error``
explaining why, per the Task 4 spec ("output that can't be parsed is treated
as NOT-READY").
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


def parse_review_output(text: str) -> ReviewOutcome:
    """Parse Call 2's raw text into a verdict plus evidence-citing findings."""
    verdict_match = _VERDICT_LINE_RE.search(text)
    if verdict_match is None:
        return _not_ready("no 'VERDICT: READY' or 'VERDICT: NOT-READY' line found")
    verdict: Verdict = "READY" if verdict_match.group(1) == "READY" else "NOT_READY"

    if "FINDINGS:" not in text:
        # No FINDINGS marker at all is valid — nothing to report.
        return ReviewOutcome(verdict=verdict, findings=[])

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
    return ReviewOutcome(verdict=verdict, findings=findings)
