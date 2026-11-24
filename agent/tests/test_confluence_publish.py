"""Confluence create/update with the ownership guard and edit detection (#57 §4/§5)."""

from __future__ import annotations

from dataclasses import replace

import pytest

from confluence.client import (
    LABEL_DRAFT,
    LABEL_GENERATED,
    ConfluenceError,
    Page,
)
from confluence.publish import ConfluenceOutcome, publish_markdown

MAPPED = {
    "confluence_cloud_id": "cloud-1",
    "confluence_space_key": "ENG",
    "confluence_parent_page_id": "500",
    "confluence_oauth_secret_arn": "arn:secret",
    "confluence_site_url": "https://acme.atlassian.net",
}
DOC = "# Research: caching\n\nSome **findings**."


class FakeConfluence:
    """In-memory Confluence: one space, pages by title, labels, markers."""

    def __init__(self, cloud_id, token, *, site_url=""):
        self.cloud_id, self.token, self.site_url = cloud_id, token, site_url
        self.spaces = {"ENG": "77"}
        self.pages: dict[str, Page] = {}
        self.labels: dict[str, set[str]] = {}
        self.markers: dict[str, int] = {}
        self.created: list[tuple[str, str, str, str | None]] = []
        self.updated: list[tuple[str, str, str]] = []
        self.fail: dict[str, ConfluenceError] = {}
        # op -> how many more calls fail (absent: every call fails while in `fail`)
        self.fail_times: dict[str, int] = {}
        self.deleted: list[str] = []
        self._next_id = 1000

    def _maybe_fail(self, op):
        if op not in self.fail:
            return
        if op in self.fail_times:
            if self.fail_times[op] <= 0:
                return
            self.fail_times[op] -= 1
        raise self.fail[op]

    def get_space_id(self, key):
        self._maybe_fail("get_space_id")
        return self.spaces.get(key)

    def find_page_by_title(self, space_id, title):
        self._maybe_fail("find_page_by_title")
        return next((p for p in self.pages.values() if p.title == title), None)

    def create_page(self, space_id, title, body, parent_id):
        self._maybe_fail("create_page")
        self._next_id += 1
        page = Page(
            id=str(self._next_id),
            title=title,
            version=1,
            parent_id=parent_id,
            url=f"{self.site_url}/wiki/x/{self._next_id}",
        )
        self.pages[page.id] = page
        self.created.append((space_id, title, body, parent_id))
        return page

    def update_page(self, page, title, body, message=""):
        self._maybe_fail("update_page")
        new = replace(self.pages[page.id], version=page.version + 1)
        self.pages[page.id] = new
        self.updated.append((page.id, title, body))
        return new

    def delete_page(self, page_id):
        self._maybe_fail("delete_page")
        self.deleted.append(page_id)
        self.pages.pop(page_id, None)
        self.labels.pop(page_id, None)
        self.markers.pop(page_id, None)

    def get_labels(self, page_id):
        self._maybe_fail("get_labels")
        return set(self.labels.get(page_id, set()))

    def add_labels(self, page_id, names):
        self._maybe_fail("add_labels")
        self.labels.setdefault(page_id, set()).update(names)

    def get_last_written_version(self, page_id):
        return self.markers.get(page_id)

    def set_last_written_version(self, page_id, version):
        self._maybe_fail("set_last_written_version")
        self.markers[page_id] = version

    # helpers for tests
    def factory(self, cloud_id, token, *, site_url=""):
        """Stands in for the ConfluenceClient constructor; records its args."""
        self.cloud_id, self.token, self.site_url = cloud_id, token, site_url
        return self

    def seed(self, title, version, *, labels=(), marker=None) -> Page:
        self._next_id += 1
        page = Page(id=str(self._next_id), title=title, version=version)
        self.pages[page.id] = page
        self.labels[page.id] = set(labels)
        if marker is not None:
            self.markers[page.id] = marker
        return page


@pytest.fixture
def fake():
    return FakeConfluence("cloud-1", "tok", site_url=MAPPED["confluence_site_url"])


def _publish(fake, markdown=DOC, meta=MAPPED, resolved="tok", fallback_title=""):
    return publish_markdown(
        markdown,
        meta,
        resolve_token=lambda _m: resolved,
        client_factory=fake.factory,
        fallback_title=fallback_title,
    )


class TestCreate:
    def test_creates_under_parent_with_labels_and_marker(self, fake):
        out = _publish(fake)
        assert out.status == "published"
        assert out.action == "created"
        space_id, title, body, parent = fake.created[0]
        assert (space_id, title, parent) == ("77", "Research: caching", "500")
        # The H1 is the title, not repeated in the body.
        assert body == "<p>Some <strong>findings</strong>.</p>"
        assert fake.labels[out.page_id] == {LABEL_GENERATED, LABEL_DRAFT}
        assert fake.markers[out.page_id] == 1
        assert out.version == 1
        assert out.page_url == f"https://acme.atlassian.net/wiki/x/{out.page_id}"

    def test_creates_at_space_root_without_parent(self, fake):
        meta = {k: v for k, v in MAPPED.items() if k != "confluence_parent_page_id"}
        _publish(fake, meta=meta)
        assert fake.created[0][3] is None

    def test_client_gets_cloud_token_and_site(self, fake):
        _publish(fake)
        assert (fake.cloud_id, fake.token, fake.site_url) == (
            "cloud-1",
            "tok",
            "https://acme.atlassian.net",
        )


