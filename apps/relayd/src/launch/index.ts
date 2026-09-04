/**
 * Launch work package: terminal hosts (relay, relayterm), agent runtimes (Claude Code, Codex) and the
 * bootstrap prompts, all implementing the ports in `../ports.ts`.
 */
import type { AgentRuntime, TerminalHost } from '../ports.js';
import type { RuntimeKind } from '@relay/protocol';
import { createRelayHost, type RelayHostDeps } from './hosts/relay.js';
import { createRelaytermHost, type RelaytermHostDeps } from './hosts/relayterm.js';
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps } from './runtimes/claude-code.js';
import { CodexRuntime, type CodexRuntimeDeps } from './runtimes/codex.js';

export type { Exec, ExecOptions, ExecResult, ExecDeps } from './exec.js';
export { defaultExec } from './exec.js';
export { createRelayHost, RelayHost, type RelayHostDeps } from './hosts/relay.js';
export { createRelaytermHost, RelaytermHost, findTermdBinary, type RelaytermHostDeps } from './hosts/relayterm.js';
export { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps, CLAUDE_ALLOWED_TOOLS } from './runtimes/claude-code.js';
export { CodexRuntime, type CodexRuntimeDeps, codexConfigToml } from './runtimes/codex.js';
export { bootstrapPrompt, PROMPT_MAX_BYTES } from './prompts.js';

/** `relay` = the in-process PTY host; `relayterm` = relayd driving the Rust termd (PRD §22). */
export type TerminalHostKind = TerminalHost['kind'];
export type TerminalHostDeps = Partial<RelayHostDeps> & Partial<RelaytermHostDeps>;

export function createTerminalHost(kind: TerminalHostKind, deps: TerminalHostDeps = {}): TerminalHost {
  switch (kind) {
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
      throw new Error(`unknown terminal host kind: ${String(kind)} (expected relay or relayterm)`);
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
