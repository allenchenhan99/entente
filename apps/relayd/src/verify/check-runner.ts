import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import type {
  AcceptanceCriterion,
  CheckResult,
  EvidenceRecord,
  EvidenceSubmission,
  EventInput,
  TaskView,
} from '@relay/protocol';
import type { CheckRunner, EventStore, WorktreeInfo, WorktreeManager } from '../ports.js';
import type { DiffOptions } from '../worktree/git-worktrees.js';
import { createCheckSandbox, type DaemonEnv } from './sandbox.js';

export interface CheckExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Directories besides the worktree the check may write to (the evidence dir). */
  writable?: string[];
}

export interface CheckExecResult {
  stdout: string;
  stderr: string;
  all?: string;
  exitCode: number;
  timedOut?: boolean;
}

export type CheckExec = (argv: string[], options: CheckExecOptions) => Promise<CheckExecResult>;

export interface CheckRunnerDeps {
  store: EventStore;
  worktrees: WorktreeManager;
  /** Replaces the sandboxed `sh -c` executor (tests). */
  exec?: CheckExec;
  clock?: () => number;
  /** Where the checks' scratch HOME lives (`<relayDir>/home`); defaults to the OS temp dir. */
  relayDir?: string;
  /** The daemon's environment, filtered through the sandbox allow-list. Defaults to `process.env`. */
  env?: DaemonEnv;
  log?: (message: string) => void;
}

interface WorktreeManagerWithDiffOptions extends WorktreeManager {
  diff(worktreePath: string, base: string, options?: DiffOptions): Promise<{ patchPath: string; changedFiles: string[] }>;
}

/** The production executor: `sh -c <run>` inside the check sandbox (see sandbox.ts). */
function sandboxedCheckExec(deps: CheckRunnerDeps): CheckExec {
  const sandbox = createCheckSandbox({ relayDir: deps.relayDir ?? path.join(os.tmpdir(), 'relay'), env: deps.env, log: deps.log });
  return async (argv, options) => {
    const [shell, flag, run] = argv;
    if (shell !== 'sh' || flag !== '-c' || run === undefined) throw new Error('check runner: expected argv ["sh", "-c", <run>]');
    const result = await sandbox.runCheck({ run, cwd: options.cwd, timeoutMs: options.timeoutMs, writable: options.writable });
    return { stdout: result.output, stderr: '', all: result.output, exitCode: result.exitCode, timedOut: result.timedOut };
  };
}

function combinedOutput(result: CheckExecResult): string {
  if (result.all !== undefined) return result.all;
  if (!result.stdout) return result.stderr;
  if (!result.stderr) return result.stdout;
  return `${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`;
}

function outputTail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-20).join('\n');
}

function errorExecution(error: unknown): CheckExecResult {
  if (typeof error !== 'object' || error === null) {
    return { stdout: '', stderr: String(error), exitCode: -1 };
  }
  const failure = error as Partial<CheckExecResult> & { message?: string };
  return {
    stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
    stderr: typeof failure.stderr === 'string' ? failure.stderr : (failure.message ?? String(error)),
    all: typeof failure.all === 'string' ? failure.all : undefined,
    exitCode: typeof failure.exitCode === 'number' ? failure.exitCode : -1,
    timedOut: failure.timedOut,
  };
}

export class DeterministicCheckRunner implements CheckRunner {
  private readonly store: EventStore;
  private readonly worktrees: WorktreeManagerWithDiffOptions;
  private readonly exec: CheckExec;
  private readonly clock: () => number;

  constructor(deps: CheckRunnerDeps) {
    this.store = deps.store;
    this.worktrees = deps.worktrees as WorktreeManagerWithDiffOptions;
    this.exec = deps.exec ?? sandboxedCheckExec(deps);
    this.clock = deps.clock ?? Date.now;
  }

