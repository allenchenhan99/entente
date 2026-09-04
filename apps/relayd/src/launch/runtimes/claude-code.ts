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
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = 'claude-code' as const;
  private readonly executable: string;

  constructor(deps: ClaudeCodeRuntimeDeps = {}) {
    this.executable = deps.executable ?? 'claude';
  }

  async prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string> }> {
    await fs.mkdir(configDir, { recursive: true });
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
      '--permission-mode', 'acceptEdits',
      '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
      bootstrapPrompt(spec),
    ];
    return { argv, env: {} };
  }
}
