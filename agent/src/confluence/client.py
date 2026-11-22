"""A small Confluence Cloud v2 REST client (Task 14, issue #57, ADR-029 (fork)).

Calls go through Atlassian's OAuth 2.0 (3LO) gateway,
``https://api.atlassian.com/ex/confluence/{cloudId}/wiki/...`` — the same
pattern as ``jira_reactions.JIRA_API_BASE`` — with the tenant's shared
Jira+Confluence bearer token (``config.resolve_confluence_oauth_token``). Only
the five granular scopes ADR-029 widened the app with are needed:
``read/write:page``, ``read:space``, ``read/write:label``.

Surface:

- space lookup by key (``get_space_id``)
- find a page by exact title in a space, fetch a page with its storage body
  and ``version.number``, create, update
- labels: ``factory-generated`` (the ownership guard), ``factory-draft`` →
  ``factory-final`` (the draft/final lifecycle; a label, never a title prefix)
- the ``factory.lastWrittenVersion`` content property (edit detection)
- ``read_back`` — current content + version + whether someone outside the
  factory edited the page since its last write (Task 15's read-back)

Labels are written through the v1 label endpoint: v2 has no label-write
operation. Every failure raises :class:`ConfluenceError`; the deliverer turns
it into a reported skip, never a failed task.
"""

from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus
from typing import Any, Protocol
from urllib.parse import quote

import requests

CONFLUENCE_API_BASE = "https://api.atlassian.com/ex/confluence"
REQUEST_TIMEOUT_SECONDS = 15

LABEL_GENERATED = "factory-generated"
LABEL_DRAFT = "factory-draft"
LABEL_FINAL = "factory-final"
LAST_WRITTEN_VERSION_KEY = "factory.lastWrittenVersion"

# Bounds on cursor-paginated reads (labels): far beyond what a factory page
# carries, but a hostile or broken `next` link cannot loop forever.
_LABEL_PAGE_LIMIT = 250
_MAX_PAGINATION_PAGES = 10
_ERROR_BODY_PREVIEW = 200


class HttpSession(Protocol):
    """The one ``requests.Session`` method the client uses (a test seam)."""

    def request(
        self,
        method: str,
        url: str,
        *,
        params: Any = None,
        json: Any = None,
        headers: Any = None,
        timeout: Any = None,
    ) -> Any: ...


