/**
 * Append-only JSONL event store. One `Event` JSON per line in `<dir>/events.jsonl`.
 * `seq` is monotonic and recovered from the file tail on open; `ts` comes from an injectable clock.
 * Derived `State` is `replay(all())`, memoized by `last_seq`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Event, replay, initialState } from '@relay/protocol';
import type { EventInput, State } from '@relay/protocol';
import type { EventStore } from '../ports.js';

export interface JsonlStoreOptions {
  dir: string;
  /** Returns an ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  clock?: () => string;
  log?: (message: string) => void;
}

export interface JsonlStore extends EventStore {
  readonly file: string;
}

export function createJsonlStore(opts: JsonlStoreOptions): JsonlStore {
  const clock = opts.clock ?? (() => new Date().toISOString());
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, 'events.jsonl');

  const events: Event[] = [];
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  else {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let consumed = 0;
    lines.forEach((line, i) => {
      if (!line.trim()) {
        consumed += line.length + 1;
        return;
      }
      try {
        events.push(Event.parse(JSON.parse(line)));
        consumed += line.length + 1;
      } catch (err) {
        // A partial LAST line is what a crash mid-append leaves behind: drop it so the run can be reopened
        // (daemon restart). Anything unreadable before the tail is real corruption and must not be masked.
        const isTail = lines.slice(i + 1).every((l) => !l.trim());
        if (!isTail) throw new Error(`${file}:${i + 1}: unreadable event: ${(err as Error).message}`);
        opts.log?.(`${file}: dropping partial trailing line (${line.length} bytes) left by an interrupted append`);
        fs.truncateSync(file, Buffer.byteLength(text.slice(0, consumed), 'utf8'));
      }
    });
  }
  let lastSeq = events.length ? events[events.length - 1].seq : 0;

  let cached: State = initialState();
  const state = (): State => {
    if (cached.last_seq === lastSeq) return cached;
    cached = replay(events.filter((e) => e.seq > cached.last_seq), cached);
    return cached;
  };

  const listeners = new Set<(event: Event, state: State) => void>();

  return {
    file,
    append(input: EventInput): Event {
      const event = Event.parse({ seq: lastSeq + 1, ts: clock(), ...input });
      fs.appendFileSync(file, JSON.stringify(event) + '\n');
      events.push(event);
      lastSeq = event.seq;
      const s = state();
      for (const l of [...listeners]) l(event, s);
      return event;
    },
    all(sinceSeq = 0): Event[] {
      return sinceSeq <= 0 ? [...events] : events.filter((e) => e.seq > sinceSeq);
    },
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
