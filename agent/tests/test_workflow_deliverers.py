"""Tests for the deliver_artifact deliverer registry (ADR-014 addendum)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from models import AgentResult, TaskConfig
from workflow.deliverers import (
    DEFAULT_DELIVER_TARGET,
    DELIVER_OUTCOMES,
    DELIVERERS,
    MAX_ARTIFACT_BYTES,
    deliver,
    produced_outcomes,
)


def test_first_party_deliverers_present():
    assert set(DELIVERERS) == {
        "s3",
        "comment",
        "s3_and_comment",
        "confluence",
        "s3_and_confluence",
        "s3_comment_and_confluence",
        "s3_comment_and_confluence_plan",
    }


def test_produced_outcomes_match_first_party_contract():
    # These sets must equal the pre-addendum enum behavior so no existing
    # workflow / fixture changes verdict.
    assert produced_outcomes("s3") == frozenset({"artifact"})
    assert produced_outcomes("comment") == frozenset({"comment"})
    assert produced_outcomes("s3_and_comment") == frozenset({"artifact", "comment"})
    # Task 14: a Confluence publish can be skipped, so it backs no outcome itself.
    assert produced_outcomes("confluence") == frozenset()
    assert produced_outcomes("s3_and_confluence") == frozenset({"artifact"})
    assert produced_outcomes("s3_comment_and_confluence") == frozenset({"artifact", "comment"})


def test_only_confluence_targets_publish_to_confluence():
    assert {n for n, d in DELIVERERS.items() if d.publishes_confluence} == {
        "confluence",
        "s3_and_confluence",
        "s3_comment_and_confluence",
        "s3_comment_and_confluence_plan",
    }


def test_only_the_plan_target_publishes_plan_pages():
    """Task 15 (fork), #82: every existing target still publishes research pages."""
    assert {n for n, d in DELIVERERS.items() if d.confluence_kind == "plan"} == {
        "s3_comment_and_confluence_plan"
    }
    assert produced_outcomes("s3_comment_and_confluence_plan") == frozenset({"artifact", "comment"})


def test_unset_target_models_the_runtime_default():
    # PR review #296 finding #7: an unset target must resolve to the SAME default
    # the runtime applies (DEFAULT_DELIVER_TARGET), not a lenient full set — so
    # the validator models exactly what runs. With the default 's3', that is
    # {'artifact'} only; a primary:comment workflow with no target is correctly
    # flagged by rule 11 rather than silently never posting the comment.
    assert DEFAULT_DELIVER_TARGET == "s3"
    assert produced_outcomes(None) == produced_outcomes(DEFAULT_DELIVER_TARGET)
    assert produced_outcomes(None) == frozenset({"artifact"})
    # The full union still exists for rule 11's "is this a deliver-backed
    # outcome at all" membership check.
    assert frozenset({"artifact", "comment"}) == DELIVER_OUTCOMES


def test_unknown_target_produces_nothing():
    assert produced_outcomes("nope") == frozenset()


def _ctx(
    result_text="some output",
    task_id="task-1",
    progress=None,
    channel_metadata=None,
    task_description="",
):
    """A minimal StepContext stand-in for the deliver() dispatcher."""
    return SimpleNamespace(
        agent_result=AgentResult(status="success", result_text=result_text),
        config=TaskConfig(
            aws_region="us-east-1",
            requires_repo=False,
            task_id=task_id,
            channel_metadata=channel_metadata or {},
            task_description=task_description,
        ),
        progress=progress,
    )


