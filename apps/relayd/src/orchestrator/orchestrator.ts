/**
 * Task-lifecycle orchestrator. Composes the relayd ports (PRD §8–§10) and keeps its own minimal
 * bookkeeping (`Map<taskId, TaskRecord>`) so it never depends on the derived `State` — that stays
 * correct automatically once the real reducer lands, because every transition is also an event.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import {
  TaskContract, Mission, ProposeTaskOutput, RespondOutput, AwaitContractOutput, AwaitVerdictOutput,
  SubmitEvidenceOutput, GetContractOutput, AwaitTaskOutput, AWAIT_TIMEOUT_MAX_S, hasLintErrors, replay,
} from '@relay/protocol';
import type {
  Event, TaskContractInput, ContractResponse, Clarification, EvidenceSubmission, EvidenceRecord, RepairContract,
  Question, LintResult, RuntimeKind, TaskView, TaskState, HandoffState, RuntimeState, MissionStatus,
  CreateMissionBody, ReviewBody, EventInput, EventType,
  RespondInput, SubmitEvidenceInput, ReportProgressInput, ReportBlockerInput,
} from '@relay/protocol';
import type { AwaitAnswersOutput as AwaitAnswersOutputSchema, AwaitReplyOutput as AwaitReplyOutputSchema } from '@relay/protocol';
type AwaitAnswersOutput = z.infer<typeof AwaitAnswersOutputSchema>;
type AwaitReplyOutput = z.infer<typeof AwaitReplyOutputSchema>;
import type {
  EventStore, WorktreeManager, WorktreeInfo, CheckRunner, RepairPolicy, TerminalHost, AgentRuntime, RepairDecision,
} from '../ports.js';
import { lintContract } from '../lint.js';
import { Waiters } from './waiters.js';
import { RelayError, notFound, conflict } from './errors.js';

export type ProposeTaskOutput = z.infer<typeof ProposeTaskOutput>;
export type RespondOutput = z.infer<typeof RespondOutput>;
export type AwaitContractOutput = z.infer<typeof AwaitContractOutput>;
export type AwaitVerdictOutput = z.infer<typeof AwaitVerdictOutput>;
export type SubmitEvidenceOutput = z.infer<typeof SubmitEvidenceOutput>;
export type GetContractOutput = z.infer<typeof GetContractOutput>;
export type AwaitTaskOutput = z.infer<typeof AwaitTaskOutput>;
type RespondInputT = z.infer<typeof RespondInput>;
type SubmitEvidenceInputT = z.infer<typeof SubmitEvidenceInput>;
type ReportProgressInputT = z.infer<typeof ReportProgressInput>;
type ReportBlockerInputT = z.infer<typeof ReportBlockerInput>;

/** Who proposes / revises / answers: the planner, the human, or (agent networking) a recipient agent by role. */
export type Sender = 'planner' | 'human' | `agent:${string}`;
export type TokenSubject = { kind: 'task'; taskId: string } | { kind: 'mission'; missionId: string };

export interface OrchestratorDeps {
  store: EventStore;
  worktrees: WorktreeManager;
  checks: CheckRunner;
  repair: RepairPolicy;
  host: TerminalHost;
  runtimes: Record<RuntimeKind, AgentRuntime>;
  repoRoot: string;
  relayDir: string;
  mcpUrl: string;
  clock?: () => string;
  log?: (message: string) => void;
  /** Daemon restart: is a recorded worktree still on disk? Defaults to `fs.existsSync(path)`; tests inject. */
  worktreeExists?: (worktree: WorktreeInfo) => boolean;
}

export interface TaskSummary {
  id: string;
  mission_id: string;
  version: number;
  recipient: string;
  runtime: RuntimeKind;
  goal: string;
  dependencies: string[];
  blocked_on_dependencies: string[];
  task_state: TaskState;
  handoff_state: HandoffState;
  runtime_state: RuntimeState;
  lint_errors: number;
  open_questions: number;
  attempt: number;
}

export interface MissionSummary {
  mission: Mission;
  status: MissionStatus;
  task_ids: string[];
  open_questions: Question[];
  clarifications: Clarification[];
}

export interface Orchestrator {
  createMission(body: CreateMissionBody): { mission_id: string; planner_token: string };
  /** Spawns an LLM planner agent (with the mission's planner token) in the repository root. */
  spawnPlanner(missionId: string, runtime: RuntimeKind): Promise<{ pane_id: string }>;
  /** Planner → human: mission-level questions; replaces any still-open set. */
  askHuman(missionId: string, questions: Question[]): { status: 'waiting'; open_questions: number };
  /** Long-poll until every open mission question is answered. */
  awaitAnswers(missionId: string, timeoutS: number, signal?: AbortSignal): Promise<AwaitAnswersOutput>;
  /** Human → planner: answers to open mission questions. */
  clarifyMission(missionId: string, answers: Array<{ question_id: string; answer: string }>, answeredBy: Sender): { answered: number; open_questions: number };
  getMission(missionId: string): MissionSummary | undefined;
  listTasks(missionId?: string): TaskSummary[];
  taskView(taskId: string): TaskView | undefined;

  proposeTask(missionId: string, input: TaskContractInput, sender: Sender): Promise<ProposeTaskOutput>;
  /**
   * Agent networking: the recipient of `parentTaskId` delegates a separable unit of its work as a new contract
   * it is the sender of (`agent:<role>`), in the parent's mission, with `parent_task` set. The child's
   * `allowed_paths` must be disjoint from the parent's (`overlapping_scope` at error severity) and it may not
   * depend on the parent (400: cycle). Otherwise identical to `proposeTask`, including lint and spawn gating.
   */
  proposeSubtask(parentTaskId: string, input: TaskContractInput): Promise<ProposeTaskOutput>;
  /**
   * Long-poll until `taskId` is completed / failed / canceled; `pending` (with both states) on timeout.
   * Any task may be awaited; `callerTaskId` (when known) may not await itself (400) or a task of another mission.
   */
  awaitTask(taskId: string, timeoutS: number, signal?: AbortSignal, callerTaskId?: string): Promise<AwaitTaskOutput>;
  reviseTask(taskId: string, patch: Partial<TaskContractInput>, actor: Sender): Promise<{ contract_version: number }>;
  clarify(taskId: string, answers: Array<{ question_id: string; answer: string }>, answeredBy: Sender): Promise<{ contract_version: number }>;
  review(taskId: string, body: ReviewBody): Promise<void>;
  cancel(taskId: string, reason?: string): Promise<void>;

  getContract(taskId: string): GetContractOutput;
  respond(taskId: string, response: RespondInputT): RespondOutput;
  awaitContract(taskId: string, sinceVersion: number, timeoutS: number, signal?: AbortSignal): Promise<AwaitContractOutput>;
  reportProgress(taskId: string, input: ReportProgressInputT): void;
  reportBlocker(taskId: string, input: ReportBlockerInputT): void;
  /** Human/planner → agent: reply to the current blocker (delivered by awaitReply). */
  reply(taskId: string, message: string, actor: Sender): { delivered: true; unread: number };
  /** Long-poll for the next unread reply; `none` when the task has no outstanding blocker and no unread reply. */
  awaitReply(taskId: string, timeoutS: number, signal?: AbortSignal): Promise<AwaitReplyOutput>;
  submitEvidence(taskId: string, input: SubmitEvidenceInputT): SubmitEvidenceOutput;
  awaitVerdict(taskId: string, attempt: number, timeoutS: number, signal?: AbortSignal): Promise<AwaitVerdictOutput>;

