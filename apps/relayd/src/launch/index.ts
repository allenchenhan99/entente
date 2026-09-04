/**
 * Launch work package: terminal hosts (Herdr, tmux, relay), agent runtimes (Claude Code, Codex) and the
 * bootstrap prompts, all implementing the ports in `../ports.ts`.
 */
import type { AgentRuntime, TerminalHost } from '../ports.js';
import type { RuntimeKind } from '@relay/protocol';
import { HerdrHost, type HerdrHostDeps } from './hosts/herdr.js';
import { TmuxHost, type TmuxHostDeps } from './hosts/tmux.js';
import { createRelayHost, type RelayHostDeps } from './hosts/relay.js';
import { createRelaytermHost, type RelaytermHostDeps } from './hosts/relayterm.js';
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps } from './runtimes/claude-code.js';
import { CodexRuntime, type CodexRuntimeDeps } from './runtimes/codex.js';

export type { Exec, ExecOptions, ExecResult, ExecDeps } from './exec.js';
export { defaultExec } from './exec.js';
export { HerdrHost, type HerdrHostDeps } from './hosts/herdr.js';
export { TmuxHost, type TmuxHostDeps, shellQuote, shellJoin, TMUX_SESSION } from './hosts/tmux.js';
export { createRelayHost, RelayHost, type RelayHostDeps } from './hosts/relay.js';
export { createRelaytermHost, RelaytermHost, findTermdBinary, type RelaytermHostDeps } from './hosts/relayterm.js';
export { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps, CLAUDE_ALLOWED_TOOLS } from './runtimes/claude-code.js';
export { CodexRuntime, type CodexRuntimeDeps, codexConfigToml } from './runtimes/codex.js';
export { bootstrapPrompt, PROMPT_MAX_BYTES } from './prompts.js';

/** `relay` is the in-process PTY host (PRD §23); the frozen port does not list it yet (see HANDOFF_NOTES.md). */
export type TerminalHostKind = TerminalHost['kind'];
export type TerminalHostDeps = HerdrHostDeps & TmuxHostDeps & Partial<RelayHostDeps> & Partial<RelaytermHostDeps>;

export function createTerminalHost(kind: TerminalHostKind, deps: TerminalHostDeps = {}): TerminalHost {
  switch (kind) {
    case 'herdr':
      return new HerdrHost(deps);
    case 'tmux':
      return new TmuxHost(deps);
    case 'relay': {
      if (!deps.relayDir || !deps.runId) throw new Error('relay host: relayDir and runId are required');
      const host = createRelayHost({ relayDir: deps.relayDir, runId: deps.runId, clock: deps.clock, timings: deps.timings });
      return host;
    }
    case 'relayterm': {
      // relayd drives the Rust termd (docs/relay-term-spec.md); casts land under <relayDir>/runs/<runId>/casts.
      if (!deps.relayDir || !deps.runId) throw new Error('relayterm host: relayDir and runId are required');
      return createRelaytermHost({
        relayDir: deps.relayDir, runId: deps.runId, binary: deps.binary, token: deps.token, env: deps.env, repoRoot: deps.repoRoot,
        startTimeoutMs: deps.startTimeoutMs, killGraceMs: deps.killGraceMs, log: deps.log,
      });
    }
    default:
      throw new Error(`unknown terminal host kind: ${String(kind)} (expected herdr, tmux, relay or relayterm)`);
  }
}

export type RuntimeDeps = ClaudeCodeRuntimeDeps & CodexRuntimeDeps;

export function createRuntime(kind: RuntimeKind, deps: RuntimeDeps = {}): AgentRuntime {
  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeRuntime(deps);
    case 'codex':
      return new CodexRuntime(deps);
    default:
      throw new Error(`unknown agent runtime kind: ${String(kind)} (expected claude-code or codex)`);
  }
}
