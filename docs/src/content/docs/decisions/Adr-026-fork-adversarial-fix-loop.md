---
title: "ADR-026 (fork): Bounded adversarial fix loop"
---

**Status:** accepted
**Date:** 2026-11-18
**Last-updated:** 2026-11-23
**Implementation:** [autonomous-agents-factory#20](https://github.com/karlbaria/autonomous-agents-factory/issues/20). Addendum to [ADR-025 (fork)](/sample-autonomous-cloud-coding-agents/decisions/adr-025-fork-two-call-reviewer) — Factory Lab Task 5 (`docs/lab/FACTORY_PLAN.md`). "(fork)" marks this ADR as a **fork** of that plan doc's Task 5 text: six points were amended by the repo owner before implementation (see "Fork points" below), so this document — not the plan doc — is the record of what actually shipped.

## Context

Task 4 (ADR-025 (fork)) shipped the independent two-call review in `advisory` mode only: a `NOT_READY` verdict is reported in the PR, never acted on. `review_mode: adversarial` was declared in the schema and treated identically to `advisory`, with the loop itself deferred. A finding that blocks merge still required a human to read the PR, understand the finding, and either fix it themselves or send the task back — the review step produced information, not remediation.

## Decision

Extend `review.backend.run_review_and_fix` so `review_mode: adversarial` repeats the same round (fresh probes -> the probe run -> a fresh code review) up to a bounded `max_iterations`, with a **fixer** call between rounds that gets the round's findings and failing probes as evidence and must fix the code:

1. **Each round is fully independent.** Call 1 (the probe writer) runs again from scratch in a new worktree/scratch dir, blind to the fix, exactly as Task 4's single round did — never the same probes reused, never Call 1 told what changed.
2. **The previous round's failing probes carry forward** (excluding any Call 2 marked invalid) and rerun alongside the fresh ones, merged by filename (`review/backend.py::_merge_probes`) — the fix has to actually make them pass, not just dodge a fresh probe writer that might not re-discover the same gap.
3. **The fixer is coder-shaped**, not reviewer-shaped: the same model, the same tool surface (`Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep`), against the same `setup.repo_dir` — it mutates code, unlike either reviewer call. Its prompt (`review/prompts.py::fixer_user_prompt`) includes the original issue, not just findings/probes (amendment 3).
4. **The probes are protected from the fixer**, deterministically. Before the fixer call, `review/backend.py::_snapshot_dir` captures every file under `tests/review_probes/`; after it, `_restore_and_diff` reverts anything that changed (including deleting a file the fixer created there) and reports the reverted paths on the next round's result. A new Cedar hard-deny rule, `review_fixer_write_protected_root` (keyed on a `protected_write_roots` `PolicyEngine` option, the inverse of Task 4's `scratch_write_root` confinement), denies the fixer's `Write`/`Edit` into that path as a second, defense-in-depth layer — the fixer has `Bash`, which that rule cannot see, so the deterministic revert is what actually enforces this (amendment 1).
5. **Blocking is Call 2's verdict, never a raw probe-failure count.** A `block_on_severity` setting (default `major`) is threaded into Call 2's prompt as the floor for an evidence-backed `issue` finding to justify `NOT-READY`; Call 2 may also mark a probe invalid — tests behavior the issue never asked for — via an optional `INVALID_PROBES:` block in its contract, with its reasoning recorded (amendment 2). An invalid probe is excluded from the next round's carry-forward.
6. **A verdict is refused if the reviewed SHA no longer matches the code** by the time the review finishes (`RoundOutcome.stale_sha`), and **a review call that doesn't finish — raises, or produces unparseable output — is retried once** before counting as `NOT_READY` (`review/backend.py::_run_code_reviewer`).
7. **The loop stops** on a `READY` verdict, on exhausting `max_iterations`, or on running out of budget mid-loop — each case recorded (`ReviewAndFixResult.stopped_reason`) and emitted as a `review_round` milestone per round (`"round N: verdict=... findings=... probes_failed=..."`).
8. **An unresolved loop** (still `NOT_READY` when it stops) is handled per `on_unresolved`: `pr_with_warning` (the default) still opens the PR, with the `review:unresolved` label added once the PR exists (`post_hooks.py::apply_unresolved_label`); `fail` fails the task instead (`pipeline.py::_apply_unresolved_review_failure` overrides the coder's already-succeeded `agent_result`, since `review_and_fix`'s own failed `StepOutcome` does not by itself propagate past `_execute_agent_step`).

The fixer's code changes (and any probe-tamper revert) are committed deterministically (`review/backend.py::_commit_fixer_changes`), not left to the fixer's own turn — the next round's diff and reviewed-SHA capture both need it committed, the same way the coder's own turn commits before round one.

