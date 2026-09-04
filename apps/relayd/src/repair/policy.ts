import type { EvidenceRecord, TaskView } from '@relay/protocol';
import type { RepairDecision, RepairPolicy } from '../ports.js';

function failedCriteria(record: EvidenceRecord): string[] {
  return Object.entries(record.checks)
    .filter(([, result]) => result.status === 'failed' || result.status === 'error')
    .map(([criterionId]) => criterionId);
}

function sameStringsAsSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function isStagnant(task: TaskView, record: EvidenceRecord, currentFailures: string[], limit: number): boolean {
  const attempts = [
    ...task.attempts.filter(
      (attempt) => attempt.task_id !== record.task_id
        || attempt.contract_version !== record.contract_version
        || attempt.attempt !== record.attempt,
    ),
    record,
  ];
  if (attempts.length < limit) return false;
  const recent = attempts.slice(-limit);
  return recent.every(
    (attempt) => sameStringsAsSet(failedCriteria(attempt), currentFailures)
      && sameStringsAsSet(attempt.changed_files, record.changed_files),
  );
}

export class DefaultRepairPolicy implements RepairPolicy {
  decide(task: TaskView, record: EvidenceRecord): RepairDecision {
    const failures = failedCriteria(record);
    if (failures.length > 0) {
      const budget = task.contract.budget?.max_repairs ?? 0;
      const used = task.repairs.length;
      if (used >= budget) return { kind: 'failed_budget', reason: `max_repairs=${budget} exhausted` };

      const stagnationLimit = task.contract.budget?.stagnation_limit ?? 2;
      if (isStagnant(task, record, failures, stagnationLimit)) {
        return {
          kind: 'escalate',
          reason: `stagnation on ${failures.join(', ')}`,
          failed_criteria: failures,
        };
      }

      const failedSet = new Set(failures);
      const conditions = task.contract.acceptance_criteria
        .filter((criterion) => failedSet.has(criterion.id))
        .map((criterion) => criterion.condition);
      const observedFailure = failures
        .map((criterionId) => `${criterionId}: ${record.checks[criterionId]?.observed ?? ''}`)
        .join('\n');
      return {
        kind: 'repair',
        repair: {
          id: `${task.id}/r${used + 1}`,
          parent_task: task.id,
          parent_version: task.contract.version,
          attempt: record.attempt + 1,
          failed_criteria: failures,
          observed_failure: observedFailure,
          requested_correction: `Make the following criteria pass without touching unrelated code: ${conditions.join('; ')}`,
          unchanged_scope: task.contract.non_goals,
          remaining_repairs: budget - used - 1,
        },
      };
    }

    const pending = Object.entries(record.checks)
      .filter(([, result]) => result.status === 'pending_human')
      .map(([criterionId]) => criterionId);
    if (pending.length > 0) return { kind: 'pending_human', criteria: pending };
    return { kind: 'verified' };
  }
}

export function createRepairPolicy(): DefaultRepairPolicy {
  return new DefaultRepairPolicy();
}
