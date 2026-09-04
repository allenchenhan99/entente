/**
 * Daemon restart: rebuild the orchestrator from the run's event log + workspace file and respawn every
 * agent that was alive in a fresh PTY that resumes its own session (PRD §5.3: state is derived from
 * events; §23: relayd hosts the panes, so a restart must bring them back).
 */

/** Runtime-agnostic prompt delivered to a resumed agent; it re-enters the protocol through relay_get_contract. */
export const RESUME_PROMPT =
  'relayd restarted. Your session was resumed. Call relay_get_contract, then continue exactly where you were: '
  + 'if you had submitted evidence, call relay_await_verdict; if you were waiting for clarification, call '
  + 'relay_await_contract; otherwise keep working.';
