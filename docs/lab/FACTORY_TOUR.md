# Factory Tour: `backgroundagent-dev-factory`

A map from each factory component to its code, its AWS resource in this stack, and where to see it. Written after Task 2's deploy (all optional features, AgentCore-only compute, us-east-2). Resource names below are the stack's own CloudFormation-generated names — never the account ID; get the account ID from your own `.local.env` or `aws sts get-caller-identity` when you need it for a console URL or ARN.

See `docs/lab/FACTORY_PLAN.md` for the task breakdown and `docs/lab/LAB_LOG.md` for how this deploy actually went (including where it departed from the plan).

## Orchestrator

One Lambda runs the whole task lifecycle — no Step Functions state machine. It uses AWS's Durable Execution SDK (`@aws/durable-execution-sdk-js`) to make a single long-running Lambda invocation durable across the AgentCore session's lifetime (up to 8h).

| | |
|---|---|
| Code | `cdk/src/handlers/orchestrate-task.ts` (entrypoint), `cdk/src/constructs/task-orchestrator.ts` (`TaskOrchestrator` construct) |
| AWS resource | Lambda function `backgroundagent-dev-factory-TaskOrchestrator*` (see `aws lambda list-functions --region us-east-2 \| grep TaskOrchestrator`) |
| See it | CloudWatch Logs for that function; `bgagent watch <task-id>` streams its progress events live |

Task submission (`POST /tasks`) and status (`GET /tasks/{id}`) are separate Lambdas behind the Task API — see `cdk/src/handlers/create-task.ts`, `get-task.ts`. The orchestrator starts the compute session (AgentCore `InvokeAgentRuntime`, SigV4-authed — see `cdk/src/handlers/shared/strategies/agentcore-strategy.ts`), polls it, and writes `TaskRecord` updates.

## Deterministic workflow engine

A declarative workflow (YAML) drives which steps run, in what order, dispatched through a `StepKind`-keyed handler table — the deterministic part surrounding the non-deterministic LLM step.

