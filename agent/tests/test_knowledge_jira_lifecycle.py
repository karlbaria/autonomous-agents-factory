"""#64: Jira start reactions and the Done transition on the knowledge path."""

from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock, patch

import pytest

from confluence.publish import ConfluenceOutcome, SkipReason
from models import AgentResult

JIRA_META = {
    "jira_cloud_id": "cloud-1",
    "jira_issue_key": "SHOP-7",
    "jira_oauth_secret_arn": "arn:jira",
    "confluence_cloud_id": "cloud-1",
    "confluence_space_key": "ENG",
}

PUBLISHED = ConfluenceOutcome(
    status="published", action="created", page_id="9", page_url="https://a/wiki/x/9", version=1
)


def _skip(reason: str) -> ConfluenceOutcome:
    return ConfluenceOutcome(status="skipped", skip_reason=cast("SkipReason", reason), detail="why")


def _span() -> MagicMock:
    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    return span


def _run(
    monkeypatch,
    *,
    outcome: ConfluenceOutcome | None = PUBLISHED,
    agent_status: str = "success",
    channel_source: str = "api",
    channel_metadata: dict | None = None,
    workflow_id: str = "knowledge/web-research-v1",
    bucket: str | None = "artifacts-bkt",
):
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    if bucket:
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", bucket)
    else:
        monkeypatch.delenv("ARTIFACTS_BUCKET_NAME", raising=False)
    calls: list[str] = []

    async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
        calls.append("agent")
        return AgentResult(
            status=agent_status,
            turns=1,
            cost_usd=0.01,
            num_turns=1,
            result_text="# Report\n\nBody.",
            error=None if agent_status == "success" else "boom",
        )

    with (
        patch("runner.run_agent", side_effect=fake_run_agent),
        patch("repo.setup_repo") as setup_repo,
        patch("pipeline.task_span", return_value=_span()),
        patch("pipeline.task_state"),
        patch("pipeline.get_disk_usage", return_value=0),
        patch("pipeline.print_metrics"),
        patch("pipeline._maybe_upload_trace", return_value=None),
        patch("aws_session.tenant_client", return_value=MagicMock()),
        patch("confluence.publish.publish_markdown", return_value=outcome),
        patch(
            "pipeline.resolve_jira_oauth_token",
            side_effect=lambda *_a, **_k: calls.append("resolve") or "tok",
        ),
        patch(
            "pipeline.comment_task_started", side_effect=lambda *_a, **_k: calls.append("comment")
        ),
        patch(
            "pipeline.transition_task_started",
            side_effect=lambda *_a, **_k: calls.append("in_progress"),
        ),
        patch("pipeline.transition_task_done", side_effect=lambda *_a, **_k: calls.append("done")),
    ):
        from pipeline import run_task

        result = run_task(
            task_description="Research caching",
            aws_region="us-east-1",
            task_id="k-jira-1",
            resolved_workflow={"id": workflow_id, "version": "1.0.0"},
            channel_source=channel_source,
            channel_metadata=JIRA_META if channel_metadata is None else channel_metadata,
        )
    setup_repo.assert_not_called()
    return result, calls


def test_start_reactions_then_done_on_published_delivery(monkeypatch):
    result, calls = _run(monkeypatch, outcome=PUBLISHED)
    assert result["status"] == "success"
    # Start reactions run before the agent; Done only after delivery.
    assert calls == ["resolve", "comment", "in_progress", "agent", "done"]


def test_no_mapping_skip_still_moves_to_done(monkeypatch):
    """Owner decision: Confluence not configured for the repo is still success."""
    result, calls = _run(monkeypatch, outcome=_skip("no_mapping"))
    assert result["status"] == "success"
    assert result["confluence_skip_reason"] == "no_mapping"
    assert calls[-1] == "done"


@pytest.mark.parametrize(
    "reason",
    [
        "token_unavailable",
        "human_edit_detected",
        "ownership_clash",
        "space_not_found",
        "no_title",
        "api_error",
    ],
)
def test_other_skip_reasons_leave_the_card_in_progress(monkeypatch, reason):
    result, calls = _run(monkeypatch, outcome=_skip(reason))
    # The task itself still succeeds (S3 + comment delivered) ...
    assert result["status"] == "success"
    assert result["confluence_skip_reason"] == reason
    # ... but the card was only moved to In Progress.
    assert "in_progress" in calls
    assert "done" not in calls


def test_failed_agent_leaves_the_card_in_progress(monkeypatch):
    result, calls = _run(monkeypatch, agent_status="error")
    assert result["status"] != "success"
    assert "in_progress" in calls
    assert "done" not in calls


def test_failed_delivery_leaves_the_card_in_progress(monkeypatch):
    result, calls = _run(monkeypatch, bucket=None)  # S3 upload raises → deliver fails
    assert result["status"] != "success"
    assert "done" not in calls


def test_workflow_without_confluence_moves_to_done_on_success(monkeypatch):
    result, calls = _run(monkeypatch, outcome=None, workflow_id="default/agent-v1")
    assert result["status"] == "success"
    assert calls[-1] == "done"


def test_jira_origin_task_resolves_credentials(monkeypatch):
    _, calls = _run(monkeypatch, channel_source="jira")
    assert calls[0] == "resolve"


def test_no_jira_link_resolves_nothing(monkeypatch):
    """The reactions themselves no-op without a link; credentials aren't read."""
    _, calls = _run(
        monkeypatch,
        channel_metadata={"confluence_cloud_id": "c", "confluence_space_key": "ENG"},
    )
    assert "resolve" not in calls


def test_jira_reactions_noop_without_a_link():
    """The real reaction functions make no HTTP call for a task with no Jira link."""
    import jira_reactions

    with (
        patch("jira_reactions.requests.get") as get,
        patch("jira_reactions.requests.post") as post,
    ):
        jira_reactions.comment_task_started("api", {})
        jira_reactions.transition_task_started("api", {})
        jira_reactions.transition_task_done("api", {})
    get.assert_not_called()
    post.assert_not_called()
