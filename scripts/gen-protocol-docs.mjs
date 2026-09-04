// Generates docs/protocol.md and docs/schema/*.json from the zod schemas in @relay/protocol.
// Run: node scripts/gen-protocol-docs.mjs   (after `npx tsc -b`)
import fs from 'node:fs';
import { z } from 'zod';
import * as P from '../packages/protocol/dist/index.js';

const schemas = {
  TaskContract: P.TaskContract, TaskContractInput: P.TaskContractInput, ContractResponse: P.ContractResponse,
  EvidenceSubmission: P.EvidenceSubmission, EvidenceRecord: P.EvidenceRecord, RepairContract: P.RepairContract,
  Mission: P.Mission, Event: P.Event, State: P.State, LintResult: P.LintResult,
};
fs.mkdirSync('docs/schema', { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  fs.writeFileSync(`docs/schema/${name}.json`, JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }), null, 2) + '\n');
}

const toolRows = (tools, io) => Object.entries(tools).map(([k, name]) => `| \`${name}\` | ${io[k] ?? ''} |`).join('\n');
const recipientIo = {
  get_contract: 'no input → `GetContractOutput` (contract, worktree, active_repair)',
  respond_to_contract: '`RespondInput` (decision, interpretation, assumptions, risks, verification_plan, questions) → `RespondOutput`',
  await_contract: '`{ since_version, timeout_s ≤ 60 }` → `revised | pending | canceled`',
  report_progress: '`{ message, percent? }` → ok',
  report_blocker: '`{ reason, waiting_on? }` → ok',
  submit_evidence: '`{ contract_version, claimed, summary }` → `{ attempt, checks_started }`',
  await_verdict: '`{ attempt, timeout_s ≤ 60 }` → `verified | repair | pending | failed_budget | escalated`',
};
const plannerIo = {
  get_mission: 'no input → mission + tasks',
  propose_task: '`{ contract: TaskContractInput }` → `proposed | lint_error`',
  list_tasks: 'no input → task views',
  revise_task: '`{ task_id, patch }` → new version',
  answer_clarification: '`{ task_id, answers }` → new version',
};

const md = `# RelayGraph protocol

Generated from \`packages/protocol/src\` by \`scripts/gen-protocol-docs.mjs\`. JSON Schemas: [\`docs/schema/\`](schema/).

## Objects

| Object | Schema | Purpose |
|---|---|---|
| Task Contract | [TaskContract.json](schema/TaskContract.json) | what one agent asks another to do; every acceptance criterion binds a \`check\` |
| Contract Response | [ContractResponse.json](schema/ContractResponse.json) | accept (with interpretation + verification plan) / needs_clarification (questions) / rejected |
| Evidence Submission | [EvidenceSubmission.json](schema/EvidenceSubmission.json) | the agent's claimed status per criterion |
| Evidence Record | [EvidenceRecord.json](schema/EvidenceRecord.json) | what relayd measured: diff, changed files, check results, self-report mismatches |
| Repair Contract | [RepairContract.json](schema/RepairContract.json) | delta contract for the failed criteria only |
| Event | [Event.json](schema/Event.json) | the append-only log entry; the only thing ever written |
| State | [State.json](schema/State.json) | derived by \`reduce(events)\`; three independent layers per task |

## Check kinds

| kind | executed by | passes when |
|---|---|---|
| \`command\` | relayd, in the task worktree | exit code 0 (output captured as evidence) |
| \`diff_scope\` | relayd | every changed file matches \`scope.allowed_paths\` |
| \`file_exists\` | relayd | the path exists in the worktree |
| \`human_review\` | a person, via \`POST /tasks/:id/review\` | marked passed |
| \`llm_judge\` | relayd (not configured in the MVP) | — |

## Event types

${P.EVENT_TYPES.map((t) => `- \`${t}\``).join('\n')}

## Task state layers

- runtime: ${P.RuntimeState.options.join(' · ')}
- task: ${P.TaskState.options.join(' · ')}
- handoff: ${P.HandoffState.options.join(' · ')}

## MCP tools (server \`relay\`, streamable HTTP at \`/mcp\`, \`Authorization: Bearer <task token>\`)

### Recipient

| Tool | Input → output |
|---|---|
${toolRows(P.RECIPIENT_TOOLS, recipientIo)}

### Planner

| Tool | Input → output |
|---|---|
${toolRows(P.PLANNER_TOOLS, plannerIo)}

## HTTP API

| Route | Body → result |
|---|---|
| \`GET /state\` | → State |
| \`GET /events?since=<seq>\` | → server-sent events, one Event per message |
| \`GET /events/log?since=<seq>\` | → Event[] |
| \`POST /missions\` | \`{ repo, title, success_definition?, integration_check? }\` → \`{ mission_id, planner_token }\` |
| \`POST /missions/:id/plan\` | \`{ tasks: TaskContractInput[] }\` → \`{ task_ids }\` |
| \`POST /tasks/:id/clarify\` | \`{ answers: [{ question_id, answer }] }\` → \`{ contract_version }\` |
| \`POST /tasks/:id/review\` | \`{ criterion_id, status, observed_failure? }\` → ok |
| \`POST /tasks/:id/cancel\` | \`{ reason? }\` → ok |

## Lint rules

${P.LintRuleId.options.map((r) => `- \`${r}\``).join('\n')}

Errors (\`missing_goal\`, \`no_acceptance_criteria\`, \`unverifiable_criterion\`, \`unbounded_scope\`, \`unbounded_retry\`, \`missing_input\`, \`unknown_dependency\`, \`dependency_cycle\`) block spawning; the rest are warnings shown in the TUI.
`;
fs.writeFileSync('docs/protocol.md', md);
console.log('wrote docs/protocol.md and', Object.keys(schemas).length, 'schemas');
