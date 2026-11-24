"""Publish a markdown deliverable to the task's mapped Confluence space.

The create-vs-update decision of issue #57 §4, with its two guards:

1. **Ownership guard.** The deliverable's first H1 is the page title. A page
   with that title is only "ours" — eligible for update — when it carries the
   ``factory-generated`` label. A same-titled page without it is left untouched
   (``ownership_clash``).
2. **Edit detection.** After each write the page's ``version.number`` is stored
   on the page itself as the ``factory.lastWrittenVersion`` content property.
   Before an update, a current version ahead of that marker (or no marker at
   all) means someone outside the factory edited the page since: the update is
   skipped (``human_edit_detected``), never silently overwritten. Confluence's
   own HTTP 409 on a stale version write is reported the same way.

Not found → create under the mapped parent page (space root when unset), with
the ``factory-generated`` and ``factory-draft`` labels and the version marker.
If that labelling fails twice, the just-created page is deleted again, so an
unlabelled factory page never blocks later runs as an ownership clash.

**Every non-publish is a reported skip, never an exception and never silent**
(issue #57 §5): the caller records the :class:`ConfluenceOutcome` as a progress
milestone and on the step's data, and S3 delivery is unaffected.

Inputs come from ``channel_metadata``, which the orchestrator stamps at task
creation from the task repo's ``RepoConfig`` row and the tenant's OAuth secret:
``confluence_cloud_id``, ``confluence_space_key``, ``confluence_parent_page_id``
(optional), ``confluence_oauth_secret_arn``, ``confluence_site_url`` (optional;
used for the page link when the API response carries no base URL).
"""

from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Literal

from shell import log

from .client import (
    LABEL_DRAFT,
    LABEL_GENERATED,
    ConfluenceClient,
    ConfluenceError,
    Page,
)
from .storage import markdown_to_confluence_storage, split_title

if TYPE_CHECKING:
    from collections.abc import Callable

SkipReason = Literal[
    "no_mapping",
    "token_unavailable",
    "no_title",
    "space_not_found",
    "ownership_clash",
    "human_edit_detected",
    "api_error",
]

UPDATE_MESSAGE = "Updated by the software factory"


@dataclass(frozen=True)
class ConfluenceOutcome:
    """What a Confluence publish attempt did."""

    status: Literal["published", "skipped"]
    action: Literal["created", "updated"] | None = None
    page_id: str | None = None
    page_url: str | None = None
    version: int | None = None
    skip_reason: SkipReason | None = None
    detail: str = ""

    def to_data(self) -> dict[str, str | int]:
        """Flat ``StepOutcome.data`` entries (checkpoint-serializable)."""
        fields: dict[str, str | int | None] = {
            "confluence_status": self.status,
            "confluence_action": self.action,
            "confluence_page_id": self.page_id,
            "confluence_page_url": self.page_url,
            "confluence_version": self.version,
            "confluence_skip_reason": self.skip_reason,
            "confluence_skip_detail": self.detail if self.status == "skipped" else None,
        }
        return {k: v for k, v in fields.items() if v is not None and v != ""}

    def milestone(self) -> tuple[str, str]:
        """The ``(milestone, details)`` progress event for this outcome."""
        if self.status == "published":
            where = self.page_url or f"page {self.page_id}"
            return "confluence_published", f"{self.action} {where} (version {self.version})"
        return "confluence_skipped", f"{self.skip_reason}: {self.detail}"


def _skip(reason: SkipReason, detail: str) -> ConfluenceOutcome:
    log("WARN", f"confluence: publish skipped ({reason}): {detail}")
    return ConfluenceOutcome(status="skipped", skip_reason=reason, detail=detail)


def _published(action: Literal["created", "updated"], page: Page) -> ConfluenceOutcome:
    log("WORKFLOW", f"confluence: {action} page {page.id} at version {page.version}")
    return ConfluenceOutcome(
        status="published",
        action=action,
        page_id=page.id,
        page_url=page.url,
        version=page.version,
    )