  /**
   * Daemon restart: rebuilds missions/tasks from a run's event log (`replay` + a detail walk for what the
   * derived state does not carry: worktree base, submissions, verdicts, pending human review, repair
   * acknowledgement). Tokens are never persisted, so every task and planner gets a fresh one. Emits nothing.
   * Requires an empty orchestrator.
   */
  rehydrate(events: Event[]): { missions: number; tasks: number };
  /**
   * Daemon restart, after `rehydrate`: every task whose latest evidence submission never got its
   * `evidence_recorded` (the daemon died after `evidence_submitted` / `checks_started`) has that attempt re-run
   * through the normal pipeline — same submission, same evidence dir — so the record and the verdict are produced
   * and a resumed agent's `awaitVerdict` resolves. `checks_started` is not repeated for an attempt that already
   * has one. A worktree that no longer exists is recorded as a failed attempt (`observed: 'worktree missing after
   * restart'`) and handed to the repair policy. Returns the attempts that were re-run; the checks themselves run
   * in the background (`settled()`).
   */
  resumeChecks(): Array<{ task_id: string; attempt: number }>;
  /**
   * Daemon restart: reopens the agent of `taskId` (or `planner:<mission>`) in a fresh pane that resumes its
   * recorded session via `runtime.resume`. Emits `agent_exited` (reason `daemon restart`) for the old pane and
   * `agent_spawned` for the new one; a failed resume is recorded as `task_blocked` and rethrown.
   */
  respawn(taskId: string, opts?: { prompt?: string }): Promise<{ pane_id: string }>;

  issueToken(subject: string): string;
  resolveToken(token: string): TokenSubject | undefined;
  tokenFor(taskId: string): string | undefined;

  /** Resolves once every background pipeline (checks, spawns, integration) has finished. */
  settled(): Promise<void>;
}

interface MissionRecord {
  mission: Mission;
  status: MissionStatus;
  taskIds: string[];
  plannerToken: string;
  plannerPaneId?: string;
  /** Last planner launch, kept for `respawn('planner:<mission>')`. */
  plannerAgent?: { runtime: RuntimeKind; sessionId: string; cwd: string; paneId: string };
  integrationStarted: boolean;
  openQuestions: Question[];
  clarifications: Clarification[];
}

