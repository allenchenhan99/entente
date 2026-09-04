import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Event,
  TaskContract,
  TaskView,
  initialState,
  type AcceptanceCriterion,
  type EventInput,
  type TaskView as TaskViewType,
} from '@relay/protocol';
import type { EventStore, WorktreeInfo, WorktreeManager } from '../ports.js';
import { createCheckRunner, type CheckExec } from './check-runner.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  tempDirs.push(dir);
  return dir;
}

function taskView(criteria: AcceptanceCriterion[], allowedPaths = ['src/**']): TaskViewType {
  const contract = TaskContract.parse({
    id: 't-checks',
    mission_id: 'm-test',
    version: 2,
    sender: 'planner',
    recipient: 'verify',
    runtime: 'codex',
    goal: 'Run deterministic acceptance checks',
    scope: { allowed_paths: allowedPaths },
    acceptance_criteria: criteria,
    budget: { max_repairs: 2, stagnation_limit: 2 },
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
    attempt: 1,
    attempts: [],
    repairs: [],
    escalated: false,
  });
}

function fakeStore(): { store: EventStore; events: Event[] } {
  const events: Event[] = [];
  const store: EventStore = {
    append(input: EventInput) {
      const event = Event.parse({ ...input, seq: events.length + 1, ts: `2026-09-04T00:00:0${events.length}Z` });
      events.push(event);
      return event;
    },
    all: () => [...events],
    state: () => initialState(),
    subscribe: () => () => undefined,
  };
  return { store, events };
}

function fakeWorktrees(changedFiles: string[], patchPath: string) {
  const diff = vi.fn(async () => ({ changedFiles, patchPath }));
  return { worktrees: { diff } as unknown as WorktreeManager, diff };
}

function submission(claimed: Record<string, { status: 'passed' | 'failed' | 'skipped' }> = {}) {
  return { task_id: 't-checks', contract_version: 2, attempt: 1, claimed, summary: '' } as const;
}

const worktree: WorktreeInfo = { path: '/repo/.relay/wt/t-checks', branch: 'relay/t-checks', base: 'a'.repeat(40) };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check runner', () => {
  it('runs command checks with pass, failure tail, timeout, output files, and ordered events', async () => {
    const criteria: AcceptanceCriterion[] = [
      { id: 'AC-1', condition: 'passes', check: { kind: 'command', run: 'pass', timeout_ms: 50 } },
      { id: 'AC-2', condition: 'fails', check: { kind: 'command', run: 'fail', timeout_ms: 60 } },
      { id: 'AC-3', condition: 'times out', check: { kind: 'command', run: 'slow', timeout_ms: 70 } },
    ];
    const failureLines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n');
    const exec: CheckExec = vi.fn(async (argv, options) => {
      expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
      expect(options.cwd).toBe(worktree.path);
      if (argv[2] === 'pass') return { stdout: 'pass stdout\n', stderr: 'pass stderr\n', all: 'pass stdout\npass stderr\n', exitCode: 0 };
      if (argv[2] === 'fail') return { stdout: failureLines, stderr: '', exitCode: 2 };
      return { stdout: 'partial output\n', stderr: '', exitCode: 1, timedOut: true };
    });
    const { store, events } = fakeStore();
    const evidenceDir = tempDir();
    const { worktrees, diff } = fakeWorktrees(['src/file.ts'], path.join(evidenceDir, 'attempt-1.patch'));
    const runner = createCheckRunner({ store, worktrees, exec });

    const record = await runner.run(taskView(criteria), submission({ 'AC-2': { status: 'passed' } }), worktree, evidenceDir);

    expect(record.checks['AC-1']).toMatchObject({ status: 'passed', output_path: path.join(evidenceDir, 'AC-1.txt') });
    expect(fs.readFileSync(path.join(evidenceDir, 'AC-1.txt'), 'utf8')).toBe('pass stdout\npass stderr\n');
    expect(record.checks['AC-2']).toMatchObject({ status: 'failed', observed: failureLines.split('\n').slice(-20).join('\n') });
    expect(record.checks['AC-3']).toMatchObject({ status: 'failed', observed: 'timeout after 70ms' });
    expect(fs.readFileSync(path.join(evidenceDir, 'AC-3.txt'), 'utf8')).toBe('partial output\n');
    expect(record.self_report_mismatch).toEqual(['AC-2']);
    expect(events.map((event) => [event.type, event.task_id, event.payload.criterion_id])).toEqual([
      ['check_passed', 't-checks', 'AC-1'],
      ['check_failed', 't-checks', 'AC-2'],
      ['check_failed', 't-checks', 'AC-3'],
    ]);
    expect(diff).toHaveBeenCalledWith(worktree.path, worktree.base, { patchPath: path.join(evidenceDir, 'attempt-1.patch') });
  });

  it('checks diff scope with dotfile globs and reports every offender', async () => {
    const criteria: AcceptanceCriterion[] = [
      { id: 'AC-1', condition: 'scope', check: { kind: 'diff_scope' } },
    ];
    const evidenceDir = tempDir();
    const { store } = fakeStore();
    const inScope = fakeWorktrees(['src/index.ts', 'src/.config.json'], path.join(evidenceDir, 'attempt-1.patch'));
    const passing = createCheckRunner({ store, worktrees: inScope.worktrees });

    const passRecord = await passing.run(taskView(criteria), submission(), worktree, evidenceDir);

    expect(passRecord.checks['AC-1']?.status).toBe('passed');

    const outOfScope = fakeWorktrees(['src/index.ts', '.env', 'docs/readme.md'], path.join(evidenceDir, 'attempt-1.patch'));
    const failing = createCheckRunner({ store: fakeStore().store, worktrees: outOfScope.worktrees });
    const failRecord = await failing.run(taskView(criteria), submission(), worktree, evidenceDir);

    expect(failRecord.checks['AC-1']?.status).toBe('failed');
    expect(failRecord.checks['AC-1']?.observed).toContain('.env');
    expect(failRecord.checks['AC-1']?.observed).toContain('docs/readme.md');
  });

  it('fails diff scope explicitly when allowed_paths is empty', async () => {
    const evidenceDir = tempDir();
    const { store } = fakeStore();
    const { worktrees } = fakeWorktrees([], path.join(evidenceDir, 'attempt-1.patch'));
    const runner = createCheckRunner({ store, worktrees });
    const record = await runner.run(
      taskView([{ id: 'AC-1', condition: 'scope', check: { kind: 'diff_scope' } }], []),
      submission(),
      worktree,
      evidenceDir,
    );

    expect(record.checks['AC-1']).toMatchObject({ status: 'failed', observed: 'allowed_paths is empty' });
  });

  it('handles file existence, human review, llm judge, and missing checks', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'present.txt'), 'yes');
    const criteria: AcceptanceCriterion[] = [
      { id: 'AC-1', condition: 'present file', check: { kind: 'file_exists', path: 'present.txt' } },
      { id: 'AC-2', condition: 'missing file', check: { kind: 'file_exists', path: 'missing.txt' } },
      { id: 'AC-3', condition: 'human decision', check: { kind: 'human_review' } },
      { id: 'AC-4', condition: 'judge decision', check: { kind: 'llm_judge' } },
      { id: 'AC-5', condition: 'unbound decision' },
    ];
    const { store, events } = fakeStore();
    const { worktrees } = fakeWorktrees([], path.join(root, 'attempt-1.patch'));
    const runner = createCheckRunner({ store, worktrees });

    const record = await runner.run(taskView(criteria), submission(), { ...worktree, path: root }, root);

    expect(record.checks['AC-1']?.status).toBe('passed');
    expect(record.checks['AC-2']).toMatchObject({ status: 'failed', observed: 'missing file: missing.txt' });
    expect(record.checks['AC-3']).toEqual({ status: 'pending_human' });
    expect(record.checks['AC-4']).toEqual({ status: 'error', observed: 'llm_judge not configured' });
    expect(record.checks['AC-5']).toEqual({ status: 'error', observed: 'no check bound' });
    expect(events.map((event) => event.payload.criterion_id)).toEqual(['AC-1', 'AC-2', 'AC-4', 'AC-5']);
  });
});

