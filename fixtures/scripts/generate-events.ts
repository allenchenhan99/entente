/**
 * Regenerates fixtures/events-happy.jsonl and fixtures/events-repair.jsonl.
 *
 *   npx tsx fixtures/scripts/generate-events.ts
 *
 * Both logs describe the same mission (m-001, three tasks). Timestamps start at
 * 2026-09-05T10:00:00+08:00 and advance 20 s–3 min per event. Every line is validated with
 * `Event.parse` before it is written, and `lint_reported` payloads are produced by the real linter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Event, lintContract, TaskContract,
  type EventOf, type EventType, type LintContext, type TaskContract as TaskContractT,
} from '../../packages/protocol/src/index.js';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_MS = Date.parse('2026-09-05T10:00:00+08:00');
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const MISSION_ID = 'm-001';
const REPO = '/Users/demo/relaygraph-demo';
const BACKEND = 't-backend-auth';
const FRONTEND = 't-frontend-login';
const E2E = 't-e2e-tests';

const AGENT = { [BACKEND]: 'agent:backend', [FRONTEND]: 'agent:frontend', [E2E]: 'agent:e2e' } as const;
const PANE = { [BACKEND]: '%3', [FRONTEND]: '%4', [E2E]: '%5' } as const;

const fmt = (ms: number): string => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';

class Log {
  private seq = 0;
  private t = START_MS;
  private first = true;
  readonly events: Event[] = [];
  /** Latest version of every contract proposed so far (for lint siblings). */
  readonly contracts = new Map<string, TaskContractT>();

  add<T extends EventType>(step: number, type: T, opts: { task_id?: string; actor: string }, payload: EventOf<T>['payload']): EventOf<T> {
    if (step < 20 || step > 180) throw new Error(`step ${step}s out of range for ${type}`);
    if (!this.first) this.t += step * 1000;
    this.first = false;
    this.seq += 1;
    const e = Event.parse({ seq: this.seq, ts: fmt(this.t), mission_id: MISSION_ID, task_id: opts.task_id, actor: opts.actor, type, payload }) as EventOf<T>;
    this.events.push(e);
    return e;
  }

  get ts(): string { return fmt(this.t); }

  propose(step: number, contract: TaskContractT, revisedFrom?: number) {
    this.contracts.set(contract.id, contract);
    if (revisedFrom === undefined) this.add(step, 'task_proposed', { task_id: contract.id, actor: 'planner' }, { contract });
    else this.add(step, 'contract_revised', { task_id: contract.id, actor: 'planner' }, { contract, previous_version: revisedFrom });
    const ctx: LintContext = { siblings: [...this.contracts.values()].filter((c) => c.id !== contract.id), repoRoot: REPO, fileExists: () => true };
    this.add(20, 'lint_reported', { task_id: contract.id, actor: 'relayd' }, { contract_version: contract.version, results: lintContract(contract, ctx) });
  }

  spawn(task: keyof typeof AGENT, runtime: 'claude-code' | 'codex') {
    this.add(30, 'worktree_created', { task_id: task, actor: 'relayd' }, { path: `${REPO}/.relay/wt/${task}`, branch: `relay/${task}`, base: 'main' });
    this.add(25, 'agent_spawned', { task_id: task, actor: 'relayd' }, { runtime, pane_id: PANE[task], session_id: `sess-${task.slice(2)}`, cwd: `${REPO}/.relay/wt/${task}` });
  }

  accept(step: number, task: keyof typeof AGENT, version: number, response: { interpretation: string[]; verification_plan: Record<string, string>; assumptions?: string[]; risks?: string[] }) {
    this.add(step, 'task_accepted', { task_id: task, actor: AGENT[task] }, { contract_version: version, response: { task_id: task, contract_version: version, decision: 'accepted', ...response } });
    this.add(20, 'work_started', { task_id: task, actor: AGENT[task] }, {});
  }

}

// --- contracts -------------------------------------------------------------------------------------

