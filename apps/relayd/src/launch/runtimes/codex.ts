/**
 * AgentRuntime for OpenAI Codex CLI.
 *
 * prepare() creates an isolated CODEX_HOME at `<configDir>` containing a `config.toml` that registers
 * relayd as the streamable-HTTP MCP server `relay` (bearer token read from `RELAY_TOKEN`) and trusts the
 * worktree, and returns
 *   codex -C <cwd> -a never -s workspace-write <prompt>
 * with env { CODEX_HOME, RELAY_TOKEN }.
 *
 * Because CODEX_HOME is isolated, Codex would otherwise start logged out: credentials live in
 * `~/.codex/auth.json`. We copy that file into the new CODEX_HOME when it exists so the agent keeps the
 * user's login without touching the user's real config.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, LaunchSpec } from '../../ports.js';
import { bootstrapPrompt } from '../prompts.js';

export interface CodexRuntimeDeps {
  /** Home directory holding `.codex/auth.json`; defaults to `env.HOME`, then `os.homedir()`. */
  homeDir?: string;
  /** Environment used to resolve HOME; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Executable name; defaults to `codex` on PATH. */
  executable?: string;
}

/** Escapes a string for a TOML basic (double-quoted) string. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function codexConfigToml(spec: Pick<LaunchSpec, 'mcpUrl' | 'cwd'>): string {
  return (
    '[mcp_servers.relay]\n' +
    `url = ${tomlString(spec.mcpUrl)}\n` +
    'bearer_token_env_var = "RELAY_TOKEN"\n' +
    '\n' +
    `[projects.${tomlString(spec.cwd)}]\n` +
    'trust_level = "trusted"\n'
  );
}

export class CodexRuntime implements AgentRuntime {
  readonly kind = 'codex' as const;
  private readonly homeDir: string;
  private readonly executable: string;

  constructor(deps: CodexRuntimeDeps = {}) {
    const env = deps.env ?? process.env;
    this.homeDir = deps.homeDir ?? env.HOME ?? os.homedir();
    this.executable = deps.executable ?? 'codex';
  }

  async prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string> }> {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.toml'), codexConfigToml(spec), { mode: 0o600 });
    await this.copyAuth(configDir);

    const argv = [this.executable, '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write', bootstrapPrompt(spec)];
    return { argv, env: { CODEX_HOME: configDir, RELAY_TOKEN: spec.token } };
  }

  /** Keeps the isolated CODEX_HOME logged in by copying the user's `~/.codex/auth.json` when present. */
  private async copyAuth(configDir: string): Promise<void> {
    const source = path.join(this.homeDir, '.codex', 'auth.json');
    try {
      await fs.access(source);
    } catch {
      return;
    }
    await fs.copyFile(source, path.join(configDir, 'auth.json'));
    await fs.chmod(path.join(configDir, 'auth.json'), 0o600).catch(() => undefined);
  }
}
