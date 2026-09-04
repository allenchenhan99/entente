/**
 * Shared builders for protocol tests. Lives in a *.test.ts file so it is excluded from the build.
 */
import { describe, it, expect } from 'vitest';
import { Event, type EventOf, type EventType } from './events.js';
import { TaskContract, type TaskContract as TaskContractT } from './contract.js';

export const MISSION_ID = 'm-001';

export function contract(overrides: Partial<TaskContractT> & { id?: string } = {}): TaskContractT {
  return TaskContract.parse({
    id: 't-backend-auth',
    mission_id: MISSION_ID,
    version: 1,
    sender: 'planner',
    recipient: 'backend',
    runtime: 'claude-code',
    goal: 'Implement email magic-link authentication endpoints',
    inputs: ['docs/auth-spec.md'],
    constraints: ['Reuse the existing session storage'],
    non_goals: ['OAuth login'],
    scope: { allowed_paths: ['src/auth/**', 'tests/auth/**'] },
    acceptance_criteria: [
      { id: 'AC-1', condition: 'A valid magic link creates a session', check: { kind: 'command', run: 'npx vitest run tests/auth/valid.test.ts' } },
      { id: 'AC-2', condition: 'Changes stay in scope', check: { kind: 'diff_scope' } },
    ],
    output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] },
    dependencies: [],
    budget: { max_repairs: 3, stagnation_limit: 2 },
    ...overrides,
  });
}

/** Builds a sequence of parsed events with auto-incrementing seq and monotonic ts. */
export class EventLog {
  private seq = 0;
  private t = Date.parse('2026-09-05T02:00:00Z');
  readonly events: Event[] = [];

  add<T extends EventType>(
    type: T,
    payload: EventOf<T>['payload'],
    opts: { task_id?: string; actor?: string; mission_id?: string; stepSeconds?: number } = {},
  ): EventOf<T> {
    this.seq += 1;
    this.t += (opts.stepSeconds ?? 30) * 1000;
    const raw = {
      seq: this.seq,
      ts: new Date(this.t).toISOString(),
      mission_id: opts.mission_id ?? MISSION_ID,
      task_id: opts.task_id,
      actor: opts.actor ?? 'relayd',
      type,
      payload,
    };
    const parsed = Event.parse(raw) as EventOf<T>;
    this.events.push(parsed);
    return parsed;
  }
}

describe('testkit', () => {
  it('builds parseable events with ascending seq', () => {
    const log = new EventLog();
    log.add('mission_created', { id: MISSION_ID, repo: '/r', title: 'T' }, { actor: 'human' });
    log.add('task_proposed', { contract: contract() }, { task_id: 't-backend-auth', actor: 'planner' });
    expect(log.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(contract().budget?.stagnation_limit).toBe(2);
  });
});
