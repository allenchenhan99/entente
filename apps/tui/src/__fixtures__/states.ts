import type {
  ContractResponse,
  EvidenceRecord,
  Mission,
  RepairContract,
  State,
  TaskContract,
  TaskView,
} from '@relay/protocol';
import { initialState } from '@relay/protocol';

const mission: Mission = {
  id: 'm-001',
  repo: '/demo/secure-login',
  title: 'Add secure login to this application',
  success_definition: 'All login tasks are verified',
  integration_check: 'npx vitest run',
  budget: { max_repairs_per_task: 3 },
};

const commonContract = {
  mission_id: mission.id,
  sender: 'planner',
  inputs: ['docs/auth-spec.md'],
  constraints: ['Keep changes within the assigned scope'],
  non_goals: ['OAuth'],
  output: {
    type: 'code_change' as const,
    evidence_required: ['git_diff', 'changed_files', 'check_outputs'] as TaskContract['output']['evidence_required'],
  },
  budget: { max_repairs: 3, stagnation_limit: 2 },
  clarifications: [],
};

const backendV1: TaskContract = {
  ...commonContract,
  id: 't-backend-auth',
  version: 1,
  recipient: 'backend',
  runtime: 'claude-code',
  goal: 'Implement secure magic-link authentication endpoints',
  scope: { allowed_paths: ['src/auth/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'Valid links create sessions', check: { kind: 'command', run: 'npm test', timeout_ms: 120_000 } },
    { id: 'AC-2', condition: 'Expired links return 401', check: { kind: 'command', run: 'npm test', timeout_ms: 120_000 } },
  ],
  dependencies: [],
};

const backendV2: TaskContract = {
  ...backendV1,
  version: 2,
  constraints: [...backendV1.constraints, 'Links expire after 15 minutes'],
  clarifications: [{
    question_id: 'Q1',
    answer: 'Use a 15 minute expiry',
    answered_by: 'human',
    at: '2026-09-05T10:04:00+08:00',
  }],
};

const frontendV1: TaskContract = {
  ...commonContract,
  id: 't-frontend-login',
  version: 1,
  recipient: 'frontend',
  runtime: 'codex',
  goal: 'Build the magic-link login and verification screens',
  scope: { allowed_paths: ['src/ui/login/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'Form requests a link', check: { kind: 'command', run: 'npm test', timeout_ms: 120_000 } },
    { id: 'AC-2', condition: 'Callback verifies a link', check: { kind: 'human_review' } },
  ],
  dependencies: [],
};

const e2eV1: TaskContract = {
  ...commonContract,
  id: 't-e2e-tests',
  version: 1,
  recipient: 'e2e',
  runtime: 'claude-code',
  goal: 'Test the complete magic-link authentication flow',
  scope: { allowed_paths: ['tests/e2e/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'Login flow reaches the application', check: { kind: 'command', run: 'npm test', timeout_ms: 120_000 } },
  ],
  dependencies: ['t-backend-auth'],
};

function acceptedResponse(contract: TaskContract): ContractResponse {
  return {
    task_id: contract.id,
    contract_version: contract.version,
    decision: 'accepted',
    interpretation: [`Implement ${contract.recipient} scope only`],
    assumptions: [],
    risks: [],
    verification_plan: Object.fromEntries(contract.acceptance_criteria.map((criterion) => [criterion.id, 'Run its declared check'])),
    questions: [],
  };
}

function taskView(contract: TaskContract, patch: Partial<TaskView> = {}): TaskView {
  return {
    id: contract.id,
    mission_id: mission.id,
    contract,
    versions: [contract],
    response: undefined,
    open_questions: [],
    lint: [],
    runtime: 'unspawned',
    task_state: 'proposed',
    handoff_state: 'proposed',
    worktree: undefined,
    agent: undefined,
    blocker: undefined,
    blocked_on_dependencies: [],
    attempt: 0,
    attempts: [],
    repairs: [],
    active_repair: undefined,
    escalated: false,
    proposed_at: '2026-09-05T10:01:00+08:00',
    accepted_at: undefined,
    started_at: undefined,
    last_seen_at: undefined,
    completed_at: undefined,
    ...patch,
  };
}

function stateWith(tasks: TaskView[], status: State['missions'][string]['status'], lastSeq: number): State {
  return {
    ...initialState(),
    last_seq: lastSeq,
    missions: {
      [mission.id]: {
        mission,
        status,
        task_ids: tasks.map((task) => task.id),
      },
    },
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    metrics: {
      contracts_blocked_before_execution: 1,
      fields_filled_via_clarification: 2,
      criteria_total: 5,
      criteria_with_machine_check: 4,
      self_report_mismatches: 1,
      tasks_not_rerun_on_repair: 1,
      repairs_total: 1,
    },
  };
}

const passedBackendEvidence: EvidenceRecord = {
  task_id: backendV2.id,
  contract_version: 2,
  attempt: 1,
  git_diff_path: '.relay/evidence/t-backend-auth/a1.patch',
  changed_files: ['src/auth/token.ts'],
  checks: {
    'AC-1': { status: 'passed', output_path: '.relay/evidence/AC-1.txt', duration_ms: 120 },
    'AC-2': { status: 'passed', output_path: '.relay/evidence/AC-2.txt', duration_ms: 90 },
  },
  self_report_mismatch: [],
};

const failedBackendEvidence: EvidenceRecord = {
  ...passedBackendEvidence,
  checks: {
    ...passedBackendEvidence.checks,
    'AC-2': { status: 'failed', observed: 'expected 401, received 200', duration_ms: 90 },
  },
  self_report_mismatch: ['AC-2'],
};

const backendRepair: RepairContract = {
  id: 't-backend-auth/r1',
  parent_task: backendV2.id,
  parent_version: 2,
  attempt: 2,
  failed_criteria: ['AC-2'],
  observed_failure: 'expected 401, received 200',
  requested_correction: 'Reject expired links',
  unchanged_scope: ['Do not modify frontend code'],
  remaining_repairs: 2,
};

export const midClarificationState = stateWith([
  taskView(backendV2, {
    versions: [backendV1, backendV2],
    response: acceptedResponse(backendV2),
    runtime: 'working',
    task_state: 'executing',
    handoff_state: 'accepted',
    worktree: { path: '.relay/wt/t-backend-auth', branch: 'relay/t-backend-auth' },
    agent: { runtime: 'claude-code', pane_id: '%2', session_id: 'backend-session' },
    attempt: 1,
    accepted_at: '2026-09-05T10:05:00+08:00',
    started_at: '2026-09-05T10:06:00+08:00',
  }),
  taskView(frontendV1, {
    response: {
      task_id: frontendV1.id,
      contract_version: 1,
      decision: 'needs_clarification',
      interpretation: [],
      assumptions: [],
      risks: [],
      verification_plan: {},
      questions: [
        { id: 'Q1', text: 'Which empty state should be shown?', blocking: true },
        { id: 'Q2', text: 'Should the form preserve the email?', blocking: true },
      ],
    },
    open_questions: [
      { id: 'Q1', text: 'Which empty state should be shown?', blocking: true },
      { id: 'Q2', text: 'Should the form preserve the email?', blocking: true },
    ],
    runtime: 'idle',
    handoff_state: 'needs_clarification',
    worktree: { path: '.relay/wt/t-frontend-login', branch: 'relay/t-frontend-login' },
    agent: { runtime: 'codex', pane_id: '%3', session_id: 'frontend-session' },
  }),
  taskView(e2eV1, {
    runtime: 'blocked',
    blocked_on_dependencies: ['t-backend-auth'],
    blocker: { reason: 'Dependency incomplete', waiting_on: 't-backend-auth', since: '2026-09-05T10:03:00+08:00' },
  }),
], 'executing', 18);

export const midRepairState = stateWith([
  taskView(backendV2, {
    versions: [backendV1, backendV2],
    response: acceptedResponse(backendV2),
    runtime: 'done',
    task_state: 'awaiting_verification',
    handoff_state: 'retry_requested',
    worktree: { path: '.relay/wt/t-backend-auth', branch: 'relay/t-backend-auth' },
    agent: { runtime: 'claude-code', pane_id: '%2', session_id: 'backend-session' },
    attempt: 1,
    attempts: [failedBackendEvidence],
    repairs: [backendRepair],
    active_repair: backendRepair,
  }),
  taskView(frontendV1, {
    response: acceptedResponse(frontendV1),
    runtime: 'working',
    task_state: 'executing',
    handoff_state: 'accepted',
    worktree: { path: '.relay/wt/t-frontend-login', branch: 'relay/t-frontend-login' },
    agent: { runtime: 'codex', pane_id: '%3', session_id: 'frontend-session' },
  }),
  taskView(e2eV1, {
    runtime: 'blocked',
    blocked_on_dependencies: ['t-backend-auth'],
    blocker: { reason: 'Dependency incomplete', waiting_on: 't-backend-auth', since: '2026-09-05T10:03:00+08:00' },
  }),
], 'executing', 36);

export const happyState = stateWith([
  taskView(backendV2, {
    versions: [backendV1, backendV2],
    response: acceptedResponse(backendV2),
    runtime: 'done',
    task_state: 'completed',
    handoff_state: 'verified',
    worktree: { path: '.relay/wt/t-backend-auth', branch: 'relay/t-backend-auth' },
    agent: { runtime: 'claude-code', pane_id: '%2', session_id: 'backend-session' },
    attempt: 1,
    attempts: [passedBackendEvidence],
  }),
  taskView(frontendV1, {
    response: acceptedResponse(frontendV1),
    runtime: 'done',
    task_state: 'completed',
    handoff_state: 'verified',
    worktree: { path: '.relay/wt/t-frontend-login', branch: 'relay/t-frontend-login' },
    agent: { runtime: 'codex', pane_id: '%3', session_id: 'frontend-session' },
    attempt: 1,
  }),
  taskView(e2eV1, {
    response: acceptedResponse(e2eV1),
    runtime: 'done',
    task_state: 'completed',
    handoff_state: 'verified',
    worktree: { path: '.relay/wt/t-e2e-tests', branch: 'relay/t-e2e-tests' },
    agent: { runtime: 'claude-code', pane_id: '%4', session_id: 'e2e-session' },
    attempt: 1,
  }),
], 'verified', 52);