describe('check runner sandbox env', () => {
  it('runs a real command check with only the allow-listed env, in the worktree, with the evidence dir writable and output capped', async () => {
    const relayDir = tempDir();
    const worktreePath = tempDir();
    const evidenceDir = path.join(relayDir, 'evidence', 't-checks');
    const criteria: AcceptanceCriterion[] = [
      { id: 'AC-1', condition: 'env', check: { kind: 'command', run: 'env | sort; pwd', timeout_ms: 5_000 } },
      { id: 'AC-2', condition: 'evidence writable', check: { kind: 'command', run: `touch "${evidenceDir}/side-effect"`, timeout_ms: 5_000 } },
      { id: 'AC-3', condition: 'big output', check: { kind: 'command', run: "i=0; while [ $i -lt 1200 ]; do printf '%01000d\\n' $i; i=$((i+1)); done; exit 3", timeout_ms: 20_000 } },
    ];
    const { store } = fakeStore();
    const { worktrees } = fakeWorktrees([], path.join(evidenceDir, 'attempt-1.patch'));
    const logs: string[] = [];
    const runner = createCheckRunner({
      store, worktrees, relayDir, log: (m) => logs.push(m),
      env: { PATH: process.env.PATH, RELAY_SECRET_TEST: 'hunter2', RELAY_CHECK_SANDBOX: 'off' },
    });

    const record = await runner.run(taskView(criteria), submission(), { ...worktree, path: worktreePath }, evidenceDir);

    expect(record.checks['AC-1']?.status).toBe('passed');
    const envOutput = fs.readFileSync(path.join(evidenceDir, 'AC-1.txt'), 'utf8');
    expect(envOutput).toContain('PATH=');
    expect(envOutput).toContain('CI=1');
    expect(envOutput).toContain(`HOME=${path.join(relayDir, 'home')}`);
    expect(envOutput).not.toContain('RELAY_SECRET_TEST');
    expect(envOutput.trimEnd().endsWith(fs.realpathSync(worktreePath))).toBe(true);
    expect(record.checks['AC-2']?.status).toBe('passed');
    expect(fs.existsSync(path.join(evidenceDir, 'side-effect'))).toBe(true);
    expect(record.checks['AC-3']?.status).toBe('failed');
    const big = fs.readFileSync(path.join(evidenceDir, 'AC-3.txt'), 'utf8');
    expect(big.startsWith('[relayd: output truncated to the last 1048576 bytes]\n')).toBe(true);
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(record.checks['AC-3']?.observed?.split('\n').at(-1)?.endsWith('1199')).toBe(true);
    expect(logs).toEqual(['check sandbox: disabled by RELAY_CHECK_SANDBOX=off']);
  });
});
