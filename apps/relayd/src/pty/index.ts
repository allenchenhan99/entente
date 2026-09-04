/** Relay Terminal host (PRD §23): `createRelayHost` plus the pieces `http/pty.ts` mounts. */
export { createRelayHost, RelayHost, PaneNotFoundError, DEFAULT_PROMPT_TIMINGS } from './host.js';
export type { RelayHostDeps, RelaySpawnOptions, PromptTimings, WaitOutputOptions } from './host.js';
export { Pane, RING_CAPACITY, DEFAULT_COLS, DEFAULT_ROWS, KILL_GRACE_MS } from './pane.js';
export type { PaneOptions } from './pane.js';
export { readScreen } from './screen.js';
export type { ScreenQuery } from './screen.js';
export { evaluateReadiness, QUIET_MS } from './readiness.js';
export { keyToBytes, keysToBytes, UnknownKeyError } from './keys.js';
export { CastRecorder } from './recorder.js';
export { createPtyWebSocketServer } from './ws.js';
export type { PtyUpgradeHandler } from './ws.js';
