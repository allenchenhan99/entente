/**
 * MCP tool contract between relayd and agents. See PRD.md §8.
 * relayd identifies the caller by `Authorization: Bearer <task_token>`; the planner uses the mission token.
 */
import { z } from 'zod';
import { TaskContract, TaskContractInput, ContractResponse, EvidenceSubmission, RepairContract, Question, Clarification, AcceptanceCriterion, Budget } from './contract.js';

export const RECIPIENT_TOOLS = {
  get_contract: 'relay_get_contract',
  respond_to_contract: 'relay_respond_to_contract',
  await_contract: 'relay_await_contract',
  report_progress: 'relay_report_progress',
  report_blocker: 'relay_report_blocker',
  submit_evidence: 'relay_submit_evidence',
  await_verdict: 'relay_await_verdict',
  await_reply: 'relay_await_reply',
  /** Agent networking: a recipient delegates part of its work as a new contract it is the sender of. */
  propose_subtask: 'relay_propose_subtask',
  /** Wait until another task (typically a subtask) reaches a terminal state. */
  await_task: 'relay_await_task',
} as const;

export const PLANNER_TOOLS = {
  get_mission: 'relay_get_mission',
  propose_task: 'relay_propose_task',
  list_tasks: 'relay_list_tasks',
  revise_task: 'relay_revise_task',
  answer_clarification: 'relay_answer_clarification',
  ask_human: 'relay_ask_human',
  await_answers: 'relay_await_answers',
} as const;

/** Max long-poll per call; agents re-call on `pending`. Keeps under MCP client timeouts. */
export const AWAIT_TIMEOUT_MAX_S = 60;

export const GetContractOutput = z.object({
  contract: TaskContract,
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
  active_repair: RepairContract.optional(),
});

export const RespondInput = ContractResponse.omit({ task_id: true });
export const RespondOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('work_started'), worktree: z.object({ path: z.string(), branch: z.string() }) }),
  z.object({ status: z.literal('waiting'), open_questions: z.number().int() }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('invalid'), errors: z.array(z.string()) }),
]);

export const AwaitContractInput = z.object({ since_version: z.number().int().min(1), timeout_s: z.number().int().min(1).max(AWAIT_TIMEOUT_MAX_S).default(30) });
export const AwaitContractOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('revised'), contract: TaskContract }),
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('canceled') }),
]);

export const ReportProgressInput = z.object({ message: z.string().min(1), percent: z.number().min(0).max(100).optional() });
export const ReportBlockerInput = z.object({ reason: z.string().min(1), waiting_on: z.string().optional() });
export const OkOutput = z.object({ ok: z.literal(true) });

export const SubmitEvidenceInput = EvidenceSubmission.omit({ task_id: true, attempt: true });
export const SubmitEvidenceOutput = z.object({ attempt: z.number().int(), checks_started: z.literal(true) });

export const AwaitVerdictInput = z.object({ attempt: z.number().int().min(1), timeout_s: z.number().int().min(1).max(AWAIT_TIMEOUT_MAX_S).default(30) });
export const AwaitVerdictOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified') }),
  z.object({ status: z.literal('repair'), repair: RepairContract }),
  z.object({ status: z.literal('pending'), pending_criteria: z.array(z.string()) }),
  z.object({ status: z.literal('failed_budget'), reason: z.string() }),
  z.object({ status: z.literal('escalated'), reason: z.string() }),
]);

/** Blocked agent ← human: the next unread reply to this task's blocker. */
export const AwaitReplyInput = z.object({ timeout_s: z.number().int().min(1).max(AWAIT_TIMEOUT_MAX_S).default(30) });
export const AwaitReplyOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('replied'), message: z.string(), replied_by: z.string(), at: z.string() }),
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('none') }),
]);

export const ProposeSubtaskInput = z.object({ contract: TaskContractInput });
export const AwaitTaskInput = z.object({ task_id: z.string(), timeout_s: z.number().int().min(1).max(AWAIT_TIMEOUT_MAX_S).default(30) });
export const AwaitTaskOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), task_id: z.string(), branch: z.string().optional() }),
  z.object({ status: z.literal('failed'), task_id: z.string(), reason: z.string() }),
  z.object({ status: z.literal('canceled'), task_id: z.string() }),
  z.object({ status: z.literal('pending'), task_id: z.string(), task_state: z.string(), handoff_state: z.string() }),
]);

export const ProposeTaskInput = z.object({ contract: TaskContractInput });
export const ProposeTaskOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('proposed'), task_id: z.string(), version: z.number().int(), warnings: z.array(z.string()) }),
  z.object({ status: z.literal('lint_error'), task_id: z.string(), errors: z.array(z.string()), warnings: z.array(z.string()) }),
]);
/**
 * A revision patch: only the keys present are changed. Deliberately NOT `TaskContractInput.partial()` —
 * that would re-apply the schema defaults (`goal: ''`, `acceptance_criteria: []`) for every omitted key and
 * wipe the contract on merge.
 */
export const TaskContractPatch = z.object({
  recipient: TaskContract.shape.recipient.optional(),
  runtime: TaskContract.shape.runtime.optional(),
  goal: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  non_goals: z.array(z.string()).optional(),
  scope: z.object({ allowed_paths: z.array(z.string()) }).optional(),
  acceptance_criteria: z.array(AcceptanceCriterion).optional(),
  output: z.object({ type: z.enum(['code_change']), evidence_required: z.array(z.enum(['git_diff', 'changed_files', 'check_outputs'])) }).optional(),
  dependencies: z.array(z.string()).optional(),
  budget: Budget.optional(),
});
export type TaskContractPatch = z.infer<typeof TaskContractPatch>;
export const ReviseTaskInput = z.object({ task_id: z.string(), patch: TaskContractPatch });
/** Planner → human: mission-level questions that must be settled before decomposition. */
export const AskHumanInput = z.object({ questions: z.array(Question).min(1) });
export const AskHumanOutput = z.object({ status: z.literal('waiting'), open_questions: z.number().int() });
export const AwaitAnswersInput = z.object({ timeout_s: z.number().int().min(1).max(AWAIT_TIMEOUT_MAX_S).default(30) });
export const AwaitAnswersOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('answered'), answers: z.array(Clarification) }),
  z.object({ status: z.literal('pending'), open_questions: z.array(Question) }),
  z.object({ status: z.literal('none') }),
]);
export const AnswerClarificationInput = z.object({ task_id: z.string(), answers: z.array(z.object({ question_id: z.string(), answer: z.string() })) });