  private async runCommand(
    criterion: AcceptanceCriterion,
    worktreePath: string,
    evidenceDir: string,
  ): Promise<CheckResult> {
    if (criterion.check?.kind !== 'command') throw new Error('check runner: expected a command criterion');
    const outputPath = path.join(evidenceDir, `${criterion.id}.txt`);
    const startedAt = this.clock();
    let execution: CheckExecResult;
    try {
      execution = await this.exec(['sh', '-c', criterion.check.run], {
        cwd: worktreePath,
        timeoutMs: criterion.check.timeout_ms,
        writable: [evidenceDir],
      });
    } catch (error) {
      execution = errorExecution(error);
    }
    const durationMs = Math.max(0, Math.round(this.clock() - startedAt));
    const output = combinedOutput(execution);
    fs.writeFileSync(outputPath, output, 'utf8');

    if (execution.exitCode === 0 && !execution.timedOut) {
      return { status: 'passed', output_path: outputPath, duration_ms: durationMs };
    }
    return {
      status: 'failed',
      output_path: outputPath,
      duration_ms: durationMs,
      observed: execution.timedOut ? `timeout after ${criterion.check.timeout_ms}ms` : outputTail(output),
    };
  }

  private async runCriterion(
    criterion: AcceptanceCriterion,
    task: TaskView,
    changedFiles: string[],
    worktreePath: string,
    evidenceDir: string,
  ): Promise<CheckResult> {
    const check = criterion.check;
    if (!check) return { status: 'error', observed: 'no check bound' };

    switch (check.kind) {
      case 'command':
        return this.runCommand(criterion, worktreePath, evidenceDir);
      case 'diff_scope': {
        const allowedPaths = task.contract.scope.allowed_paths;
        if (allowedPaths.length === 0) return { status: 'failed', observed: 'allowed_paths is empty' };
        const offenders = changedFiles.filter(
          (file) => !allowedPaths.some((pattern) => picomatch.isMatch(file, pattern, { dot: true })),
        );
        return offenders.length === 0
          ? { status: 'passed' }
          : { status: 'failed', observed: `files outside allowed_paths: ${offenders.join(', ')}` };
      }
      case 'file_exists':
        return fs.existsSync(path.join(worktreePath, check.path))
          ? { status: 'passed' }
          : { status: 'failed', observed: `missing file: ${check.path}` };
      case 'human_review':
        return { status: 'pending_human' };
      case 'llm_judge':
        return { status: 'error', observed: 'llm_judge not configured' };
    }
  }

  private emit(task: TaskView, attempt: number, criterionId: string, result: CheckResult): void {
    if (result.status === 'pending_human') return;
    const input = {
      mission_id: task.mission_id,
      task_id: task.id,
      actor: 'relayd',
      type: result.status === 'passed' ? 'check_passed' : 'check_failed',
      payload: { attempt, criterion_id: criterionId, result },
    } as EventInput;
    this.store.append(input);
  }

  async run(
    task: TaskView,
    submission: EvidenceSubmission,
    worktree: WorktreeInfo,
    evidenceDir: string,
  ): Promise<EvidenceRecord> {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const requestedPatchPath = path.join(evidenceDir, `attempt-${submission.attempt}.patch`);
    const diff = await this.worktrees.diff(worktree.path, worktree.base, { patchPath: requestedPatchPath });
    const checks: Record<string, CheckResult> = {};

    for (const criterion of task.contract.acceptance_criteria) {
      const result = await this.runCriterion(criterion, task, diff.changedFiles, worktree.path, evidenceDir);
      checks[criterion.id] = result;
      this.emit(task, submission.attempt, criterion.id, result);
    }

    const selfReportMismatch = task.contract.acceptance_criteria
      .filter((criterion) => submission.claimed[criterion.id]?.status === 'passed' && checks[criterion.id]?.status === 'failed')
      .map((criterion) => criterion.id);

    return {
      task_id: task.id,
      contract_version: submission.contract_version,
      attempt: submission.attempt,
      git_diff_path: diff.patchPath,
      changed_files: diff.changedFiles,
      checks,
      self_report_mismatch: selfReportMismatch,
    };
  }
}

export function createCheckRunner(deps: CheckRunnerDeps): DeterministicCheckRunner {
  return new DeterministicCheckRunner(deps);
}
