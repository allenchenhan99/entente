# RelayGraph protocol

Generated from `packages/protocol/src` by `scripts/gen-protocol-docs.mjs`. JSON Schemas: [`docs/schema/`](schema/).

## Objects

| Object | Schema | Purpose |
|---|---|---|
| Task Contract | [TaskContract.json](schema/TaskContract.json) | what one agent asks another to do; every acceptance criterion binds a `check` |
| Contract Response | [ContractResponse.json](schema/ContractResponse.json) | accept (with interpretation + verification plan) / needs_clarification (questions) / rejected |
| Evidence Submission | [EvidenceSubmission.json](schema/EvidenceSubmission.json) | the agent's claimed status per criterion |
| Evidence Record | [EvidenceRecord.json](schema/EvidenceRecord.json) | what relayd measured: diff, changed files, check results, self-report mismatches |
| Repair Contract | [RepairContract.json](schema/RepairContract.json) | delta contract for the failed criteria only |
| Event | [Event.json](schema/Event.json) | the append-only log entry; the only thing ever written |
| State | [State.json](schema/State.json) | derived by `reduce(events)`; three independent layers per task |

## Check kinds

| kind | executed by | passes when |
|---|---|---|
| `command` | relayd, in the task worktree | exit code 0 (output captured as evidence) |
| `diff_scope` | relayd | every changed file matches `scope.allowed_paths` |
| `file_exists` | relayd | the path exists in the worktree |
| `human_review` | a person, via `POST /tasks/:id/review` | marked passed |
| `llm_judge` | relayd (not configured in the MVP) | — |

## Event types

- `mission_created`
- `tasks_planned`
- `lint_reported`
- `task_proposed`
- `clarification_requested`
- `clarification_answered`
- `contract_revised`
- `task_accepted`
- `task_rejected`
- `worktree_created`
- `agent_spawned`
- `agent_exited`
- `work_started`
- `progress_reported`
- `task_blocked`
- `task_unblocked`
- `evidence_submitted`
- `checks_started`
- `check_passed`
- `check_failed`
- `human_review_recorded`
- `evidence_recorded`
- `repair_requested`
- `repair_accepted`
- `task_verified`
- `task_completed`
- `task_failed_budget`
- `task_escalated`
- `task_canceled`
- `integration_started`
- `integration_conflict`
- `mission_verified`
- `mission_failed`

## Task state layers

- runtime: unspawned · idle · working · blocked · done · exited · unknown
- task: pending · proposed · accepted · executing · awaiting_verification · repairing · completed · failed · canceled
- handoff: draft · proposed · needs_clarification · revised · accepted · rejected · evidence_submitted · retry_requested · verified

## MCP tools (server `relay`, streamable HTTP at `/mcp`, `Authorization: Bearer <task token>`)

### Recipient

| Tool | Input → output |
|---|---|
| `relay_get_contract` | no input → `GetContractOutput` (contract, worktree, active_repair) |
| `relay_respond_to_contract` | `RespondInput` (decision, interpretation, assumptions, risks, verification_plan, questions) → `RespondOutput` |
| `relay_await_contract` | `{ since_version, timeout_s ≤ 60 }` → `revised | pending | canceled` |
| `relay_report_progress` | `{ message, percent? }` → ok |
| `relay_report_blocker` | `{ reason, waiting_on? }` → ok |
| `relay_submit_evidence` | `{ contract_version, claimed, summary }` → `{ attempt, checks_started }` |
| `relay_await_verdict` | `{ attempt, timeout_s ≤ 60 }` → `verified | repair | pending | failed_budget | escalated` |

### Planner

| Tool | Input → output |
|---|---|
| `relay_get_mission` | no input → mission + tasks |
| `relay_propose_task` | `{ contract: TaskContractInput }` → `proposed | lint_error` |
| `relay_list_tasks` | no input → task views |
| `relay_revise_task` | `{ task_id, patch }` → new version |
| `relay_answer_clarification` | `{ task_id, answers }` → new version |

## HTTP API

| Route | Body → result |
|---|---|
| `GET /state` | → State |
| `GET /events?since=<seq>` | → server-sent events, one Event per message |
| `GET /events/log?since=<seq>` | → Event[] |
| `POST /missions` | `{ repo, title, success_definition?, integration_check? }` → `{ mission_id, planner_token }` |
| `POST /missions/:id/plan` | `{ tasks: TaskContractInput[] }` → `{ task_ids }` |
| `POST /tasks/:id/clarify` | `{ answers: [{ question_id, answer }] }` → `{ contract_version }` |
| `POST /tasks/:id/review` | `{ criterion_id, status, observed_failure? }` → ok |
| `POST /tasks/:id/cancel` | `{ reason? }` → ok |

## Lint rules

- `missing_goal`
- `no_acceptance_criteria`
- `unverifiable_criterion`
- `unbounded_scope`
- `unbounded_retry`
- `missing_input`
- `unknown_dependency`
- `dependency_cycle`
- `overlapping_scope`
- `no_non_goals`
- `no_evidence_required`
- `stale_handoff`
- `long_block`
- `interpretation_drift`

Errors (`missing_goal`, `no_acceptance_criteria`, `unverifiable_criterion`, `unbounded_scope`, `unbounded_retry`, `missing_input`, `unknown_dependency`, `dependency_cycle`) block spawning; the rest are warnings shown in the TUI.
