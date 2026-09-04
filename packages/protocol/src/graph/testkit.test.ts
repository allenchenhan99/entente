/**
 * Shared helpers for graph tests: fixture loading and partial replays. Lives in a *.test.ts file so it is
 * excluded from the build.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Event } from '../events.js';
import { replay } from '../reducer.js';
import type { State } from '../state.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

export function loadFixture(name: string): Event[] {
  const text = fs.readFileSync(`${FIXTURES_DIR}${name}`, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => Event.parse(JSON.parse(line)));
}

/** Replay every event up to and including the first event matching `pred` (or all events when none). */
export function replayUntil(events: Event[], pred: (e: Event) => boolean): { state: State; events: Event[] } {
  const idx = events.findIndex(pred);
  const slice = idx === -1 ? events : events.slice(0, idx + 1);
  return { state: replay(slice), events: slice };
}

describe('graph testkit', () => {
  it('loads the live fixtures', () => {
    expect(loadFixture('events-live-4.jsonl').length).toBeGreaterThan(10);
  });
});
