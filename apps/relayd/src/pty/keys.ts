/** Logical key names accepted by `POST /panes/:id/input` (`PaneInputBody.keys`) → terminal bytes. */

export class UnknownKeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown key: ${JSON.stringify(key)}`);
  }
}

const NAMED: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};

export function keyToBytes(key: string): string {
  const named = NAMED[key.toLowerCase()];
  if (named !== undefined) return named;
  const ctrl = /^ctrl\+([a-z])$/i.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) - 64);
  throw new UnknownKeyError(key);
}

/** Maps every key up front so an unknown key writes nothing to the pane. */
export function keysToBytes(keys: string[]): string {
  return keys.map(keyToBytes).join('');
}
