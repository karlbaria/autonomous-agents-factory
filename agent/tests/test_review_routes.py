"""Tests for new-route extraction (Task 4 — ADR-025 (fork); routes only since #105)."""

from __future__ import annotations

from review.routes import NewRoute, extract_new_routes, issue_names_routes

_FASTAPI_DIFF = """\
diff --git a/app/main.py b/app/main.py
index 1111111..2222222 100644
--- a/app/main.py
+++ b/app/main.py
@@ -10,6 +10,14 @@ def power(a: int, b: int) -> int:
     return a ** b


+@app.get("/gcd/{a}/{b}")
+def gcd(a: int, b: int) -> int:
+    while b:
+        a, b = b, a % b
+    return a
+
+
+@router.post('/bag/items', status_code=201)
+async def add_item(item: Item) -> Bag:
+    return bag_store.add(item)
+
+
+def _internal_helper(x: int) -> int:
+    return x * 2
"""

_FLASK_DIFF = """\
diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1,0 +1,6 @@
+@app.route("/health")
+def health():
+    return "ok"
+@app.route("/bag", methods=["POST", "DELETE"])
+def bag():
+    return "ok"
"""

_EXPRESS_DIFF = """\
diff --git a/server/routes.js b/server/routes.js
--- a/server/routes.js
+++ b/server/routes.js
@@ -1,0 +1,6 @@
+export function computeGcd(a, b) {
+  while (b) { [a, b] = [b, a % b]; }
+  return a;
+}
+router.get('/gcd/:a/:b', (req, res) => res.json(computeGcd(req.params.a, req.params.b)));
+const cached = cache.get('key');
"""

_REACT_ROUTER_DIFF = """\
diff --git a/frontend/src/App.jsx b/frontend/src/App.jsx
--- a/frontend/src/App.jsx
+++ b/frontend/src/App.jsx
@@ -1,0 +1,8 @@
+export function BagPage() {
+  return <Bag />;
+}
+<Route path="/bag" element={<BagPage />} />
+<Route element={<Checkout />} path={'/checkout'} />
diff --git a/frontend/src/router.js b/frontend/src/router.js
--- a/frontend/src/router.js
+++ b/frontend/src/router.js
@@ -1,0 +1,1 @@
+const routes = [{ path: '/orders/:id', element: <Order /> }];
"""


class TestBackendEndpoints:
    def test_fastapi_decorators_give_method_and_path(self):
        assert extract_new_routes(_FASTAPI_DIFF) == [
            NewRoute(kind="backend", method="GET", path="/gcd/{a}/{b}"),
            NewRoute(kind="backend", method="POST", path="/bag/items"),
        ]

    def test_flask_route_defaults_to_get_and_reads_methods(self):
        assert extract_new_routes(_FLASK_DIFF) == [
            NewRoute(kind="backend", method="GET", path="/health"),
            NewRoute(kind="backend", method="POST", path="/bag"),
            NewRoute(kind="backend", method="DELETE", path="/bag"),
        ]

    def test_express_calls_give_method_and_path_and_skip_non_routes(self):
        # `cache.get('key')` has no leading slash, so it is not a route.
        assert extract_new_routes(_EXPRESS_DIFF) == [
            NewRoute(kind="backend", method="GET", path="/gcd/:a/:b"),
        ]


class TestFrontendRoutes:
    def test_react_router_paths_from_jsx_and_route_objects(self):
        assert extract_new_routes(_REACT_ROUTER_DIFF) == [
            NewRoute(kind="frontend", path="/bag"),
            NewRoute(kind="frontend", path="/checkout"),
            NewRoute(kind="frontend", path="/orders/:id"),
        ]


class TestNoFunctionNamesOrSignatures:
    """#105: the extractor yields routes only — never names, signatures or bodies."""

    def test_nothing_but_routes_is_captured(self):
        diff = _FASTAPI_DIFF + _EXPRESS_DIFF + _REACT_ROUTER_DIFF
        described = "\n".join(r.describe() for r in extract_new_routes(diff))
        for leaked in ("gcd(", "add_item", "computeGcd", "BagPage", "def ", "function", "return"):
            assert leaked not in described

    def test_a_function_without_a_route_yields_nothing(self):
        diff = "+++ b/src/bag.js\n+export function addItem(bag, item) {\n+  return bag;\n+}\n"
        assert extract_new_routes(diff) == []


class TestExtractEdgeCases:
    def test_empty_diff(self):
        assert extract_new_routes("") == []

    def test_non_code_files_are_ignored(self):
        diff = '+++ b/README.md\n+Call @app.get("/gcd") or <Route path="/bag" />.\n'
        assert extract_new_routes(diff) == []

    def test_removed_and_context_lines_are_ignored(self):
        diff = '+++ b/app.py\n-@app.get("/old")\n @app.get("/kept")\n'
        assert extract_new_routes(diff) == []

    def test_duplicates_are_dropped(self):
        diff = '+++ b/app.py\n+@app.get("/a")\n+@app.get("/a")\n'
        assert extract_new_routes(diff) == [NewRoute(kind="backend", method="GET", path="/a")]


class TestDescribe:
    def test_backend_and_frontend_wording(self):
        assert NewRoute(kind="backend", method="GET", path="/a").describe() == (
            "Backend endpoint: `GET /a`"
        )
        assert NewRoute(kind="frontend", path="/bag").describe() == "Frontend route: `/bag`"


class TestIssueNamesRoutes:
    def test_true_when_issue_mentions_a_path(self):
        routes = extract_new_routes(_FASTAPI_DIFF)
        assert issue_names_routes("Add a GET /gcd/{a}/{b} endpoint", routes)

    def test_false_when_issue_mentions_no_path(self):
        routes = extract_new_routes(_FASTAPI_DIFF)
        assert not issue_names_routes("Add a new endpoint for the next operation", routes)

    def test_a_longer_path_does_not_count_as_naming_a_prefix(self):
        routes = [NewRoute(kind="frontend", path="/bag")]
        assert not issue_names_routes("Show the bag at /bag/summary", routes)

    def test_false_on_empty_route_list(self):
        assert not issue_names_routes("anything", [])