const backendContract = (version: number, extra: Partial<TaskContractT> = {}): TaskContractT => TaskContract.parse({
  id: BACKEND, mission_id: MISSION_ID, version, sender: 'planner', recipient: 'backend', runtime: 'claude-code',
  goal: 'Implement email magic-link authentication endpoints (/auth/request and /auth/verify)',
  inputs: ['docs/auth-spec.md', 'src/models/user.ts', 'src/session/store.ts'],
  constraints: ['Reuse the existing session storage', 'Magic links are single-use'],
  non_goals: ['OAuth login', 'Account recovery', 'Frontend UI'],
  scope: { allowed_paths: ['src/auth/**', 'src/routes/auth.ts', 'tests/auth/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'A valid magic link creates a user session', check: { kind: 'command', run: 'npx vitest run tests/auth/valid-link.test.ts' } },
    { id: 'AC-2', condition: 'An expired magic link is rejected with 401', check: { kind: 'command', run: 'npx vitest run tests/auth/expired-link.test.ts' } },
    { id: 'AC-3', condition: 'A link cannot be reused after first successful use', check: { kind: 'human_review' } },
    { id: 'AC-4', condition: 'Changes stay within allowed scope', check: { kind: 'diff_scope' } },
  ],
  output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] },
  dependencies: [],
  budget: { max_repairs: 3, stagnation_limit: 2 },
  ...extra,
});

const frontendContract = (version: number, extra: Partial<TaskContractT> = {}): TaskContractT => TaskContract.parse({
  id: FRONTEND, mission_id: MISSION_ID, version, sender: 'planner', recipient: 'frontend', runtime: 'codex',
  goal: 'Build the login page that requests a magic link and handles the verify callback',
  inputs: ['docs/auth-spec.md', 'src/ui/App.tsx'],
  constraints: ['Use the existing design tokens in src/ui/theme.ts', 'Call the backend only through src/ui/api/auth.ts'],
  non_goals: ['Backend endpoints', 'Password login', 'Account settings page'],
  scope: { allowed_paths: ['src/ui/login/**', 'src/ui/api/auth.ts', 'src/ui/routes.tsx', 'tests/ui/login/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'Submitting an email calls POST /auth/request and shows a confirmation', check: { kind: 'command', run: 'npx vitest run tests/ui/login/request.test.tsx' } },
    { id: 'AC-2', condition: 'Visiting /login/verify?token=... exchanges the token and redirects to /app', check: { kind: 'command', run: 'npx vitest run tests/ui/login/verify.test.tsx' } },
    { id: 'AC-3', condition: 'Changes stay within allowed scope', check: { kind: 'diff_scope' } },
  ],
  output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] },
  dependencies: [],
  budget: { max_repairs: 3, stagnation_limit: 2 },
  ...extra,
});

const e2eContract = (version: number): TaskContractT => TaskContract.parse({
  id: E2E, mission_id: MISSION_ID, version, sender: 'planner', recipient: 'e2e', runtime: 'claude-code',
  goal: 'Write end-to-end tests covering the magic-link login flow against the real backend',
  inputs: ['docs/auth-spec.md', 'tests/e2e/setup.ts'],
  constraints: ['Use the existing tests/e2e/setup.ts harness', 'No network calls outside localhost'],
  non_goals: ['Unit tests for backend or frontend', 'Load testing'],
  scope: { allowed_paths: ['tests/e2e/**'] },
  acceptance_criteria: [
    { id: 'AC-1', condition: 'An end-to-end test signs in with a magic link and reaches /app', check: { kind: 'command', run: 'npx vitest run tests/e2e/login.e2e.test.ts' } },
    { id: 'AC-2', condition: 'Changes stay within allowed scope', check: { kind: 'diff_scope' } },
  ],
  output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] },
  dependencies: [BACKEND],
  budget: { max_repairs: 2, stagnation_limit: 2 },
});

