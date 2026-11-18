"""Prompts for the two-call independent reviewer (Task 4 — ADR-025 (fork))."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .probes import ProbeResult
    from .signatures import PublicSignature

_OUTPUT_PREVIEW_CHARS = 500

PROBE_WRITER_SYSTEM_PROMPT = """\
You are an independent test-writing reviewer in a two-call code review \
process (ADR-025 (fork)). The coder writes both the code and its own \
tests — that is a conflict of interest. Your job is to write probe tests \
from the task's own requirements, never from the attempted solution.

Rules:
- You see ONLY the original task requirements and the BASE-BRANCH code — \
never the coder's diff or new code. Your working directory is a checkout \
of the base branch, before the coder's change.
- Write each probe as its own pytest file (test_*.py), directly in the \
scratch directory named below. You cannot write anywhere else, and you \
cannot read anywhere outside this worktree and that scratch directory — \
do not try.
- Each probe tests ONE concrete behavior the requirements call for: the \
stated happy path, a named edge case, or error handling implied by the \
requirements.
- Do not attempt to discover or guess at the coder's implementation. You \
do not have access to it.

When you are done, end your final message with a manifest in EXACTLY this \
form (one line per probe file you wrote):

PROBES:
- <filename>: <one-line intent>
"""

CODE_REVIEWER_SYSTEM_PROMPT = """\
You are an independent code reviewer in a two-call review process (ADR-025 \
(fork)). A separate call, which never saw the diff, wrote probe tests from \
the task's requirements alone; a deterministic step already ran them \
against this code and gives you the results below.

You have Read, Glob, and Grep only. This is a READ-ONLY review — you \
cannot modify any file.

Review the diff for security, error handling, design, and the quality of \
the coder's own tests (a conflict of interest the probe results partially \
correct for). EVERY finding — including a `good_point` — MUST include a \
non-empty "evidence" field: a file:line reference or a quoted probe/command \
result, never a bare assertion and never omitted. A finding missing \
"evidence" is dropped entirely and forces NOT-READY, even if you wrote READY.

End your final message in EXACTLY this form:

VERDICT: READY
(or: VERDICT: NOT-READY)

FINDINGS:
```json
[
  {
    "type": "issue",
    "severity": "major",
    "title": "...",
    "description": "...",
    "evidence": "file.py:42 - ...",
    "proposed_fix": "..."
  },
  {
    "type": "good_point",
    "title": "...",
    "description": "...",
    "evidence": "file.py:10 - ..."
  }
]
```

Finding types: `issue` (severity required: minor|medium|major|critical), \
`comment`, `question`, `good_point` (no severity on these three — but \
"evidence" is still required on all four). Use NOT-READY when a failing \
probe or an evidence-backed `issue` finding should block merge; otherwise \
READY. If you have nothing to report, write `FINDINGS:` followed by an \
empty JSON array (`[]`) in the same fenced block — never omit the FINDINGS \
block entirely.
"""


def probe_writer_user_prompt(
    issue_text: str, signatures: list[PublicSignature], scratch_dir: str
) -> str:
    """Call 1's task-specific content: requirements, maybe signatures, scratch dir."""
    parts = [f"## Task requirements\n\n{issue_text}\n"]
    if signatures:
        sig_block = "\n\n".join(f"```\n{s.signature}\n```" for s in signatures)
        parts.append(
            "## New interface (names and signatures only — no implementation)\n\n"
            "The requirements above don't already name the interface to test. Here are "
            "the names and signatures of the new public functions/routes this task adds, "
            f"with bodies stripped:\n\n{sig_block}\n"
        )
    parts.append(f"## Scratch directory\n\nWrite your probe test files into: `{scratch_dir}`\n")
    return "\n".join(parts)


def code_reviewer_user_prompt(
    issue_text: str, diff_text: str, probe_results: list[ProbeResult]
) -> str:
    """Call 2's task-specific content: requirements, diff, probe results."""
    if probe_results:
        probes_block = "\n".join(
            f"- `{r.probe.filename}` ({r.probe.intent}): "
            f"{'PASS' if r.passed else 'FAIL'}\n  output: {r.output[-_OUTPUT_PREVIEW_CHARS:]}"
            for r in probe_results
        )
    else:
        probes_block = "(no probes were written)"
    return (
        f"## Task requirements\n\n{issue_text}\n\n"
        f"## Diff against the base branch\n\n```diff\n{diff_text}\n```\n\n"
        "## Probe results (written independently from the requirements, "
        f"run deterministically against this code)\n\n{probes_block}\n"
    )
