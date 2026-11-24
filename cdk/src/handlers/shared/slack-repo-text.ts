/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Finding and removing the `owner/repo` token in a Slack `@mention` (moved
 * out of `slack-events.ts` for Task 15 (fork), #82 PR 2a). Pure — no I/O.
 *
 * Links are masked before the scan, so nothing inside a URL — a Confluence
 * page such as `…/wiki/spaces/SD/pages/123/Title`, or any other link — is
 * read as a repo, and the repo is never cut out of a link.
 */

/** Pattern for an "owner/repo" or "owner/repo#N" candidate inside free text. */
const REPO_CANDIDATE_PATTERN = /\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:#\d+)?)\b/g;

/**
 * A link as Slack sends it (`<https://…>` or `<https://…|label>`, also any
 * other `<…>` reference), or a bare http(s) URL.
 */
const LINK_PATTERN = /<[^<>\s]+>|https?:\/\/\S+/gi;

/** `text` with every link blanked out, keeping the length (and so every index). */
function maskLinks(text: string): string {
  return text.replace(LINK_PATTERN, (link) => ' '.repeat(link.length));
}

interface RepoMention {
  readonly token: string;
  readonly index: number;
}

function findRepoMentions(text: string): RepoMention[] {
  const masked = maskLinks(text);
  const pattern = new RegExp(REPO_CANDIDATE_PATTERN);
  const mentions: RepoMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    // A deeper segment of a longer path ("api/products" in "/api/products/count").
    if (masked[match.index - 1] === '/') continue;
    mentions.push({ token: match[1], index: match.index });
  }
  return mentions;
}

/**
 * Candidate "owner/repo[#N]" tokens found in free text, in order of first
 * appearance, de-duplicated. Excludes a match that's actually a deeper
 * segment of a longer path rather than a real repo mention — e.g.
 * "api/products" lifted out of the URL path "/api/products/count" — detected
 * by the character immediately before the match being a "/", and anything
 * inside a link (see {@link maskLinks}).
 */
export function extractRepoCandidates(text: string): string[] {
  return [...new Set(findRepoMentions(text).map((m) => m.token))];
}

/** Text before the repo that is only a leading `in` / `for`. */
const LEADING_PREPOSITION_ONLY = /^\s*(?:in|for)\s+$/i;
/** `… in` / `… for` directly before the repo. */
const PRECEDING_PREPOSITION = /(^|\s)(?:in|for)\s+$/i;
/** A separator directly after the repo ("In owner/repo, add X"). */
const FOLLOWING_SEPARATOR = /^\s*[,:;]/;
/** Nothing but closing punctuation after the repo. */
const NOTHING_AFTER = /^[\s.!?]*$/;

/**
 * `text` with the first real mention of `repo` removed, together with the
 * words that only pointed at it:
 *
 * - leading form: "In owner/repo, add X" → "add X"
 * - inline form: "plan in owner/repo, a wishlist" → "plan a wishlist"
 * - trailing form: "add X in owner/repo" → "add X"
 *
 * Anywhere else only the token goes. Whitespace is collapsed. A text with no
 * mention of `repo` (outside links) is returned unchanged.
 */
export function removeRepoMention(text: string, repo: string): string {
  const mention = findRepoMentions(text).find((m) => m.token === repo);
  if (!mention) return text;
  let before = text.slice(0, mention.index);
  let after = text.slice(mention.index + repo.length);

  if (LEADING_PREPOSITION_ONLY.test(before) || before.trim() === '') {
    before = '';
    after = after.replace(FOLLOWING_SEPARATOR, '');
  } else if (PRECEDING_PREPOSITION.test(before) && (FOLLOWING_SEPARATOR.test(after) || NOTHING_AFTER.test(after))) {
    before = before.replace(PRECEDING_PREPOSITION, '$1');
    after = after.replace(FOLLOWING_SEPARATOR, '');
    if (NOTHING_AFTER.test(after)) after = '';
  }
  return `${before} ${after}`.replace(/\s+/g, ' ').trim();
}
