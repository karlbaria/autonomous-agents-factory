"""Markdown → Confluence storage format (Task 14, issue #57 §3).

A small, explicit, bounded converter — the same precedent as ADR-015's
ADF→markdown extractor — rather than a general markdown library. Supported:

- ATX headings (``#`` … ``######``), paragraphs, horizontal rules
- ``**bold**`` / ``__bold__``, ``*italic*`` / ``_italic_``, ``inline code``
- ordered and unordered lists, nested by indentation
- pipe tables (a header row followed by a ``---`` separator row)
- fenced code blocks → Confluence's ``code`` macro, body in CDATA
- links ``[text](url)`` (``http``, ``https``, ``mailto``, relative and ``#``
  anchors only; any other scheme stays escaped plain text)

**Escaping.** Every text node outside a code block is XHTML-escaped (``&``,
``<``, ``>``, ``"``), so markdown cannot inject markup or macros into the page.
Inside a code block's CDATA section a literal ``]]>`` is split as
``]]]]><![CDATA[>`` so it cannot end the section early. Characters XML 1.0
forbids (C0 controls other than tab/newline/carriage return) are dropped.

**Lossy boundary (documented, deliberate).** Anything else — images, block
quotes, task lists, HTML, footnotes — passes through as escaped plain text in
a paragraph: readable, never interpreted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Confluence's maximum page-title length.
MAX_TITLE_LENGTH = 255

_INVALID_XML_CHARS_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$")
_FENCE_OPEN_RE = re.compile(r"^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$")
_HR_RE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_LIST_ITEM_RE = re.compile(r"^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$")
_TABLE_SEPARATOR_RE = re.compile(r"^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
_CODE_LANGUAGE_RE = re.compile(r"[^A-Za-z0-9_+#.-]")

_CODE_SPAN_RE = re.compile(r"(`+)(.+?)\1", re.DOTALL)
# ``(?<!!)`` keeps an image ``![alt](src)`` out — images are lossy plain text.
_LINK_RE = re.compile(r"(?<!!)\[([^\[\]]+)\]\(([^()\s]+)\)")
# ``__`` is word-bounded like ``_`` (#96): ``site-header__bag-count and
# site-header__bag`` is two identifiers, not bold text between them.
_BOLD_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])")
_ITALIC_STAR_RE = re.compile(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])")
_ITALIC_UNDERSCORE_RE = re.compile(r"(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])")
_SAFE_URL_RE = re.compile(r"^(?:https?://|mailto:|/|#|\./|\.\./)", re.IGNORECASE)
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
# Placeholder delimiters: \x00 is stripped from the input first, so a
# placeholder can never collide with user text.
_PLACEHOLDER = "\x00{}\x00"
_PLACEHOLDER_RE = re.compile(r"\x00(\d+)\x00")


def escape_xhtml(text: str) -> str:
    """Escape a text node or attribute value for Confluence storage format."""
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def cdata(text: str) -> str:
    """Wrap ``text`` in a CDATA section, splitting any literal ``]]>``."""
    return "<![CDATA[" + text.replace("]]>", "]]]]><![CDATA[>") + "]]>"


def _clean(text: str) -> str:
    return _INVALID_XML_CHARS_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))


def _is_safe_url(url: str) -> bool:
    return bool(_SAFE_URL_RE.match(url)) or not _SCHEME_RE.match(url)


def _inline(text: str) -> str:
    """Render inline markdown (code spans, links, emphasis) with escaping.

    Code spans and links are swapped for placeholders before emphasis is
    applied, so an ``_`` or ``*`` inside a URL or code span is never read as
    emphasis.
    """
    slots: list[str] = []

    def _stash(rendered: str) -> str:
        slots.append(rendered)
        return _PLACEHOLDER.format(len(slots) - 1)

    def _code(m: re.Match[str]) -> str:
        return _stash(f"<code>{escape_xhtml(m.group(2).strip())}</code>")

    def _link(m: re.Match[str]) -> str:
        label, url = m.group(1), m.group(2)
        if not _is_safe_url(url):
            return m.group(0)
        return _stash(f'<a href="{escape_xhtml(url)}">{_emphasis(escape_xhtml(label))}</a>')

    text = _CODE_SPAN_RE.sub(_code, text)
    text = _LINK_RE.sub(_link, text)
    rendered = _emphasis(escape_xhtml(text))
    # A link label can itself hold a code-span placeholder: resolve until none
    # are left (each pass removes one nesting level; nesting is at most 2).
    while _PLACEHOLDER_RE.search(rendered):
        rendered = _PLACEHOLDER_RE.sub(lambda m: slots[int(m.group(1))], rendered)
    return rendered


def _emphasis(escaped: str) -> str:
    escaped = _BOLD_RE.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", escaped)
    escaped = _ITALIC_STAR_RE.sub(r"<em>\1</em>", escaped)
    return _ITALIC_UNDERSCORE_RE.sub(r"<em>\1</em>", escaped)


def _code_macro(language: str, body: str) -> str:
    lang = _CODE_LANGUAGE_RE.sub("", language)
    param = f'<ac:parameter ac:name="language">{escape_xhtml(lang)}</ac:parameter>' if lang else ""
    return (
        f'<ac:structured-macro ac:name="code">{param}'
        f"<ac:plain-text-body>{cdata(body)}</ac:plain-text-body></ac:structured-macro>"
    )


def _split_row(line: str) -> list[str]:
    stripped = line.strip()
    stripped = stripped.removeprefix("|")
    if stripped.endswith("|") and not stripped.endswith("\\|"):
        stripped = stripped[:-1]
    cells = re.split(r"(?<!\\)\|", stripped)
    return [c.strip().replace("\\|", "|") for c in cells]


def _is_table_start(lines: list[str], i: int) -> bool:
    return (
        i + 1 < len(lines)
        and "|" in lines[i]
        and bool(_TABLE_SEPARATOR_RE.match(lines[i + 1]))
        and "-" in lines[i + 1]
    )


def _indent_width(prefix: str) -> int:
    return len(prefix.expandtabs(4))


@dataclass
class _ListItem:
    indent: int
    ordered: bool
    text: str
    children: list[_ListItem] = field(default_factory=list)


def _render_list(items: list[_ListItem]) -> str:
    out: list[str] = []
    i = 0
    while i < len(items):
        ordered = items[i].ordered
        tag = "ol" if ordered else "ul"
        out.append(f"<{tag}>")
        while i < len(items) and items[i].ordered == ordered:
            item = items[i]
            children = _render_list(item.children) if item.children else ""
            out.append(f"<li>{_inline(item.text)}{children}</li>")
            i += 1
        out.append(f"</{tag}>")
    return "".join(out)


def _parse_list(lines: list[str], i: int) -> tuple[str, int]:
    """Consume a list block starting at ``lines[i]``; return (xhtml, next index)."""
    roots: list[_ListItem] = []
    stack: list[_ListItem] = []
    while i < len(lines):
        line = lines[i]
        m = _LIST_ITEM_RE.match(line)
        if m:
            indent = _indent_width(m.group(1))
            item = _ListItem(indent=indent, ordered=m.group(2)[0].isdigit(), text=m.group(3))
            while stack and stack[-1].indent >= indent:
                stack.pop()
            (stack[-1].children if stack else roots).append(item)
            stack.append(item)
            i += 1
            continue
        if line.strip() and stack and line[:1] in (" ", "\t") and not _is_block_start(lines, i):
            # Lazy continuation of the current item's text.
            stack[-1].text += " " + line.strip()
            i += 1
            continue
        break
    return _render_list(roots), i


def _is_block_start(lines: list[str], i: int) -> bool:
    line = lines[i]
    return bool(
        _HEADING_RE.match(line)
        or _FENCE_OPEN_RE.match(line)
        or _HR_RE.match(line)
        or _LIST_ITEM_RE.match(line)
        or _is_table_start(lines, i)
    )


def _parse_fence(lines: list[str], i: int, m: re.Match[str]) -> tuple[str, int]:
    fence = m.group(2)
    closing = re.compile(rf"^ {{0,3}}{re.escape(fence[0])}{{{len(fence)},}}[ \t]*$")
    body: list[str] = []
    i += 1
    while i < len(lines) and not closing.match(lines[i]):
        body.append(lines[i])
        i += 1
    # An unclosed fence runs to the end of the document.
    return _code_macro(m.group(3), "\n".join(body)), i + 1


def _parse_table(lines: list[str], i: int) -> tuple[str, int]:
    header = _split_row(lines[i])
    rows: list[list[str]] = []
    i += 2
    while i < len(lines) and lines[i].strip() and "|" in lines[i]:
        rows.append(_split_row(lines[i]))
        i += 1
    out = ["<table><tbody><tr>"]
    out.extend(f"<th>{_inline(cell)}</th>" for cell in header)
    out.append("</tr>")
    for row in rows:
        out.append("<tr>")
        out.extend(f"<td>{_inline(cell)}</td>" for cell in row)
        out.append("</tr>")
    out.append("</tbody></table>")
    return "".join(out), i


def markdown_to_confluence_storage(markdown: str) -> str:
    """Convert markdown to Confluence storage format (XHTML)."""
    lines = _clean(markdown).split("\n")
    out: list[str] = []
    paragraph: list[str] = []

    def _flush() -> None:
        if paragraph:
            out.append(f"<p>{_inline(' '.join(p.strip() for p in paragraph))}</p>")
            paragraph.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            _flush()
            i += 1
            continue
        if fence := _FENCE_OPEN_RE.match(line):
            _flush()
            block, i = _parse_fence(lines, i, fence)
            out.append(block)
            continue
        if heading := _HEADING_RE.match(line):
            _flush()
            level = len(heading.group(1))
            out.append(f"<h{level}>{_inline(heading.group(2) or '')}</h{level}>")
            i += 1
            continue
        if _HR_RE.match(line):
            _flush()
            out.append("<hr />")
            i += 1
            continue
        if _is_table_start(lines, i):
            _flush()
            block, i = _parse_table(lines, i)
            out.append(block)
            continue
        if _LIST_ITEM_RE.match(line):
            _flush()
            block, i = _parse_list(lines, i)
            out.append(block)
            continue
        paragraph.append(line)
        i += 1
    _flush()
    return "".join(out)


def split_title(markdown: str) -> tuple[str, str]:
    """Return ``(title, body)``: the first H1 line's text, and the rest.

    The H1 becomes the Confluence page title (every generated artifact opens
    with one), so it is removed from the body rather than repeated. A ``#``
    line inside a fenced code block is not a heading. Returns ``("", markdown)``
    when there is no H1. Titles are capped at Confluence's 255 characters.
    """
    lines = _clean(markdown).split("\n")
    in_fence: str | None = None
    for idx, line in enumerate(lines):
        fence = _FENCE_OPEN_RE.match(line)
        if in_fence is not None:
            if re.match(rf"^ {{0,3}}{re.escape(in_fence)}+[ \t]*$", line):
                in_fence = None
            continue
        if fence:
            in_fence = fence.group(2)[0]
            continue
        heading = _HEADING_RE.match(line)
        if heading and len(heading.group(1)) == 1 and (heading.group(2) or "").strip():
            title = heading.group(2).strip()[:MAX_TITLE_LENGTH].strip()
            body = "\n".join(lines[:idx] + lines[idx + 1 :])
            return title, body
    return "", markdown
