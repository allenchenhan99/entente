import { fileURLToPath } from 'node:url';

import { initialState, replay } from '@relay/protocol';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { loadJsonlFile } from './jsonl.js';
import { type ReplayView, useReplay } from './replay.js';

const fixturePath = (name: string) => fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));

function ReplayProbe({ file }: { file: string }) {
  const view = useReplay(file, 1, false);
  useInput((input) => {
    if (input === '>') view.step(1);
    if (input === '<') view.step(-1);
    if (input === '0') view.seek(0);
  });
  return <Text>{`${view.cursor}/${view.total} seq=${view.state.last_seq}`}</Text>;
}

function frame(view: ReturnType<typeof render>): string {
  return view.lastFrame() ?? '';
}

const flushRender = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('replay', () => {
  it('loads and replays the merged happy fixture with the real protocol reducer', () => {
    const events = loadJsonlFile(fixturePath('events-happy.jsonl'));
    const state = replay(events);

    expect(events).toHaveLength(52);
    expect(state.last_seq).toBe(52);
    expect(state.missions['m-001']?.status).toBe('verified');
    expect(Object.values(state.tasks).every((task) => task.handoff_state === 'verified')).toBe(true);
  });

  it('loads the merged repair fixture and exposes its retry state during replay', () => {
    const events = loadJsonlFile(fixturePath('events-repair.jsonl'));
    const repairIndex = events.findIndex((event) => event.type === 'repair_requested');
    const repairState = replay(events.slice(0, repairIndex + 1));

    expect(events).toHaveLength(69);
    expect(repairIndex).toBeGreaterThan(0);
    expect(repairState.tasks['t-backend-auth']?.handoff_state).toBe('retry_requested');
    expect(repairState.tasks['t-backend-auth']?.active_repair?.failed_criteria).toEqual(['AC-2']);
  });

  it('steps cursor and last_seq together, and seek zero restores initialState', async () => {
    const view = render(<ReplayProbe file={fixturePath('events-happy.jsonl')} />);

    expect(frame(view)).toBe('0/52 seq=0');
    view.stdin.write('>');
    await flushRender();
    expect(frame(view)).toBe('1/52 seq=1');
    view.stdin.write('>');
    await flushRender();
    expect(frame(view)).toBe('2/52 seq=2');
    view.stdin.write('<');
    await flushRender();
    expect(frame(view)).toBe('1/52 seq=1');
    view.stdin.write('0');
    await flushRender();
    expect(frame(view)).toBe(`0/52 seq=${initialState().last_seq}`);
  });

  it('exposes navigation and bounded speed controls', async () => {
    let current: ReplayView | undefined;
    function Capture() {
      current = useReplay(fixturePath('events-happy.jsonl'), 2, false);
      return <Text>{current.speed}</Text>;
    }
    const view = render(<Capture />);

    expect(current?.playing).toBe(false);
    current?.doubleSpeed();
    await flushRender();
    expect(frame(view)).toBe('4');
    current?.halveSpeed();
    await flushRender();
    expect(frame(view)).toBe('2');
    current?.toggle();
    await flushRender();
    expect(current?.playing).toBe(true);
  });
});