| | |
|---|---|
| Code | `agent/src/workflow/runner.py` (`run_workflow`, `STEP_HANDLERS`), `agent/src/workflow/models.py` (`StepKind`), `agent/src/workflow/validator.py`, workflow definitions in `agent/workflows/coding/new-task-v1.yaml` (and siblings) |
| AWS resource | None directly — this runs inside the AgentCore Runtime container (`agent/src/pipeline.py`'s `run_task`), not as separate AWS infrastructure |
| See it | A task's `resolved_workflow` field (`bgagent status <task-id>` or `bgagent submit --output json`) names the workflow and version actually run, e.g. `coding/new-task-v1@1.0.0` |

Today's default and only workflow is `coding/new-task-v1`: coder → build/lint gate → PR. `coding/new-task-verified-v1` (test author → coder → reviewer ⇄ fixer → gate → PR) is Task 4+ in the plan, not built yet.

## Gates

Two independent gate families run before a PR is opened.

**Build-regression gate** (`agent/src/pipeline.py`'s `verify_build`/`verify_lint`, around line 1400-1500): runs the repo's build/lint command (`mise run build` / `mise run lint` by default, or a Blueprint's `pipeline.buildCommand`/`lintCommand` override) once on the clean clone and once after the agent's changes; a passing-to-failing transition fails the task. Confirmed this session that a repo with no `mise run build` task makes this gate silently inert (`build_passed: true` regardless of actual test results) — see LAB_LOG's Task 2 demo results.

**Cedar HITL approval gates** (`agent/src/policy.py`'s `PolicyEngine`, built-in policies in `agent/policies/hard_deny.cedar` + `soft_deny.cedar`): every tool call the agent makes is evaluated hard-deny → pre-approval → soft-deny before it runs. A soft-deny creates an approval request the operator must act on.

| | |
|---|---|
| AWS resource | DynamoDB table `TaskApprovalsTableV2` — see the stack output `TaskApprovalsTableName` (`aws cloudformation describe-stacks --stack-name backgroundagent-dev-factory --region us-east-2 --query "Stacks[0].Outputs[?OutputKey=='TaskApprovalsTableName'].OutputValue"`) |
| See it | `bgagent status <task-id>` shows `approval_gate_count`/`approval_gate_cap`; a pending approval shows in `awaiting_approval_request_id` and the `/pending` Task API route (Cognito-authenticated) |

## Cost

Per-task cost is tracked on the `TaskRecord` (`cost_usd`), aggregated monthly per user/team in a separate budget table.

| | |
|---|---|
| Code | `agent/src/runner.py` (per-turn cost accounting), `cdk/src/constructs/budget-table.ts` + `budget-alerts.ts` |
| AWS resource | DynamoDB table `BudgetTable` (stack output `BudgetTableName`) |
| See it | `bgagent budget status --me` (current UTC-month spend vs. limit); per-task cost via `bgagent status <task-id>` (`cost_usd` field) |

Today this is one agent call per task (the coder). Task 3 of the plan (`AgentInvocationLedger`) is what makes multiple agent calls per task — reviewer, test author — sum correctly; not built yet, so there's nothing to tour there.

## Observability

| | |
|---|---|
| Code | `agent/src/progress_writer.py` (`_ProgressWriter`, emits `TaskEvents`), `agent/src/observability.py` (`task_span`, OpenTelemetry) |
| AWS resources | CloudWatch dashboard `BackgroundAgent-Tasks-backgroundagent-dev-factory`; DynamoDB `TaskEventsTable` (stack output `TaskEventsTableName`); X-Ray, via the AgentCore Runtime's `tracingEnabled: true` (fixed this task, issue #6/PR #7 on `autonomous-agents-factory`) |
| See it | Dashboard: CloudWatch console → Dashboards → `BackgroundAgent-Tasks-backgroundagent-dev-factory`. Live events: `bgagent watch <task-id>`. X-Ray: convert a task's `otel_trace_id` to X-Ray's `1-{first 8 hex chars}-{remaining 24 hex chars}` form, then `aws xray batch-get-traces --trace-ids <that> --region us-east-2`, or the CloudWatch console's **GenAI Observability** / Transaction Search page. |

The AgentCore Runtime's application and usage logs land in CloudWatch Logs under `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/backgroundagent-dev-factory` and `.../USAGE_LOGS/backgroundagent-dev-factory` — per-task log streams are named by task ID (`metrics/<task-id>`, `trajectory/<task-id>`, `server_debug/<task-id>`).

## Isolation

Three layers, from the outside in:

1. **Per-task compute isolation** — AgentCore Runtime runs each session in its own Firecracker MicroVM (`docs/design/COMPUTE.md`). Nothing about one task's session is visible to another's.
2. **Per-task IAM isolation** — the agent doesn't hold tenant-data permissions on its own execution role. It assumes a per-task `SessionRole` (`cdk/src/constructs/agent-session-role.ts`) tagged `{user_id, repo, task_id}`, and every tenant-data grant (the task-scoped DynamoDB tables, trace artifacts, attachments) is conditioned on `aws:PrincipalTag` matching those tags — a compromised session can only reach its own task's data, not another task's row in the same table.
3. **Network isolation** — the AgentCore Runtime sits in its own VPC (`cdk/src/constructs/agent-vpc.ts`) with a Route53 Resolver DNS Firewall (`cdk/src/constructs/dns-firewall.ts`) in front of its egress; see `docs/design/SECURITY.md`.

| | |
|---|---|
| AWS resource | Per-task: nothing to inspect directly (the MicroVM and its SessionRole exist only for the task's lifetime). Standing: the VPC (stack output implicit — `aws ec2 describe-vpcs --region us-east-2 --filters "Name=tag:aws:cloudformation:stack-name,Values=backgroundagent-dev-factory"`), the DNS Firewall rule group (`Route53Resolver::FirewallRuleGroup`) |
| See it | IAM console → Roles → search `AgentSessionRole` for the standing role the per-task sessions assume; CloudTrail for a specific session's actual calls, filtered by the session's `task_id` principal tag |

## What's deployed vs. what's planned

This stack has every optional feature (Slack, Linear, Jira, deploy-preview screenshots, Agent Registry, Tool Gateway) — see `docs/lab/LAB_LOG.md`'s Task 2 entry for why that differs from the plan's `--features none`, and the endpoint security audit covering the extra surface area. None of Slack/Jira/Linear are connected yet (deferred to a future session). The reviewer, test-author, and multi-agent-cost pieces (Tasks 3-7 of `FACTORY_PLAN.md`) aren't built: today's single workflow is coder → build/lint gate → PR, exactly the `coding/new-task-v1` row in `docs/design/COMPUTE.md`'s architecture, with nothing yet for the `coding/new-task-verified-v1` row.
