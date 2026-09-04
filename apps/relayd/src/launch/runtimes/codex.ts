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
 *
 * Sandbox: Codex's shell tool runs through a "code-mode host" process that must be able to write to
 * CODEX_HOME and `~/.cache/codex-runtimes`; under `workspace-write` those live outside the worktree, so the
 * host silently times out ("timed out negotiating with the code-mode host") and the agent has no shell.
 * We therefore grant `sandbox_workspace_write.writable_roots` = [CODEX_HOME, /tmp, the runtime cache, and
 * the repository's common `.git` dir (linked worktrees commit into `<repo>/.git/worktrees/<id>`)].
 * Browser/computer-use features are disabled so a coding agent never wanders into desktop automation.
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

export interface CodexSandboxRoots {
  configDir: string;
  homeDir: string;
  /** The repository's common git dir (e.g. `<repo>/.git`), or undefined when it cannot be determined. */
  gitCommonDir?: string;
}

export function codexConfigToml(spec: Pick<LaunchSpec, 'mcpUrl' | 'cwd'>, roots?: CodexSandboxRoots): string {
  let toml =
    '[mcp_servers.relay]\n' +
    `url = ${tomlString(spec.mcpUrl)}\n` +
    'bearer_token_env_var = "RELAY_TOKEN"\n' +
    // Without this every relay_* call stops for approval, which an unattended agent (approval policy `never`) can never grant.
    'default_tools_approval_mode = "approve"\n' +
    '\n' +
    `[projects.${tomlString(spec.cwd)}]\n` +
    'trust_level = "trusted"\n';
  if (roots) {
    const list = [roots.configDir, '/tmp', path.join(roots.homeDir, '.cache', 'codex-runtimes')];
    if (roots.gitCommonDir) list.push(roots.gitCommonDir);
    toml +=
      '\n[sandbox_workspace_write]\n' +
      `writable_roots = [${list.map(tomlString).join(', ')}]\n` +
      // `apps` adds a 30 s codex_apps MCP startup timeout for every agent; browser/computer use are desktop automation.
      '\n[features]\napps = false\nbrowser_use = false\ncomputer_use = false\n';
  }
  return toml;
}

/**
 * Resolves the common git dir for `cwd` without spawning git: a linked worktree has a `.git` *file*
 * containing `gitdir: <repo>/.git/worktrees/<id>`; a normal checkout has a `.git` directory.
 */
export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const dotGit = path.join(cwd, '.git');
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
    const content = (await fs.readFile(dotGit, 'utf8')).trim();
    const m = /^gitdir:\s*(.+)$/m.exec(content);
    if (!m) return undefined;
    const gitdir = path.resolve(cwd, m[1]!.trim());
    const idx = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    return idx >= 0 ? gitdir.slice(0, idx + 5) : gitdir;
  } catch {
    return undefined;
  }
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

  async prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt: string }> {
    await fs.mkdir(configDir, { recursive: true });
    const roots: CodexSandboxRoots = { configDir, homeDir: this.homeDir, gitCommonDir: await gitCommonDir(spec.cwd) };
    await fs.writeFile(path.join(configDir, 'config.toml'), codexConfigToml(spec, roots), { mode: 0o600 });
    await this.copyAuth(configDir);

    const argv = [this.executable, '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write'];
    return { argv, env: { CODEX_HOME: configDir, RELAY_TOKEN: spec.token }, prompt: bootstrapPrompt(spec) };
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