// --- shared phases ---------------------------------------------------------------------------------

type Check = { id: string; status: 'passed' | 'failed' | 'pending_human'; observed?: string; duration_ms?: number; step?: number };

function submitAndCheck(log: Log, task: keyof typeof AGENT, version: number, attempt: number, summary: string, changed: string[], checks: Check[], claimedOverride?: Record<string, 'passed' | 'failed'>) {
  const claimed = Object.fromEntries(checks.map((c) => [c.id, { status: claimedOverride?.[c.id] ?? (c.status === 'failed' ? 'failed' : 'passed') }])) as Record<string, { status: 'passed' | 'failed' }>;
  log.add(attempt === 1 ? 180 : 150, 'evidence_submitted', { task_id: task, actor: AGENT[task] }, { submission: { task_id: task, contract_version: version, attempt, claimed, summary } });
  log.add(20, 'checks_started', { task_id: task, actor: 'relayd' }, { attempt });
  const record: Record<string, { status: Check['status']; output_path?: string; observed?: string; duration_ms?: number }> = {};
  for (const c of checks) {
    if (c.status === 'pending_human') {
      record[c.id] = { status: 'pending_human' };
      continue;
    }
    const result = { status: c.status, output_path: `.relay/evidence/${task}/a${attempt}/${c.id}.txt`, ...(c.observed ? { observed: c.observed } : {}), duration_ms: c.duration_ms ?? 1200 };
    log.add(c.step ?? 30, c.status === 'passed' ? 'check_passed' : 'check_failed', { task_id: task, actor: 'relayd' }, { attempt, criterion_id: c.id, result });
    record[c.id] = result;
  }
  const mismatch = checks.filter((c) => c.status === 'failed' && claimed[c.id]?.status === 'passed').map((c) => c.id);
  log.add(20, 'evidence_recorded', { task_id: task, actor: 'relayd' }, { record: { task_id: task, contract_version: version, attempt, git_diff_path: `.relay/evidence/${task}/a${attempt}.patch`, changed_files: changed, checks: record, self_report_mismatch: mismatch } });
}

function verifyAndComplete(log: Log, task: keyof typeof AGENT, attempt: number, humanReview?: string) {
  if (humanReview) log.add(90, 'human_review_recorded', { task_id: task, actor: 'human' }, { attempt, criterion_id: humanReview, status: 'passed' });
  log.add(20, 'task_verified', { task_id: task, actor: 'relayd' }, { attempt });
  log.add(20, 'task_completed', { task_id: task, actor: 'relayd' }, {});
  log.add(30, 'agent_exited', { task_id: task, actor: 'relayd' }, { pane_id: PANE[task], exit_reason: 'completed' });
}

const BACKEND_RESPONSE = {
  interpretation: ['Backend endpoints only; no UI', 'Reuse the current session model', 'Done means AC-1..AC-4 pass'],
  assumptions: ['A dev mail transport is available for magic links'],
  risks: ['Current token table has no used_at column; a migration is needed'],
  verification_plan: { 'AC-1': 'Add tests/auth/valid-link.test.ts', 'AC-2': 'Add tests/auth/expired-link.test.ts with fake timers', 'AC-3': 'Mark token used on first verify; demo for human review', 'AC-4': 'Only touch src/auth, src/routes/auth.ts, tests/auth' },
};
const FRONTEND_RESPONSE = {
  interpretation: ['Login page + verify callback route only', 'Backend is called through src/ui/api/auth.ts'],
  assumptions: ['Backend exposes POST /auth/request and GET /auth/verify as in docs/auth-spec.md'],
  risks: [],
  verification_plan: { 'AC-1': 'tests/ui/login/request.test.tsx with a mocked fetch', 'AC-2': 'tests/ui/login/verify.test.tsx asserting the redirect', 'AC-3': 'Stay within src/ui/login, src/ui/api/auth.ts, src/ui/routes.tsx, tests/ui/login' },
};
const E2E_RESPONSE = {
  interpretation: ['One end-to-end test through the real backend on localhost', 'Uses the existing harness'],
  assumptions: ['The backend branch is merged into this worktree'],
  risks: ['Mail capture in the harness may be flaky'],
  verification_plan: { 'AC-1': 'tests/e2e/login.e2e.test.ts using the captured magic link', 'AC-2': 'Only touch tests/e2e' },
};

