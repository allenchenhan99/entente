import { readFileSync } from 'node:fs';

import { Event, type Event as RelayEvent } from '@relay/protocol';

export function parseJsonl(source: string, label = 'JSONL'): RelayEvent[] {
  const events: RelayEvent[] = [];
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    try {
      events.push(Event.parse(JSON.parse(line)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}:${index + 1}: invalid RelayGraph event: ${message}`, { cause: error });
    }
  }
  return events;
}

export function loadJsonlFile(file: string): RelayEvent[] {
  return parseJsonl(readFileSync(file, 'utf8'), file);
}
