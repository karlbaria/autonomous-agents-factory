# ADR-027 (fork): Agent writes IaC, the pipeline deploys it

**Status:** accepted
**Date:** 2026-11-19
**Implementation:** [autonomous-agents-factory#36](https://github.com/karlbaria/autonomous-agents-factory/issues/36) (this repo's share of the work) and [karlbaria/factory-shop#8](https://github.com/karlbaria/factory-shop/pull/8) (the CDK app, GitHub Actions workflows, and OIDC trust, which live in the target app repo) — Factory Lab Task 16 (`docs/lab/FACTORY_PLAN.md`). "(fork)" marks this ADR as a **fork** of that plan doc's Task 16 text: three points were amended by the repo owner before implementation (see "Fork points" below), so this document — not the plan doc — is the record of what actually shipped.

## Context

Through Task 15.5, `factory-shop` (the second target app repo) has application code — a FastAPI backend and a Vite + React frontend — but no infrastructure: no CDK app, no GitHub Actions, no path from a merged PR to a running AWS resource. Task 16 gives the coding agent the ability to write CDK for this app, with the same gates (`mise run build`, independent review) the rest of its work already goes through, while keeping deploy authority entirely outside the agent.

## Decision

- **The agent's own AWS credentials stay Bedrock-only.** It never holds a credential capable of a CloudFormation write. As defense-in-depth against the agent attempting one anyway through `Bash`, a new Cedar soft-deny rule (`cdk_deploy_or_destroy`, `agent/policies/soft_deny.cedar`) forbids `cdk deploy`/`cdk destroy` and routes the call to human approval instead of executing it.
- **`factory-shop/infra/`** is a CDK app with two stacks:
  - `github-oidc-factory-shop` — the account-wide GitHub OIDC provider (`token.actions.githubusercontent.com`, `RemovalPolicy.RETAIN`) and the GitHub Actions deploy role, trusted only for `repo:karlbaria/factory-shop:ref:refs/heads/main`. **Deployed only by a human operator**, with their own elevated local credentials — never by CI, never by this task's author.
  - `factory-shop-backend` — the app's actual backend resources (one DynamoDB table for this demo). **Deployed only by `.github/workflows/deploy.yml`**, on push to `main`, via the OIDC role.
- The deploy role has **no CloudFormation permissions of its own** — only `sts:AssumeRole` on the account's existing CDK bootstrap roles (`deploy-role`, `file-publishing-role`, `image-publishing-role`, `lookup-role`). A resource-ARN-scoped CloudFormation statement on this role was considered and removed: with the modern CDK bootstrap, every `cdk deploy` CloudFormation call actually runs through the assumed `deploy-role`, which can act on any stack in the account — a stack-name-scoped statement on the GitHub Actions role itself would never be what CDK's own calls go through, so it would do nothing but look like a boundary. What actually keeps this role from deploying anything other than `factory-shop-backend` is the OIDC trust condition (only `refs/heads/main` can assume the role) plus human review of every change merged to `main`, including `deploy.yml` itself.
- `cdk-nag` (`AwsSolutionsChecks`) runs as an Aspect over both stacks; `cdk synth` fails on any ERROR-level finding, and that's the build gate — wired into `mise run build`, so broken or insecure IaC fails the same build gate every other change goes through. `.github/workflows/build.yml` runs this gate on every PR with no AWS credentials at all.
- The reviewer's system prompt (`agent/src/review/prompts.py`) now names public resources (other than the documented Amplify PR-preview hosting), wildcard IAM, and missing encryption as automatic `major` findings when the diff touches IaC.
- Amplify Hosting is set up once, by a human, through the console (connecting the GitHub App is an interactive OAuth step that can't be scripted), with PR previews on; `amplify.yml` documents the monorepo build spec (`appRoot: frontend`).

## Fork points

Approved by the repo owner before implementation, amending `FACTORY_PLAN.md`'s Task 16 text:

1. **The OIDC provider and the deploy role live in their own stack, named outside the `factory-shop-*` prefix** (`github-oidc-factory-shop`), **deployed only by the owner.** The OIDC provider resource carries `RemovalPolicy.RETAIN`, since it is account-wide and meant to be reused by future app repos onboarded the same way. **This naming is not a security boundary** — the deploy role has no CloudFormation permissions of its own to scope by stack name in the first place; every `cdk deploy` call it makes runs through the account's bootstrap `deploy-role`, which can act on any stack. What actually keeps the GitHub Actions pipeline from touching `github-oidc-factory-shop` is that only `refs/heads/main` can assume the deploy role at all, and `deploy.yml` — reviewed like any other change to `main` — only ever calls `cdk deploy factory-shop-backend`.
2. **This ADR states plainly that there is no IAM boundary protecting `factory-shop-backend` (or any future app's equivalent stack) from the account's broader CloudFormation execution surface.** The plan's own guidance already noted "no permission boundary, because the shared default bootstrap's CloudFormation role is Admin" — the owner required that limitation to be stated here without softening, and an earlier draft of this implementation got it wrong in the other direction: it gave the GitHub Actions role its own resource-ARN-scoped CloudFormation statement (`stack/factory-shop-*/*`) and described that as the thing stopping the role from acting on other stacks. It does nothing: CDK's own deploy calls never go through that role's directly-attached policy, only through the assumed (Admin) bootstrap `deploy-role`. The statement was removed. The real protection is the OIDC trust condition (branch-scoped) and human review of merges to `main`; closing the deeper gap — a sufficiently crafted CDK template still being able to do anything the (Admin) `cfn-exec` role allows — is the account's least-privilege-bootstrap hardening-backlog item, which this task is linked to, not a substitute for.
3. **The frontend falls back to its bundled demo product list whenever the backend API is unreachable**, so an Amplify PR preview — which has no backend deployed — still renders standalone rather than showing an empty or broken page.

## Consequences

- **Positive:** The agent gets real IaC-authoring capability (and the demo it unlocks: an agent PR with a CDK change, checked by `cdk synth` + cdk-nag, deployed by the pipeline after a human merges it) without ever holding deploy credentials, with Cedar as a second layer in case it tries anyway through `Bash`.
- **Positive:** The one-time OIDC bootstrap is reusable — a future app repo onboarding the same way reuses the existing provider and adds only its own branch-trusted deploy role, rather than re-creating account-wide trust infrastructure per repo.
- **Negative / scoped out:** Nothing in IAM stops the deploy role from acting on a stack other than `factory-shop-backend`, or from doing anything the (Admin) `cfn-exec` role allows once CloudFormation is executing a change set. Protection here is branch-scoped OIDC trust plus human code review, not a technical boundary. This is accepted as this demo's risk, explicitly not hidden in the implementation, and tracked against the least-privilege-bootstrap backlog item rather than solved here.
- **Negative / scoped out:** The backend CDK stack ships one demo resource (a DynamoDB table) that the FastAPI app does not yet read from or write to — wiring the app to real backend infrastructure is later work, not part of proving the write-IaC/pipeline-deploys loop itself.

## References

- `docs/lab/FACTORY_PLAN.md` — Task 16 (IaC and pipeline deploys for the target app repo)
- [autonomous-agents-factory#36](https://github.com/karlbaria/autonomous-agents-factory/issues/36)
- [karlbaria/factory-shop#8](https://github.com/karlbaria/factory-shop/pull/8)
