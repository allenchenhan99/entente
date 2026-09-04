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
  SubmitEvidenceOutput, GetContractOutput, AWAIT_TIMEOUT_MAX_S, hasLintErrors,
} from '@relay/protocol';
import type {
  TaskContractInput, ContractResponse, Clarification, EvidenceSubmission, EvidenceRecord, RepairContract,
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
type RespondInputT = z.infer<typeof RespondInput>;
type SubmitEvidenceInputT = z.infer<typeof SubmitEvidenceInput>;
type ReportProgressInputT = z.infer<typeof ReportProgressInput>;
type ReportBlockerInputT = z.infer<typeof ReportBlockerInput>;

export type Sender = 'planner' | 'human';
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
  verdicts: Map<number, AwaitVerdictOutput>;
  pendingRecord?: EvidenceRecord;
  repairs: RepairContract[];
  activeRepair?: RepairContract;
  repairAckPending: boolean;
  escalated: boolean;
  proposedAt?: string;
  acceptedAt?: string;
  startedAt?: string;
  lastSeenAt?: string;
  completedAt?: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
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
      const { paneId } = await deps.host.spawn({ name: contract.recipient, cwd: worktree.path, argv: launch.argv, env: launch.env, prompt: launch.prompt });
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
  const proposeTask: Orchestrator['proposeTask'] = async (missionId, input, sender) => {
    const m = mustMission(missionId);
    const existing = tasks.get(input.id);
    if (existing && existing.missionId !== missionId) throw conflict(`task ${input.id} belongs to mission ${existing.missionId}`);
    const version = existing ? current(existing).version + 1 : 1;
    const contract = TaskContract.parse({ ...input, mission_id: missionId, version, sender, clarifications: existing ? current(existing).clarifications : [] });
    let rec = existing;
    if (!rec) {
      rec = {
        id: contract.id, missionId, versions: [], lint: [], openQuestions: [],
        taskState: 'proposed', handoffState: 'proposed', runtimeState: 'unspawned',
        spawned: false, spawning: false, attempt: 0, attempts: [], submissions: [], verdicts: new Map(),
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
    if (input.contract_version !== contract.version) errors.push(`contract_version ${input.contract_version} is not the current version ${contract.version}`);
    if (rec.taskState === 'canceled') errors.push('task is canceled');
    if (rec.handoffState !== 'proposed') errors.push(`contract v${contract.version} already has a response (${rec.handoffState})`);
    if (input.decision === 'accepted' && !rec.worktree) errors.push('task has no worktree yet (not spawned)');
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
        rec.verdicts.set(attempt, { status: 'escalated', reason: decision.reason });
        emitTask(rec, 'relayd', 'task_escalated', { reason: decision.reason, failed_criteria: decision.failed_criteria });
        return;
      }
      case 'failed_budget': {
        rec.pendingRecord = undefined;
        rec.taskState = 'failed';
        rec.verdicts.set(attempt, { status: 'failed_budget', reason: decision.reason });
        emitTask(rec, 'relayd', 'task_failed_budget', { attempts: attempt, reason: decision.reason });
        return;
      }
    }
  };

  const runChecks = async (rec: TaskRecord, submission: EvidenceSubmission): Promise<void> => {
    // Let the tool call return before any check event is produced, even with synchronous runners.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const evidenceDir = path.join(deps.relayDir, 'evidence', rec.id);
    let record: EvidenceRecord;
    try {
      record = await deps.checks.run(toView(rec), submission, rec.worktree!, evidenceDir);
    } catch (err) {
      const reason = `check runner failed: ${(err as Error)?.message ?? String(err)}`;
      rec.escalated = true;
      rec.verdicts.set(submission.attempt, { status: 'escalated', reason });
      emitTask(rec, 'relayd', 'task_escalated', { reason, failed_criteria: [] });
      return;
    }
    rec.attempts.push(record);
    emitTask(rec, 'relayd', 'evidence_recorded', { record });
    await applyDecision(rec, record, deps.repair.decide(toView(rec), record));
  };

  const submitEvidence: Orchestrator['submitEvidence'] = (taskId, input) => {
    const rec = mustTask(taskId);
    touch(rec);
    if (rec.taskState === 'canceled' || rec.taskState === 'completed' || rec.taskState === 'failed') {
      throw conflict(`task ${taskId} is ${rec.taskState}`);
    }
    if (!rec.worktree) throw conflict(`task ${taskId} has no worktree (not spawned)`);
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
    emitTask(rec, 'relayd', 'checks_started', { attempt });
    track(runChecks(rec, submission));
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
    const summary = [
      m.mission.title,
      m.mission.success_definition ? `Success definition: ${m.mission.success_definition}` : '',
      `Repository: ${deps.repoRoot}`,
    ].filter(Boolean).join('\n');
    const launch = await rt.prepare(
      { taskId: `planner-${missionId}`, token: m.plannerToken, mcpUrl: deps.mcpUrl, sessionId, cwd: deps.repoRoot, role: 'planner', contractSummary: summary },
      configDir,
    );
    const { paneId } = await deps.host.spawn({ name: 'planner', cwd: deps.repoRoot, argv: launch.argv, env: launch.env, prompt: launch.prompt });
    m.plannerPaneId = paneId;
    emit({ mission_id: missionId, actor: 'relayd', type: 'agent_spawned', payload: { runtime, pane_id: paneId, session_id: sessionId, cwd: deps.repoRoot } });
    return { pane_id: paneId };
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
    proposeTask, reviseTask, clarify, review, cancel,
    getContract, respond, awaitContract, reportProgress, reportBlocker, reply, awaitReply, submitEvidence, awaitVerdict,
    issueToken,
    resolveToken: (token) => tokens.get(token),
    tokenFor: (taskId) => tasks.get(taskId)?.token,
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
