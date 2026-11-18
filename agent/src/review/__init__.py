"""The two-call independent reviewer (Task 4 — ADR-025 (fork): two-call reviewer).

The coder writes both the code and its own tests, which is a conflict of
interest. This package gives the task an independent second opinion through
two separate Claude Agent SDK calls that share the task's
``AgentInvocationLedger`` (Task 3):

- **Call 1, the probe writer** (``prompts.PROBE_WRITER_PROMPT`` via
  ``backend.ClaudeReviewerBackend``) — runs in a dedicated git worktree pinned
  to the base-branch commit, sees the issue (or, when the issue doesn't name
  the interface, the new public signatures extracted by ``signatures``) and
  never the coder's diff. It writes probe tests into a scratch directory.
- A deterministic step (``probes.run_probes``) runs those probes against the
  coder's version.
- **Call 2, the code reviewer** (``prompts.CODE_REVIEWER_PROMPT``) — sees the
  issue, the diff, and the probe results, and does the white-box review.
  ``findings.parse_review_output`` turns its raw text into a verdict plus
  evidence-citing findings.

``backend.run_review_and_fix`` orchestrates one round of the above (advisory
mode only in Task 4 — no fix loop; that is Task 5's ``adversarial`` mode) and
is the function ``workflow.runner._handle_review_and_fix`` wraps.
"""

from __future__ import annotations

from .backend import ReviewAndFixResult, run_review_and_fix
from .findings import Finding, ReviewOutcome, parse_review_output
from .probes import Probe, ProbeResult, collect_probes, run_probes
from .signatures import PublicSignature, extract_new_public_signatures, issue_names_interface

__all__ = [
    "Finding",
    "Probe",
    "ProbeResult",
    "PublicSignature",
    "ReviewAndFixResult",
    "ReviewOutcome",
    "collect_probes",
    "extract_new_public_signatures",
    "issue_names_interface",
    "parse_review_output",
    "run_probes",
    "run_review_and_fix",
]
