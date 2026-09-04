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

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = 'claude-code' as const;
  private readonly executable: string;
  private readonly homeDir: string;

  constructor(deps: ClaudeCodeRuntimeDeps = {}) {
    const env = deps.env ?? process.env;
    this.executable = deps.executable ?? 'claude';
    this.homeDir = deps.homeDir ?? env.HOME ?? os.homedir();
  }

  /**
   * Claude Code shows a "do you trust this folder?" dialog the first time it starts in a directory. An
   * unattended agent cannot answer it, and any typed prompt lands in the dialog instead (selecting
   * "No, exit"). Pre-record the worktree as trusted in `~/.claude.json`, touching nothing else.
   */
  private async trustFolder(cwd: string): Promise<void> {
    const file = path.join(this.homeDir, '.claude.json');
    let root: Record<string, unknown> = {};
    try {
      root = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      root = {};
    }
    const projects = (root.projects ??= {}) as Record<string, Record<string, unknown>>;
    const existing = projects[cwd] ?? {};
    projects[cwd] = { allowedTools: [], ...existing, hasTrustDialogAccepted: true };
    const tmp = `${file}.relay-${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(root, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt: string }> {
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