class TestUpdate:
    def test_owned_unedited_page_is_updated_and_marker_advanced(self, fake):
        page = fake.seed("Research: caching", 3, labels={LABEL_GENERATED}, marker=3)
        out = _publish(fake)
        assert (out.status, out.action, out.page_id, out.version) == (
            "published",
            "updated",
            page.id,
            4,
        )
        assert fake.markers[page.id] == 4
        assert not fake.created

    def test_second_publish_of_same_doc_updates_the_page_it_created(self, fake):
        first = _publish(fake)
        second = _publish(fake, markdown=DOC + "\n\nMore.")
        assert second.action == "updated"
        assert second.page_id == first.page_id
        assert len(fake.created) == 1


class TestSkipReasons:
    """Every skip carries a reason and detail; none raises."""

    def _assert_skip(self, out: ConfluenceOutcome, reason: str):
        assert out.status == "skipped"
        assert out.skip_reason == reason
        assert out.detail
        data = out.to_data()
        assert data["confluence_status"] == "skipped"
        assert data["confluence_skip_reason"] == reason
        assert data["confluence_skip_detail"] == out.detail
        milestone, details = out.milestone()
        assert milestone == "confluence_skipped"
        assert details.startswith(f"{reason}: ")

    @pytest.mark.parametrize(
        "meta",
        [
            None,
            {},
            {"confluence_space_key": "ENG"},
            {"confluence_cloud_id": "cloud-1"},
            {"jira_cloud_id": "cloud-1"},
        ],
    )
    def test_no_mapping(self, fake, meta):
        calls = []
        out = publish_markdown(
            DOC, meta, resolve_token=lambda m: calls.append(m) or "tok", client_factory=fake.factory
        )
        self._assert_skip(out, "no_mapping")
        assert calls == []  # no secret read without a mapping

    def test_token_unavailable(self, fake):
        self._assert_skip(_publish(fake, resolved=""), "token_unavailable")
        assert not fake.created

    def test_no_title(self, fake):
        # No H1 and no fallback (the task has no description): still no_title.
        self._assert_skip(_publish(fake, markdown="## not h1\n\ntext"), "no_title")
        self._assert_skip(
            _publish(fake, markdown="## not h1\n\ntext", fallback_title="  "), "no_title"
        )
        assert not fake.created

    def test_space_not_found(self, fake):
        fake.spaces = {}
        self._assert_skip(_publish(fake), "space_not_found")

    def test_ownership_clash_leaves_page_untouched(self, fake):
        page = fake.seed("Research: caching", 2, labels={"some-human-label"}, marker=2)
        out = _publish(fake)
        self._assert_skip(out, "ownership_clash")
        assert fake.pages[page.id].version == 2
        assert not fake.updated
        assert not fake.created

    def test_human_edit_detected_by_version(self, fake):
        page = fake.seed("Research: caching", 5, labels={LABEL_GENERATED}, marker=4)
        out = _publish(fake)
        self._assert_skip(out, "human_edit_detected")
        assert "version 5" in out.detail
        assert "4" in out.detail
        assert not fake.updated
        assert fake.markers[page.id] == 4

    def test_human_edit_assumed_when_marker_missing(self, fake):
        fake.seed("Research: caching", 2, labels={LABEL_GENERATED})
        out = _publish(fake)
        self._assert_skip(out, "human_edit_detected")
        assert "no stored marker" in out.detail
        assert not fake.updated

    def test_conflict_on_update_is_reported_as_human_edit(self, fake):
        fake.seed("Research: caching", 3, labels={LABEL_GENERATED}, marker=3)
        fake.fail["update_page"] = ConfluenceError("HTTP 409", status=409)
        self._assert_skip(_publish(fake), "human_edit_detected")

    @pytest.mark.parametrize(
        "op", ["get_space_id", "find_page_by_title", "create_page", "get_labels"]
    )
    def test_api_error(self, fake, op):
        if op == "get_labels":
            fake.seed("Research: caching", 3, labels={LABEL_GENERATED}, marker=3)
        fake.fail[op] = ConfluenceError("HTTP 500: boom", status=500)
        out = _publish(fake)
        self._assert_skip(out, "api_error")
        assert "HTTP 500" in out.detail

    def test_non_conflict_update_error_is_api_error(self, fake):
        fake.seed("Research: caching", 3, labels={LABEL_GENERATED}, marker=3)
        fake.fail["update_page"] = ConfluenceError("HTTP 400", status=400)
        self._assert_skip(_publish(fake), "api_error")


