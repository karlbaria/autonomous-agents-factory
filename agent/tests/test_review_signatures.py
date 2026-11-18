"""Tests for new-public-signature extraction (Task 4 — ADR-025 (fork))."""

from __future__ import annotations

from review.signatures import extract_new_public_signatures, issue_names_interface

_PYTHON_DIFF = """\
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
+def _internal_helper(x: int) -> int:
+    return x * 2
"""

_JS_DIFF = """\
diff --git a/src/routes.js b/src/routes.js
index 1111111..2222222 100644
--- a/src/routes.js
+++ b/src/routes.js
@@ -1,0 +1,4 @@
+export function computeGcd(a, b) {
+  while (b) { [a, b] = [b, a % b]; }
+  return a;
+}
"""


class TestExtractNewPublicSignatures:
    def test_extracts_route_and_def_without_body(self):
        sigs = extract_new_public_signatures(_PYTHON_DIFF)
        names = {s.name for s in sigs}
        assert "gcd" in names
        gcd = next(s for s in sigs if s.name == "gcd")
        assert gcd.file == "app/main.py"
        assert '@app.get("/gcd/{a}/{b}")' in gcd.signature
        assert "def gcd(a: int, b: int) -> int:" in gcd.signature
        # No body line ("while b:" / "return a") leaked into the signature.
        assert "while b" not in gcd.signature
        assert "return a" not in gcd.signature

    def test_private_functions_excluded(self):
        sigs = extract_new_public_signatures(_PYTHON_DIFF)
        assert "_internal_helper" not in {s.name for s in sigs}

    def test_js_function_extracted(self):
        sigs = extract_new_public_signatures(_JS_DIFF)
        assert "computeGcd" in {s.name for s in sigs}

    def test_no_signatures_in_empty_diff(self):
        assert extract_new_public_signatures("") == []

    def test_non_matching_diff_yields_no_signatures(self):
        diff = "diff --git a/README.md b/README.md\n+++ b/README.md\n+Just some prose.\n"
        assert extract_new_public_signatures(diff) == []


class TestIssueNamesInterface:
    def test_true_when_issue_mentions_function_name(self):
        sigs = extract_new_public_signatures(_PYTHON_DIFF)
        assert issue_names_interface("Add a GET /gcd/{a}/{b} endpoint called gcd", sigs)

    def test_false_when_issue_does_not_mention_any_name(self):
        sigs = extract_new_public_signatures(_PYTHON_DIFF)
        assert not issue_names_interface("Add a new endpoint for the next operation", sigs)

    def test_false_on_empty_signature_list(self):
        assert not issue_names_interface("anything", [])
