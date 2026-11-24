"""Clarify-and-hold: detection and scope, shared by the pipeline and the runner.

Clarify-before-spend (UX #4): a PR-producing coding task whose agent judged the
request too ambiguous asks a question instead of guessing. The task then HOLDS:
no review, build, commit or PR — the deliverable is the question.

Two helpers, one place (#78):

- :func:`agent_requested_input` — did this agent result ask for input? Primary
  signal: the agent CALLED ``request_clarification`` (the runner captures the
  question into ``AgentResult.clarification_question``). Fallback: the legacy
  first-line text sentinel :data:`NEEDS_INPUT_MARKER`.
- :func:`hold_applies` — does a hold mean anything for this workflow? Not for an
  artifact workflow (it emits a document, not a question) nor a PR workflow
  (pr-iteration has its own answer-only path).

``pipeline.py`` combines both into ``needs_input``; ``_execute_agent_step`` uses
:func:`hold_applies` to turn on the runner's ``stop_on_hold``, and the runner uses
:func:`agent_requested_input` to decide whether to stop. Keep the rules here only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from config import NEEDS_INPUT_MARKER

if TYPE_CHECKING:
    from models import AgentResult
    from workflow.models import Workflow


def starts_with_needs_input_marker(result_text: str | None) -> bool:
    """True when the agent's final message opens with the clarify-and-hold marker.

    The new_task workflow tells the agent to put :data:`NEEDS_INPUT_MARKER` on
    the FIRST line of its final message when it needs to ask instead of guess.
    Only the FIRST non-empty line counts (a marker buried mid-answer is not a
    hold signal — a stray mention of the token in prose must not trip the hold).
    """
    if not result_text:
        return False
    for line in result_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        return stripped.startswith(NEEDS_INPUT_MARKER)
    return False


def agent_requested_input(agent_result: AgentResult | None) -> bool:
    """True when the agent asked for clarification (tool call or text sentinel)."""
    if agent_result is None:
        return False
    if (agent_result.clarification_question or "").strip():
        return True
    return starts_with_needs_input_marker(agent_result.result_text)


def is_artifact_workflow(workflow: Workflow | None) -> bool:
    """A REPO-FUL workflow whose primary terminal outcome is an artifact.

    It clones the repo for context but produces a document, not a PR. BOTH
    conditions matter: ``default/agent-v1`` is repo-OPTIONAL (``primary:
    artifact`` but ``requires_repo: false``) and, run with a repo, still
    expects a PR — so it is not an artifact workflow here.
    """
    return bool(
        workflow
        and getattr(workflow.terminal_outcomes, "primary", None) == "artifact"
        and getattr(workflow, "requires_repo", False)
    )


def hold_applies(workflow: Workflow | None, *, is_pr_workflow: bool) -> bool:
    """Whether a clarification request holds the task for this workflow.

    Scoped OFF for artifact workflows and PR workflows; a ``None`` workflow (it
    failed to load) is treated as a plain coding workflow, as before.
    """
    return not is_artifact_workflow(workflow) and not is_pr_workflow
