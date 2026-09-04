import { describe, expect, it } from 'vitest';
import {
  EvidenceRecord,
  RepairContract,
  TaskContract,
  TaskView,
  type CheckResult,
  type EvidenceRecord as EvidenceRecordType,
  type RepairContract as RepairContractType,
  type TaskView as TaskViewType,
} from '@relay/protocol';
import { createRepairPolicy } from './policy.js';

function record(
  checks: Record<string, CheckResult>,
  overrides: Partial<EvidenceRecordType> = {},
): EvidenceRecordType {
  return EvidenceRecord.parse({
    task_id: 't-repair',
    contract_version: 4,
    attempt: 2,
    changed_files: ['src/auth.ts'],
    checks,
    ...overrides,
  });
}

function priorRepair(): RepairContractType {
  return RepairContract.parse({
    id: 't-repair/r1',
    parent_task: 't-repair',
    parent_version: 4,
    attempt: 2,
    failed_criteria: ['AC-1'],
    observed_failure: 'AC-1: old failure',
    requested_correction: 'Fix the old failure',
    remaining_repairs: 2,
  });
}

function task(overrides: { maxRepairs?: number; stagnationLimit?: number; attempts?: EvidenceRecordType[]; repairs?: RepairContractType[] } = {}): TaskViewType {
  const contract = TaskContract.parse({
    id: 't-repair',
    mission_id: 'm-test',
    version: 4,
    sender: 'planner',
    recipient: 'verify',
    runtime: 'codex',
    goal: 'Repair only the failing criteria',
    non_goals: ['Do not change public APIs', 'Do not touch unrelated code'],
    scope: { allowed_paths: ['src/**'] },
    acceptance_criteria: [
      { id: 'AC-1', condition: 'The command succeeds', check: { kind: 'command', run: 'test' } },
      { id: 'AC-2', condition: 'The file is generated', check: { kind: 'file_exists', path: 'out.txt' } },
      { id: 'AC-3', condition: 'A human approves the result', check: { kind: 'human_review' } },
    ],
    budget: { max_repairs: overrides.maxRepairs ?? 3, stagnation_limit: overrides.stagnationLimit ?? 2 },
  });
  return TaskView.parse({
    id: contract.id,
    mission_id: contract.mission_id,
    contract,
    versions: [contract],
    open_questions: [],
    lint: [],
    runtime: 'done',
    task_state: 'awaiting_verification',
    handoff_state: 'evidence_submitted',
    blocked_on_dependencies: [],
    attempt: 2,
    attempts: overrides.attempts ?? [],
    repairs: overrides.repairs ?? [],
    escalated: false,
  });
}

describe('repair policy', () => {
  const policy = createRepairPolicy();

  it('returns verified when every criterion passed', () => {
    const decision = policy.decide(task(), record({
      'AC-1': { status: 'passed' },
      'AC-2': { status: 'passed' },
      'AC-3': { status: 'passed' },
    }));

    expect(decision).toEqual({ kind: 'verified' });
  });

  it('builds the next scoped repair contract with remaining budget', () => {
    const decision = policy.decide(
      task({ repairs: [priorRepair()] }),
      record({
        'AC-1': { status: 'passed' },
        'AC-2': { status: 'failed', observed: 'expected generated file' },
        'AC-3': { status: 'pending_human' },
      }),
    );

    expect(decision).toEqual({
      kind: 'repair',
      repair: {
        id: 't-repair/r2',
        parent_task: 't-repair',
        parent_version: 4,
        attempt: 3,
        failed_criteria: ['AC-2'],
        observed_failure: 'AC-2: expected generated file',
        requested_correction: 'Make the following criteria pass without touching unrelated code: The file is generated',
        unchanged_scope: ['Do not change public APIs', 'Do not touch unrelated code'],
        remaining_repairs: 1,
      },
    });
  });

  it('fails immediately when the repair budget is exhausted', () => {
    const decision = policy.decide(
      task({ maxRepairs: 0 }),
      record({ 'AC-1': { status: 'failed', observed: 'still broken' } }),
    );

    expect(decision).toEqual({ kind: 'failed_budget', reason: 'max_repairs=0 exhausted' });
  });

  it('escalates after the stagnation limit sees the same failures and changed files', () => {
    const first = record(
      { 'AC-1': { status: 'failed', observed: 'first failure' }, 'AC-2': { status: 'passed' } },
      { attempt: 1, changed_files: ['src/auth.ts', 'src/token.ts'] },
    );
    const second = record(
      { 'AC-1': { status: 'failed', observed: 'second failure' }, 'AC-2': { status: 'passed' } },
      { attempt: 2, changed_files: ['src/token.ts', 'src/auth.ts'] },
    );

    const decision = policy.decide(task({ attempts: [first], repairs: [priorRepair()] }), second);

    expect(decision).toEqual({ kind: 'escalate', reason: 'stagnation on AC-1', failed_criteria: ['AC-1'] });
  });

  it('does not count the current record twice when it is already in task attempts', () => {
    const current = record(
      { 'AC-1': { status: 'failed', observed: 'first failure' }, 'AC-2': { status: 'passed' } },
      { attempt: 1 },
    );

    const decision = policy.decide(task({ attempts: [current] }), current);

    expect(decision.kind).toBe('repair');
  });

  it('returns pending human only when no criterion failed', () => {
    const pending = policy.decide(task(), record({
      'AC-1': { status: 'passed' },
      'AC-2': { status: 'passed' },
      'AC-3': { status: 'pending_human' },
    }));
    const withError = policy.decide(task(), record({
      'AC-1': { status: 'error', observed: 'runner unavailable' },
      'AC-3': { status: 'pending_human' },
    }));

    expect(pending).toEqual({ kind: 'pending_human', criteria: ['AC-3'] });
    expect(withError.kind).toBe('repair');
    if (withError.kind === 'repair') expect(withError.repair.failed_criteria).toEqual(['AC-1']);
  });
});
