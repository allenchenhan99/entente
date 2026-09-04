/**
 * Append-only event log schema. All state is derived by `reduce(events)`. See PRD.md §6.6.
 */
import { z } from 'zod';
import {
  Mission, TaskContract, ContractResponse, Question, Clarification,
  EvidenceSubmission, EvidenceRecord, CheckResult, RepairContract, CriterionId, RuntimeKind,
} from './contract.js';
import { LintResult } from './lint.js';

export const Actor = z.string().regex(/^(human|planner|relayd|agent:[a-z][a-z0-9_-]{0,31})$/);
export type Actor = z.infer<typeof Actor>;

const base = {
  seq: z.number().int().min(1),
  ts: z.string(),
  mission_id: z.string(),
  task_id: z.string().optional(),
  actor: Actor,
};

const ev = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ ...base, type: z.literal(type), payload });

export const EventSchemas = [
  ev('mission_created', Mission),
  ev('mission_clarification_requested', z.object({ questions: z.array(Question).min(1) })),
  ev('mission_clarification_answered', z.object({ answers: z.array(Clarification).min(1) })),
  ev('tasks_planned', z.object({ task_ids: z.array(z.string()) })),
  ev('lint_reported', z.object({ contract_version: z.number().int(), results: z.array(LintResult) })),

  ev('task_proposed', z.object({ contract: TaskContract })),
  ev('clarification_requested', z.object({ contract_version: z.number().int(), response: ContractResponse })),
  ev('clarification_answered', z.object({ answers: z.array(Clarification) })),
  ev('contract_revised', z.object({ contract: TaskContract, previous_version: z.number().int() })),
  ev('task_accepted', z.object({ contract_version: z.number().int(), response: ContractResponse })),
  ev('task_rejected', z.object({ contract_version: z.number().int(), response: ContractResponse })),

  ev('worktree_created', z.object({ path: z.string(), branch: z.string(), base: z.string() })),
  ev('agent_spawned', z.object({ runtime: RuntimeKind, pane_id: z.string(), session_id: z.string(), cwd: z.string() })),
  ev('agent_exited', z.object({ pane_id: z.string(), exit_reason: z.string().optional() })),

  ev('work_started', z.object({})),
  ev('progress_reported', z.object({ message: z.string(), percent: z.number().min(0).max(100).optional() })),
  ev('task_blocked', z.object({ reason: z.string(), waiting_on: z.string().optional() })),
  ev('task_unblocked', z.object({})),
  /** Human (or planner) → blocked agent: a free-text reply delivered through `relay_await_reply`. */
  ev('blocker_replied', z.object({ message: z.string().min(1) })),

  ev('evidence_submitted', z.object({ submission: EvidenceSubmission })),
  ev('checks_started', z.object({ attempt: z.number().int() })),
  ev('check_passed', z.object({ attempt: z.number().int(), criterion_id: CriterionId, result: CheckResult })),
  ev('check_failed', z.object({ attempt: z.number().int(), criterion_id: CriterionId, result: CheckResult })),
  ev('human_review_recorded', z.object({ attempt: z.number().int(), criterion_id: CriterionId, status: z.enum(['passed', 'failed']), observed_failure: z.string().optional() })),
  ev('evidence_recorded', z.object({ record: EvidenceRecord })),

  ev('repair_requested', z.object({ repair: RepairContract })),
  ev('repair_accepted', z.object({ repair_id: z.string() })),
  ev('task_verified', z.object({ attempt: z.number().int() })),
  ev('task_completed', z.object({})),
  ev('task_failed_budget', z.object({ attempts: z.number().int(), reason: z.string() })),
  ev('task_escalated', z.object({ reason: z.string(), failed_criteria: z.array(CriterionId) })),
  ev('task_canceled', z.object({ reason: z.string().optional() })),

  ev('integration_started', z.object({ branch: z.string(), order: z.array(z.string()) })),
  ev('integration_conflict', z.object({ task_id: z.string(), files: z.array(z.string()) })),
  ev('mission_verified', z.object({})),
  ev('mission_failed', z.object({ reason: z.string() })),
] as const;

export const Event = z.discriminatedUnion('type', [...EventSchemas]);
export type Event = z.infer<typeof Event>;
export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** Input to `EventStore.append`: relayd assigns `seq` and `ts`. */
export type EventInput = Event extends infer E ? (E extends unknown ? Omit<E, 'seq' | 'ts'> : never) : never;

export const EVENT_TYPES = EventSchemas.map((s) => s.shape.type.value) as readonly EventType[];

/** Re-exported so `Question` stays reachable from the events module for consumers. */
export type { Question };