class ConfluenceError(Exception):
    """A Confluence call failed (network error or non-2xx response)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Page:
    """The parts of a Confluence page the factory reads."""

    id: str
    title: str
    version: int
    parent_id: str | None = None
    body: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class PageReadBack:
    """A page's current content and edit state (Task 15's read-back).

    ``human_edited`` is True when the page's current version is ahead of the
    ``factory.lastWrittenVersion`` the factory stored after its last write —
    or when that marker is missing, since an edit then cannot be ruled out.
    """

    page: Page
    last_written_version: int | None
    human_edited: bool


@dataclass(frozen=True)
class _Property:
    id: str
    value: int | None
    version: int


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


class ConfluenceClient:
    """Confluence v2 client for one tenant (``cloud_id``) and bearer token."""

    def __init__(
        self,
        cloud_id: str,
        token: str,
        *,
        site_url: str = "",
        session: HttpSession | None = None,
    ) -> None:
        if not cloud_id or not token:
            raise ValueError("ConfluenceClient needs a cloud_id and a token")
        self._gateway = f"{CONFLUENCE_API_BASE}/{quote(cloud_id, safe='')}"
        self._token = token
        self._site_url = site_url.rstrip("/")
        self._http: HttpSession = session or requests.Session()

    # --- transport ---------------------------------------------------------

    def _v2(self, path: str) -> str:
        return f"{self._gateway}/wiki/api/v2{path}"

    def _v1(self, path: str) -> str:
        return f"{self._gateway}/wiki/rest/api{path}"

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            resp = self._http.request(
                method,
                url,
                params=params,
                json=body,
                headers=headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            raise ConfluenceError(f"{method} request failed ({type(e).__name__})") from e
        if resp.status_code >= HTTPStatus.MULTIPLE_CHOICES:
            preview = (resp.text or "")[:_ERROR_BODY_PREVIEW]
            raise ConfluenceError(
                f"{method} returned HTTP {resp.status_code}: {preview}", status=resp.status_code
            )
        if resp.status_code == HTTPStatus.NO_CONTENT or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as e:
            raise ConfluenceError(f"{method} returned a non-JSON body") from e

    def _page_url(self, raw: dict[str, Any]) -> str | None:
        links = raw.get("_links") or {}
        webui = links.get("webui")
        if not isinstance(webui, str) or not webui:
            return None
        base = links.get("base")
        if isinstance(base, str) and base.startswith("https://"):
            return base.rstrip("/") + webui
        if self._site_url:
            return f"{self._site_url}/wiki{webui}"
        return None

    def _to_page(self, raw: Any) -> Page:
        if not isinstance(raw, dict) or not raw.get("id"):
            raise ConfluenceError("unexpected page payload (no id)")
        version = _int_or_none((raw.get("version") or {}).get("number"))
        if version is None:
            raise ConfluenceError(f"page {raw['id']} has no version number")
        body = ((raw.get("body") or {}).get("storage") or {}).get("value")
        parent = raw.get("parentId")
        return Page(
            id=str(raw["id"]),
            title=str(raw.get("title", "")),
            version=version,
            parent_id=str(parent) if parent else None,
            body=body if isinstance(body, str) else None,
            url=self._page_url(raw),
        )

    # --- spaces and pages --------------------------------------------------

    def get_space_id(self, space_key: str) -> str | None:
        """Resolve a space key (what the operator maps) to its numeric id."""
        data = self._request("GET", self._v2("/spaces"), params={"keys": space_key, "limit": 1})
        for space in (data or {}).get("results", []):
            if isinstance(space, dict) and space.get("key") == space_key and space.get("id"):
                return str(space["id"])
        return None

    def find_page_by_title(self, space_id: str, title: str) -> Page | None:
        """The current page titled exactly ``title`` in the space, if any.

        Confluence enforces unique page titles within a space, so the title
        identifies the page; the mapped parent only decides where a *new* page
        is created.
        """
        data = self._request(
            "GET",
            self._v2("/pages"),
            params={"space-id": space_id, "title": title, "status": "current", "limit": 5},
        )
        for raw in (data or {}).get("results", []):
            if isinstance(raw, dict) and raw.get("title") == title:
                return self._to_page(raw)
        return None

    def get_page(self, page_id: str) -> Page:
        """Fetch a page with its storage-format body and current version."""
        raw = self._request(
            "GET",
            self._v2(f"/pages/{quote(page_id, safe='')}"),
            params={"body-format": "storage"},
        )
        return self._to_page(raw)

    def create_page(
        self, space_id: str, title: str, storage_body: str, parent_id: str | None
    ) -> Page:
        payload: dict[str, Any] = {
            "spaceId": space_id,
            "status": "current",
            "title": title,
            "body": {"representation": "storage", "value": storage_body},
        }
        if parent_id:
            payload["parentId"] = parent_id
        return self._to_page(self._request("POST", self._v2("/pages"), body=payload))

    def update_page(self, page: Page, title: str, storage_body: str, message: str = "") -> Page:
        """Overwrite ``page`` with a new body at ``page.version + 1``.

        Confluence rejects a stale version with HTTP 409, which the deliverer
        reports as an edit clash rather than retrying.
        """
        payload = {
            "id": page.id,
            "status": "current",
            "title": title,
            "body": {"representation": "storage", "value": storage_body},
            "version": {"number": page.version + 1, "message": message},
        }
        raw = self._request("PUT", self._v2(f"/pages/{quote(page.id, safe='')}"), body=payload)
        return self._to_page(raw)

    # --- labels ------------------------------------------------------------

    def get_labels(self, page_id: str) -> set[str]:
        url: str | None = self._v2(f"/pages/{quote(page_id, safe='')}/labels")
        params: dict[str, Any] | None = {"limit": _LABEL_PAGE_LIMIT}
        names: set[str] = set()
        for _ in range(_MAX_PAGINATION_PAGES):
            if url is None:
                break
            data = self._request("GET", url, params=params) or {}
            for label in data.get("results", []):
                if isinstance(label, dict) and isinstance(label.get("name"), str):
                    names.add(label["name"])
            nxt = (data.get("_links") or {}).get("next")
            # `next` is site-relative (/wiki/api/v2/...): re-root it on the
            # gateway; anything else is not followed.
            url = (
                f"{self._gateway}{nxt}"
                if isinstance(nxt, str) and nxt.startswith("/wiki/")
                else None
            )
            params = None
        return names

    def add_labels(self, page_id: str, names: list[str]) -> None:
        self._request(
            "POST",
            self._v1(f"/content/{quote(page_id, safe='')}/label"),
            body=[{"prefix": "global", "name": n} for n in names],
        )

    def remove_label(self, page_id: str, name: str) -> None:
        try:
            self._request(
                "DELETE",
                self._v1(f"/content/{quote(page_id, safe='')}/label"),
                params={"name": name},
            )
        except ConfluenceError as e:
            if e.status != HTTPStatus.NOT_FOUND:  # already absent is the desired end state
                raise

    def mark_final(self, page_id: str) -> None:
        """Move a factory page from draft to final (Task 15's approve step)."""
        self.add_labels(page_id, [LABEL_FINAL])
        self.remove_label(page_id, LABEL_DRAFT)

    # --- the factory.lastWrittenVersion content property -------------------

    def _get_last_written_property(self, page_id: str) -> _Property | None:
        data = self._request(
            "GET",
            self._v2(f"/pages/{quote(page_id, safe='')}/properties"),
            params={"key": LAST_WRITTEN_VERSION_KEY},
        )
        for prop in (data or {}).get("results", []):
            if isinstance(prop, dict) and prop.get("key") == LAST_WRITTEN_VERSION_KEY:
                return _Property(
                    id=str(prop.get("id", "")),
                    value=_int_or_none(prop.get("value")),
                    version=_int_or_none((prop.get("version") or {}).get("number")) or 1,
                )
        return None

    def get_last_written_version(self, page_id: str) -> int | None:
        prop = self._get_last_written_property(page_id)
        return prop.value if prop else None

    def set_last_written_version(self, page_id: str, version: int) -> None:
        prop = self._get_last_written_property(page_id)
        base = f"/pages/{quote(page_id, safe='')}/properties"
        if prop is None or not prop.id:
            self._request(
                "POST", self._v2(base), body={"key": LAST_WRITTEN_VERSION_KEY, "value": version}
            )
            return
        self._request(
            "PUT",
            self._v2(f"{base}/{quote(prop.id, safe='')}"),
            body={
                "key": LAST_WRITTEN_VERSION_KEY,
                "value": version,
                "version": {"number": prop.version + 1},
            },
        )

    # --- read-back ---------------------------------------------------------

    def read_back(self, page_id: str) -> PageReadBack:
        """Current content + version, and whether it was edited outside the factory."""
        page = self.get_page(page_id)
        last = self.get_last_written_version(page_id)
        return PageReadBack(
            page=page,
            last_written_version=last,
            human_edited=last is None or page.version > last,
        )
