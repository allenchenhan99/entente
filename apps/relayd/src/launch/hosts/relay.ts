/**
 * TerminalHost `relay`: relayd hosts the agent terminals itself with node-pty (PRD §23). The implementation
 * lives in `../../pty/`; this file only exists so `createTerminalHost('relay', deps)` sits next to its siblings.
 */
export { createRelayHost, RelayHost } from '../../pty/host.js';
export type { RelayHostDeps } from '../../pty/host.js';
