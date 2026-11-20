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
- The deploy role's CloudFormation permissions are scoped by resource ARN to `stack/factory-shop-*/*` — a specific, minimal action list (`CreateStack`, `UpdateStack`, `DescribeStacks`, `CreateChangeSet`, …), not `cloudformation:*` — plus `sts:AssumeRole` on the account's existing CDK bootstrap roles (`deploy-role`, `file-publishing-role`, `image-publishing-role`, `lookup-role`). `github-oidc-factory-shop` does not match `factory-shop-*`, so this role has no CloudFormation permission on its own trust stack.
- `cdk-nag` (`AwsSolutionsChecks`) runs as an Aspect over both stacks, with a Jest test asserting zero ERROR-level findings — wired into `mise run build`, so broken or insecure IaC fails the same build gate every other change goes through. `.github/workflows/build.yml` runs this gate on every PR with no AWS credentials at all.
- The reviewer's system prompt (`agent/src/review/prompts.py`) now names public resources (other than the documented Amplify PR-preview hosting), wildcard IAM, and missing encryption as automatic `major` findings when the diff touches IaC.
- Amplify Hosting is set up once, by a human, through the console (connecting the GitHub App is an interactive OAuth step that can't be scripted), with PR previews on; `amplify.yml` documents the monorepo build spec (`appRoot: frontend`).

## Fork points

Approved by the repo owner before implementation, amending `FACTORY_PLAN.md`'s Task 16 text:

1. **The OIDC provider and the deploy role live in their own stack, named outside the `factory-shop-*` prefix** (`github-oidc-factory-shop`), **deployed only by the owner.** The OIDC provider resource carries `RemovalPolicy.RETAIN`, since it is account-wide and meant to be reused by future app repos onboarded the same way. Because the deploy role's own CloudFormation permissions are scoped to `factory-shop-*` stacks, and this stack's name does not match that pattern, the pipeline role cannot act on the stack that defines its own trust relationship.
2. **This ADR states plainly that the `factory-shop-*` scoping is a convention, not an enforced IAM boundary.** The plan's own guidance already noted "no permission boundary, because the shared default bootstrap's CloudFormation role is Admin" — the owner required that limitation to be stated here without softening: a correctly-scoped CloudFormation resource policy on the GitHub Actions role still executes through the CDK bootstrap's `cfn-exec` role, which is Admin by default. The stack-name-prefix pattern stops the GitHub Actions identity itself from targeting another app's stacks; it does not stop a sufficiently crafted CDK template deployed *as* `factory-shop-backend` from doing something the `cfn-exec` role's own (Admin) permissions allow. Closing that gap is the account's least-privilege-bootstrap hardening-backlog item, which this scoping is linked to, not a substitute for.
3. **The frontend falls back to its bundled demo product list whenever the backend API is unreachable**, so an Amplify PR preview — which has no backend deployed — still renders standalone rather than showing an empty or broken page.

## Consequences

- **Positive:** The agent gets real IaC-authoring capability (and the demo it unlocks: an agent PR with a CDK change, checked by `cdk synth` + cdk-nag, deployed by the pipeline after a human merges it) without ever holding deploy credentials, with Cedar as a second layer in case it tries anyway through `Bash`.
- **Positive:** The one-time OIDC bootstrap is reusable — a future app repo onboarding the same way reuses the existing provider and adds only its own scoped deploy role, rather than re-creating account-wide trust infrastructure per repo.
- **Negative / scoped out:** The `factory-shop-*` stack-name scoping is enforced by the GitHub Actions role's own IAM policy, not by anything that constrains what the (Admin) `cfn-exec` role does once CloudFormation is executing a change set it already approved. This is accepted as this demo's risk, explicitly not hidden in the implementation, and tracked against the least-privilege-bootstrap backlog item rather than solved here.
- **Negative / scoped out:** The backend CDK stack ships one demo resource (a DynamoDB table) that the FastAPI app does not yet read from or write to — wiring the app to real backend infrastructure is later work, not part of proving the write-IaC/pipeline-deploys loop itself.

## References

- `docs/lab/FACTORY_PLAN.md` — Task 16 (IaC and pipeline deploys for the target app repo)
- [autonomous-agents-factory#36](https://github.com/karlbaria/autonomous-agents-factory/issues/36)
- [karlbaria/factory-shop#8](https://github.com/karlbaria/factory-shop/pull/8)