class TestDeliver:
    def test_unknown_target_raises(self):
        with pytest.raises(ValueError, match="unknown target"):
            deliver("nope", _ctx())

    def test_s3_uploads_and_returns_uri(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        mock_client = MagicMock()
        with patch("aws_session.tenant_client", return_value=mock_client):
            result = deliver("s3", _ctx(result_text="hello", task_id="task-9"))

        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-9/result.md"
        assert result.comment_posted is False
        # Uploaded to the task_id-scoped key the SessionRole grant allows.
        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "artifacts/task-9/result.md"
        assert kwargs["Body"] == b"hello"

    def test_s3_missing_bucket_raises(self, monkeypatch):
        monkeypatch.delenv("ARTIFACTS_BUCKET_NAME", raising=False)
        with pytest.raises(ValueError, match="ARTIFACTS_BUCKET_NAME is not configured"):
            deliver("s3", _ctx())

    def test_empty_result_text_raises(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with pytest.raises(ValueError, match="no result text"):
            deliver("s3", _ctx(result_text=""))

    def test_oversize_artifact_raises(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        big = "x" * (MAX_ARTIFACT_BYTES + 1)
        with pytest.raises(ValueError, match="exceeds the"):
            deliver("s3", _ctx(result_text=big))

    def test_oversize_artifact_rejected_before_encoding(self, monkeypatch):
        # PR review #296 finding #9: the cap must bound memory by rejecting on the
        # character count BEFORE encoding to UTF-8 bytes (which would materialize a
        # second full copy). Patch str.encode to prove it is never called on the
        # oversize path — the up-front character check fires first.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        from workflow.deliverers import _artifact_body

        big = "x" * (MAX_ARTIFACT_BYTES + 1)

        class _NoEncode(str):
            def encode(self, *a, **k):
                raise AssertionError("encode() called before the size cap fired")

        ctx = _ctx(result_text=_NoEncode(big))
        with pytest.raises(ValueError, match="characters, exceeds the"):
            _artifact_body(ctx)

    def test_deferral_message_rejected_not_uploaded(self, monkeypatch):
        # #515 exit-path guard: a final message that defers the work ("running…
        # watch /workflows") must fail the deliver step, not upload as the
        # artifact. This is the exact placeholder observed on task 01KWDEFQH6.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        deferral = (
            "The deep-research workflow is running in the background. I'll deliver "
            "the full cited report here as soon as it completes. Use /workflows to "
            "watch live progress."
        )
        with pytest.raises(ValueError, match="defers the work"):
            deliver("s3", _ctx(result_text=deferral))

    def test_deferral_guard_applies_to_comment_target_too(self):
        # Both deliverers route through _artifact_body, so the comment path is
        # guarded as well — a deferral is never presented as a delivered comment.
        # (progress must be present, else _post_comment short-circuits before
        # building the body.)
        ctx = _ctx(result_text="results will follow shortly.", progress=MagicMock())
        with pytest.raises(ValueError, match="defers the work"):
            deliver("comment", ctx)

    def test_genuine_answer_mentioning_background_is_not_rejected(self, monkeypatch):
        # Guard against false positives: an answer that legitimately discusses
        # "background" as a topic (not a deferral) must still deliver.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        answer = (
            "# DynamoDB capacity modes\n\nOn-demand suits bursty traffic; provisioned "
            "with auto-scaling suits steady load. Background compaction is handled by "
            "the service. Sources: docs.aws.amazon.com/..."
        )
        with patch("workflow.deliverers._upload_to_s3", return_value="s3://b/k"):
            result = deliver("s3", _ctx(result_text=answer))
        assert result.artifact_uri == "s3://b/k"

    @pytest.mark.parametrize(
        "answer",
        [
            # PR #523 review: a cited CI URL matched the old "/workflows" marker.
            (
                "Our CI is defined in `.github/workflows/ci.yml`. See "
                "https://github.com/o/r/actions/workflows/ci.yml for the runs."
            ),
            # "running in the background" as genuine topic prose.
            "Log compaction runs in the background, so writes are never blocked.",
            # "watch progress" / "check back" as legitimate instructions in an answer.
            (
                "To watch progress of a deployment, run `bgagent watch <id>`; check back "
                "in the console once it reports COMPLETED."
            ),
            # A fenced code block quoting a deferral-looking string must not trip it.
            (
                "Here is the guard's marker list:\n```\nresults will follow\n```\nThat is "
                "the full answer."
            ),
        ],
    )
    def test_genuine_answer_with_colliding_tokens_not_rejected(self, monkeypatch, answer):
        # #523: the guard was pared to full first-person deferral phrases and now
        # strips code/URLs before matching, so answers that merely quote a token
        # in a link, code, or topic prose still deliver.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with patch("workflow.deliverers._upload_to_s3", return_value="s3://b/k"):
            result = deliver("s3", _ctx(result_text=answer))
        assert result.artifact_uri == "s3://b/k"

    def test_comment_writes_milestone_no_s3(self):
        progress = MagicMock()
        result = deliver("comment", _ctx(result_text="findings", progress=progress))
        assert result.artifact_uri is None
        assert result.comment_posted is True
        progress.write_agent_milestone.assert_called_once()
        assert progress.write_agent_milestone.call_args.args[0] == "delivered_comment"

    def test_s3_and_comment_does_both(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        progress = MagicMock()
        with patch("aws_session.tenant_client", return_value=MagicMock()):
            result = deliver("s3_and_comment", _ctx(result_text="r", progress=progress))
        assert result.artifact_uri is not None
        assert result.comment_posted is True


CONFLUENCE_META = {
    "confluence_cloud_id": "cloud-1",
    "confluence_space_key": "ENG",
    "confluence_oauth_secret_arn": "arn:secret",
}


class TestConfluenceDeliverers:
    """`confluence` / `s3_and_confluence` (Task 14, issue #57)."""

    def _published(self):
        from confluence.publish import ConfluenceOutcome

        return ConfluenceOutcome(
            status="published", action="created", page_id="9", page_url="https://u", version=1
        )

    def test_s3_and_confluence_does_both_s3_first(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        order: list[str] = []
        s3 = MagicMock()
        s3.put_object.side_effect = lambda **_k: order.append("s3")

        def fake_publish(text, meta, *, resolve_token, fallback_title):
            order.append("confluence")
            assert text == "# T\n\nbody"
            assert meta == CONFLUENCE_META
            from config import resolve_confluence_oauth_token

            assert resolve_token is resolve_confluence_oauth_token
            return self._published()

        progress = MagicMock()
        with (
            patch("aws_session.tenant_client", return_value=s3),
            patch("confluence.publish.publish_markdown", side_effect=fake_publish),
        ):
            result = deliver(
                "s3_and_confluence",
                _ctx("# T\n\nbody", progress=progress, channel_metadata=CONFLUENCE_META),
            )
        assert order == ["s3", "confluence"]
        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-1/result.md"
        assert result.confluence == self._published()
        progress.write_agent_milestone.assert_called_once_with(
            "confluence_published", "created https://u (version 1)"
        )

    def test_s3_and_confluence_unmapped_degrades_to_plain_s3(self, monkeypatch):
        """No mapping: S3 is delivered exactly as `s3` would, plus a reported skip."""
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        s3 = MagicMock()
        progress = MagicMock()
        with (
            patch("aws_session.tenant_client", return_value=s3),
            patch("requests.Session.request") as http,
            patch("config.resolve_confluence_oauth_token") as token,
        ):
            result = deliver("s3_and_confluence", _ctx("# T\nx", progress=progress))
        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-1/result.md"
        s3.put_object.assert_called_once()
        assert result.confluence is not None
        assert result.confluence.skip_reason == "no_mapping"
        http.assert_not_called()
        token.assert_not_called()
        progress.write_agent_milestone.assert_called_once()
        assert progress.write_agent_milestone.call_args.args[0] == "confluence_skipped"

    def test_s3_failure_raises_before_confluence(self, monkeypatch):
        monkeypatch.delenv("ARTIFACTS_BUCKET_NAME", raising=False)
        with (
            patch("confluence.publish.publish_markdown") as publish,
            pytest.raises(ValueError, match="ARTIFACTS_BUCKET_NAME"),
        ):
            deliver("s3_and_confluence", _ctx(channel_metadata=CONFLUENCE_META))
        publish.assert_not_called()

    @pytest.mark.parametrize(
        "reason", ["token_unavailable", "ownership_clash", "human_edit_detected", "api_error"]
    )
    def test_confluence_skip_never_fails_s3_delivery(self, monkeypatch, reason):
        from confluence.publish import ConfluenceOutcome

        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        skip = ConfluenceOutcome(status="skipped", skip_reason=reason, detail="why")
        progress = MagicMock()
        with (
            patch("aws_session.tenant_client", return_value=MagicMock()),
            patch("confluence.publish.publish_markdown", return_value=skip),
        ):
            result = deliver(
                "s3_and_confluence", _ctx(progress=progress, channel_metadata=CONFLUENCE_META)
            )
        assert result.artifact_uri is not None
        assert result.confluence == skip
        progress.write_agent_milestone.assert_called_once_with(
            "confluence_skipped", f"{reason}: why"
        )

    def test_confluence_only_uploads_nothing_to_s3(self):
        with (
            patch("aws_session.tenant_client") as s3,
            patch("confluence.publish.publish_markdown", return_value=self._published()),
        ):
            result = deliver("confluence", _ctx(channel_metadata=CONFLUENCE_META))
        s3.assert_not_called()
        assert result.artifact_uri is None
        assert result.comment_posted is False
        assert result.confluence == self._published()

    def test_confluence_without_progress_writer_still_returns_outcome(self):
        with patch("confluence.publish.publish_markdown", return_value=self._published()):
            result = deliver("confluence", _ctx(progress=None))
        assert result.confluence == self._published()

    def test_deferral_guard_applies_to_confluence(self):
        with (
            patch("confluence.publish.publish_markdown") as publish,
            pytest.raises(ValueError, match="defers the work"),
        ):
            deliver("confluence", _ctx(result_text="Results will follow shortly."))
        publish.assert_not_called()

    def test_other_targets_never_touch_confluence(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with (
            patch("aws_session.tenant_client", return_value=MagicMock()),
            patch("confluence.publish.publish_markdown") as publish,
        ):
            for target in ("s3", "comment", "s3_and_comment"):
                result = deliver(
                    target, _ctx(progress=MagicMock(), channel_metadata=CONFLUENCE_META)
                )
                assert result.confluence is None
        publish.assert_not_called()


class TestDeliverHandlerData:
    """The runner's deliver_artifact handler threads the outcome onto step data."""

    def test_confluence_fields_land_on_step_data(self, monkeypatch):
        from confluence.publish import ConfluenceOutcome
        from workflow.models import Step
        from workflow.runner import STEP_HANDLERS

        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        skip = ConfluenceOutcome(status="skipped", skip_reason="ownership_clash", detail="d")
        step = Step.model_validate(
            {"kind": "deliver_artifact", "name": "deliver", "target": "s3_and_confluence"}
        )
        with (
            patch("aws_session.tenant_client", return_value=MagicMock()),
            patch("confluence.publish.publish_markdown", return_value=skip),
        ):
            outcome = STEP_HANDLERS["deliver_artifact"](
                step, _ctx(progress=MagicMock(), channel_metadata=CONFLUENCE_META)
            )
        assert outcome.status == "succeeded"
        assert outcome.data == {
            "artifact_uri": "s3://artifacts-bkt/artifacts/task-1/result.md",
            "confluence_status": "skipped",
            "confluence_skip_reason": "ownership_clash",
            "confluence_skip_detail": "d",
        }


class TestS3CommentAndConfluence:
    """`s3_comment_and_confluence` (Task 14 PR 2b): the comment's first line
    reports the Confluence outcome — the page link, or the skip reason."""

    def _run(self, monkeypatch, outcome, text="# T\n\nbody"):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        order: list[str] = []
        s3 = MagicMock()
        s3.put_object.side_effect = lambda **_k: order.append("s3")
        progress = MagicMock()
        progress.write_agent_milestone.side_effect = lambda name, _d: order.append(name)

        def fake_publish(*_a, **_k):
            order.append("publish")
            return outcome

        with (
            patch("aws_session.tenant_client", return_value=s3),
            patch("confluence.publish.publish_markdown", side_effect=fake_publish),
        ):
            result = deliver(
                "s3_comment_and_confluence",
                _ctx(text, progress=progress, channel_metadata=CONFLUENCE_META),
            )
        comments = [
            c.args[1]
            for c in progress.write_agent_milestone.call_args_list
            if c.args[0] == "delivered_comment"
        ]
        return result, order, comments

    def test_published_comment_leads_with_the_page_link(self, monkeypatch):
        from confluence.publish import ConfluenceOutcome

        published = ConfluenceOutcome(
            status="published", action="created", page_id="9", page_url="https://u/9", version=1
        )
        result, order, comments = self._run(monkeypatch, published)
        assert order == ["s3", "publish", "confluence_published", "delivered_comment"]
        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-1/result.md"
        assert result.comment_posted is True
        assert result.confluence == published
        assert comments == ["Confluence: created https://u/9\n\n# T\n\nbody"]

    def test_published_without_url_names_the_page(self, monkeypatch):
        from confluence.publish import ConfluenceOutcome

        published = ConfluenceOutcome(status="published", action="updated", page_id="9", version=3)
        _, _, comments = self._run(monkeypatch, published)
        assert comments[0].startswith("Confluence: updated page 9\n\n")

    @pytest.mark.parametrize(
        "reason",
        [
            "no_mapping",
            "token_unavailable",
            "no_title",
            "space_not_found",
            "ownership_clash",
            "human_edit_detected",
            "api_error",
        ],
    )
    def test_skipped_comment_leads_with_the_reason(self, monkeypatch, reason):
        from confluence.publish import ConfluenceOutcome

        skip = ConfluenceOutcome(status="skipped", skip_reason=reason, detail="why")
        result, order, comments = self._run(monkeypatch, skip)
        assert order == ["s3", "publish", "confluence_skipped", "delivered_comment"]
        assert result.artifact_uri is not None
        assert comments == [f"Confluence: not published ({reason}: why)\n\n# T\n\nbody"]

    def test_s3_and_comment_comment_is_unchanged(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        progress = MagicMock()
        with patch("aws_session.tenant_client", return_value=MagicMock()):
            deliver("s3_and_comment", _ctx("plain", progress=progress))
        progress.write_agent_milestone.assert_called_once_with("delivered_comment", "plain")


def test_web_research_uses_s3_comment_and_confluence():
    """web-research-v1 keeps its comment and adds Confluence (Task 14 PR 2b)."""
    from pathlib import Path

    import yaml

    doc = yaml.safe_load(
        (Path(__file__).parent.parent / "workflows/knowledge/web-research-v1.yaml").read_text()
    )
    targets = [s.get("target") for s in doc["steps"] if s["kind"] == "deliver_artifact"]
    assert targets == ["s3_comment_and_confluence"]


class TestFallbackPageTitle:
    """#80: a research report with no H1 gets a title from the task description."""

    def test_short_description_is_used_whole(self):
        from workflow.deliverers import _fallback_page_title

        assert _fallback_page_title("  Product   search UX ") == "Research: Product search UX"

    def test_long_description_is_cut_at_a_word_boundary(self):
        from workflow.deliverers import _fallback_page_title

        desc = "Compare caching options for the shop backend, " * 5
        title = _fallback_page_title(desc)
        assert title.startswith("Research: Compare caching options")
        body = title.removeprefix("Research: ")
        assert len(body) <= 80
        assert desc.startswith(body)
        assert desc[len(body)] in " ,"  # ends on a word boundary

    def test_no_description_gives_no_title(self):
        from workflow.deliverers import _fallback_page_title

        assert _fallback_page_title("") == ""
        assert _fallback_page_title("   ") == ""

    def test_deliverer_passes_the_fallback_to_publish(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        seen = {}

        def fake_publish(text, meta, *, resolve_token, fallback_title):
            seen["fallback_title"] = fallback_title
            from confluence.publish import ConfluenceOutcome

            return ConfluenceOutcome(status="skipped", skip_reason="no_mapping", detail="x")

        with (
            patch("aws_session.tenant_client", return_value=MagicMock()),
            patch("confluence.publish.publish_markdown", side_effect=fake_publish),
        ):
            deliver(
                "s3_and_confluence",
                _ctx(
                    "no heading here",
                    channel_metadata=CONFLUENCE_META,
                    task_description="Research caching options",
                ),
            )
        assert seen["fallback_title"] == "Research: Research caching options"


class TestPlanDelivery:
    """Task 15 (fork), #82: planning docs are titled and labelled by the deliverer."""

    PLAN_DOC = "# Plan: Product tagging\n\n## Summary\nAdd tags.\n"

    def test_plan_title_uses_the_h1_feature_and_the_task_id_suffix(self):
        from workflow.deliverers import _plan_page_title

        assert (
            _plan_page_title(self.PLAN_DOC, "01M85AKACXSZ2TKGTWPR30G1SX", "ignored")
            == "Plan: Product tagging · 30G1SX"
        )

    def test_plan_title_accepts_an_h1_without_the_plan_prefix(self):
        from workflow.deliverers import _plan_page_title

        assert _plan_page_title("# Tagging\n\nbody", "task-abcdef", "") == "Plan: Tagging · abcdef"

    def test_plan_title_falls_back_to_the_task_description(self):
        from workflow.deliverers import _plan_page_title

        assert (
            _plan_page_title("no heading", "task-abcdef", "a tagging feature")
            == "Plan: a tagging feature · abcdef"
        )

    def test_plan_title_is_empty_without_a_feature_name(self):
        from workflow.deliverers import _plan_page_title

        assert _plan_page_title("no heading", "task-abcdef", "") == ""
        assert _plan_page_title("# Plan:\n\nbody", "task-abcdef", "  ") == ""

    def test_plan_target_publishes_a_plan_page_with_the_deliverer_title(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        seen = {}

        def fake_publish(text, meta, *, resolve_token, kind, title):
            seen.update(text=text, meta=meta, kind=kind, title=title)
            from confluence.publish import ConfluenceOutcome

            return ConfluenceOutcome(status="skipped", skip_reason="no_mapping", detail="x")

        progress = MagicMock()
        with (
            patch("aws_session.tenant_client", return_value=MagicMock()),
            patch("confluence.publish.publish_markdown", side_effect=fake_publish),
        ):
            result = deliver(
                "s3_comment_and_confluence_plan",
                _ctx(
                    self.PLAN_DOC,
                    task_id="01M85AKACXSZ2TKGTWPR30G1SX",
                    progress=progress,
                    channel_metadata=CONFLUENCE_META,
                    task_description="a tagging feature",
                ),
            )
        assert seen["kind"] == "plan"
        assert seen["title"] == "Plan: Product tagging · 30G1SX"
        assert seen["meta"] == CONFLUENCE_META
        assert (
            result.artifact_uri
            == "s3://artifacts-bkt/artifacts/01M85AKACXSZ2TKGTWPR30G1SX/result.md"
        )
        assert result.comment_posted is True

    def test_research_targets_call_publish_exactly_as_before(self, monkeypatch):
        """Research delivery, incl. #81's title fallback, is unchanged by the plan kind."""
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        for target in ("confluence", "s3_and_confluence", "s3_comment_and_confluence"):
            with (
                patch("aws_session.tenant_client", return_value=MagicMock()),
                patch("confluence.publish.publish_markdown") as publish,
            ):
                from confluence.publish import ConfluenceOutcome

                publish.return_value = ConfluenceOutcome(
                    status="skipped", skip_reason="no_mapping", detail="x"
                )
                deliver(
                    target,
                    _ctx(
                        "no heading here",
                        progress=MagicMock(),
                        channel_metadata=CONFLUENCE_META,
                        task_description="Research caching options",
                    ),
                )
            args, kwargs = publish.call_args
            assert args[0] == "no heading here"
            assert args[1] == CONFLUENCE_META
            assert set(kwargs) == {"resolve_token", "fallback_title"}, target
            assert kwargs["fallback_title"] == "Research: Research caching options"


def test_feature_planning_uses_the_plan_target():
    from pathlib import Path

    import yaml

    doc = yaml.safe_load(
        (Path(__file__).parent.parent / "workflows/knowledge/feature-planning-v1.yaml").read_text()
    )
    targets = [s.get("target") for s in doc["steps"] if s["kind"] == "deliver_artifact"]
    assert targets == ["s3_comment_and_confluence_plan"]
