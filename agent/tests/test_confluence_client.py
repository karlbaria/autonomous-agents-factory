"""Confluence v2 client (Task 14, issue #57 §4, ADR-029 (fork))."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest
import requests

from confluence.client import (
    CONFLUENCE_API_BASE,
    LABEL_DRAFT,
    LABEL_FINAL,
    LAST_WRITTEN_VERSION_KEY,
    ConfluenceClient,
    ConfluenceError,
    Page,
)

GATEWAY = f"{CONFLUENCE_API_BASE}/cloud-1"
V2 = f"{GATEWAY}/wiki/api/v2"
V1 = f"{GATEWAY}/wiki/rest/api"


class _Resp:
    def __init__(self, status: int, payload: Any = None, text: str | None = None) -> None:
        self.status_code = status
        if text is not None:
            self.text = text
            self.content = text.encode()
        elif payload is None:
            self.text = ""
            self.content = b""
        else:
            self.text = json.dumps(payload)
            self.content = self.text.encode()
        self._payload = payload

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


@dataclass
class _Call:
    method: str
    url: str
    params: dict | None
    json: Any
    headers: dict


@dataclass
class FakeSession:
    """Queue of responses; records every request."""

    responses: list[Any] = field(default_factory=list)
    calls: list[_Call] = field(default_factory=list)

    def request(self, method, url, *, params=None, json=None, headers=None, timeout=None):
        assert timeout is not None, "every call must carry a timeout"
        self.calls.append(_Call(method, url, params, json, headers or {}))
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _client(*responses: Any, site_url: str = "") -> tuple[ConfluenceClient, FakeSession]:
    session = FakeSession(responses=list(responses))
    return ConfluenceClient("cloud-1", "tok", site_url=site_url, session=session), session


def _page(pid="10", title="T", version=3, **extra) -> dict:
    return {"id": pid, "title": title, "version": {"number": version}, **extra}


class TestConstruction:
    def test_requires_cloud_id_and_token(self):
        with pytest.raises(ValueError):
            ConfluenceClient("", "tok")
        with pytest.raises(ValueError):
            ConfluenceClient("c", "")

    def test_cloud_id_is_path_quoted(self):
        session = FakeSession(responses=[_Resp(200, {"results": []})])
        ConfluenceClient("a/b", "tok", session=session).get_space_id("K")
        assert session.calls[0].url.startswith(f"{CONFLUENCE_API_BASE}/a%2Fb/wiki/api/v2/")


class TestTransport:
    def test_bearer_token_and_accept_header(self):
        client, s = _client(_Resp(200, {"results": []}))
        client.get_space_id("K")
        assert s.calls[0].headers["Authorization"] == "Bearer tok"
        assert s.calls[0].headers["Accept"] == "application/json"
        assert "Content-Type" not in s.calls[0].headers

    def test_http_error_raises_with_status(self):
        client, _ = _client(_Resp(403, text="forbidden"))
        with pytest.raises(ConfluenceError) as ei:
            client.get_space_id("K")
        assert ei.value.status == 403
        assert "HTTP 403" in str(ei.value)

    def test_error_body_preview_is_bounded(self):
        client, _ = _client(_Resp(500, text="x" * 5000))
        with pytest.raises(ConfluenceError) as ei:
            client.get_space_id("K")
        assert len(str(ei.value)) < 300

    def test_network_error_raises_without_status(self):
        client, _ = _client(requests.ConnectionError("boom"))
        with pytest.raises(ConfluenceError) as ei:
            client.get_space_id("K")
        assert ei.value.status is None

    def test_non_json_body_raises(self):
        client, _ = _client(_Resp(200, text="<html>"))
        with pytest.raises(ConfluenceError, match="non-JSON"):
            client.get_space_id("K")

    def test_token_never_appears_in_errors(self):
        client, _ = _client(_Resp(401, text="bad token"))
        with pytest.raises(ConfluenceError) as ei:
            client.get_space_id("K")
        assert "tok" not in str(ei.value).replace("token", "")


class TestSpacesAndPages:
    def test_get_space_id(self):
        client, s = _client(_Resp(200, {"results": [{"id": 77, "key": "ENG"}]}))
        assert client.get_space_id("ENG") == "77"
        assert s.calls[0].url == f"{V2}/spaces"
        assert s.calls[0].params == {"keys": "ENG", "limit": 1}

    def test_get_space_id_none_when_absent_or_key_differs(self):
        client, _ = _client(_Resp(200, {"results": [{"id": 1, "key": "OTHER"}]}))
        assert client.get_space_id("ENG") is None

    def test_find_page_by_title_exact_match_only(self):
        client, s = _client(
            _Resp(200, {"results": [_page("1", "t"), _page("2", "T", 4, parentId=9)]})
        )
        page = client.find_page_by_title("77", "T")
        assert page == Page(id="2", title="T", version=4, parent_id="9")
        assert s.calls[0].url == f"{V2}/pages"
        assert s.calls[0].params == {
            "space-id": "77",
            "title": "T",
            "status": "current",
            "limit": 5,
        }

    def test_find_page_by_title_none(self):
        client, _ = _client(_Resp(200, {"results": []}))
        assert client.find_page_by_title("77", "T") is None

    def test_get_page_reads_body_and_version(self):
        raw = _page(body={"storage": {"value": "<p>x</p>"}})
        client, s = _client(_Resp(200, raw))
        page = client.get_page("10")
        assert page.body == "<p>x</p>"
        assert page.version == 3
        assert s.calls[0].params == {"body-format": "storage"}

    def test_page_without_version_is_an_error(self):
        client, _ = _client(_Resp(200, {"id": "1", "title": "T"}))
        with pytest.raises(ConfluenceError, match="no version"):
            client.get_page("1")

    def test_page_without_id_is_an_error(self):
        client, _ = _client(_Resp(200, {"title": "T"}))
        with pytest.raises(ConfluenceError, match="no id"):
            client.get_page("1")

    def test_create_page_under_parent(self):
        client, s = _client(_Resp(200, _page("11", "T", 1)))
        page = client.create_page("77", "T", "<p>b</p>", "5")
        assert page.id == "11"
        call = s.calls[0]
        assert (call.method, call.url) == ("POST", f"{V2}/pages")
        assert call.json == {
            "spaceId": "77",
            "status": "current",
            "title": "T",
            "parentId": "5",
            "body": {"representation": "storage", "value": "<p>b</p>"},
        }
        assert call.headers["Content-Type"] == "application/json"

    def test_create_page_at_space_root_omits_parent(self):
        client, s = _client(_Resp(200, _page("11", "T", 1)))
        client.create_page("77", "T", "<p>b</p>", None)
        assert "parentId" not in s.calls[0].json

    def test_update_page_increments_version(self):
        client, s = _client(_Resp(200, _page("10", "T", 4)))
        updated = client.update_page(Page(id="10", title="T", version=3), "T", "<p>n</p>", "msg")
        assert updated.version == 4
        call = s.calls[0]
        assert (call.method, call.url) == ("PUT", f"{V2}/pages/10")
        assert call.json["version"] == {"number": 4, "message": "msg"}
        assert call.json["body"] == {"representation": "storage", "value": "<p>n</p>"}


class TestPageUrl:
    def test_base_plus_webui(self):
        raw = _page(
            _links={"base": "https://acme.atlassian.net/wiki", "webui": "/spaces/E/pages/10"}
        )
        client, _ = _client(_Resp(200, raw))
        assert client.get_page("10").url == "https://acme.atlassian.net/wiki/spaces/E/pages/10"

    def test_site_url_fallback(self):
        raw = _page(_links={"webui": "/spaces/E/pages/10"})
        client, _ = _client(_Resp(200, raw), site_url="https://acme.atlassian.net/")
        assert client.get_page("10").url == "https://acme.atlassian.net/wiki/spaces/E/pages/10"

    def test_no_url_without_base_or_site(self):
        client, _ = _client(_Resp(200, _page(_links={"webui": "/x"})))
        assert client.get_page("10").url is None

    def test_non_https_base_is_ignored(self):
        raw = _page(_links={"base": "javascript:x", "webui": "/x"})
        client, _ = _client(_Resp(200, raw))
        assert client.get_page("10").url is None


class TestLabels:
    def test_get_labels_follows_relative_next_links(self):
        client, s = _client(
            _Resp(
                200,
                {
                    "results": [{"name": "factory-generated"}],
                    "_links": {"next": "/wiki/api/v2/pages/10/labels?cursor=abc"},
                },
            ),
            _Resp(200, {"results": [{"name": "factory-draft"}, {"bad": 1}]}),
        )
        assert client.get_labels("10") == {"factory-generated", "factory-draft"}
        assert s.calls[1].url == f"{GATEWAY}/wiki/api/v2/pages/10/labels?cursor=abc"
        assert s.calls[1].params is None

    def test_get_labels_ignores_absolute_next_links(self):
        client, s = _client(
            _Resp(200, {"results": [], "_links": {"next": "https://evil.example/x"}}),
        )
        assert client.get_labels("10") == set()
        assert len(s.calls) == 1

    def test_get_labels_pagination_is_bounded(self):
        loop = {"results": [], "_links": {"next": "/wiki/api/v2/pages/10/labels?cursor=x"}}
        client, s = _client(*[_Resp(200, loop) for _ in range(20)])
        client.get_labels("10")
        assert len(s.calls) == 10

    def test_add_labels_uses_v1(self):
        client, s = _client(_Resp(200, {"results": []}))
        client.add_labels("10", ["a", "b"])
        assert (s.calls[0].method, s.calls[0].url) == ("POST", f"{V1}/content/10/label")
        assert s.calls[0].json == [
            {"prefix": "global", "name": "a"},
            {"prefix": "global", "name": "b"},
        ]

    def test_remove_label_tolerates_404(self):
        client, s = _client(_Resp(404, text="nope"))
        client.remove_label("10", "x")
        assert s.calls[0].method == "DELETE"
        assert s.calls[0].params == {"name": "x"}

    def test_remove_label_raises_other_errors(self):
        client, _ = _client(_Resp(500, text="err"))
        with pytest.raises(ConfluenceError):
            client.remove_label("10", "x")

    def test_mark_final_adds_final_then_removes_draft(self):
        client, s = _client(_Resp(200, {}), _Resp(204))
        client.mark_final("10")
        assert s.calls[0].json == [{"prefix": "global", "name": LABEL_FINAL}]
        assert s.calls[1].method == "DELETE"
        assert s.calls[1].params == {"name": LABEL_DRAFT}


class TestLastWrittenVersion:
    def _prop(self, value, version=1, pid="p1"):
        return {
            "results": [
                {
                    "id": pid,
                    "key": LAST_WRITTEN_VERSION_KEY,
                    "value": value,
                    "version": {"number": version},
                }
            ]
        }

    def test_get_reads_property(self):
        client, s = _client(_Resp(200, self._prop(5)))
        assert client.get_last_written_version("10") == 5
        assert s.calls[0].url == f"{V2}/pages/10/properties"
        assert s.calls[0].params == {"key": LAST_WRITTEN_VERSION_KEY}

    @pytest.mark.parametrize("value", ["7", " 7 "])
    def test_get_accepts_numeric_strings(self, value):
        client, _ = _client(_Resp(200, self._prop(value)))
        assert client.get_last_written_version("10") == 7

    @pytest.mark.parametrize("value", [True, "x", None, {"n": 1}, 1.5])
    def test_get_rejects_non_integers(self, value):
        client, _ = _client(_Resp(200, self._prop(value)))
        assert client.get_last_written_version("10") is None

    def test_get_none_when_missing(self):
        client, _ = _client(_Resp(200, {"results": []}))
        assert client.get_last_written_version("10") is None

    def test_set_creates_when_missing(self):
        client, s = _client(_Resp(200, {"results": []}), _Resp(200, {"id": "p1"}))
        client.set_last_written_version("10", 4)
        assert (s.calls[1].method, s.calls[1].url) == ("POST", f"{V2}/pages/10/properties")
        assert s.calls[1].json == {"key": LAST_WRITTEN_VERSION_KEY, "value": 4}

    def test_set_updates_existing_with_bumped_property_version(self):
        client, s = _client(_Resp(200, self._prop(3, version=2)), _Resp(200, {"id": "p1"}))
        client.set_last_written_version("10", 4)
        assert (s.calls[1].method, s.calls[1].url) == ("PUT", f"{V2}/pages/10/properties/p1")
        assert s.calls[1].json == {
            "key": LAST_WRITTEN_VERSION_KEY,
            "value": 4,
            "version": {"number": 3},
        }


class TestReadBack:
    def _responses(self, version, marker):
        props = (
            {"results": []}
            if marker is None
            else {"results": [{"id": "p", "key": LAST_WRITTEN_VERSION_KEY, "value": marker}]}
        )
        return (
            _Resp(200, _page(version=version, body={"storage": {"value": "<p>PM edit</p>"}})),
            _Resp(200, props),
        )

    def test_returns_current_content_and_version(self):
        client, _ = _client(*self._responses(5, 5))
        rb = client.read_back("10")
        assert rb.page.body == "<p>PM edit</p>"
        assert rb.page.version == 5
        assert rb.last_written_version == 5
        assert rb.human_edited is False

    def test_detects_an_edit_by_version(self):
        client, _ = _client(*self._responses(6, 5))
        assert client.read_back("10").human_edited is True

    def test_missing_marker_counts_as_edited(self):
        client, _ = _client(*self._responses(1, None))
        assert client.read_back("10").human_edited is True
