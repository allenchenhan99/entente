/**
 * Launch work package: terminal hosts (Herdr, tmux), agent runtimes (Claude Code, Codex) and the
 * bootstrap prompts, all implementing the ports in `../ports.ts`.
 */
import type { AgentRuntime, TerminalHost } from '../ports.js';
import type { RuntimeKind } from '@relay/protocol';
import { HerdrHost, type HerdrHostDeps } from './hosts/herdr.js';
import { TmuxHost, type TmuxHostDeps } from './hosts/tmux.js';
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps } from './runtimes/claude-code.js';
import { CodexRuntime, type CodexRuntimeDeps } from './runtimes/codex.js';

export type { Exec, ExecOptions, ExecResult, ExecDeps } from './exec.js';
export { defaultExec } from './exec.js';
export { HerdrHost, type HerdrHostDeps } from './hosts/herdr.js';
export { TmuxHost, type TmuxHostDeps, shellQuote, shellJoin, TMUX_SESSION } from './hosts/tmux.js';
export { ClaudeCodeRuntime, type ClaudeCodeRuntimeDeps, CLAUDE_ALLOWED_TOOLS } from './runtimes/claude-code.js';
export { CodexRuntime, type CodexRuntimeDeps, codexConfigToml } from './runtimes/codex.js';
export { bootstrapPrompt, PROMPT_MAX_BYTES } from './prompts.js';

export type TerminalHostKind = TerminalHost['kind'];
export type TerminalHostDeps = HerdrHostDeps & TmuxHostDeps;

export function createTerminalHost(kind: TerminalHostKind, deps: TerminalHostDeps = {}): TerminalHost {
  switch (kind) {
    case 'herdr':
      return new HerdrHost(deps);
    case 'tmux':
      return new TmuxHost(deps);
    default:
      throw new Error(`unknown terminal host kind: ${String(kind)} (expected herdr or tmux)`);
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
