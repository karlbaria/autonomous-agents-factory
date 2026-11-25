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
 * Auto-integration node for fan-out orchestrations.
 *
 * When a validated DAG has TWO OR MORE sub-issues, we append a synthetic
 * integration node that depends on ALL leaves (sub-issues with no
 * successors). It always branches off the default branch and merges every
 * leaf branch in, even a single one (``selectBaseBranch`` with
 * ``mergeIntoDefault`` → ``_merge_predecessor_branch``), so its PR is the
 * combined result and the build's only PR to target ``main`` (#89). Every
 * other child PR is labelled ``factory-stacked`` and never auto-merged: a
 * story PR merged on its own leaves the others behind ``main`` or stranded on
 * a story branch.
 *
 * Pure (no I/O), so the leaf computation + node construction is unit-tested
 * in isolation. The discovery composer calls this AFTER ``validateDag``
 * (it needs the validated node set to compute leaves) and BEFORE
 * ``seedOrchestration``, re-validating the augmented graph.
 *
 * Cases:
 *  - 0–1 sub-issue: nothing added — the single task's own PR is the result.
 *  - 2+ sub-issues (a chain, a fan-out or a diamond): one synthetic node added
 *    over all leaves. Before #89 a chain or diamond fan-in (one leaf) got none,
 *    so its final PR targeted a predecessor branch and never reached ``main``.
 */

import type { SubIssueNode } from './linear-subissue-fetch';

/**
 * Suffix marking a synthetic, platform-injected node (not a real Linear
 * sub-issue). Uses ``_`` separators, NOT ``#``: the node's ``sub_issue_id``
 * flows into ``releaseChild``'s idempotency key (``${orch}_${sub}``), which
 * createTaskCore validates against ``/^[a-zA-Z0-9_-]{1,128}$/`` — a ``#``
 * would 400 the child and it would never start (the same trap the meta-row
 * ``#meta`` SK can use safely because it never becomes an idempotency key).
 */
export const INTEGRATION_NODE_SUFFIX = '__integration';

/**
 * True if ``subIssueId`` is a platform-synthesized integration node rather
 * than a real Linear sub-issue. Callers that would address a real Linear
 * issue (reactions, MCP comments) can guard on this.
 */
export function isIntegrationNode(subIssueId: string): boolean {
  return subIssueId.endsWith(INTEGRATION_NODE_SUFFIX);
}

/** Node ids that no other node depends on — the DAG's leaves. */
export function computeLeaves(nodes: readonly SubIssueNode[]): readonly string[] {
  const hasSuccessor = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.depends_on) hasSuccessor.add(dep);
  }
  return nodes.map((n) => n.id).filter((id) => !hasSuccessor.has(id));
}

/**
 * Given a validated DAG, return the node list to seed: unchanged when there
 * are 0–1 sub-issues, or with a synthetic integration node appended
 * (depending on all leaves) when there are two or more.
 *
 * ``orchestrationId`` namespaces the synthetic node's id so it is unique +
 * recognizable (``<orchestrationId>__integration`` — see
 * {@link INTEGRATION_NODE_SUFFIX} for why the separator is ``_`` and not ``#``).
 * The node carries no
 * ``identifier`` (there is no Linear issue) and a fixed ``title`` so the
 * status block / rollup render "Integration …" gracefully.
 */
export function withIntegrationNode(
  nodes: readonly SubIssueNode[],
  orchestrationId: string,
): { readonly nodes: readonly SubIssueNode[]; readonly added: boolean } {
  const realNodes = nodes.filter((n) => !isIntegrationNode(n.id));
  if (realNodes.length < 2 || realNodes.length !== nodes.length) {
    return { nodes, added: false };
  }
  const leaves = computeLeaves(nodes);
  const integration: SubIssueNode = {
    id: `${orchestrationId}${INTEGRATION_NODE_SUFFIX}`,
    depends_on: leaves,
    title: 'Integration — combine sub-issue results',
  };
  return { nodes: [...nodes, integration], added: true };
}