A new workflow, `coding/new-task-adversarial-v1`, is `coding/new-task-v1` plus a `review_and_fix` step with `review_mode: adversarial`. **`coding/new-task-v1` and `coding/new-task-verified-v1` are both unchanged.**

## Fork points

Approved by the repo owner before implementation, amending `FACTORY_PLAN.md`'s Task 5 text:

1. **Probes are protected by a deterministic check, not just Cedar.** The plan noted the fixer "can't edit or delete the probes" without saying how that's enforced against a tool surface that includes `Bash`. The owner required the snapshot/revert in `review/backend.py` as the actual enforcement, with the Cedar rule kept as defense-in-depth only.
2. **Blocking is Call 2's verdict, not raw probe failures.** The owner required Call 2 to be able to mark a probe invalid (with its reasoning recorded) rather than treating every failing probe as inherently blocking — codified as the optional `INVALID_PROBES:` contract block.
3. **The fixer's prompt includes the original issue**, not just the findings and failing probes, so it grades against the same requirements Call 1 and Call 2 do.
4. **Each later round reruns the previous round's failing probes alongside the fresh ones** — not just whatever the fresh probe-writer call for that round happens to produce.
5. **`on_unresolved` defaults to `pr_with_warning`**, not `fail` — an unresolved adversarial review still ships a PR a human can look at, by default.
6. **ADR file name:** `docs/decisions/ADR-026-fork-adversarial-fix-loop.md`.

## Consequences

- **Positive:** A `NOT_READY` finding is no longer just information — the bounded loop gives the task a real chance to self-correct before a human ever sees it, while `max_iterations` and the budget check both keep it from running away.
- **Positive:** The probe-protection mechanism (snapshot/revert + a Cedar rule keyed on a new, dormant-by-default `protected_write_roots` option) reuses exactly the pattern ADR-025 anticipated: "a future reviewer-shaped call... reuses the same mechanism by setting the same two `TaskConfig` fields, no new Cedar rule required" — here inverted (forbid *inside* a root, not outside one), but the same boolean-context-attribute design.
- **Negative / scoped out:** The fixer always uses the coder's own model (`TaskConfig.anthropic_model`), not a separately configurable one — Task 5's base spec never asked for that, and reusing the coder's model keeps "the fixer is coder-shaped" literally true. `block_on_severity` shapes Call 2's prompt only; it is not independently enforced as a structural gate in the loop (Call 2's own verdict is the single source of truth for blocking, per amendment 2) — a model that ignores the instructed floor is a reviewer-prompt-quality problem Task 4's pattern already has, not new to this change.

## References

- [ADR-025 (fork): Two-call independent reviewer, advisory mode](/sample-autonomous-cloud-coding-agents/decisions/adr-025-fork-two-call-reviewer)
- `docs/lab/FACTORY_PLAN.md` — Task 5 (the adversarial fix loop)
- [autonomous-agents-factory#20](https://github.com/karlbaria/autonomous-agents-factory/issues/20)

## Changelog

- **2026-11-23 — JS/TS probes ([#69](https://github.com/karlbaria/autonomous-agents-factory/issues/69)).** Refinement: the fixer's protected set now covers JS/TS probes as well as `tests/review_probes/`.
  - The snapshot-and-revert (`_snapshot_dirs` / `_restore_and_diff`) and the `review_fixer_write_protected_root` Cedar roots also cover every package's `__probes__/` directory that a probe ran in or was committed to (see ADR-025's changelog).
  - Reverted paths are now reported repo-relative.
  - A not-runnable probe is not a failing probe: it is never carried into the next round or handed to the fixer.
- **2026-11-25 — Review gates ([#97](https://github.com/karlbaria/autonomous-agents-factory/issues/97), [#98](https://github.com/karlbaria/autonomous-agents-factory/issues/98)).** Refinement of decision 5: blocking is still Call 2's verdict, but a READY verdict can no longer stand over a probe that ran, failed and was not marked invalid.
  - `review/findings.py::enforce_probe_waivers` turns such a READY into NOT_READY with a `parse_error` naming the probes, so the fixer still runs. A waiver matches the probe's key or its bare filename.
  - A final READY whose failing probes were all waived, with no probe passing, holds the PR with `needs-human` (no independent verification). A partial waiver doesn't.
  - The reviewer's turn cap defaults to 30 (was 15) and is stated in its prompt. A call that runs out of turns, or writes no final message, is retried once with a verdict-only instruction and a 2-turn cap, rather than the same investigation again.
