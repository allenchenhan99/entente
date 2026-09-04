/**
 * AgentRuntime for Claude Code.
 *
 * prepare() writes `<configDir>/mcp.json` pointing at relayd's streamable-HTTP MCP endpoint with the
 * task's bearer token, and returns
 *   claude --session-id <id> --mcp-config <path> --permission-mode acceptEdits --allowedTools <list> <prompt>
 * `--allowedTools` is variadic ("comma or space-separated" per `claude --help`), so the list is passed
 * as ONE comma-joined value; separate values would swallow the trailing prompt as a tool name.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, LaunchSpec } from '../../ports.js';
import { bootstrapPrompt } from '../prompts.js';

export const CLAUDE_ALLOWED_TOOLS = [
  'mcp__relay__*',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(git *)',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
] as const;

export interface ClaudeCodeRuntimeDeps {
  /** Executable name; defaults to `claude` on PATH. */
  executable?: string;
  /** Home directory holding `.claude.json`; defaults to `env.HOME`, then `os.homedir()`. */
  homeDir?: string;
  /** Environment used to resolve HOME; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * `--dangerously-skip-permissions` is gated behind a one-time, GLOBAL disclaimer ("you accept all
 * responsibility for actions taken while running in Bypass Permissions mode"), which is separate from
 * the per-directory trust dialog. Claude Code records acceptance as `bypassPermissionsModeAccepted` in
 * `~/.claude.json`, migrating to `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`.
 *
 * Unaccepted, the agent stops on the dialog with "No, exit" preselected, the bootstrap prompt's Enter
 * chooses it, Claude exits, and the host only sees Herdr's `agent_not_found` ~45 s later. Detecting it
 * up front turns that into an actionable error. relayd does NOT accept it silently: unlike the
 * worktree-scoped trust flag, this one applies to every future `claude` run by this user, so it stays a
 * human decision unless `RELAY_ACCEPT_CLAUDE_BYPASS=1` opts in.
 */
export const BYPASS_OPT_IN_ENV = 'RELAY_ACCEPT_CLAUDE_BYPASS';

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = 'claude-code' as const;
  private readonly executable: string;
  private readonly homeDir: string;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: ClaudeCodeRuntimeDeps = {}) {
    const env = deps.env ?? process.env;
    this.executable = deps.executable ?? 'claude';
    this.homeDir = deps.homeDir ?? env.HOME ?? os.homedir();
    this.env = env;
  }

  private async readJson(file: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private get claudeJson(): string { return path.join(this.homeDir, '.claude.json'); }
  private get userSettings(): string { return path.join(this.homeDir, '.claude', 'settings.json'); }

  /** True when the global Bypass Permissions disclaimer has been accepted, in either storage location. */
  private async bypassAccepted(): Promise<boolean> {
    const [legacy, settings] = await Promise.all([
      this.readJson(this.claudeJson),
      this.readJson(this.userSettings),
    ]);
    return legacy.bypassPermissionsModeAccepted === true || settings.skipDangerousModePermissionPrompt === true;
  }

  /** Records the disclaimer as accepted. Only reached with `RELAY_ACCEPT_CLAUDE_BYPASS=1`. */
  private async acceptBypass(): Promise<void> {
    const root = await this.readJson(this.claudeJson);
    root.bypassPermissionsModeAccepted = true;
    await this.writeJsonAtomic(this.claudeJson, root);
  }

  private async requireBypassAccepted(): Promise<void> {
    if (await this.bypassAccepted()) return;
    if (this.env[BYPASS_OPT_IN_ENV] === '1') {
      await this.acceptBypass();
      return;
    }
    throw new Error(
      'claude-code runtime: Claude Code has not accepted the Bypass Permissions disclaimer, so an unattended '
      + 'agent would stop on that dialog and exit. Run `claude --dangerously-skip-permissions` once '
      + `interactively and accept it, or start relayd with ${BYPASS_OPT_IN_ENV}=1 to record the acceptance `
      + `in ${this.claudeJson} automatically.`,
    );
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.relay-${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  /**
   * Claude Code shows a "do you trust this folder?" dialog the first time it starts in a directory. An
   * unattended agent cannot answer it, and any typed prompt lands in the dialog instead (selecting
   * "No, exit"). Pre-record the worktree as trusted in `~/.claude.json`, touching nothing else.
   */
  private async trustFolder(cwd: string): Promise<void> {
    const root = await this.readJson(this.claudeJson);
    const projects = (root.projects ??= {}) as Record<string, Record<string, unknown>>;
    const existing = projects[cwd] ?? {};
    projects[cwd] = { allowedTools: [], ...existing, hasTrustDialogAccepted: true };
    await this.writeJsonAtomic(this.claudeJson, root);
  }

  async prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt: string }> {
    await this.requireBypassAccepted();
    await fs.mkdir(configDir, { recursive: true });
    await this.trustFolder(spec.cwd);
    const mcpPath = path.join(configDir, 'mcp.json');
    const mcpConfig = {
      mcpServers: {
        relay: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer ${spec.token}` } },
      },
    };
    await fs.writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', { mode: 0o600 });

    const argv = [
      this.executable,
      '--session-id', spec.sessionId,
      '--mcp-config', mcpPath,
      // Unattended agents cannot answer permission dialogs (any `ls`/`cat`/`mkdir` outside the allowlist, or a
      // read through the node_modules symlink, would block forever). Isolation comes from the git worktree and
      // scope.allowed_paths + diff_scope verification, not from Claude's interactive prompts.
      '--dangerously-skip-permissions',
      '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
    ];
    return { argv, env: {}, prompt: bootstrapPrompt(spec) };
  }
}