def _update_owned_page(
    client: ConfluenceClient, page: Page, title: str, storage: str
) -> ConfluenceOutcome:
    labels = client.get_labels(page.id)
    if LABEL_GENERATED not in labels:
        return _skip(
            "ownership_clash",
            f"a page titled {title!r} already exists (id {page.id}) without the "
            f"{LABEL_GENERATED!r} label; it was left untouched",
        )
    last_written = client.get_last_written_version(page.id)
    if last_written is None or page.version > last_written:
        stored = (
            "no stored marker" if last_written is None else f"factory last wrote {last_written}"
        )
        return _skip(
            "human_edit_detected",
            f"page {page.id} is at version {page.version} ({stored}); it was "
            "edited outside the factory and was not overwritten",
        )
    try:
        updated = client.update_page(page, title, storage, UPDATE_MESSAGE)
    except ConfluenceError as e:
        if e.status == HTTPStatus.CONFLICT:
            return _skip(
                "human_edit_detected",
                f"page {page.id} changed while the factory was updating it (HTTP 409)",
            )
        raise
    client.set_last_written_version(updated.id, updated.version)
    return _published("updated", updated)


def _claim_created_page(client: ConfluenceClient, page: Page) -> None:
    """Label a just-created page as ours and store its version marker."""
    client.add_labels(page.id, [LABEL_GENERATED, LABEL_DRAFT])
    client.set_last_written_version(page.id, page.version)


def _mark_created_page_or_roll_back(
    client: ConfluenceClient, page: Page
) -> ConfluenceOutcome | None:
    """Claim a just-created page (one retry); delete it if that keeps failing.

    A created page without the ``factory-generated`` label (or without its
    version marker) would make every later run of the same deliverable report
    an ``ownership_clash`` (or ``human_edit_detected``) forever. So the claim is
    retried once, and if it still fails the page is deleted: the run reports
    ``api_error`` and the next run starts clean. Returns ``None`` on success.
    """
    try:
        _claim_created_page(client, page)
        return None
    except ConfluenceError as first:
        log("WARN", f"confluence: labelling new page {page.id} failed ({first}); retrying once")
    try:
        _claim_created_page(client, page)
        return None
    except ConfluenceError as second:
        failure = second
    try:
        client.delete_page(page.id)
    except ConfluenceError as e:
        return _skip(
            "api_error",
            f"page {page.id} was created but labelling it failed twice ({failure}), and "
            f"deleting it failed too ({e}); delete it by hand, or later runs will report "
            "an ownership clash on this title",
        )
    return _skip(
        "api_error",
        f"labelling new page {page.id} failed twice ({failure}); the page was deleted "
        "so the next run can create it cleanly",
    )


def publish_markdown(
    markdown: str,
    channel_metadata: dict[str, str] | None,
    *,
    resolve_token: Callable[[dict[str, str] | None], str],
    client_factory: Callable[..., ConfluenceClient] = ConfluenceClient,
    fallback_title: str = "",
) -> ConfluenceOutcome:
    """Create or update the deliverable's page; never raises.

    The page title is the deliverable's first H1 (removed from the body). When
    there is none, ``fallback_title`` — supplied by the caller, which knows the
    task (#80) — is used and the whole deliverable becomes the body. This module
    never guesses a title from the body. A fallback title goes through the same
    lookup-by-title and ``factory-generated`` ownership check as an H1 title, so
    it can never update a page the factory doesn't own.
    """
    meta = channel_metadata or {}
    cloud_id = meta.get("confluence_cloud_id", "")
    space_key = meta.get("confluence_space_key", "")
    if not cloud_id or not space_key:
        return _skip("no_mapping", "the task's repo has no Confluence space mapping")

    token = resolve_token(meta)
    if not token:
        return _skip(
            "token_unavailable",
            "no usable Confluence OAuth token (missing, unreadable or expiring); "
            "the agent does not refresh Atlassian tokens",
        )

    title, body = split_title(markdown)
    if not title:
        title, body = fallback_title.strip()[:255], markdown
    if not title:
        return _skip(
            "no_title",
            "the deliverable has no H1 line to use as the page title, and the task "
            "has no description to derive one from",
        )

    try:
        client = client_factory(cloud_id, token, site_url=meta.get("confluence_site_url", ""))
        space_id = client.get_space_id(space_key)
        if space_id is None:
            return _skip("space_not_found", f"no Confluence space with key {space_key!r}")
        storage = markdown_to_confluence_storage(body)
        existing = client.find_page_by_title(space_id, title)
        if existing is not None:
            return _update_owned_page(client, existing, title, storage)
        parent_id = meta.get("confluence_parent_page_id") or None
        created = client.create_page(space_id, title, storage, parent_id)
        rollback = _mark_created_page_or_roll_back(client, created)
        if rollback is not None:
            return rollback
        return _published("created", created)
    except ConfluenceError as e:
        return _skip("api_error", str(e))