const BACKEND_CHANGED = ['src/auth/token.ts', 'src/auth/magic-link.ts', 'src/routes/auth.ts', 'tests/auth/valid-link.test.ts', 'tests/auth/expired-link.test.ts'];
const FRONTEND_CHANGED = ['src/ui/login/LoginPage.tsx', 'src/ui/login/VerifyPage.tsx', 'src/ui/api/auth.ts', 'src/ui/routes.tsx', 'tests/ui/login/request.test.tsx', 'tests/ui/login/verify.test.tsx'];
const E2E_CHANGED = ['tests/e2e/login.e2e.test.ts'];

function integrate(log: Log) {
  log.add(40, 'integration_started', { actor: 'relayd' }, { branch: 'relay/integration', order: [BACKEND, FRONTEND, E2E] });
  log.add(150, 'mission_verified', { actor: 'relayd' }, {});
}

const mission = () => ({ id: MISSION_ID, repo: REPO, title: 'Add secure login to this application', success_definition: 'Users can sign in securely with a magic link; all task contracts verified', integration_check: 'npx vitest run', budget: { max_repairs_per_task: 3 } });

// --- happy path ------------------------------------------------------------------------------------

function happy(): Log {
  const log = new Log();
  log.add(20, 'mission_created', { actor: 'human' }, mission());
  log.propose(60, backendContract(1));
  log.propose(45, frontendContract(1));
  log.propose(40, e2eContract(1));
  log.add(20, 'tasks_planned', { actor: 'planner' }, { task_ids: [BACKEND, FRONTEND, E2E] });

  log.spawn(BACKEND, 'claude-code');
  log.spawn(FRONTEND, 'codex');
  log.accept(90, BACKEND, 1, BACKEND_RESPONSE);
  log.accept(60, FRONTEND, 1, FRONTEND_RESPONSE);
  log.add(150, 'progress_reported', { task_id: BACKEND, actor: AGENT[BACKEND] }, { message: 'Token model + /auth/request done; writing /auth/verify', percent: 55 });
  log.add(120, 'progress_reported', { task_id: FRONTEND, actor: AGENT[FRONTEND] }, { message: 'LoginPage renders; wiring verify route', percent: 60 });

  submitAndCheck(log, BACKEND, 1, 1, 'Implemented /auth/request and /auth/verify with single-use, 15-minute tokens', BACKEND_CHANGED, [
    { id: 'AC-1', status: 'passed', duration_ms: 3120 },
    { id: 'AC-2', status: 'passed', duration_ms: 2870, step: 25 },
    { id: 'AC-3', status: 'pending_human' },
    { id: 'AC-4', status: 'passed', duration_ms: 90, step: 20 },
  ]);
  verifyAndComplete(log, BACKEND, 1, 'AC-3');

  e2ePhaseStart(log);
  submitAndCheck(log, FRONTEND, 1, 1, 'Login page, verify callback and API client added', FRONTEND_CHANGED, [
    { id: 'AC-1', status: 'passed', duration_ms: 4100, step: 40 },
    { id: 'AC-2', status: 'passed', duration_ms: 3900, step: 35 },
    { id: 'AC-3', status: 'passed', duration_ms: 80, step: 20 },
  ]);
  verifyAndComplete(log, FRONTEND, 1);
  e2ePhaseFinish(log);
  integrate(log);
  return log;
}

