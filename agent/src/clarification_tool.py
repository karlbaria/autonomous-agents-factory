"""In-process ``request_clarification`` SDK tool (clarify-before-spend, UX #4).

The customer-caught problem: a vague request like "make it faster" was answered
by GUESSING (shipping a plausible PR and charging for it) instead of asking what
was meant. The fix asks the agent to STOP and pose a question when a request is
too underspecified to implement without guessing.

An earlier cut used a text sentinel the agent had to reproduce verbatim on its
final line. That proved unreliable live — the model either shipped a guess or
finished silently without emitting the exact string. A **tool call** is a
discrete, deterministic event: the model either invokes ``request_clarification``
or it doesn't, and the runner sees the ``ToolUseBlock`` in the message stream (no
string-matching, no reproduction). This module defines that tool as an in-process
SDK MCP server; the runner registers it and captures the question, and the
pipeline treats a captured question as a hold-and-ask (no build, no PR).

Kept tiny and side-effect-free: the tool just acknowledges the call. The
authoritative signal is the runner observing the call + its ``question`` arg.

#82 PR 3a adds a second tool on the same server, ``flag_concern(reason)``: the
agent SHIPS the change but marks something a person must check before merge.
It is captured the same way (the runner sees the ``ToolUseBlock``), and the
pipeline labels the PR ``needs-human`` so the auto-merge watchdog leaves it
alone. Writing the concern only in the PR body did not stop an auto-merge
(LAB_LOG Task 14 §13).
"""

from __future__ import annotations

from typing import Any

#: The in-process MCP server name. The SDK exposes each tool as
#: ``mcp__<server>__<tool>``, so the fully-qualified tool name the runner matches
#: on is :data:`CLARIFICATION_TOOL_NAME`.
CLARIFICATION_SERVER_NAME = "abca"
CLARIFICATION_TOOL_NAME = f"mcp__{CLARIFICATION_SERVER_NAME}__request_clarification"
#: The fully-qualified name of the merge-gate tool (#82 PR 3a), on the same server.
FLAG_CONCERN_TOOL_NAME = f"mcp__{CLARIFICATION_SERVER_NAME}__flag_concern"


def build_clarification_server(*, clarification: bool = True, flag_concern: bool = False) -> Any:
    """Build the in-process SDK MCP server with the requested platform tools.

    ``clarification`` offers ``request_clarification``; ``flag_concern`` offers
    ``flag_concern`` (#82 PR 3a). One server holds both because the SDK keys
    servers by name and both tools live under ``abca``.

    Returns the SDK server config dict for ``ClaudeAgentOptions(mcp_servers=...)``,
    or ``None`` if the SDK is unavailable or no tool was requested (defensive —
    the runner then simply doesn't register it and the marker-based fallback
    still works).
    """
    if not (clarification or flag_concern):
        return None
    try:
        from claude_agent_sdk import create_sdk_mcp_server, tool
    except ImportError:  # pragma: no cover - SDK always present in the container
        return None  # nosemgrep: py-silent-success-masking -- optional-dependency feature detect; None is the documented "server not registered" signal and the runner's marker-based fallback covers it (#756 Category 3)  # noqa: E501

    @tool(
        "request_clarification",
        (
            "Ask the requester ONE clarifying question and STOP, instead of guessing, "
            "when the task is too underspecified to implement without picking among "
            "materially different interpretations (e.g. 'make it faster' with no target "
            "or slow path named). Calling this opens NO pull request and charges nothing "
            "for a guess — the platform surfaces your question to the requester. Only "
            "call it for genuinely ambiguous goal-without-substance requests; a task that "
            "names what to change is actionable, so just do it."
        ),
        {"question": str},
    )
    async def request_clarification(args: dict[str, Any]) -> dict[str, Any]:
        question = str(args.get("question", "")).strip()
        # The tool's own return is only feedback to the agent; the runner captures
        # the question from the ToolUseBlock. Tell the agent to stop here.
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Clarifying question recorded and will be posted to the requester. "
                        "Do not make code changes or open a PR — end your turn now."
                        + (f" (question: {question})" if question else "")
                    ),
                }
            ]
        }

    @tool(
        "flag_concern",
        (
            "Ship the change, but mark something a person must check before it is merged: "
            "a risk you can't rule out, an assumption you couldn't verify, or a request you "
            "followed that looks wrong. Give ONE short reason naming what to check and where. "
            "The platform labels the pull request needs-human, so it is not auto-merged, and "
            "adds your reason to its description. Keep working and open the PR as usual. Not "
            "for a request that contradicts the code: ask with request_clarification instead."
        ),
        {"reason": str},
    )
    async def flag_concern_tool(args: dict[str, Any]) -> dict[str, Any]:
        reason = str(args.get("reason", "")).strip()
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Concern recorded. The pull request will be labelled needs-human and "
                        "will not be auto-merged. Finish the task and open the PR as usual."
                        + (f" (reason: {reason})" if reason else "")
                    ),
                }
            ]
        }

    tools = [
        *([request_clarification] if clarification else []),
        *([flag_concern_tool] if flag_concern else []),
    ]
    return create_sdk_mcp_server(name=CLARIFICATION_SERVER_NAME, tools=tools)
