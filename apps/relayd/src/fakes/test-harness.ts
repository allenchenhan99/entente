/**
 * Composes a JSONL store in a temp dir with every fake port and an orchestrator.
 * Used by relayd's own tests and by `RELAY_HOST=fake` demos; never by production wiring.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventType, TaskContractInput, RuntimeKind } from '@relay/protocol';
import { createJsonlStore } from '../store/jsonl-store.js';
import { createOrchestrator } from '../orchestrator/orchestrator.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { fakeWorktrees } from './worktrees.js';
import type { FakeWorktreeOptions } from './worktrees.js';
import { fakeChecks } from './checks.js';
import type { CheckScript } from './checks.js';
import { fakeRepair } from './repair.js';
import { fakeHost } from './host.js';
import { fakeRuntime } from './runtime.js';
import type { RepairPolicy } from '../ports.js';

export interface TestRelayOptions {
  script?: CheckScript;
  worktrees?: FakeWorktreeOptions;
  repair?: RepairPolicy;
  clock?: () => string;
  dir?: string;
}

export function createTestRelay(opts: TestRelayOptions = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const store = createJsonlStore({ dir: path.join(dir, 'run'), clock: opts.clock });
  const worktrees = fakeWorktrees(opts.worktrees);
  const checks = fakeChecks(opts.script ?? {}, store);
  const repair = opts.repair ?? fakeRepair();
  const host = fakeHost();
  const runtimes = { 'claude-code': fakeRuntime('claude-code'), codex: fakeRuntime('codex') };
  const orchestrator: Orchestrator = createOrchestrator({
    store, worktrees, checks, repair, host, runtimes,
    repoRoot: dir, relayDir: path.join(dir, '.relay'), mcpUrl: 'http://127.0.0.1:0/mcp', clock: opts.clock,
    worktreeExists: (wt) => !worktrees.missing.has(wt.path),
  });
  const types = (): EventType[] => store.all().map((e) => e.type);
  const ofType = <T extends EventType>(type: T) =>
    store.all().filter((e): e is Extract<typeof e, { type: T }> => e.type === type);
  return { dir, store, worktrees, checks, repair, host, runtimes, orchestrator, types, ofType };
}

export type TestRelay = ReturnType<typeof createTestRelay>;

/** A lint-clean contract input; override any field. */
export function sampleContract(id: string, over: Partial<TaskContractInput> = {}): TaskContractInput {
  return {
    id,
    recipient: id.replace(/^t-/, '').replace(/[^a-z0-9_-]/g, '-').slice(0, 32),
    runtime: 'claude-code' as RuntimeKind,
    goal: `Implement ${id}`,
    inputs: [],
    constraints: ['Keep it small'],
    non_goals: ['UI'],
    scope: { allowed_paths: [`src/${id}/**`] },
    acceptance_criteria: [
      { id: 'AC-1', condition: 'tests pass', check: { kind: 'command', run: 'npx vitest run', timeout_ms: 120_000 } },
      { id: 'AC-2', condition: 'stays in scope', check: { kind: 'diff_scope' } },
    ],
    output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] },
    dependencies: [],
    budget: { max_repairs: 3, stagnation_limit: 2 },
    ...over,
  };
}
