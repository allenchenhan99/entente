/** In-memory TerminalHost: records spawns and kills, never opens a terminal. */
import type { TerminalHost, SpawnOptions } from '../ports.js';

export interface FakeHost extends TerminalHost {
  calls: { spawn: SpawnOptions[]; kill: string[]; focus: string[] };
  alive: Set<string>;
}

export function fakeHost(): FakeHost {
  let n = 0;
  const host: FakeHost = {
    kind: 'relay',
    calls: { spawn: [], kill: [], focus: [] },
    alive: new Set(),
    async spawn(opts) {
      host.calls.spawn.push({ ...opts, argv: [...opts.argv], env: { ...opts.env } });
      const paneId = `%fake-${++n}`;
      host.alive.add(paneId);
      return { paneId };
    },
    async focus(paneId) {
      host.calls.focus.push(paneId);
    },
    async isAlive(paneId) {
      return host.alive.has(paneId);
    },
    async kill(paneId) {
      host.calls.kill.push(paneId);
      host.alive.delete(paneId);
    },
  };
  return host;
}