interface TaskRecord {
  id: string;
  missionId: string;
  versions: TaskContract[];
  lint: LintResult[];
  response?: ContractResponse;
  openQuestions: Question[];
  taskState: TaskState;
  handoffState: HandoffState;
  runtimeState: RuntimeState;
  spawned: boolean;
  spawning: boolean;
  token?: string;
  worktree?: WorktreeInfo;
  paneId?: string;
  sessionId?: string;
  blocker?: { reason: string; waiting_on?: string; since: string };
  replies: Array<{ message: string; replied_by: string; at: string }>;
  repliesRead: number;
  attempt: number;
  attempts: EvidenceRecord[];
  submissions: EvidenceSubmission[];
  /** Attempts for which `checks_started` was emitted (this run or a recorded one): the pipeline is idempotent per attempt. */
  checksStarted: Set<number>;
  verdicts: Map<number, AwaitVerdictOutput>;
  pendingRecord?: EvidenceRecord;
  repairs: RepairContract[];
  activeRepair?: RepairContract;
  repairAckPending: boolean;
  escalated: boolean;
  /** Reason of the last `task_failed_budget` / `task_escalated`; surfaced by `awaitTask` once the task is failed. */
  failureReason?: string;
  proposedAt?: string;
  acceptedAt?: string;
  startedAt?: string;
  lastSeenAt?: string;
  completedAt?: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nonEmpty = (s: string | undefined): boolean => typeof s === 'string' && s.trim().length > 0;

/**
 * PRD §6.3 / §4 principle 1: an acceptance is only meaningful when the recipient restates the task and says how
 * it will prove every criterion; a clarification needs questions; a rejection needs a reason. Pure: the caller
 * reports the errors and lets the agent respond again.
 */
export function responseShapeErrors(contract: TaskContract, input: Omit<ContractResponse, 'task_id'>): string[] {
  const errors: string[] = [];
  if (input.decision === 'accepted') {
    if (!input.interpretation.some(nonEmpty)) errors.push('accepted requires a non-empty interpretation (restate the task in your own words)');
    const criteria = contract.acceptance_criteria.map((ac) => ac.id);
    const missing = criteria.filter((id) => !nonEmpty(input.verification_plan[id]));
    if (missing.length > 0) errors.push(`verification_plan is missing an entry for ${missing.join(', ')}`);
    const unknown = Object.keys(input.verification_plan).filter((id) => !criteria.includes(id));
    if (unknown.length > 0) errors.push(`verification_plan names unknown criteria ${unknown.join(', ')} (criteria: ${criteria.join(', ') || 'none'})`);
  } else if (input.decision === 'needs_clarification') {
    if (input.questions.length === 0) errors.push('needs_clarification requires at least one question');
  } else if (!nonEmpty(input.reason)) {
    errors.push('rejected requires a reason');
  }
  return errors;
}
export const INTEGRATION_BRANCH = 'relay/integration';
/** Synthetic criterion for the mission-level integration check (`CriterionId` requires `AC-<n>`). */
export const INTEGRATION_CRITERION = 'AC-0';
/** Workspace/respawn id of a mission's planner pane (`respawn('planner:<mission>')`). */
export const plannerTaskId = (missionId: string): string => `planner:${missionId}`;
export const isPlannerTaskId = (id: string): boolean => id.startsWith('planner:');
/** Per-agent config directory (`mcp.json`, `CODEX_HOME`); planners use `agents/planner-<mission>`. */
export const agentConfigDir = (relayDir: string, taskId: string): string =>
  path.join(relayDir, 'agents', isPlannerTaskId(taskId) ? `planner-${taskId.slice('planner:'.length)}` : taskId);

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const worktreeExists = deps.worktreeExists ?? ((wt: WorktreeInfo) => fs.existsSync(wt.path));
  const { store } = deps;
  const missions = new Map<string, MissionRecord>();
  const tasks = new Map<string, TaskRecord>();
  const tokens = new Map<string, TokenSubject>();
  const waiters = new Waiters();
  const inflight = new Set<Promise<unknown>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    const wrapped = p.catch((err) => log(`background failure: ${(err as Error)?.stack ?? err}`));
    inflight.add(wrapped);
    void wrapped.finally(() => inflight.delete(wrapped));
    return p;
  };

  const emit = (input: EventInput) => {
    const ev = store.append(input);
    if (input.task_id) waiters.notify(`task:${input.task_id}`);
    return ev;
  };
  const emitTask = (rec: TaskRecord, actor: EventInput['actor'], type: EventType, payload: unknown) =>
    emit({ mission_id: rec.missionId, task_id: rec.id, actor, type, payload } as EventInput);

  const mustMission = (id: string): MissionRecord => {
    const m = missions.get(id);
    if (!m) throw notFound(`mission ${id}`);
    return m;
  };
  const mustTask = (id: string): TaskRecord => {
    const t = tasks.get(id);
    if (!t) throw notFound(`task ${id}`);
    return t;
  };
  const current = (rec: TaskRecord): TaskContract => rec.versions[rec.versions.length - 1];
  const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'canceled', 'failed']);
  /** Responses and evidence must target the version the recipient actually read; one wording for both. */
  const versionMismatch = (rec: TaskRecord, given: number): string | undefined =>
    given === current(rec).version ? undefined : `contract_version v${given} is not the current contract of ${rec.id} (v${current(rec).version}); call relay_get_contract and respond to the current version`;
  const agentActor = (rec: TaskRecord) => `agent:${current(rec).recipient}` as const;

  const depsUnmet = (rec: TaskRecord): string[] =>
    current(rec).dependencies.filter((d) => tasks.get(d)?.taskState !== 'completed');

  const toView = (rec: TaskRecord): TaskView => ({
    id: rec.id,
    mission_id: rec.missionId,
    contract: current(rec),
    versions: [...rec.versions],
    response: rec.response,
    open_questions: [...rec.openQuestions],
    lint: [...rec.lint],
    runtime: rec.runtimeState,
    task_state: rec.taskState,
    handoff_state: rec.handoffState,
    worktree: rec.worktree ? { path: rec.worktree.path, branch: rec.worktree.branch } : undefined,
    agent: rec.paneId ? { runtime: current(rec).runtime, pane_id: rec.paneId, session_id: rec.sessionId ?? '' } : undefined,
    blocker: rec.blocker,
    replies: [...rec.replies],
    blocked_on_dependencies: depsUnmet(rec),
    attempt: rec.attempt,
    attempts: [...rec.attempts],
    repairs: [...rec.repairs],
    active_repair: rec.activeRepair,
    escalated: rec.escalated,
    proposed_at: rec.proposedAt,
    accepted_at: rec.acceptedAt,
    started_at: rec.startedAt,
    last_seen_at: rec.lastSeenAt,
    completed_at: rec.completedAt,
  });

  const summarize = (rec: TaskRecord): TaskSummary => {
    const c = current(rec);
    return {
      id: rec.id, mission_id: rec.missionId, version: c.version, recipient: c.recipient, runtime: c.runtime, goal: c.goal,
      dependencies: [...c.dependencies], blocked_on_dependencies: depsUnmet(rec),
      task_state: rec.taskState, handoff_state: rec.handoffState, runtime_state: rec.runtimeState,
      lint_errors: rec.lint.filter((l) => l.severity === 'error').length,
      open_questions: rec.openQuestions.length, attempt: rec.attempt,
    };
  };

  // ---------- tokens ----------
  const issueToken = (subject: string): string => {
    const token = hex(16);
    tokens.set(token, subject.startsWith('mission:') ? { kind: 'mission', missionId: subject.slice('mission:'.length) } : { kind: 'task', taskId: subject });
    return token;
  };

  // ---------- lint + spawn ----------
  const computeLint = (rec: TaskRecord): LintResult[] => {
    const siblings = [...tasks.values()].filter((t) => t.missionId === rec.missionId && t.id !== rec.id).map(current);
    return lintContract(current(rec), {
      siblings,
      repoRoot: deps.repoRoot,
      fileExists: (rel) => fs.existsSync(path.resolve(deps.repoRoot, rel)),
    });
  };
  const runLint = (rec: TaskRecord): LintResult[] => {
    const results = computeLint(rec);
    rec.lint = results;
    emitTask(rec, 'relayd', 'lint_reported', { contract_version: current(rec).version, results });
    return results;
  };
  /** Sibling-dependent rules (unknown_dependency, overlapping_scope) can change when a sibling is (re)proposed. */
  const relintSiblings = async (rec: TaskRecord): Promise<void> => {
    for (const t of tasks.values()) {
      if (t.missionId !== rec.missionId || t.id === rec.id || t.taskState === 'canceled') continue;
      const results = computeLint(t);
      if (JSON.stringify(results) === JSON.stringify(t.lint)) continue;
      t.lint = results;
      emitTask(t, 'relayd', 'lint_reported', { contract_version: current(t).version, results });
      await track(maybeSpawn(t.id)).catch((e) => reportSpawnFailure(t.id, e));
    }
  };

  /**
   * A failed spawn reached only relayd's stderr (via `track`'s logger) and produced no event, so the task
   * sat at proposed/unspawned with nothing in the event log, the TUI or replay to say why. Record it as a
   * blocker — `task_blocked` already carries a reason and the reducer already surfaces it.
   */
  const reportSpawnFailure = (taskId: string, error: unknown): void => {
    const rec = tasks.get(taskId);
    if (!rec || rec.taskState === 'canceled') return;
    const reason = `agent spawn failed: ${error instanceof Error ? error.message : String(error)}`;
    rec.blocker = { reason, since: clock() };
    emitTask(rec, 'relayd', 'task_blocked', { reason });
  };

  const maybeSpawn = async (taskId: string): Promise<void> => {
    const rec = tasks.get(taskId);
    if (!rec || rec.spawned || rec.spawning) return;
    if (rec.taskState === 'canceled') return;
    if (hasLintErrors(rec.lint)) return;
    if (depsUnmet(rec).length > 0) return;
    rec.spawning = true;
    try {
      const contract = current(rec);
      const dependencyBranches = contract.dependencies.map((d) => tasks.get(d)?.worktree?.branch ?? `relay/${d}`);
      const worktree = await deps.worktrees.create(deps.repoRoot, contract, dependencyBranches);
      rec.worktree = worktree;
      emitTask(rec, 'relayd', 'worktree_created', { path: worktree.path, branch: worktree.branch, base: worktree.base });

      const token = issueToken(taskId);
      rec.token = token;
      const sessionId = randomUUID();
      rec.sessionId = sessionId;
      const runtime = deps.runtimes[contract.runtime];
      if (!runtime) throw new Error(`no runtime registered for ${contract.runtime}`);
      const configDir = agentConfigDir(deps.relayDir, taskId);
      const launch = await runtime.prepare(
        { taskId, token, mcpUrl: deps.mcpUrl, sessionId, cwd: worktree.path, role: 'recipient', contractSummary: contract.goal },
        configDir,
      );
      const { paneId } = await deps.host.spawn({ name: contract.recipient, cwd: worktree.path, argv: launch.argv, env: launch.env, prompt: launch.prompt, taskId: contract.id });
      rec.paneId = paneId;
      rec.spawned = true;
      rec.runtimeState = 'idle';
      emitTask(rec, 'relayd', 'agent_spawned', { runtime: contract.runtime, pane_id: paneId, session_id: sessionId, cwd: worktree.path });
    } finally {
      rec.spawning = false;
    }
  };

  const spawnDependants = async (taskId: string, missionId: string): Promise<void> => {
    for (const t of tasks.values()) {
      if (t.missionId === missionId && current(t).dependencies.includes(taskId)) {
        // This runs inside the verification pipeline: an unhandled spawn failure here would abort the
        // parent's completion and skip `maybeIntegrate`. Record it and carry on to the next dependant.
        await maybeSpawn(t.id).catch((e) => reportSpawnFailure(t.id, e));
      }
    }
  };

  // ---------- proposals / revisions ----------
  /** Shared by `proposeTask` (planner / human) and `proposeSubtask` (a recipient agent, `parentTask` set). */
  const propose = async (missionId: string, input: TaskContractInput, sender: Sender, parentTask?: string): Promise<ProposeTaskOutput> => {
    const m = mustMission(missionId);
    const existing = tasks.get(input.id);
    if (existing && existing.missionId !== missionId) throw conflict(`task ${input.id} belongs to mission ${existing.missionId}`);
    // "Fix and re-propose" exists for one situation only: the contract never got past lint, so no agent has seen
    // it. Anything else already has a reader (or a history) and must go through reviseTask, which keeps the
    // version chain, clarifications and the recipient's re-response intact.
    if (existing && !(!existing.spawned && !existing.spawning && hasLintErrors(existing.lint))) {
      throw conflict(`task ${input.id} is ${existing.taskState}; use relay_revise_task`);
    }
    const version = existing ? current(existing).version + 1 : 1;
    const contract = TaskContract.parse({
      ...input, mission_id: missionId, version, sender, clarifications: existing ? current(existing).clarifications : [],
      ...(parentTask !== undefined ? { parent_task: parentTask } : {}),
    });
    let rec = existing;
    if (!rec) {
      rec = {
        id: contract.id, missionId, versions: [], lint: [], openQuestions: [],
        taskState: 'proposed', handoffState: 'proposed', runtimeState: 'unspawned',
        spawned: false, spawning: false, attempt: 0, attempts: [], submissions: [], checksStarted: new Set(), verdicts: new Map(),
        repairs: [], repairAckPending: false, escalated: false, proposedAt: clock(), replies: [], repliesRead: 0,
      };
      tasks.set(rec.id, rec);
      m.taskIds.push(rec.id);
    }
    rec.versions.push(contract);
    rec.handoffState = 'proposed';
    rec.openQuestions = [];
    if (m.status === 'planning') m.status = 'executing';
    emitTask(rec, sender, 'task_proposed', { contract });
    const results = runLint(rec);
    const errors = results.filter((r) => r.severity === 'error').map((r) => `${r.rule}: ${r.message}`);
    const warnings = results.filter((r) => r.severity !== 'error').map((r) => `${r.rule}: ${r.message}`);
    if (errors.length === 0) await track(maybeSpawn(rec.id)).catch((e) => reportSpawnFailure(rec.id, e));
    await relintSiblings(rec);
    if (errors.length > 0) return { status: 'lint_error', task_id: rec.id, errors, warnings };
    return { status: 'proposed', task_id: rec.id, version, warnings };
  };

  const proposeTask: Orchestrator['proposeTask'] = (missionId, input, sender) => propose(missionId, input, sender);

  /** Every task above `rec` through `parent_task` links (nearest first). */
  const ancestorsOf = (rec: TaskRecord): string[] => {
    const out: string[] = [];
    let cursor = current(rec).parent_task;
    while (cursor !== undefined && !out.includes(cursor)) {
      out.push(cursor);
      const next = tasks.get(cursor);
      cursor = next ? current(next).parent_task : undefined;
    }
    return out;
  };

  const proposeSubtask: Orchestrator['proposeSubtask'] = async (parentTaskId, input) => {
    const parent = mustTask(parentTaskId);
    if (parent.taskState === 'completed' || parent.taskState === 'canceled' || parent.taskState === 'failed') {
      throw conflict(`task ${parentTaskId} is ${parent.taskState}; it cannot delegate any more work`);
    }
    if (input.id === parentTaskId) throw new RelayError(400, `subtask ${input.id} cannot be its own parent (cycle)`);
    const existing = tasks.get(input.id);
    if (existing && current(existing).parent_task !== parentTaskId) {
      throw conflict(`task ${input.id} already exists and is not a subtask of ${parentTaskId}`);
    }
    const lineage = [parentTaskId, ...ancestorsOf(parent)];
    const cyclic = (input.dependencies ?? []).filter((d) => lineage.includes(d));
    if (cyclic.length > 0) {
      throw new RelayError(400, `subtask ${input.id} cannot depend on ${cyclic.join(', ')}: that is its parent chain (dependency cycle)`);
    }
    const parentContract = current(parent);
    // The parent keeps working in its own worktree while the child runs: their allowed_paths must be disjoint.
    // Reuse the `overlapping_scope` rule against the parent alone and promote it to an error.
    const candidate = TaskContract.parse({ ...input, mission_id: parent.missionId, version: 1, sender: agentActor(parent), parent_task: parentTaskId });
    const overlaps = lintContract(candidate, { siblings: [parentContract], repoRoot: deps.repoRoot, fileExists: (rel) => fs.existsSync(path.resolve(deps.repoRoot, rel)) })
      .filter((r) => r.rule === 'overlapping_scope')
      .map((r) => `${r.rule}: ${r.message} (a subtask's scope must be disjoint from its parent's)`);
    if (overlaps.length > 0) return { status: 'lint_error', task_id: input.id, errors: overlaps, warnings: [] };
    return propose(parent.missionId, input, agentActor(parent), parentTaskId);
  };

  const revise = async (rec: TaskRecord, next: TaskContract, actor: Sender): Promise<number> => {
    const previous = current(rec).version;
    rec.versions.push(next);
    rec.handoffState = 'proposed';
    rec.openQuestions = [];
    emitTask(rec, actor, 'contract_revised', { contract: next, previous_version: previous });
    runLint(rec);
    await track(maybeSpawn(rec.id)).catch((e) => reportSpawnFailure(rec.id, e));
    await relintSiblings(rec);
    return next.version;
  };

  const reviseTask: Orchestrator['reviseTask'] = async (taskId, patch, actor) => {
    const rec = mustTask(taskId);
    if (rec.taskState === 'completed' || rec.taskState === 'canceled') {
      throw conflict(`task ${taskId} is ${rec.taskState}; a verified or canceled contract is immutable`);
    }
    const base = current(rec);
    // Only keys explicitly present in the patch change; undefined never overwrites.
    const provided = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = TaskContract.parse({ ...base, ...provided, id: base.id, mission_id: base.mission_id, version: base.version + 1, clarifications: base.clarifications });
    return { contract_version: await revise(rec, next, actor) };
  };

  const clarify: Orchestrator['clarify'] = async (taskId, answers, answeredBy) => {
    const rec = mustTask(taskId);
    if (rec.taskState === 'canceled') throw conflict(`task ${taskId} is canceled`);
    const at = clock();
    const clarifications: Clarification[] = answers.map((a) => ({ question_id: a.question_id, answer: a.answer, answered_by: answeredBy, at }));
    emitTask(rec, answeredBy, 'clarification_answered', { answers: clarifications });
    const base = current(rec);
    const questionText = (id: string) => rec.openQuestions.find((q) => q.id === id)?.text ?? rec.response?.questions.find((q) => q.id === id)?.text ?? id;
    const next: TaskContract = {
      ...base,
      version: base.version + 1,
      clarifications: [...base.clarifications, ...clarifications],
      constraints: [...base.constraints, ...answers.map((a) => `${questionText(a.question_id)}: ${a.answer}`)],
    };
    return { contract_version: await revise(rec, next, answeredBy) };
  };

  // ---------- recipient side ----------
  const touch = (rec: TaskRecord): void => {
    rec.lastSeenAt = clock();
    if (rec.taskState === 'canceled' || rec.taskState === 'completed') return;
    if (rec.blocker) {
      rec.blocker = undefined;
      emitTask(rec, agentActor(rec), 'task_unblocked', {});
    }
    if (rec.runtimeState !== 'done') rec.runtimeState = 'working';
  };
  const ackRepair = (rec: TaskRecord): void => {
    if (!rec.repairAckPending || !rec.activeRepair) return;
    rec.repairAckPending = false;
    rec.taskState = 'repairing';
    rec.runtimeState = 'working';
    emitTask(rec, agentActor(rec), 'repair_accepted', { repair_id: rec.activeRepair.id });
  };

  const getContract: Orchestrator['getContract'] = (taskId) => {
    const rec = mustTask(taskId);
    touch(rec);
    ackRepair(rec);
    return {
      contract: current(rec),
      worktree: rec.worktree ? { path: rec.worktree.path, branch: rec.worktree.branch } : undefined,
      active_repair: rec.activeRepair,
    };
  };

  const respond: Orchestrator['respond'] = (taskId, input) => {
    const rec = mustTask(taskId);
    touch(rec);
    const contract = current(rec);
    const errors: string[] = [];
    const stale = versionMismatch(rec, input.contract_version);
    if (stale) errors.push(stale);
    if (rec.taskState === 'canceled') errors.push('task is canceled');
    if (rec.handoffState !== 'proposed') errors.push(`contract v${contract.version} already has a response (${rec.handoffState})`);
    if (input.decision === 'accepted' && !rec.worktree) errors.push('task has no worktree yet (not spawned)');
    errors.push(...responseShapeErrors(contract, input));
    if (errors.length > 0) return { status: 'invalid', errors };
    const response: ContractResponse = { ...input, task_id: taskId };
    rec.response = response;
    const actor = agentActor(rec);
    if (input.decision === 'accepted') {
      rec.handoffState = 'accepted';
      rec.taskState = 'executing';
      rec.acceptedAt = clock();
      rec.startedAt = rec.acceptedAt;
      emitTask(rec, actor, 'task_accepted', { contract_version: contract.version, response });
      emitTask(rec, actor, 'work_started', {});
      return { status: 'work_started', worktree: { path: rec.worktree!.path, branch: rec.worktree!.branch } };
    }
    if (input.decision === 'needs_clarification') {
      rec.handoffState = 'needs_clarification';
      rec.openQuestions = [...input.questions];
      emitTask(rec, actor, 'clarification_requested', { contract_version: contract.version, response });
      return { status: 'waiting', open_questions: input.questions.length };
    }
    rec.handoffState = 'rejected';
    emitTask(rec, actor, 'task_rejected', { contract_version: contract.version, response });
    return { status: 'rejected' };
  };

  const clampTimeout = (s: number) => Math.min(Math.max(1, s), AWAIT_TIMEOUT_MAX_S) * 1000;

  const awaitContract: Orchestrator['awaitContract'] = async (taskId, sinceVersion, timeoutS, signal) => {
    const rec = mustTask(taskId);
    const deadline = Date.now() + clampTimeout(timeoutS);
    for (;;) {
      if (rec.taskState === 'canceled') return { status: 'canceled' };
      const c = current(rec);
      if (c.version > sinceVersion) return { status: 'revised', contract: c };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'pending' };
      if ((await waiters.wait(`task:${taskId}`, remaining, signal)) === 'aborted') return { status: 'pending' };
    }
  };

  const reportProgress: Orchestrator['reportProgress'] = (taskId, input) => {
    const rec = mustTask(taskId);
    touch(rec);
    ackRepair(rec);
    emitTask(rec, agentActor(rec), 'progress_reported', input);
  };

  const reportBlocker: Orchestrator['reportBlocker'] = (taskId, input) => {
    const rec = mustTask(taskId);
    touch(rec);
    rec.blocker = { reason: input.reason, waiting_on: input.waiting_on, since: clock() };
    rec.runtimeState = 'blocked';
    emitTask(rec, agentActor(rec), 'task_blocked', input);
  };

  const reply: Orchestrator['reply'] = (taskId, message, actor) => {
    const rec = mustTask(taskId);
    if (rec.taskState === 'canceled' || rec.taskState === 'completed') throw conflict(`task ${taskId} is ${rec.taskState}`);
    rec.replies.push({ message, replied_by: actor, at: clock() });
    emitTask(rec, actor, 'blocker_replied', { message }); // emit() wakes the task's waiters
    return { delivered: true, unread: rec.replies.length - rec.repliesRead };
  };

  const awaitReply: Orchestrator['awaitReply'] = async (taskId, timeoutS, signal) => {
    const rec = mustTask(taskId);
    const deadline = Date.now() + clampTimeout(timeoutS);
    for (;;) {
      if (rec.repliesRead < rec.replies.length) {
        const next = rec.replies[rec.repliesRead++]!;
        return { status: 'replied', message: next.message, replied_by: next.replied_by, at: next.at };
      }
      if (!rec.blocker || rec.taskState === 'canceled') return { status: 'none' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'pending' };
      if ((await waiters.wait(`task:${taskId}`, remaining, signal)) === 'aborted') return { status: 'pending' };
    }
  };

  /**
   * The view the check runner sees: a parent's `diff_scope` must accept the files its completed subtasks
   * produced (their branches were merged into the parent's worktree), so their allowed_paths are appended.
   */
  const viewForChecks = (rec: TaskRecord): TaskView => {
    const view = toView(rec);
    const inherited = [...tasks.values()]
      .filter((t) => current(t).parent_task === rec.id && t.taskState === 'completed')
      .flatMap((t) => current(t).scope.allowed_paths);
    if (inherited.length === 0) return view;
    return { ...view, contract: { ...view.contract, scope: { allowed_paths: [...view.contract.scope.allowed_paths, ...inherited] } } };
  };

  /**
   * Agent networking: a verified subtask's branch is merged into its parent's worktree so the parent can
   * consume the output without knowing git. The parent is told through the timeline (progress_reported by
   * relayd); a conflict becomes a blocker on the parent.
   */
  const landSubtaskInParent = async (child: TaskRecord): Promise<void> => {
    const parentId = current(child).parent_task;
    if (!parentId || !child.worktree) return;
    const parent = tasks.get(parentId);
    if (!parent?.worktree || parent.taskState === 'completed' || parent.taskState === 'canceled') return;
    try {
      const result = await deps.worktrees.mergeBranch(parent.worktree.path, child.worktree.branch);
      if (result.merged) {
        emitTask(parent, 'relayd', 'progress_reported', { message: `subtask ${child.id} verified; its branch ${child.worktree.branch} was merged into your worktree` });
      } else {
        parent.blocker = { reason: `subtask ${child.id} could not be merged into your worktree: conflicts in ${(result.conflict ?? []).join(', ')}`, waiting_on: 'human', since: clock() };
        parent.runtimeState = 'blocked';
        emitTask(parent, 'relayd', 'task_blocked', { reason: parent.blocker.reason, waiting_on: 'human' });
      }
    } catch (error) {
      log(`failed to merge subtask ${child.id} into ${parentId}: ${String(error)}`);
    }
  };

  // ---------- verification pipeline ----------
  const applyDecision = async (rec: TaskRecord, record: EvidenceRecord, decision: RepairDecision): Promise<void> => {
    const attempt = record.attempt;
    switch (decision.kind) {
      case 'verified': {
        rec.pendingRecord = undefined;
        rec.handoffState = 'verified';
        rec.taskState = 'completed';
        rec.completedAt = clock();
        rec.activeRepair = undefined;
        rec.verdicts.set(attempt, { status: 'verified' });
        emitTask(rec, 'relayd', 'task_verified', { attempt });
        if (rec.worktree) {
          // Freeze the verified state into the task branch; integration merges branches, not working trees.
          try {
            await deps.worktrees.commitAll(rec.worktree.path, `relay: verified evidence attempt ${attempt} for ${rec.id}`);
          } catch (error) {
            log(`failed to commit verified worktree for ${rec.id}: ${String(error)}`);
          }
        }
        emitTask(rec, 'relayd', 'task_completed', {});
        await landSubtaskInParent(rec);
        await spawnDependants(rec.id, rec.missionId);
        await maybeIntegrate(rec.missionId);
        return;
      }
      case 'repair': {
        rec.pendingRecord = undefined;
        rec.handoffState = 'retry_requested';
        rec.repairs.push(decision.repair);
        rec.activeRepair = decision.repair;
        rec.repairAckPending = true;
        rec.verdicts.set(attempt, { status: 'repair', repair: decision.repair });
        emitTask(rec, 'relayd', 'repair_requested', { repair: decision.repair });
        return;
      }
      case 'pending_human':
        rec.pendingRecord = record;
        return;
      case 'escalate': {
        rec.pendingRecord = undefined;
        rec.escalated = true;
        rec.failureReason = decision.reason;
        rec.verdicts.set(attempt, { status: 'escalated', reason: decision.reason });
        emitTask(rec, 'relayd', 'task_escalated', { reason: decision.reason, failed_criteria: decision.failed_criteria });
        return;
      }
      case 'failed_budget': {
        rec.pendingRecord = undefined;
        rec.taskState = 'failed';
        rec.failureReason = decision.reason;
        rec.verdicts.set(attempt, { status: 'failed_budget', reason: decision.reason });
        emitTask(rec, 'relayd', 'task_failed_budget', { attempts: attempt, reason: decision.reason });
        return;
      }
    }
  };

  const attemptSettled = (rec: TaskRecord, attempt: number): boolean =>
    rec.attempts.some((a) => a.attempt === attempt) || rec.verdicts.has(attempt) || rec.taskState === 'canceled';

  const runChecks = async (rec: TaskRecord, submission: EvidenceSubmission): Promise<void> => {
    // Let the tool call return before any check event is produced, even with synchronous runners.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (attemptSettled(rec, submission.attempt)) return;
    const evidenceDir = path.join(deps.relayDir, 'evidence', rec.id);
    let record: EvidenceRecord;
    try {
      record = await deps.checks.run(viewForChecks(rec), submission, rec.worktree!, evidenceDir);
    } catch (err) {
      const reason = `check runner failed: ${(err as Error)?.message ?? String(err)}`;
      rec.escalated = true;
      rec.failureReason = reason;
      rec.verdicts.set(submission.attempt, { status: 'escalated', reason });
      emitTask(rec, 'relayd', 'task_escalated', { reason, failed_criteria: [] });
      return;
    }
    if (attemptSettled(rec, submission.attempt)) return; // decided elsewhere while the runner was busy (cancel, review)
    rec.attempts.push(record);
    emitTask(rec, 'relayd', 'evidence_recorded', { record });
    await applyDecision(rec, record, deps.repair.decide(toView(rec), record));
  };

  /** PRD §9 step 1: `evidence_submitted` triggers `checks_started` — once per attempt — then the runner. */
  const startChecks = (rec: TaskRecord, submission: EvidenceSubmission): void => {
    if (!rec.checksStarted.has(submission.attempt)) {
      rec.checksStarted.add(submission.attempt);
      emitTask(rec, 'relayd', 'checks_started', { attempt: submission.attempt });
    }
    track(runChecks(rec, submission));
  };

  /** The worktree of an interrupted attempt is gone: nothing can be checked, so every criterion fails on record. */
  const recordMissingWorktree = async (rec: TaskRecord, submission: EvidenceSubmission): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (attemptSettled(rec, submission.attempt)) return;
    const observed = 'worktree missing after restart';
    const checks: EvidenceRecord['checks'] = {};
    for (const ac of current(rec).acceptance_criteria) checks[ac.id] = { status: 'failed', observed };
    const record: EvidenceRecord = {
      task_id: rec.id, contract_version: submission.contract_version, attempt: submission.attempt, changed_files: [], checks,
      self_report_mismatch: Object.keys(checks).filter((id) => submission.claimed[id]?.status === 'passed'),
    };
    rec.attempts.push(record);
    emitTask(rec, 'relayd', 'evidence_recorded', { record });
    await applyDecision(rec, record, deps.repair.decide(toView(rec), record));
  };

  const resumeChecks: Orchestrator['resumeChecks'] = () => {
    const resumed: Array<{ task_id: string; attempt: number }> = [];
    for (const rec of tasks.values()) {
      if (TERMINAL.has(rec.taskState)) continue;
      const submission = rec.submissions.at(-1);
      if (!submission || attemptSettled(rec, submission.attempt)) continue;
      resumed.push({ task_id: rec.id, attempt: submission.attempt });
      if (!rec.worktree || !worktreeExists(rec.worktree)) {
        log(`resuming checks for ${rec.id} attempt ${submission.attempt}: worktree missing, recording the attempt as failed`);
        track(recordMissingWorktree(rec, submission));
        continue;
      }
      log(`resuming checks for ${rec.id} attempt ${submission.attempt} (interrupted by the previous daemon)`);
      startChecks(rec, submission);
    }
    return resumed;
  };

  const submitEvidence: Orchestrator['submitEvidence'] = (taskId, input) => {
    const rec = mustTask(taskId);
    // Guards come before `touch` so a refused submission changes nothing: no heartbeat, no unblock event.
    const stale = versionMismatch(rec, input.contract_version);
    if (stale) throw conflict(stale);
    if (rec.taskState === 'canceled' || rec.taskState === 'completed' || rec.taskState === 'failed') {
      throw conflict(`task ${taskId} is ${rec.taskState}`);
    }
    if (!rec.worktree) throw conflict(`task ${taskId} has no worktree (not spawned)`);
    touch(rec);
    const attempt = rec.attempt + 1;
    rec.attempt = attempt;
    const submission: EvidenceSubmission = { task_id: taskId, contract_version: input.contract_version, attempt, claimed: input.claimed, summary: input.summary };
    rec.submissions.push(submission);
    rec.activeRepair = undefined;
    rec.repairAckPending = false;
    rec.pendingRecord = undefined;
    rec.handoffState = 'evidence_submitted';
    rec.taskState = 'awaiting_verification';
    rec.runtimeState = 'done';
    const actor = agentActor(rec);
    emitTask(rec, actor, 'evidence_submitted', { submission });
    startChecks(rec, submission);
    return { attempt, checks_started: true };
  };

  const pendingCriteria = (rec: TaskRecord, attempt: number): string[] => {
    const record = rec.attempts.find((a) => a.attempt === attempt);
    if (record) return Object.entries(record.checks).filter(([, r]) => r.status === 'pending_human').map(([id]) => id);
    return current(rec).acceptance_criteria.map((ac) => ac.id);
  };

  const awaitVerdict: Orchestrator['awaitVerdict'] = async (taskId, attempt, timeoutS, signal) => {
    const rec = mustTask(taskId);
    const deadline = Date.now() + clampTimeout(timeoutS);
    for (;;) {
      const v = rec.verdicts.get(attempt);
      if (v) return v;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'pending', pending_criteria: pendingCriteria(rec, attempt) };
      if ((await waiters.wait(`task:${taskId}`, remaining, signal)) === 'aborted') {
        return { status: 'pending', pending_criteria: pendingCriteria(rec, attempt) };
      }
    }
  };

  const awaitTask: Orchestrator['awaitTask'] = async (taskId, timeoutS, signal, callerTaskId) => {
    const rec = mustTask(taskId);
    if (callerTaskId !== undefined) {
      if (callerTaskId === taskId) throw new RelayError(400, `task ${taskId} cannot await itself`);
      const caller = mustTask(callerTaskId);
      if (caller.missionId !== rec.missionId) throw new RelayError(400, `task ${taskId} belongs to another mission`);
    }
    const deadline = Date.now() + clampTimeout(timeoutS);
    for (;;) {
      switch (rec.taskState) {
        case 'completed':
          return { status: 'completed', task_id: taskId, ...(rec.worktree ? { branch: rec.worktree.branch } : {}) };
        case 'failed':
          return { status: 'failed', task_id: taskId, reason: rec.failureReason ?? 'task failed' };
        case 'canceled':
          return { status: 'canceled', task_id: taskId };
        default:
          break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (await waiters.wait(`task:${taskId}`, remaining, signal)) === 'aborted') {
        return { status: 'pending', task_id: taskId, task_state: rec.taskState, handoff_state: rec.handoffState };
      }
    }
  };

  const review: Orchestrator['review'] = async (taskId, body) => {
    const rec = mustTask(taskId);
    const record = rec.pendingRecord;
    if (!record) throw conflict(`task ${taskId} has no evidence awaiting human review`);
    if (!current(rec).acceptance_criteria.some((ac) => ac.id === body.criterion_id)) {
      throw new RelayError(400, `unknown criterion ${body.criterion_id}`);
    }
    emitTask(rec, 'human', 'human_review_recorded', { attempt: record.attempt, criterion_id: body.criterion_id, status: body.status, observed_failure: body.observed_failure });
    record.checks[body.criterion_id] = { status: body.status, observed: body.observed_failure };
    const submission = rec.submissions.find((s) => s.attempt === record.attempt);
    if (body.status === 'failed' && submission?.claimed[body.criterion_id]?.status === 'passed' && !record.self_report_mismatch.includes(body.criterion_id)) {
      record.self_report_mismatch.push(body.criterion_id);
    }
    await applyDecision(rec, record, deps.repair.decide(toView(rec), record));
  };

  const cancel: Orchestrator['cancel'] = async (taskId, reason) => {
    const rec = mustTask(taskId);
    if (rec.taskState === 'canceled') return;
    rec.taskState = 'canceled';
    rec.pendingRecord = undefined;
    emitTask(rec, 'human', 'task_canceled', { reason });
    if (rec.paneId) {
      await deps.host.kill(rec.paneId);
      rec.runtimeState = 'exited';
    }
  };

  // ---------- integration ----------
  const topoOrder = (ids: string[]): string[] => {
    const set = new Set(ids);
    const order: string[] = [];
    const done = new Set<string>();
    const visit = (id: string, stack: Set<string>) => {
      if (done.has(id) || !set.has(id)) return;
      if (stack.has(id)) return; // cycle: keep whatever order we have
      stack.add(id);
      for (const d of current(tasks.get(id)!).dependencies) visit(d, stack);
      stack.delete(id);
      done.add(id);
      order.push(id);
    };
    for (const id of ids) visit(id, new Set());
    return order;
  };

  const maybeIntegrate = async (missionId: string): Promise<void> => {
    const m = missions.get(missionId);
    if (!m || m.integrationStarted || m.taskIds.length === 0) return;
    if (!m.taskIds.every((id) => tasks.get(id)?.taskState === 'completed')) return;
    m.integrationStarted = true;
    m.status = 'integrating';
    const order = topoOrder(m.taskIds);
    const branchOf = (id: string) => tasks.get(id)!.worktree?.branch ?? `relay/${id}`;
    emit({ mission_id: missionId, actor: 'relayd', type: 'integration_started', payload: { branch: INTEGRATION_BRANCH, order } });
    try {
      const res = await deps.worktrees.integrate(deps.repoRoot, order.map(branchOf));
      if (res.conflict) {
        const taskId = order.find((id) => branchOf(id) === res.conflict!.branch) ?? res.conflict.branch;
        emit({ mission_id: missionId, task_id: taskId, actor: 'relayd', type: 'integration_conflict', payload: { task_id: taskId, files: res.conflict.files } });
        m.status = 'failed';
        emit({ mission_id: missionId, actor: 'relayd', type: 'mission_failed', payload: { reason: `integration conflict in ${taskId}: ${res.conflict.files.join(', ')}` } });
        return;
      }
      const contract = TaskContract.parse({
        id: 't-integration', mission_id: missionId, version: 1, sender: 'relayd', recipient: 'integration', runtime: 'claude-code',
        goal: `Integration check for ${missionId}`,
        acceptance_criteria: [{ id: INTEGRATION_CRITERION, condition: 'integration check passes', check: { kind: 'command', run: m.mission.integration_check } }],
      });
      const view: TaskView = {
        id: contract.id, mission_id: missionId, contract, versions: [contract], open_questions: [], lint: [],
        runtime: 'unknown', task_state: 'awaiting_verification', handoff_state: 'evidence_submitted',
        blocked_on_dependencies: [], attempt: 1, attempts: [], repairs: [], escalated: false,
      };
      const worktree: WorktreeInfo = { path: path.join(deps.relayDir, 'wt', 'integration'), branch: res.branch, base: 'main' };
      const submission: EvidenceSubmission = { task_id: contract.id, contract_version: 1, attempt: 1, claimed: {}, summary: 'integration' };
      const record = await deps.checks.run(view, submission, worktree, path.join(deps.relayDir, 'evidence', 'integration'));
      const result = record.checks[INTEGRATION_CRITERION];
      if (result?.status === 'passed') {
        m.status = 'verified';
        emit({ mission_id: missionId, actor: 'relayd', type: 'mission_verified', payload: {} });
      } else {
        m.status = 'failed';
        emit({ mission_id: missionId, actor: 'relayd', type: 'mission_failed', payload: { reason: `integration check ${result?.status ?? 'missing'}: ${result?.observed ?? m.mission.integration_check}` } });
      }
    } catch (err) {
      m.status = 'failed';
      emit({ mission_id: missionId, actor: 'relayd', type: 'mission_failed', payload: { reason: `integration error: ${(err as Error)?.message ?? String(err)}` } });
    }
  };

  // ---------- missions ----------
  const createMission: Orchestrator['createMission'] = (body) => {
    const id = `m-${hex(3)}`;
    const mission = Mission.parse({ id, repo: body.repo, title: body.title, success_definition: body.success_definition, integration_check: body.integration_check });
    const plannerToken = issueToken(`mission:${id}`);
    missions.set(id, { mission, status: 'planning', taskIds: [], plannerToken, integrationStarted: false, openQuestions: [], clarifications: [] });
    emit({ mission_id: id, actor: 'human', type: 'mission_created', payload: mission });
    return { mission_id: id, planner_token: plannerToken };
  };

  const spawnPlanner: Orchestrator['spawnPlanner'] = async (missionId, runtime) => {
    const m = missions.get(missionId);
    if (!m) throw new RelayError(404, `mission ${missionId} not found`);
    if (m.plannerPaneId) throw new RelayError(409, `mission ${missionId} already has a planner in pane ${m.plannerPaneId}`);
    const rt = deps.runtimes[runtime];
    if (!rt) throw new RelayError(400, `no runtime registered for ${runtime}`);
    const sessionId = randomUUID();
    const configDir = agentConfigDir(deps.relayDir, plannerTaskId(missionId));
    const launch = await rt.prepare(
      { taskId: `planner-${missionId}`, token: m.plannerToken, mcpUrl: deps.mcpUrl, sessionId, cwd: deps.repoRoot, role: 'planner', contractSummary: plannerSummary(m) },
      configDir,
    );
    const { paneId } = await deps.host.spawn({ name: 'planner', cwd: deps.repoRoot, argv: launch.argv, env: launch.env, prompt: launch.prompt });
    m.plannerPaneId = paneId;
    m.plannerAgent = { runtime, sessionId, cwd: deps.repoRoot, paneId };
    emit({ mission_id: missionId, actor: 'relayd', type: 'agent_spawned', payload: { runtime, pane_id: paneId, session_id: sessionId, cwd: deps.repoRoot } });
    return { pane_id: paneId };
  };

  const plannerSummary = (m: MissionRecord): string => [
    m.mission.title,
    m.mission.success_definition ? `Success definition: ${m.mission.success_definition}` : '',
    `Repository: ${deps.repoRoot}`,
  ].filter(Boolean).join('\n');

  // ---------- daemon restart ----------

  const rehydrate: Orchestrator['rehydrate'] = (events) => {
    if (missions.size > 0 || tasks.size > 0) throw conflict('rehydrate requires an empty orchestrator');
    const state = replay(events);
    for (const [id, mv] of Object.entries(state.missions)) {
      const status: MissionStatus = mv.status === 'planning' && mv.task_ids.length > 0 ? 'executing' : mv.status;
      missions.set(id, {
        mission: mv.mission, status, taskIds: [...mv.task_ids], plannerToken: issueToken(`mission:${id}`),
        integrationStarted: mv.integration !== undefined || status === 'integrating' || status === 'verified' || status === 'failed',
        openQuestions: [...(mv.open_questions ?? [])], clarifications: [...(mv.clarifications ?? [])],
      });
    }
    for (const [id, v] of Object.entries(state.tasks)) {
      const replies = [...(v.replies ?? [])];
      tasks.set(id, {
        id, missionId: v.mission_id, versions: [...v.versions], lint: [...v.lint], response: v.response, openQuestions: [...v.open_questions],
        taskState: v.task_state, handoffState: v.handoff_state, runtimeState: v.runtime,
        spawned: v.agent !== undefined, spawning: false, token: issueToken(id),
        paneId: v.agent?.pane_id, sessionId: v.agent?.session_id, blocker: v.blocker,
        replies,
        // Replies sent while the current blocker is open were possibly never read (the agent may have been
        // mid-await_reply); re-delivering one is cheaper than losing it. Everything older counts as read.
        repliesRead: v.blocker ? replies.filter((r) => r.at < v.blocker!.since).length : replies.length,
        attempt: v.attempt, attempts: v.attempts.map((a) => ({ ...a, checks: { ...a.checks }, self_report_mismatch: [...a.self_report_mismatch] })),
        submissions: [], checksStarted: new Set(), verdicts: new Map(), repairs: [...v.repairs], activeRepair: v.active_repair, repairAckPending: false, escalated: v.escalated,
        proposedAt: v.proposed_at, acceptedAt: v.accepted_at, startedAt: v.started_at, lastSeenAt: v.last_seen_at, completedAt: v.completed_at,
      });
    }
    // Detail walk: what the derived state does not carry.
    for (const ev of events) {
      if (ev.type === 'agent_spawned' && ev.task_id === undefined) {
        const m = missions.get(ev.mission_id);
        if (m) {
          m.plannerPaneId = ev.payload.pane_id;
          m.plannerAgent = { runtime: ev.payload.runtime, sessionId: ev.payload.session_id, cwd: ev.payload.cwd, paneId: ev.payload.pane_id };
        }
        continue;
      }
      if (ev.type === 'agent_exited' && ev.task_id === undefined) {
        const m = missions.get(ev.mission_id);
        if (m?.plannerPaneId === ev.payload.pane_id) m.plannerPaneId = undefined;
        continue;
      }
      const rec = ev.task_id !== undefined ? tasks.get(ev.task_id) : undefined;
      if (!rec) continue;
      switch (ev.type) {
        case 'worktree_created':
          rec.worktree = { path: ev.payload.path, branch: ev.payload.branch, base: ev.payload.base };
          break;
        case 'evidence_submitted':
          rec.submissions.push(ev.payload.submission);
          rec.repairAckPending = false;
          rec.pendingRecord = undefined;
          break;
        case 'checks_started':
          rec.checksStarted.add(ev.payload.attempt);
          break;
        case 'evidence_recorded': {
          const record = rec.attempts.find((a) => a.attempt === ev.payload.record.attempt);
          if (record && Object.values(record.checks).some((c) => c.status === 'pending_human')) rec.pendingRecord = record;
          break;
        }
        case 'human_review_recorded': {
          const record = rec.attempts.find((a) => a.attempt === ev.payload.attempt);
          if (!record) break;
          record.checks[ev.payload.criterion_id] = { status: ev.payload.status, observed: ev.payload.observed_failure };
          const submission = rec.submissions.find((sub) => sub.attempt === record.attempt);
          if (ev.payload.status === 'failed' && submission?.claimed[ev.payload.criterion_id]?.status === 'passed' && !record.self_report_mismatch.includes(ev.payload.criterion_id)) {
            record.self_report_mismatch.push(ev.payload.criterion_id);
          }
          break;
        }
        case 'task_verified':
          rec.verdicts.set(ev.payload.attempt, { status: 'verified' });
          rec.pendingRecord = undefined;
          break;
        case 'repair_requested':
          rec.verdicts.set(ev.payload.repair.attempt - 1, { status: 'repair', repair: ev.payload.repair });
          rec.repairAckPending = true;
          rec.pendingRecord = undefined;
          break;
        case 'repair_accepted':
          rec.repairAckPending = false;
          break;
        case 'task_escalated':
          rec.verdicts.set(rec.submissions.at(-1)?.attempt ?? rec.attempt, { status: 'escalated', reason: ev.payload.reason });
          rec.pendingRecord = undefined;
          break;
        case 'task_failed_budget':
          rec.verdicts.set(ev.payload.attempts, { status: 'failed_budget', reason: ev.payload.reason });
          rec.pendingRecord = undefined;
          break;
        case 'task_canceled':
          rec.pendingRecord = undefined;
          break;
        default:
          break;
      }
    }
    return { missions: missions.size, tasks: tasks.size };
  };

  const respawnPlanner = async (missionId: string, prompt: string | undefined): Promise<{ pane_id: string }> => {
    const m = mustMission(missionId);
    const agent = m.plannerAgent;
    if (!agent) throw conflict(`mission ${missionId} has no planner session to resume`);
    const rt = deps.runtimes[agent.runtime];
    if (!rt?.resume) throw new Error(`runtime ${agent.runtime} cannot resume sessions`);
    emit({ mission_id: missionId, actor: 'relayd', type: 'agent_exited', payload: { pane_id: agent.paneId, exit_reason: 'daemon restart' } });
    m.plannerPaneId = undefined;
    const launch = await rt.resume(
      { taskId: `planner-${missionId}`, token: m.plannerToken, mcpUrl: deps.mcpUrl, sessionId: agent.sessionId, cwd: agent.cwd, role: 'planner', contractSummary: plannerSummary(m) },
      agentConfigDir(deps.relayDir, plannerTaskId(missionId)),
    );
    const { paneId } = await deps.host.spawn({ name: 'planner', cwd: agent.cwd, argv: launch.argv, env: launch.env, prompt: prompt ?? launch.prompt });
    m.plannerPaneId = paneId;
    agent.paneId = paneId;
    emit({ mission_id: missionId, actor: 'relayd', type: 'agent_spawned', payload: { runtime: agent.runtime, pane_id: paneId, session_id: agent.sessionId, cwd: agent.cwd } });
    return { pane_id: paneId };
  };

  const respawn: Orchestrator['respawn'] = async (taskId, opts = {}) => {
    if (isPlannerTaskId(taskId)) return respawnPlanner(taskId.slice('planner:'.length), opts.prompt);
    const rec = mustTask(taskId);
    if (TERMINAL.has(rec.taskState)) throw conflict(`task ${taskId} is ${rec.taskState}; nothing to resume`);
    if (!rec.sessionId || !rec.paneId || !rec.worktree) throw conflict(`task ${taskId} has no agent session to resume`);
    const contract = current(rec);
    const runtime = deps.runtimes[contract.runtime];
    if (!runtime?.resume) throw new Error(`runtime ${contract.runtime} cannot resume sessions`);
    // The old pane died with the previous daemon; say so before trying to bring the agent back.
    emitTask(rec, 'relayd', 'agent_exited', { pane_id: rec.paneId, exit_reason: 'daemon restart' });
    rec.runtimeState = 'exited';
    try {
      const token = rec.token ?? issueToken(taskId);
      rec.token = token;
      const launch = await runtime.resume(
        { taskId, token, mcpUrl: deps.mcpUrl, sessionId: rec.sessionId, cwd: rec.worktree.path, role: 'recipient', contractSummary: contract.goal },
        agentConfigDir(deps.relayDir, taskId),
      );
      const { paneId } = await deps.host.spawn({ name: contract.recipient, cwd: rec.worktree.path, argv: launch.argv, env: launch.env, prompt: opts.prompt ?? launch.prompt, taskId: contract.id });
      rec.paneId = paneId;
      rec.spawned = true;
      rec.runtimeState = 'idle';
      emitTask(rec, 'relayd', 'agent_spawned', { runtime: contract.runtime, pane_id: paneId, session_id: rec.sessionId, cwd: rec.worktree.path });
      return { pane_id: paneId };
    } catch (error) {
      const reason = `resume failed: ${error instanceof Error ? error.message : String(error)}`;
      rec.blocker = { reason, since: clock() };
      rec.runtimeState = 'blocked';
      emitTask(rec, 'relayd', 'task_blocked', { reason });
      throw error;
    }
  };

  const askHuman: Orchestrator['askHuman'] = (missionId, questions) => {
    const m = missions.get(missionId);
    if (!m) throw new RelayError(404, `mission ${missionId} not found`);
    m.openQuestions = questions.map((q) => ({ ...q }));
    emit({ mission_id: missionId, actor: 'planner', type: 'mission_clarification_requested', payload: { questions: m.openQuestions } });
    return { status: 'waiting', open_questions: m.openQuestions.length };
  };

  const clarifyMission: Orchestrator['clarifyMission'] = (missionId, answers, answeredBy) => {
    const m = missions.get(missionId);
    if (!m) throw new RelayError(404, `mission ${missionId} not found`);
    const open = new Set(m.openQuestions.map((q) => q.id));
    const unknown = answers.filter((a) => !open.has(a.question_id)).map((a) => a.question_id);
    if (unknown.length > 0) throw new RelayError(400, `no open mission question ${unknown.join(', ')} (open: ${[...open].join(', ') || 'none'})`);
    const at = clock();
    const recorded: Clarification[] = answers.map((a) => ({ question_id: a.question_id, answer: a.answer, answered_by: answeredBy, at }));
    m.clarifications.push(...recorded);
    const answered = new Set(recorded.map((a) => a.question_id));
    m.openQuestions = m.openQuestions.filter((q) => !answered.has(q.id));
    emit({ mission_id: missionId, actor: answeredBy, type: 'mission_clarification_answered', payload: { answers: recorded } });
    waiters.notify(`mission:${missionId}`);
    return { answered: recorded.length, open_questions: m.openQuestions.length };
  };

  const awaitAnswers: Orchestrator['awaitAnswers'] = async (missionId, timeoutS, signal) => {
    const m = missions.get(missionId);
    if (!m) throw new RelayError(404, `mission ${missionId} not found`);
    const deadline = Date.now() + clampTimeout(timeoutS);
    const seen = m.clarifications.length;
    for (;;) {
      if (m.openQuestions.length === 0) {
        const fresh = m.clarifications.slice(seen);
        return fresh.length > 0 || seen > 0 ? { status: 'answered', answers: m.clarifications } : { status: 'none' };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'pending', open_questions: [...m.openQuestions] };
      if ((await waiters.wait(`mission:${missionId}`, remaining, signal)) === 'aborted') return { status: 'pending', open_questions: [...m.openQuestions] };
    }
  };

  return {
    createMission,
    spawnPlanner,
    askHuman,
    awaitAnswers,
    clarifyMission,
    getMission: (id) => {
      const m = missions.get(id);
      return m ? { mission: m.mission, status: m.status, task_ids: [...m.taskIds], open_questions: [...m.openQuestions], clarifications: [...m.clarifications] } : undefined;
    },
    listTasks: (missionId) => [...tasks.values()].filter((t) => !missionId || t.missionId === missionId).map(summarize),
    taskView: (id) => {
      const rec = tasks.get(id);
      return rec ? toView(rec) : undefined;
    },
    proposeTask, proposeSubtask, awaitTask, reviseTask, clarify, review, cancel,
    getContract, respond, awaitContract, reportProgress, reportBlocker, reply, awaitReply, submitEvidence, awaitVerdict,
    rehydrate, resumeChecks, respawn,
    issueToken,
    resolveToken: (token) => tokens.get(token),
    tokenFor: (taskId) => tasks.get(taskId)?.token,
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
