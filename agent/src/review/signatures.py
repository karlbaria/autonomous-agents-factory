"""Deterministic extraction of new public interface signatures from a diff.

Call 1 (the probe writer) must never see the coder's diff (ADR-025 (fork)).
When the issue doesn't already name the interface to test, this module gives
it the next best thing instead: the names and signatures of new public
functions or routes the diff adds, with bodies stripped — never the
implementation.

Deliberately scoped to Python (``def`` + common route decorators) and
JS/TS (``function`` + common route calls), matching what this lab's sample
repos use. A language this cannot parse simply yields no signatures, and the
probe writer falls back to the issue text alone.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict

_FILE_HEADER_RE = re.compile(r"^\+\+\+ b/(.+)$")

# Python: `def name(...):` / `async def name(...):`, and a decorator line
# immediately preceding it (e.g. `@app.get("/path")`) is folded in.
_PY_DEF_RE = re.compile(
    r"^\+\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$"
)
_PY_DECORATOR_RE = re.compile(r"^\+\s*@[A-Za-z_][A-Za-z0-9_.]*\(.*\)\s*$")

# JS/TS: `function name(...)`, optionally `export`/`async`.
_JS_FUNCTION_RE = re.compile(
    r"^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("
)


class PublicSignature(BaseModel):
    """A new public function/route name + signature line(s), body-free."""

    model_config = ConfigDict(frozen=True)

    name: str
    signature: str
    file: str


def _is_public(name: str) -> bool:
    return not name.startswith("_")


def _iter_added_lines(diff_text: str) -> list[tuple[str, str]]:
    """Yield ``(file, line)`` for every added line, in diff order."""
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
            out.append((current_file, line))
    return out


def extract_new_public_signatures(diff_text: str) -> list[PublicSignature]:
    """Extract new public function/route signatures added by ``diff_text``.

    Bodies are never included: each result is the decorator line(s) (if any)
    immediately preceding a matched definition, plus the definition line
    itself, with nothing captured beyond it.
    """
    signatures: list[PublicSignature] = []
    pending_decorators: list[str] = []

    for file, raw_line in _iter_added_lines(diff_text):
        line = raw_line[1:]  # drop the leading '+'
        prefixed = "+" + line

        py_decorator = _PY_DECORATOR_RE.match(prefixed)
        if py_decorator:
            pending_decorators.append(line.strip())
            continue

        py_def = _PY_DEF_RE.match(prefixed)
        if py_def:
            name = py_def.group(1)
            if _is_public(name):
                sig_lines = [*pending_decorators, line.strip()]
                signatures.append(
                    PublicSignature(name=name, signature="\n".join(sig_lines), file=file)
                )
            pending_decorators = []
            continue

        js_fn = _JS_FUNCTION_RE.match(prefixed)
        if js_fn:
            name = js_fn.group(1)
            if _is_public(name):
                sig_lines = [*pending_decorators, line.strip()]
                signatures.append(
                    PublicSignature(name=name, signature="\n".join(sig_lines), file=file)
                )
            pending_decorators = []
            continue

        # Any other added line breaks the decorator/def adjacency.
        pending_decorators = []

    return signatures


def issue_names_interface(issue_text: str, signatures: list[PublicSignature]) -> bool:
    """Whether the issue text already names at least one of ``signatures``.

    A simple whole-word, case-sensitive match on each signature's name — good
    enough to decide "does Call 1 need the signature list at all", not a
    claim about full coverage.
    """
    return any(re.search(rf"\b{re.escape(sig.name)}\b", issue_text) for sig in signatures)
