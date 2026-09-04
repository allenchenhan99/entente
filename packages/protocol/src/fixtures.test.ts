/**
 * Replays the committed fixture event logs through the reducer and checks the shape the
 * TUI and relayd rely on. Fixtures are regenerated with `npx tsx fixtures/scripts/generate-events.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Event, Actor } from './events.js';
import { replay } from './reducer.js';
import { lintContract } from './lint/index.js';
import type { TaskContract } from './contract.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const START = '2026-09-05T10:00:00+08:00';
const MIN_STEP_MS = 20_000;
const MAX_STEP_MS = 180_000;

function load(name: string): Event[] {
  const text = fs.readFileSync(`${FIXTURES_DIR}${name}`, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const parsed = Event.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${name}:${i + 1} does not parse: ${parsed.error.message}`);
    return parsed.data;
  });
}

const BACKEND = 't-backend-auth';
const FRONTEND = 't-frontend-login';
const E2E = 't-e2e-tests';

describe('fixtures', () => {
  describe.each(['events-happy.jsonl', 'events-repair.jsonl'])('%s', (name) => {
    const events = load(name);

    it('every line parses as an Event with a valid actor', () => {
      expect(events.length).toBeGreaterThan(20);
      for (const e of events) expect(Actor.safeParse(e.actor).success).toBe(true);
    });

    it('seq starts at 1 and is contiguous', () => {
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    });

    it(`timestamps start at ${START}, carry the +08:00 offset and step 20 s–3 min apart`, () => {
      expect(events[0]!.ts).toBe(START);
      for (let i = 0; i < events.length; i += 1) {
        expect(events[i]!.ts.endsWith('+08:00')).toBe(true);
        if (i === 0) continue;
        const step = Date.parse(events[i]!.ts) - Date.parse(events[i - 1]!.ts);
        expect(step, `step before seq ${events[i]!.seq}`).toBeGreaterThanOrEqual(MIN_STEP_MS);
        expect(step, `step before seq ${events[i]!.seq}`).toBeLessThanOrEqual(MAX_STEP_MS);
      }
    });

    it('lint_reported results match lintContract on the contract they describe', () => {
      const contracts = new Map<string, TaskContract>();
      for (const e of events) {
        if (e.type === 'task_proposed' || e.type === 'contract_revised') contracts.set(e.payload.contract.id, e.payload.contract);
        if (e.type === 'lint_reported') {
          const c = contracts.get(e.task_id!)!;
          expect(c.version).toBe(e.payload.contract_version);
          const siblings = [...contracts.values()].filter((s) => s.id !== c.id);
          expect(e.payload.results).toEqual(lintContract(c, { siblings, repoRoot: c.mission_id, fileExists: () => true }));
        }
      }
    });

    it('all three tasks end completed, verified and exited with a verified mission', () => {
      const s = replay(events);
      expect(Object.keys(s.tasks).sort()).toEqual([BACKEND, E2E, FRONTEND]);
      for (const id of [BACKEND, FRONTEND, E2E]) {
        expect(s.tasks[id]!.task_state, id).toBe('completed');
        expect(s.tasks[id]!.handoff_state, id).toBe('verified');
        expect(s.tasks[id]!.runtime, id).toBe('exited');
        expect(s.tasks[id]!.blocked_on_dependencies, id).toEqual([]);
        expect(s.tasks[id]!.lint, id).toEqual([]);
      }
      expect(s.tasks[BACKEND]!.agent?.runtime).toBe('claude-code');
      expect(s.tasks[FRONTEND]!.agent?.runtime).toBe('codex');
      expect(s.tasks[E2E]!.contract.dependencies).toEqual([BACKEND]);
      expect(s.missions['m-001']!.status).toBe('verified');
      expect(s.missions['m-001']!.task_ids).toEqual([BACKEND, FRONTEND, E2E]);
      expect(s.missions['m-001']!.integration?.order).toEqual([BACKEND, FRONTEND, E2E]);
      expect(s.last_seq).toBe(events.length);
    });
  });

  it('events-happy.jsonl: every task accepted first time, no repairs, no clarifications', () => {
    const s = replay(load('events-happy.jsonl'));
    for (const id of [BACKEND, FRONTEND, E2E]) {
      expect(s.tasks[id]!.versions).toHaveLength(1);
      expect(s.tasks[id]!.attempts).toHaveLength(1);
      expect(s.tasks[id]!.repairs).toHaveLength(0);
    }
    expect(s.metrics.repairs_total).toBe(0);
    expect(s.metrics.self_report_mismatches).toBe(0);
    expect(s.metrics.fields_filled_via_clarification).toBe(0);
    expect(s.metrics.contracts_blocked_before_execution).toBe(0);
    expect(s.metrics.tasks_not_rerun_on_repair).toBe(0);
    expect(s.metrics.criteria_total).toBe(9);
    expect(s.metrics.criteria_with_machine_check).toBe(8);
  });

  it('events-repair.jsonl: clarification, lint-blocked revision and one scoped repair', () => {
    const s = replay(load('events-repair.jsonl'));
    const backend = s.tasks[BACKEND]!;
    expect(backend.versions.length).toBe(2);
    expect(backend.repairs.length).toBe(1);
    expect(backend.handoff_state).toBe('verified');
    expect(backend.task_state).toBe('completed');
    expect(backend.attempts.length).toBe(2);
    expect(backend.attempt).toBe(2);
    expect(backend.active_repair).toBeUndefined();
    expect(backend.open_questions).toEqual([]);
    expect(backend.contract.clarifications).toHaveLength(2);
    expect(backend.attempts[0]!.self_report_mismatch).toEqual(['AC-2']);
    expect(backend.attempts[1]!.self_report_mismatch).toEqual([]);

    const frontend = s.tasks[FRONTEND]!;
    expect(frontend.versions.length).toBe(2);
    expect(frontend.versions[0]!.acceptance_criteria.some((ac) => ac.check === undefined)).toBe(true);
    expect(frontend.contract.acceptance_criteria.every((ac) => ac.check !== undefined)).toBe(true);

    expect(s.metrics.self_report_mismatches).toBe(1);
    expect(s.metrics.fields_filled_via_clarification).toBe(2);
    expect(s.metrics.repairs_total).toBe(1);
    expect(s.metrics.contracts_blocked_before_execution).toBe(1);
    expect(s.metrics.tasks_not_rerun_on_repair).toBe(1);
    expect(s.missions['m-001']!.status).toBe('verified');
  });
});
