---
title: "ADR-025 (fork): Two-call independent reviewer, advisory mode"
---

**Status:** accepted
**Date:** 2026-11-18
**Last-updated:** 2026-11-23
**Implementation:** Shipped ([autonomous-agents-factory#15](https://github.com/karlbaria/autonomous-agents-factory/issues/15)). Addendum to [ADR-014](/sample-autonomous-cloud-coding-agents/decisions/adr-014-workflow-driven-tasks) — Factory Lab Task 4 (`docs/lab/FACTORY_PLAN.md`). "(fork)" marks this ADR as a **fork** of that plan doc's Task 4 text: four points were amended by the repo owner before implementation (see "Fork points" below), so this document — not the plan doc — is the record of what actually shipped.

## Context

The coder (`run_agent`'s `coder` stage) writes both the implementation and its own tests. That is a conflict of interest: a coder that misunderstands the requirement writes tests that agree with its own misunderstanding, and `verify_build` only proves the coder's tests pass against the coder's code — it proves nothing independent.

Task 3 ([ADR-014](/sample-autonomous-cloud-coding-agents/decisions/adr-014-workflow-driven-tasks)'s multi-call ledger) built exactly the seam this needs: `StepContext.ledger` already anticipated "Task 4's reviewer" sharing one `AgentInvocationLedger` across several `run_agent`-shaped calls in the same task, each drawing only the budget earlier calls left.

## Decision

Add a `review_and_fix` step kind that runs, in `advisory` mode, one round of an independent two-call review between the coder's `run_agent` step and the build/PR gates:

1. **Call 1, the probe writer** — runs in a **dedicated git worktree**, detached at `origin/<default_branch>` (the base-branch commit, never the coder's branch), plus a scratch directory outside any repository. It sees the issue/task description (or, when neither already names the routes to test, the new frontend routes and backend endpoints extracted from the diff — paths and HTTP methods only, never function names, signatures or bodies; see the changelog entry for #105) and writes pytest probe files into the scratch directory. Tools: `Read`, `Glob`, `Grep`, `Write` — no `Bash`. Two new Cedar hard-deny rules (`agent/policies/hard_deny.cedar`) confine it: `review_probe_writer_write_outside_scratch` (deny `write_file` outside the scratch root) and `review_probe_writer_read_outside_allowed_roots` (deny `read_file`/`read_file`-via-Glob/Grep outside the worktree + scratch roots). Both key off booleans `policy.py`'s `PolicyEngine` computes from two new constructor options (`scratch_write_root`, `allowed_read_roots`, threaded from two new `TaskConfig` fields) — `False` for every other caller, so the rules are dormant everywhere else.
2. **A deterministic step** (`review/probes.py::run_probes`, not an agent call) runs each probe, via `pytest`, against the coder's actual checked-out code, and records pass/fail + output per probe.
3. **Call 2, the code reviewer** — sees the issue, the diff against the base branch, and the probe results. Tools: `Read`, `Glob`, `Grep` only (no `Write`/`Edit`/`Bash`), `read_only: true`. Does the white-box review (security, error handling, design, test quality) and answers in a fixed `VERDICT:` + `FINDINGS:` JSON contract that `review/findings.py::parse_review_output` parses deterministically — the code, not the model, assigns finding IDs, and anything that doesn't fit the contract is forced to `NOT_READY` with a `parse_error`, never silently dropped.
4. **A deterministic commit step** writes only the probes that passed on the coder's code into `tests/review_probes/`, as one separate commit, before `ensure_pr` — failing probes are never committed; they appear only as unresolved findings in the PR body.

Both reviewer calls run through the **same model** (default: a model distinct from the coder's — `global.anthropic.claude-sonnet-5-5` unless the workflow step sets `reviewer_model`) and share **one turn cap**, both configurable per step (`reviewer_model`, `reviewer_max_turns`) and separate from the coder's `limits.max_turns`.

The whole round is **advisory only**: a failure anywhere in `review/backend.py::run_review_and_fix` (worktree setup, either agent call, probe execution, parsing) is caught and turned into a neutral/`NOT_READY` result, never raised — the coder's PR must ship regardless of whether the review itself could run. `review_mode: adversarial` (Task 5's bounded fix loop) is declared in the schema but not yet implemented; `run_review_and_fix` runs the same single advisory round for it today and logs that the loop is pending.

`review_and_fix` is wired into `pipeline._execute_agent_step` alongside `run_agent` (`run_workflow(wf, ctx, only_kinds={"run_agent", "review_and_fix"})`) so both share one `StepContext`/ledger within one `run_workflow` pass, rather than as a second, separate pipeline call. The result threads back to `pipeline.run_task` via an output parameter (`review_outcome_out`, mirroring the existing `ledger`-by-reference pattern) so `_execute_agent_step`'s return type — asserted by identity in existing tests — does not change. `ensure_pr` (`post_hooks.py`) gained two optional parameters, `ledger` and `review_outcome`, that add a per-stage cost breakdown and an "Independent review" section to the PR body; both are no-ops for every workflow but `coding/new-task-verified-v1`.

A new workflow, `coding/new-task-verified-v1`, is `coding/new-task-v1` plus the `review_and_fix` step. **`coding/new-task-v1` itself is unchanged.**

## Fork points

Approved by the repo owner before implementation, amending `FACTORY_PLAN.md`'s Task 4 text:

1. **Worktree isolation, not just a scratch directory.** The plan said Call 1 "writes probe tests... in a scratch directory outside the repo" but did not specify how it would be kept from reading the coder's diff. The owner required a dedicated git worktree pinned to the base-branch commit for reads, plus the scratch directory for writes — both enforced by new Cedar rules, each proven by a test that the opposite (reading the coder's checkout, writing outside scratch) is denied.
2. **No `Bash` for either reviewer call.** The plan didn't specify Call 1/Call 2's tool surface beyond "its own independent tests" and "white-box review." The owner scoped both to `Read`/`Glob`/`Grep` (+`Write` for Call 1 only) — removing `Bash` closes off the main way a path-confinement rule could be bypassed (`cd`, `cat`, `cp` outside the allowed roots) and keeps the deterministic probe run (not the agent) as the only thing that ever executes code.
3. **Deterministic interface extraction, not agent-provided.** The plan left open how Call 1 would learn the new interface when the issue doesn't name it. The owner required a deterministic step over the diff, giving Call 1 only names and signatures with bodies stripped — never the agent inferring or being told the implementation. Since [#105](https://github.com/karlbaria/autonomous-agents-factory/issues/105) that step (`review/routes.py::extract_new_routes`) gives routes only.
4. **Configurable reviewer model, defaulting to a different one than the coder's.** The plan said "the reviewer prompt" without naming a model. The owner required `reviewer_model` to be a workflow-step setting (`review/backend.py::DEFAULT_REVIEWER_MODEL`), defaulting away from the coder's model — an independent-model opinion was treated as part of "independent," not just an independent prompt/call.

## Consequences

- **Positive:** The coder's tests are no longer the only check — Call 1's probes are written blind to the implementation, so a coder that satisfies its own flawed test suite but not the stated requirement is now visible as a failing probe. The review never gates delivery (advisory), so this ships with zero risk of blocking a correct PR on a flaky or wrong reviewer call.
- **Positive:** The Cedar confinement rules are keyed on booleans the engine computes itself (`outside_scratch_dir`, `outside_allowed_read_roots`), not on a principal literal — a future reviewer-shaped call (Task 5's fixer, or any new per-call-confined agent role) reuses the same mechanism by setting the same two `TaskConfig` fields, no new Cedar rule required.
- **Negative / scoped out:** Probe execution is pytest-only (the lab's sample repos are Python); a probe in a repo this cannot run is recorded as failed with its collection error, not silently skipped — but a non-Python-testable repo gets no real coverage from this step yet. Full observability (dashboard widgets, per-round `task_span`s) is Task 6, not this change: the round emits `write_agent_milestone` milestones only. The bounded fix loop (`review_mode: adversarial`) is Task 5 — this ADR's implementation treats it identically to `advisory` and logs that the loop is pending.

## References

- [ADR-014: Workflow-driven tasks with an agent-side step runner](/sample-autonomous-cloud-coding-agents/decisions/adr-014-workflow-driven-tasks)
- `docs/lab/FACTORY_PLAN.md` — Task 4 (original plan) and Task 5 (the adversarial fix loop, deferred)
- [autonomous-agents-factory#15](https://github.com/karlbaria/autonomous-agents-factory/issues/15)

## Changelog

- **2026-11-23 — JS/TS probes ([#69](https://github.com/karlbaria/autonomous-agents-factory/issues/69)).** Refinement: the deterministic step is no longer pytest-only.
  - **Python probes** (`test_*.py`) run with `pytest` and are committed to `tests/review_probes/`, as before.
  - **JS/TS probes** (`*.test.jsx`/`.tsx`/`.js`/`.ts`) run with the probe's package's own runner: Vitest, else Jest, read from its `package.json`, using `node_modules/.bin`. The probe writer names the package by writing the probe into a scratch subdirectory with the package's path (`<scratch>/frontend/…`). A probe at the scratch root goes to the repo's only package that has a runner. The probe is copied temporarily into `<package>/src/__probes__/` (or `<package>/__probes__/` if the package has no `src/`), so its relative imports resolve and the runner's config applies. It is removed after the run.
  - **Where passing JS/TS probes are committed:** exactly the path where they ran and passed. That path is inside the package and matched by the repo's own test runner, so `npm test` runs probes already known to pass there and doesn't break.
  - **Probes that can't run** (no package or runner found, the runner not installed, an unknown file kind) are reported **not runnable**, with the reason. This shows in the `review_probes_run` milestone (`not_runnable=N`, now emitted even for zero probes), in the code reviewer's input and in the PR body. Such probes are counted neither as passed nor as failed, and they are not committed.
  - The probe-writer prompt now asks for the repo's own framework, and for `*.test.jsx`/`.tsx` names for JS/TS.
- **2026-11-26 — Probes test through public entry points ([#105](https://github.com/karlbaria/autonomous-agents-factory/issues/105)).** Most probe failures in the factory-shop builds came from probes importing internal modules and names guessed from the story, which the coder had named differently.
  - The probe-writer prompt now has probes test through public entry points: frontend probes render the app's top-level component through its router at a route and act as a user (Testing Library queries by role or label, clicks, typing); backend probes call the HTTP API through the framework's test client (FastAPI: `TestClient(app)` from the entry module). A module or function may be imported only when the story names it as part of the contract, with the reason in a comment in the probe.
  - The code-reviewer prompt treats a probe that imports an internal module the story does not name as invalid by default.
  - The deterministic extraction (fork point 3) now gives Call 1 only the new frontend route paths and backend endpoints (method + path), in `review/routes.py` (formerly `review/signatures.py`). Function names and signatures are no longer passed on: under the new rule a probe could not import them anyway.
