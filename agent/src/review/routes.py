"""Deterministic extraction of the new routes a diff adds.

Call 1 (the probe writer) must never see the coder's diff (ADR-025 (fork)).
When the issue doesn't already name the routes to test, this module gives it
the next best thing instead: the frontend route paths and backend HTTP
endpoints (method + path) the diff adds — never function names, signatures
or bodies (#105). Probes test through the app's public entry points, so a
route is all they need; a function name would only invite an import of an
internal module.

Deliberately scoped to what this lab's sample repos use: React Router
(``<Route path=...>`` and route objects with ``path:``), FastAPI/Flask
decorators, and Express-style ``app.get('/x', ...)`` calls. A framework this
cannot parse simply yields no routes, and the probe writer falls back to the
issue text alone.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict

_FILE_HEADER_RE = re.compile(r"^\+\+\+ b/(.+)$")

_JS_SUFFIXES = (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")

_HTTP_METHODS = "get|post|put|patch|delete|head|options"

# Python: `@app.get("/path")`, `@router.post('/path', ...)`.
_PY_METHOD_ROUTE_RE = re.compile(
    rf"^\s*@[A-Za-z_][A-Za-z0-9_.]*\.({_HTTP_METHODS})\(\s*[rf]?[\"'](/[^\"']*)[\"']"
)
# Python (Flask): `@app.route("/path", methods=["POST", "PUT"])`.
_PY_FLASK_ROUTE_RE = re.compile(
    r"^\s*@[A-Za-z_][A-Za-z0-9_.]*\.route\(\s*[rf]?[\"'](/[^\"']*)[\"']"
)
_PY_FLASK_METHODS_RE = re.compile(r"methods\s*=\s*[\[(]([^\])]*)[\])]")

# JS/TS backend (Express and alikes): `app.get('/path', ...)`, `router.post("/path"`.
_JS_METHOD_ROUTE_RE = re.compile(
    rf"\b[A-Za-z_$][A-Za-z0-9_$]*\.({_HTTP_METHODS})\(\s*[\"'`](/[^\"'`]*)[\"'`]"
)

# JS/TS frontend (React Router): `<Route path="/bag" ...>`, `{ path: '/bag', ... }`.
# Lazy `.*?`, not `[^>]*`: an `element={<Page />}` before `path` holds a `>`.
_JSX_ROUTE_RE = re.compile(r"<Route\b.*?\bpath\s*=\s*\{?\s*[\"'`]([^\"'`]*)[\"'`]")
_ROUTE_OBJECT_RE = re.compile(r"\bpath\s*:\s*[\"'`]([^\"'`]*)[\"'`]")


class NewRoute(BaseModel):
    """A route the diff adds: a frontend path, or a backend method + path."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["frontend", "backend"]
    path: str
    method: str | None = None

    def describe(self) -> str:
        if self.kind == "backend":
            return f"Backend endpoint: `{self.method} {self.path}`"
        return f"Frontend route: `{self.path}`"


def _iter_added_lines(diff_text: str) -> list[tuple[str, str]]:
    """Yield ``(file, line)`` for every added line, in diff order, without the '+'."""
    current_file = ""
    out: list[tuple[str, str]] = []
    for line in diff_text.splitlines():
        header = _FILE_HEADER_RE.match(line)
        if header:
            current_file = header.group(1)
            continue
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            out.append((current_file, line[1:]))
    return out


def _flask_methods(line: str) -> list[str]:
    found = _PY_FLASK_METHODS_RE.search(line)
    if not found:
        return ["GET"]
    methods = re.findall(r"[\"']([A-Za-z]+)[\"']", found.group(1))
    return [m.upper() for m in methods] or ["GET"]


def _python_routes(line: str) -> list[NewRoute]:
    method_route = _PY_METHOD_ROUTE_RE.match(line)
    if method_route:
        method, path = method_route.groups()
        return [NewRoute(kind="backend", method=method.upper(), path=path)]
    flask_route = _PY_FLASK_ROUTE_RE.match(line)
    if flask_route:
        path = flask_route.group(1)
        return [NewRoute(kind="backend", method=m, path=path) for m in _flask_methods(line)]
    return []


def _js_routes(line: str) -> list[NewRoute]:
    routes = [
        NewRoute(kind="backend", method=method.upper(), path=path)
        for method, path in _JS_METHOD_ROUTE_RE.findall(line)
    ]
    jsx_paths = _JSX_ROUTE_RE.findall(line)
    object_paths = [] if jsx_paths else _ROUTE_OBJECT_RE.findall(line)
    routes.extend(NewRoute(kind="frontend", path=p) for p in [*jsx_paths, *object_paths])
    return routes


def extract_new_routes(diff_text: str) -> list[NewRoute]:
    """The frontend route paths and backend endpoints ``diff_text`` adds.

    Only added lines are read, and only the route itself is captured: no
    handler or component name, no signature, no body. Duplicates are dropped,
    first occurrence first.
    """
    routes: list[NewRoute] = []
    for file, line in _iter_added_lines(diff_text):
        if file.endswith(".py"):
            found = _python_routes(line)
        elif file.endswith(_JS_SUFFIXES):
            found = _js_routes(line)
        else:
            continue
        routes.extend(r for r in found if r not in routes)
    return routes


def issue_names_routes(issue_text: str, routes: list[NewRoute]) -> bool:
    """Whether the issue text already names at least one of ``routes``' paths.

    A whole-path match (not followed or preceded by another path character),
    good enough to decide "does Call 1 need the route list at all", not a
    claim about full coverage.
    """
    return any(
        re.search(rf"(?<![\w/]){re.escape(route.path)}(?![\w/])", issue_text) for route in routes
    )
