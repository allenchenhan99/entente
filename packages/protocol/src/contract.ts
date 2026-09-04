/**
 * Core contract schemas — the frozen integration contract between relayd, the TUI,
 * agents (via MCP) and fixtures. See PRD.md §6.
 */
import { z } from 'zod';

export const RuntimeKind = z.enum(['claude-code', 'codex']);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

export const Check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), run: z.string().min(1), timeout_ms: z.number().int().positive().default(120_000) }),
  z.object({ kind: z.literal('diff_scope') }),
  z.object({ kind: z.literal('file_exists'), path: z.string().min(1) }),
  z.object({ kind: z.literal('human_review') }),
  z.object({ kind: z.literal('llm_judge'), prompt: z.string().optional() }),
]);
export type Check = z.infer<typeof Check>;

export const CriterionId = z.string().regex(/^AC-\d+$/, 'criterion id must look like AC-1');

export const AcceptanceCriterion = z.object({
  id: CriterionId,
  condition: z.string().min(1),
  /** Missing check ⇒ lint error `unverifiable_criterion`. */
  check: Check.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const Clarification = z.object({
  question_id: z.string(),
  answer: z.string(),
  answered_by: z.string(),
  at: z.string(),
});
export type Clarification = z.infer<typeof Clarification>;

export const Budget = z.object({
  max_repairs: z.number().int().min(0),
  stagnation_limit: z.number().int().min(1).default(2),
});
export type Budget = z.infer<typeof Budget>;

/**
 * A Task Contract as stored. Fields a planner may omit are defaulted so that lint,
 * not the schema, reports communication debt.
 */
export const TaskContract = z.object({
  id: z.string().regex(/^t-[a-z0-9-]+$/, 'task id must look like t-backend-auth'),
  mission_id: z.string(),
  version: z.number().int().min(1),
  sender: z.string(),
  recipient: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  runtime: RuntimeKind,
  goal: z.string().default(''),
  inputs: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  scope: z.object({ allowed_paths: z.array(z.string()).default([]) }).default({ allowed_paths: [] }),
  acceptance_criteria: z.array(AcceptanceCriterion).default([]),
  output: z
    .object({
      type: z.enum(['code_change']).default('code_change'),
      evidence_required: z.array(z.enum(['git_diff', 'changed_files', 'check_outputs'])).default([]),
    })
    .default({ type: 'code_change', evidence_required: [] }),
  dependencies: z.array(z.string()).default([]),
  budget: Budget.optional(),
  clarifications: z.array(Clarification).default([]),
});
export type TaskContract = z.infer<typeof TaskContract>;

/** What a planner submits via `relay_propose_task`: everything except bookkeeping fields. */
export const TaskContractInput = TaskContract.omit({ mission_id: true, version: true, sender: true, clarifications: true });
export type TaskContractInput = z.infer<typeof TaskContractInput>;

export const Question = z.object({
  id: z.string().regex(/^Q\d+$/),
  text: z.string().min(1),
  blocking: z.boolean().default(true),
});
export type Question = z.infer<typeof Question>;

export const ContractResponse = z.object({
  task_id: z.string(),
  contract_version: z.number().int().min(1),
  decision: z.enum(['accepted', 'needs_clarification', 'rejected']),
  interpretation: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  /** criterion id → how the agent intends to prove it. Required when accepted. */
  verification_plan: z.record(z.string(), z.string()).default({}),
  questions: z.array(Question).default([]),
  reason: z.string().optional(),
});
export type ContractResponse = z.infer<typeof ContractResponse>;

export const ClaimedStatus = z.enum(['passed', 'failed', 'skipped']);

export const EvidenceSubmission = z.object({
  task_id: z.string(),
  contract_version: z.number().int().min(1),
  attempt: z.number().int().min(1),
  claimed: z.record(CriterionId, z.object({ status: ClaimedStatus, note: z.string().optional() })),
  summary: z.string().default(''),
});
export type EvidenceSubmission = z.infer<typeof EvidenceSubmission>;

export const CheckResult = z.object({
  status: z.enum(['passed', 'failed', 'pending_human', 'error']),
  output_path: z.string().optional(),
  observed: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** Produced by relayd after running checks on an evidence submission. */
export const EvidenceRecord = z.object({
  task_id: z.string(),
  contract_version: z.number().int().min(1),
  attempt: z.number().int().min(1),
  git_diff_path: z.string().optional(),
  changed_files: z.array(z.string()).default([]),
  checks: z.record(CriterionId, CheckResult),
  self_report_mismatch: z.array(CriterionId).default([]),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const RepairContract = z.object({
  id: z.string(),
  parent_task: z.string(),
  parent_version: z.number().int().min(1),
  attempt: z.number().int().min(2),
  failed_criteria: z.array(CriterionId).min(1),
  observed_failure: z.string(),
  requested_correction: z.string(),
  unchanged_scope: z.array(z.string()).default([]),
  remaining_repairs: z.number().int().min(0),
});
export type RepairContract = z.infer<typeof RepairContract>;

export const MissionStatus = z.enum(['planning', 'executing', 'integrating', 'verified', 'failed', 'canceled']);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const Mission = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string().min(1),
  success_definition: z.string().default(''),
  integration_check: z.string().default('npx vitest run'),
  budget: z.object({ max_repairs_per_task: z.number().int().min(0).default(3) }).default({ max_repairs_per_task: 3 }),
});
export type Mission = z.infer<typeof Mission>;
