/**
 * Minimal RepairPolicy (PRD §10, simplified): any failed criterion ⇒ delta repair while the task's
 * `max_repairs` budget allows, else `failed_budget`; any pending human review ⇒ `pending_human`;
 * otherwise `verified`. No stagnation detection.
 */
import type { TaskView, EvidenceRecord, RepairContract } from '@relay/protocol';
import type { RepairPolicy, RepairDecision } from '../ports.js';

export const DEFAULT_MAX_REPAIRS = 3;

export function fakeRepair(): RepairPolicy {
  return {
    decide(task: TaskView, record: EvidenceRecord): RepairDecision {
      const failed = Object.entries(record.checks)
        .filter(([, r]) => r.status === 'failed' || r.status === 'error')
        .map(([id]) => id);
      const pending = Object.entries(record.checks)
        .filter(([, r]) => r.status === 'pending_human')
        .map(([id]) => id);
      if (failed.length > 0) {
        const maxRepairs = task.contract.budget?.max_repairs ?? DEFAULT_MAX_REPAIRS;
        if (record.attempt > maxRepairs) {
          return { kind: 'failed_budget', reason: `repair budget exhausted after ${record.attempt} attempts; still failing: ${failed.join(', ')}` };
        }
        const conditions = task.contract.acceptance_criteria.filter((ac) => failed.includes(ac.id));
        const repair: RepairContract = {
          id: `${task.id}/r${record.attempt}`,
          parent_task: task.id,
          parent_version: record.contract_version,
          attempt: record.attempt + 1,
          failed_criteria: failed,
          observed_failure: failed.map((id) => `${id}: ${record.checks[id].observed ?? 'failed'}`).join('\n'),
          requested_correction: `Make ${failed.join(', ')} pass: ${conditions.map((c) => c.condition).join('; ')}`,
          unchanged_scope: [...task.contract.non_goals],
          remaining_repairs: maxRepairs - record.attempt,
        };
        return { kind: 'repair', repair };
      }
      if (pending.length > 0) return { kind: 'pending_human', criteria: pending };
      return { kind: 'verified' };
    },
  };
}
