/**
 * Scripted CheckRunner: every criterion resolves to the scripted status (default `passed`),
 * emits `check_passed` / `check_failed` through the store, and computes `self_report_mismatch`.
 */
import type { TaskView, EvidenceSubmission, EvidenceRecord, CheckResult } from '@relay/protocol';
import type { CheckRunner, EventStore, WorktreeInfo } from '../ports.js';

export type CheckScript = Record<string, 'passed' | 'failed' | 'pending_human'>;

export interface FakeChecks extends CheckRunner {
  /** Mutable: tests change it between attempts. */
  script: CheckScript;
  store?: EventStore;
  calls: Array<{ taskId: string; attempt: number; allowedPaths: string[]; worktreePath: string }>;
}

export function fakeChecks(script: CheckScript, store?: EventStore): FakeChecks {
  const fake: FakeChecks = {
    script,
    store,
    calls: [],
    async run(task: TaskView, submission: EvidenceSubmission, _worktree: WorktreeInfo, evidenceDir: string): Promise<EvidenceRecord> {
      fake.calls.push({ taskId: task.id, attempt: submission.attempt, allowedPaths: [...task.contract.scope.allowed_paths], worktreePath: _worktree.path });
      const checks: EvidenceRecord['checks'] = {};
      const mismatch: string[] = [];
      for (const ac of task.contract.acceptance_criteria) {
        const status = fake.script[ac.id] ?? 'passed';
        const result: CheckResult = { status, duration_ms: 1 };
        if (status !== 'pending_human') result.output_path = `${evidenceDir}/${ac.id}.txt`;
        if (status === 'failed') result.observed = `fake check ${ac.id} failed: ${ac.condition}`;
        checks[ac.id] = result;
        if (status === 'failed' && submission.claimed[ac.id]?.status === 'passed') mismatch.push(ac.id);
        if (status !== 'pending_human' && fake.store) {
          fake.store.append({
            mission_id: task.mission_id,
            task_id: task.id,
            actor: 'relayd',
            type: status === 'passed' ? 'check_passed' : 'check_failed',
            payload: { attempt: submission.attempt, criterion_id: ac.id, result },
          });
        }
      }
      return {
        task_id: task.id,
        contract_version: submission.contract_version,
        attempt: submission.attempt,
        git_diff_path: `${evidenceDir}/a${submission.attempt}.patch`,
        changed_files: [],
        checks,
        self_report_mismatch: mismatch,
      };
    },
  };
  return fake;
}