class TestCreateRollback:
    """Labelling a just-created page: retry once, then delete it (never leave an
    unlabelled factory page that blocks every later run as a clash)."""

    def test_single_labelling_failure_is_retried_and_published(self, fake):
        fake.fail["add_labels"] = ConfluenceError("HTTP 503", status=503)
        fake.fail_times["add_labels"] = 1
        out = _publish(fake)
        assert (out.status, out.action) == ("published", "created")
        assert fake.labels[out.page_id] == {LABEL_GENERATED, LABEL_DRAFT}
        assert fake.markers[out.page_id] == 1
        assert not fake.deleted

    def test_single_marker_failure_is_retried_and_published(self, fake):
        fake.fail["set_last_written_version"] = ConfluenceError("HTTP 503", status=503)
        fake.fail_times["set_last_written_version"] = 1
        out = _publish(fake)
        assert out.status == "published"
        assert fake.markers[out.page_id] == 1
        assert not fake.deleted

    @pytest.mark.parametrize("op", ["add_labels", "set_last_written_version"])
    def test_repeated_failure_deletes_the_created_page(self, fake, op):
        fake.fail[op] = ConfluenceError("HTTP 403", status=403)
        out = _publish(fake)
        assert out.status == "skipped"
        assert out.skip_reason == "api_error"
        assert "the page was deleted" in out.detail
        created_id = str(fake._next_id)
        assert fake.deleted == [created_id]
        assert created_id not in fake.pages

    def test_next_run_after_rollback_creates_cleanly(self, fake):
        fake.fail["add_labels"] = ConfluenceError("HTTP 403", status=403)
        assert _publish(fake).skip_reason == "api_error"
        del fake.fail["add_labels"]
        out = _publish(fake)
        # Not an ownership clash: no unlabelled page was left behind.
        assert (out.status, out.action) == ("published", "created")
        assert fake.labels[out.page_id] == {LABEL_GENERATED, LABEL_DRAFT}

    def test_delete_failure_is_reported_with_manual_cleanup(self, fake):
        fake.fail["add_labels"] = ConfluenceError("HTTP 403", status=403)
        fake.fail["delete_page"] = ConfluenceError("HTTP 403", status=403)
        out = _publish(fake)
        assert out.skip_reason == "api_error"
        assert "delete it by hand" in out.detail
        assert str(fake._next_id) in fake.pages


class TestOutcomeShape:
    def test_published_data_and_milestone(self):
        out = ConfluenceOutcome(
            status="published", action="created", page_id="9", page_url="https://u", version=1
        )
        assert out.to_data() == {
            "confluence_status": "published",
            "confluence_action": "created",
            "confluence_page_id": "9",
            "confluence_page_url": "https://u",
            "confluence_version": 1,
        }
        assert out.milestone() == ("confluence_published", "created https://u (version 1)")

    def test_published_without_url_names_the_page(self):
        out = ConfluenceOutcome(status="published", action="updated", page_id="9", version=2)
        assert out.milestone() == ("confluence_published", "updated page 9 (version 2)")


class TestFallbackTitle:
    """#80: the caller's fallback title is used only when the report has no H1."""

    NO_H1 = "A summary.\n\n## Detail\n\nFindings."

    def test_report_without_h1_publishes_with_the_fallback_title(self, fake):
        out = _publish(fake, markdown=self.NO_H1, fallback_title="Research: caching options")
        assert out.status == "published"
        assert out.action == "created"
        (_space, title, body, _parent) = fake.created[0]
        assert title == "Research: caching options"
        assert "A summary." in body  # the whole report is the body
        assert "Detail" in body

    def test_report_with_h1_still_uses_it(self, fake):
        out = _publish(fake, fallback_title="Research: something else")
        assert out.status == "published"
        (_space, title, body, _parent) = fake.created[0]
        assert title == "Research: caching"
        assert "Research: caching" not in body  # the H1 is removed from the body

    def test_fallback_title_matching_a_human_page_is_an_ownership_clash(self, fake):
        page = fake.seed("Research: caching options", 3, labels={"team-notes"}, marker=3)
        out = _publish(fake, markdown=self.NO_H1, fallback_title="Research: caching options")
        assert out.status == "skipped"
        assert out.skip_reason == "ownership_clash"
        assert fake.pages[page.id].version == 3
        assert not fake.updated
        assert not fake.created

    def test_fallback_title_matching_a_factory_page_updates_it(self, fake):
        page = fake.seed(
            "Research: caching options", 1, labels={LABEL_GENERATED, LABEL_DRAFT}, marker=1
        )
        out = _publish(fake, markdown=self.NO_H1, fallback_title="Research: caching options")
        assert out.status == "published"
        assert out.action == "updated"
        assert fake.updated[0][0] == page.id