/** e2e is spawned as soon as its dependency (backend) completes, while frontend is still working. */
function e2ePhaseStart(log: Log) {
  log.spawn(E2E, 'claude-code');
  log.accept(80, E2E, 1, E2E_RESPONSE);
}
function e2ePhaseFinish(log: Log) {
  log.add(90, 'progress_reported', { task_id: E2E, actor: AGENT[E2E] }, { message: 'Harness boots backend + frontend; writing the login flow test', percent: 50 });
  submitAndCheck(log, E2E, 1, 1, 'Added tests/e2e/login.e2e.test.ts covering request → mail → verify → /app', E2E_CHANGED, [
    { id: 'AC-1', status: 'passed', duration_ms: 48200, step: 120 },
    { id: 'AC-2', status: 'passed', duration_ms: 310, step: 20 },
  ]);
  verifyAndComplete(log, E2E, 1);
}

// --- repair path -----------------------------------------------------------------------------------

function repair(): Log {
  const log = new Log();
  log.add(20, 'mission_created', { actor: 'human' }, mission());
  log.propose(60, backendContract(1));
  // Frontend v1: AC-2 has no check → lint error → spawn is blocked until the planner revises.
  const frontendV1 = frontendContract(1);
  frontendV1.acceptance_criteria = frontendV1.acceptance_criteria.map((ac) => (ac.id === 'AC-2' ? { id: ac.id, condition: ac.condition } : ac));
  log.propose(45, frontendV1);
  log.propose(40, e2eContract(1));
  log.add(20, 'tasks_planned', { actor: 'planner' }, { task_ids: [BACKEND, FRONTEND, E2E] });

  // Backend asks for clarification before writing any code.
  log.spawn(BACKEND, 'claude-code');
  log.add(120, 'clarification_requested', { task_id: BACKEND, actor: AGENT[BACKEND] }, {
    contract_version: 1,
    response: {
      task_id: BACKEND, contract_version: 1, decision: 'needs_clarification',
      interpretation: ['Backend endpoints only; no UI'],
      assumptions: [], risks: ['docs/auth-spec.md does not state the link expiry'],
      verification_plan: {},
      questions: [
        { id: 'Q1', text: 'Is the magic link the only sign-in method, or must password login keep working alongside it?', blocking: true },
        { id: 'Q2', text: 'How long should a magic link stay valid before it is rejected as expired?', blocking: true },
      ],
    },
  });

  // Planner fixes the unverifiable criterion on the frontend contract.
  log.propose(90, frontendContract(2), 1);
  log.spawn(FRONTEND, 'codex');

  // Human answers both questions; relayd produces backend v2 with the clarifications attached.
  const answered = log.add(150, 'clarification_answered', { task_id: BACKEND, actor: 'human' }, {
    answers: [
      { question_id: 'Q1', answer: 'Magic link is the only sign-in method. Do not keep password login.', answered_by: 'human', at: log.ts },
      { question_id: 'Q2', answer: '15 minutes.', answered_by: 'human', at: log.ts },
    ],
  });
  const backendV2 = backendContract(2, {
    constraints: ['Reuse the existing session storage', 'Magic links are single-use', 'Magic link is the only sign-in method', 'Magic links expire after 15 minutes'],
    clarifications: answered.payload.answers,
  });
  log.contracts.set(BACKEND, backendV2);
  log.add(20, 'contract_revised', { task_id: BACKEND, actor: 'relayd' }, { contract: backendV2, previous_version: 1 });
  log.add(20, 'lint_reported', { task_id: BACKEND, actor: 'relayd' }, { contract_version: 2, results: lintContract(backendV2, { siblings: [...log.contracts.values()].filter((c) => c.id !== BACKEND), repoRoot: REPO, fileExists: () => true }) });

  log.accept(60, FRONTEND, 2, FRONTEND_RESPONSE);
  log.accept(60, BACKEND, 2, { ...BACKEND_RESPONSE, interpretation: [...BACKEND_RESPONSE.interpretation, 'Links expire after 15 minutes; no password login'] });

  log.add(150, 'progress_reported', { task_id: BACKEND, actor: AGENT[BACKEND] }, { message: 'Token model + /auth/request done; writing /auth/verify', percent: 55 });
  log.add(60, 'task_blocked', { task_id: FRONTEND, actor: AGENT[FRONTEND] }, { reason: 'Need the JSON shape of GET /auth/verify success response before wiring the redirect', waiting_on: BACKEND });
  log.add(120, 'progress_reported', { task_id: BACKEND, actor: AGENT[BACKEND] }, { message: '/auth/verify returns { session_id, user_id }; documented in docs/auth-spec.md', percent: 80 });
  log.add(45, 'task_unblocked', { task_id: FRONTEND, actor: AGENT[FRONTEND] }, {});

  // Attempt 1: agent claims AC-2 passed, relayd finds it failed → scoped repair r1.
  submitAndCheck(log, BACKEND, 2, 1, 'Implemented /auth/request and /auth/verify', BACKEND_CHANGED, [
    { id: 'AC-1', status: 'passed', duration_ms: 3120 },
    { id: 'AC-2', status: 'failed', observed: 'GET /auth/verify with an expired token returned 200; expected 401', duration_ms: 2950, step: 25 },
    { id: 'AC-3', status: 'pending_human' },
    { id: 'AC-4', status: 'passed', duration_ms: 90, step: 20 },
  ], { 'AC-1': 'passed', 'AC-2': 'passed', 'AC-3': 'passed', 'AC-4': 'passed' });
  log.add(20, 'repair_requested', { task_id: BACKEND, actor: 'relayd' }, {
    repair: {
      id: `${BACKEND}/r1`, parent_task: BACKEND, parent_version: 2, attempt: 2,
      failed_criteria: ['AC-2'],
      observed_failure: 'GET /auth/verify with an expired token returned 200; expected 401',
      requested_correction: 'Reject tokens older than 15 minutes with 401 and make tests/auth/expired-link.test.ts pass',
      unchanged_scope: ['Do not modify frontend code', 'Do not change the session schema'],
      remaining_repairs: 2,
    },
  });
  log.add(40, 'repair_accepted', { task_id: BACKEND, actor: AGENT[BACKEND] }, { repair_id: `${BACKEND}/r1` });
  log.add(120, 'progress_reported', { task_id: BACKEND, actor: AGENT[BACKEND] }, { message: 'Comparing token.created_at against now() with a 15-minute window', percent: 90 });

  // Attempt 2: only the failed criterion changed; everything passes.
  submitAndCheck(log, BACKEND, 2, 2, 'Expired tokens are now rejected with 401', ['src/auth/token.ts', 'tests/auth/expired-link.test.ts'], [
    { id: 'AC-1', status: 'passed', duration_ms: 3050 },
    { id: 'AC-2', status: 'passed', duration_ms: 2910, step: 25 },
    { id: 'AC-3', status: 'pending_human' },
    { id: 'AC-4', status: 'passed', duration_ms: 85, step: 20 },
  ]);
  verifyAndComplete(log, BACKEND, 2, 'AC-3');

  e2ePhaseStart(log);
  submitAndCheck(log, FRONTEND, 2, 1, 'Login page, verify callback and API client added', FRONTEND_CHANGED, [
    { id: 'AC-1', status: 'passed', duration_ms: 4100, step: 40 },
    { id: 'AC-2', status: 'passed', duration_ms: 3900, step: 35 },
    { id: 'AC-3', status: 'passed', duration_ms: 80, step: 20 },
  ]);
  verifyAndComplete(log, FRONTEND, 1);
  e2ePhaseFinish(log);
  integrate(log);
  return log;
}

// --- write -----------------------------------------------------------------------------------------

for (const [name, build] of [['events-happy.jsonl', happy], ['events-repair.jsonl', repair]] as const) {
  const log = build();
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, log.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`${name}: ${log.events.length} events, ${log.events[0]!.ts} → ${log.events.at(-1)!.ts}`);
}
