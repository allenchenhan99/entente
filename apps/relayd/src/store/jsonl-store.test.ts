import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventInput } from '@relay/protocol';
import { createJsonlStore } from './jsonl-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));

const mission = (): EventInput => ({
  mission_id: 'm-000001',
  actor: 'human',
  type: 'mission_created',
  payload: {
    id: 'm-000001',
    repo: '/repo',
    title: 'Add login',
    success_definition: '',
    integration_check: 'npx vitest run',
    budget: { max_repairs_per_task: 3 },
  },
});
const progress = (msg: string): EventInput => ({
  mission_id: 'm-000001',
  task_id: 't-a',
  actor: 'agent:backend',
  type: 'progress_reported',
  payload: { message: msg },
});

describe('jsonl store', () => {
  it('round-trips 3 events through disk with seq 1..3 and state.last_seq 3', () => {
    const dir = tmp();
    let n = 0;
    const clock = () => `2026-09-04T00:00:0${n++}.000Z`;
    const store = createJsonlStore({ dir, clock });
    const e1 = store.append(mission());
    store.append(progress('one'));
    store.append(progress('two'));
    expect(e1.seq).toBe(1);
    expect(e1.ts).toBe('2026-09-04T00:00:00.000Z');

    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).seq).toBe(3);

    const reopened = createJsonlStore({ dir, clock });
    const all = reopened.all();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all[1].type).toBe('progress_reported');
    expect(reopened.state().last_seq).toBe(3);

    const e4 = reopened.append(progress('three'));
    expect(e4.seq).toBe(4);
    expect(reopened.all(2).map((e) => e.seq)).toEqual([3, 4]);
    expect(reopened.state().last_seq).toBe(4);
  });

  it('creates an empty events.jsonl on open so the run is visible immediately', () => {
    const dir = tmp();
    createJsonlStore({ dir: path.join(dir, 'nested') });
    expect(fs.readFileSync(path.join(dir, 'nested', 'events.jsonl'), 'utf8')).toBe('');
  });

  it('subscribe fires synchronously after append with the event and fresh state', () => {
    const store = createJsonlStore({ dir: tmp() });
    const seen: number[] = [];
    const unsub = store.subscribe((ev, state) => {
      seen.push(ev.seq);
      expect(state.last_seq).toBe(ev.seq);
    });
    store.append(mission());
    expect(seen).toEqual([1]);
    unsub();
    store.append(progress('x'));
    expect(seen).toEqual([1]);
  });

  it('rejects an event that does not match the protocol schema', () => {
    const store = createJsonlStore({ dir: tmp() });
    expect(() =>
      store.append({ mission_id: 'm-1', actor: 'relayd', type: 'task_completed', payload: {} } as EventInput),
    ).not.toThrow();
    expect(() =>
      store.append({ mission_id: 'm-1', actor: 'nobody', type: 'task_completed', payload: {} } as unknown as EventInput),
    ).toThrow();
    expect(store.all()).toHaveLength(1);
  });
});

describe('jsonl store on an existing run log (daemon restart)', () => {
  it('continues seq numbering after the last recorded event and never reuses a seq', () => {
    const dir = tmp();
    const first = createJsonlStore({ dir });
    first.append(mission());
    first.append(progress('before restart'));
    first.append(progress('crash here'));
    expect(first.all().map((e) => e.seq)).toEqual([1, 2, 3]);

    // A new process opens the same directory: the tail seq is recovered from the file, not from memory.
    const resumed = createJsonlStore({ dir });
    expect(resumed.state().last_seq).toBe(3);
    const next = resumed.append(progress('after restart'));
    expect(next.seq).toBe(4);
    const seqs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq as number);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length);
    // A trailing partial line (crash mid-append) must not poison the reopen: it is dropped, numbering goes on.
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":5,"ts":"x"');
    const logged: string[] = [];
    const again = createJsonlStore({ dir, log: (m) => logged.push(m) });
    expect(again.all().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(logged[0]).toMatch(/partial trailing line/);
    expect(again.append(progress('recovered')).seq).toBe(5);
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3, 4, 5]);
    // Corruption before the tail is not masked.
    fs.writeFileSync(path.join(dir, 'events.jsonl'), lines[0] + '\n{"broken"\n' + lines[1] + '\n');
    expect(() => createJsonlStore({ dir })).toThrow(/unreadable event/);
  });
});
