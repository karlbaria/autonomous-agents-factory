"""Markdown → Confluence storage format (Task 14, issue #57 §3)."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from confluence.storage import (
    MAX_TITLE_LENGTH,
    cdata,
    escape_xhtml,
    markdown_to_confluence_storage,
    split_title,
)

FIXTURES = Path(__file__).parent / "fixtures" / "confluence"
# Inputs are `.input.txt`, not `.md`: the repo's Markdown lint and link check
# scan every `.md` file, and these deliberately hold unresolvable links and
# skipped heading levels.
FIXTURE_NAMES = sorted(p.name.removesuffix(".input.txt") for p in FIXTURES.glob("*.input.txt"))


def _parse(storage: str) -> ET.Element:
    """Storage format must be well-formed XML once the ac: namespace is bound."""
    return ET.fromstring(  # noqa: S314 -- parses the converter's own output, not untrusted input
        f'<root xmlns:ac="urn:confluence-ac" xmlns:ri="urn:confluence-ri">{storage}</root>'
    )


def test_fixture_set_is_not_empty():
    assert {
        "code_blocks",
        "escaping_and_lossy",
        "headings_and_inline",
        "lists",
        "table",
    } <= set(FIXTURE_NAMES)


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_converts_to_expected_storage(name):
    markdown = (FIXTURES / f"{name}.input.txt").read_text()
    expected = (FIXTURES / f"{name}.storage.xml").read_text().rstrip("\n")
    assert markdown_to_confluence_storage(markdown) == expected


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_output_is_well_formed_xml(name):
    _parse(markdown_to_confluence_storage((FIXTURES / f"{name}.input.txt").read_text()))


class TestEscaping:
    def test_escape_xhtml_covers_the_four_characters(self):
        assert escape_xhtml('a & b < c > d "e"') == "a &amp; b &lt; c &gt; d &quot;e&quot;"

    def test_ampersand_is_escaped_first(self):
        assert escape_xhtml("&lt;") == "&amp;lt;"

    def test_markup_in_text_is_never_interpreted(self):
        out = markdown_to_confluence_storage(
            '<ac:structured-macro ac:name="html">x</ac:structured-macro>'
        )
        root = _parse(out)
        assert [child.tag for child in root] == ["p"]
        assert "ac:structured-macro" in (root[0].text or "")

    def test_cdata_splits_terminator(self):
        assert cdata("a]]>b") == "<![CDATA[a]]]]><![CDATA[>b]]>"

    def test_cdata_round_trips_terminator_through_an_xml_parser(self):
        body = 'x = "]]>" ; y = "]]>]]>"'
        out = markdown_to_confluence_storage(f"```\n{body}\n```")
        root = _parse(out)
        text = "".join(root.itertext())
        assert text == body

    def test_code_block_body_is_not_escaped_or_formatted(self):
        out = markdown_to_confluence_storage("```\n<b>**x**</b> & y\n```")
        assert "<![CDATA[<b>**x**</b> & y]]>" in out

    def test_xml_invalid_control_characters_are_dropped(self):
        out = markdown_to_confluence_storage("a\x00b\x07c\x1fd\tz")
        assert out == "<p>abcd\tz</p>"
        _parse(out)

    def test_crlf_input_is_normalised(self):
        assert markdown_to_confluence_storage("# H\r\n\r\ntext\r\n") == "<h1>H</h1><p>text</p>"


class TestBlocks:
    def test_empty_input_renders_nothing(self):
        assert markdown_to_confluence_storage("") == ""

    def test_unclosed_fence_runs_to_end(self):
        out = markdown_to_confluence_storage("```js\nlet a = 1;\nlet b = 2;")
        assert out.endswith(
            "<![CDATA[let a = 1;\nlet b = 2;]]></ac:plain-text-body></ac:structured-macro>"
        )

    def test_code_language_is_sanitised(self):
        out = markdown_to_confluence_storage('```c++"><x>\nint a;\n```')
        # Only [A-Za-z0-9_+#.-] survive: no quote or tag can break out.
        assert '<ac:parameter ac:name="language">c++x</ac:parameter>' in out
        _parse(out)

    def test_heading_with_closing_hashes(self):
        assert markdown_to_confluence_storage("## Title ##") == "<h2>Title</h2>"

    def test_seven_hashes_is_a_paragraph(self):
        assert markdown_to_confluence_storage("####### no") == "<p>####### no</p>"

    def test_list_ends_at_a_heading(self):
        out = markdown_to_confluence_storage("- a\n  # heading")
        assert out == "<ul><li>a</li></ul><h1>heading</h1>"

    def test_switching_list_type_at_same_level_starts_a_new_list(self):
        out = markdown_to_confluence_storage("- a\n1. b")
        assert out == "<ul><li>a</li></ul><ol><li>b</li></ol>"

    def test_table_requires_a_separator_row(self):
        assert markdown_to_confluence_storage("a | b\nc | d") == "<p>a | b c | d</p>"

    def test_table_ends_at_blank_line(self):
        out = markdown_to_confluence_storage("| a |\n|---|\n| 1 |\n\nafter")
        assert out.endswith("</tbody></table><p>after</p>")


class TestInline:
    def test_emphasis_inside_link_label(self):
        out = markdown_to_confluence_storage("[**b**](https://x.y)")
        assert out == '<p><a href="https://x.y"><strong>b</strong></a></p>'

    def test_code_span_inside_link_label(self):
        out = markdown_to_confluence_storage("[`a_b`](https://x.y)")
        assert out == '<p><a href="https://x.y"><code>a_b</code></a></p>'

    def test_underscores_in_urls_are_not_emphasis(self):
        out = markdown_to_confluence_storage("[x](https://h/_a_/_b_)")
        assert 'href="https://h/_a_/_b_"' in out
        assert "<em>" not in out

    def test_double_backtick_code_span(self):
        assert markdown_to_confluence_storage("``a ` b``") == "<p><code>a ` b</code></p>"

    @pytest.mark.parametrize(
        "url",
        ["javascript:alert(1)", "JaVaScRiPt:x", "vbscript:x", "data:text/html,x", "file:///etc"],
    )
    def test_unsafe_link_schemes_stay_plain_text(self, url):
        out = markdown_to_confluence_storage(f"[x]({url})")
        assert "<a " not in out

    @pytest.mark.parametrize(
        "url",
        ["https://a.b", "http://a.b", "mailto:a@b.c", "/abs", "#frag", "./rel", "../up", "rel"],
    )
    def test_safe_link_targets_become_anchors(self, url):
        assert f'<a href="{url}">' in markdown_to_confluence_storage(f"[x]({url})")


class TestSplitTitle:
    def test_first_h1_becomes_title_and_leaves_the_body(self):
        title, body = split_title("intro\n# The Title\n\nbody text")
        assert title == "The Title"
        assert body == "intro\n\nbody text"

    def test_no_h1_returns_empty_title_and_unchanged_body(self):
        assert split_title("## only h2\ntext") == ("", "## only h2\ntext")

    def test_h1_inside_a_code_fence_is_not_a_title(self):
        md = "```\n# not a title\n```\n# Real"
        title, body = split_title(md)
        assert title == "Real"
        assert "# not a title" in body

    def test_empty_h1_is_skipped(self):
        assert split_title("#\n# Second")[0] == "Second"

    def test_title_is_capped(self):
        title, _ = split_title("# " + "x" * 400)
        assert len(title) == MAX_TITLE_LENGTH
