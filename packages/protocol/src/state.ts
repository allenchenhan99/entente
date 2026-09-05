/**
 * Derived state. Three independent layers per task (PRD.md §7.1) plus mission-level view.
 * Everything here is produced by `reduce(state, event)` and never written directly.
 */
import { z } from 'zod';
import {
  Mission, MissionStatus, TaskContract, ContractResponse, EvidenceRecord, RepairContract, RuntimeKind, Question, Clarification,
} from './contract.js';
import { LintResult } from './lint.js';

export const RuntimeState = z.enum(['unspawned', 'idle', 'working', 'blocked', 'done', 'exited', 'unknown']);
export type RuntimeState = z.infer<typeof RuntimeState>;

export const TaskState = z.enum([
  'pending', 'proposed', 'accepted', 'executing', 'awaiting_verification', 'repairing', 'completed', 'failed', 'canceled',
]);
export type TaskState = z.infer<typeof TaskState>;

export const HandoffState = z.enum([
  'draft', 'proposed', 'needs_clarification', 'revised', 'accepted', 'rejected', 'evidence_submitted', 'retry_requested', 'verified',
]);
export type HandoffState = z.infer<typeof HandoffState>;

export const TaskView = z.object({
  id: z.string(),
  mission_id: z.string(),
  contract: TaskContract,
  versions: z.array(TaskContract),
  response: ContractResponse.optional(),
  open_questions: z.array(Question),
  lint: z.array(LintResult),

  runtime: RuntimeState,
  task_state: TaskState,
  handoff_state: HandoffState,

  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
  agent: z.object({ runtime: RuntimeKind, pane_id: z.string(), session_id: z.string() }).optional(),
  blocker: z.object({ reason: z.string(), waiting_on: z.string().optional(), since: z.string() }).optional(),
  /** Replies sent to this task's blockers, oldest first. */
  replies: z.array(z.object({ message: z.string(), replied_by: z.string(), at: z.string() })).optional(),
  /** Task ids this task waits on that are not yet completed. */
  blocked_on_dependencies: z.array(z.string()),

  attempt: z.number().int().min(0),
  attempts: z.array(EvidenceRecord),
  repairs: z.array(RepairContract),
  active_repair: RepairContract.optional(),
  escalated: z.boolean(),

  proposed_at: z.string().optional(),
  accepted_at: z.string().optional(),
  started_at: z.string().optional(),
  last_seen_at: z.string().optional(),
  completed_at: z.string().optional(),
});
export type TaskView = z.infer<typeof TaskView>;

export const MissionView = z.object({
  mission: Mission,
  status: MissionStatus,
  task_ids: z.array(z.string()),
  /** Mission-level questions the planner asked the human and that are still unanswered. */
  open_questions: z.array(Question).optional(),
  /** When the planner last asked, so the inbox can say how long the mission has been stopped here. */
  questions_asked_at: z.string().optional(),
  /** Mission-level answers given by the human, in order. */
  clarifications: z.array(Clarification).optional(),
  integration: z.object({ branch: z.string(), order: z.array(z.string()), conflict: z.object({ task_id: z.string(), files: z.array(z.string()) }).optional() }).optional(),
});
export type MissionView = z.infer<typeof MissionView>;

export const Metrics = z.object({
  contracts_blocked_before_execution: z.number().int(),
  fields_filled_via_clarification: z.number().int(),
  criteria_total: z.number().int(),
  criteria_with_machine_check: z.number().int(),
  self_report_mismatches: z.number().int(),
  tasks_not_rerun_on_repair: z.number().int(),
  repairs_total: z.number().int(),
});
export type Metrics = z.infer<typeof Metrics>;

export const State = z.object({
  last_seq: z.number().int().min(0),
  missions: z.record(z.string(), MissionView),
  tasks: z.record(z.string(), TaskView),
  metrics: Metrics,
});
export type State = z.infer<typeof State>;

export const initialState = (): State => ({
  last_seq: 0,
  missions: {},
  tasks: {},
  metrics: {
    contracts_blocked_before_execution: 0,
    fields_filled_via_clarification: 0,
    criteria_total: 0,
    criteria_with_machine_check: 0,
    self_report_mismatches: 0,
    tasks_not_rerun_on_repair: 0,
    repairs_total: 0,
  },
});
