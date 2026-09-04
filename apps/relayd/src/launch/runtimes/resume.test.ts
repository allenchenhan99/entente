import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeRuntime } from './claude-code.js';
import { CodexRuntime, findCodexSessionId } from './codex.js';
import { fakeRuntime } from '../../fakes/runtime.js';
import { RESUME_PROMPT } from '../../persist/restore.js';
import type { LaunchSpec } from '../../ports.js';

const spec: LaunchSpec = {
  taskId: 't-backend-auth',
  token: 'tok-new-456',
  mcpUrl: 'http://127.0.0.1:7421/mcp',
  sessionId: '2b3f2c1e-1111-4222-8333-444455556666',
  cwd: '/repo/.relay/wt/t-backend-auth',
  role: 'recipient',
  contractSummary: 'Goal: add magic-link login.',
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('claude runtime resume', () => {
  it('resume rewrites the config files and returns `claude --resume <id> …` with no positional prompt', async () => {
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ bypassPermissionsModeAccepted: true }));
    const runtime = new ClaudeCodeRuntime({ homeDir: tmp, env: {} });
    const configDir = path.join(tmp, 'cfg');
    const first = await runtime.prepare({ ...spec, token: 'tok-old-123' }, configDir);
    expect(first.argv).toContain('--session-id');

    const { argv, env, prompt } = await runtime.resume(spec, configDir);

    const mcpPath = path.join(configDir, 'mcp.json');
    // Tokens are re-issued on restart: the regenerated mcp.json carries the new one.
    expect(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.relay.headers.Authorization).toBe('Bearer tok-new-456');
    expect(argv).toEqual([
      'claude', '--resume', spec.sessionId, '--mcp-config', mcpPath, '--dangerously-skip-permissions',
      '--allowedTools', 'mcp__relay__*,Bash(npm *),Bash(npx *),Bash(node *),Bash(git *),Read,Edit,Write,Glob,Grep',
    ]);
    expect(argv).not.toContain('--session-id');
    expect(argv.some((a) => a.includes(spec.contractSummary))).toBe(false);
    expect(env).toEqual({});
    expect(prompt).toBe(RESUME_PROMPT);
  });
});

describe('codex runtime resume', () => {
  const rollout = (home: string, day: string, stamp: string, id: string) => {
    const dir = path.join(home, 'sessions', ...day.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-${stamp}-${id}.jsonl`), '{}\n');
  };

  it('resume uses `codex resume <id>` when the isolated CODEX_HOME has a rollout file', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const runtime = new CodexRuntime({ homeDir: home });
    const configDir = path.join(tmp, 'codex-cfg');
    await runtime.prepare(spec, configDir);
    rollout(configDir, '2026/09/04', '2026-09-04T11-16-58', '019cf774-40ed-7253-ab1a-b48ee6c6d8ea');
    rollout(configDir, '2026/09/04', '2026-09-04T12-30-00', '019d0fb7-d3fb-7b40-a542-7f25249e0fb3');

    const { argv, env, prompt } = await runtime.resume(spec, configDir);

    expect(argv).toEqual(['codex', '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write', 'resume', '019d0fb7-d3fb-7b40-a542-7f25249e0fb3']);
    expect(env).toEqual({ CODEX_HOME: configDir, RELAY_TOKEN: spec.token });
    expect(prompt).toBe(RESUME_PROMPT);
    expect(fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8')).toContain(`url = "${spec.mcpUrl}"`);
  });

  it('resume falls back to `codex resume --last` when no session file exists under the isolated home', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const runtime = new CodexRuntime({ homeDir: home });
    const configDir = path.join(tmp, 'codex-cfg');

    const { argv } = await runtime.resume(spec, configDir);

    expect(argv).toEqual(['codex', '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write', 'resume', '--last']);
    expect(await findCodexSessionId(configDir)).toBeUndefined();
  });

  it('findCodexSessionId picks the newest rollout across day directories', async () => {
    const home = path.join(tmp, 'h');
    rollout(home, '2026/09/03', '2026-09-03T23-59-59', 'aaaaaaaa-0000-0000-0000-000000000001');
    rollout(home, '2026/09/04', '2026-09-04T00-00-01', 'bbbbbbbb-0000-0000-0000-000000000002');
    expect(await findCodexSessionId(home)).toBe('bbbbbbbb-0000-0000-0000-000000000002');
  });
});

describe('fake runtime resume', () => {
  it("returns argv ['fake-agent','resume',sessionId] and records the call", async () => {
    const rt = fakeRuntime('codex');
    const out = await rt.resume(spec, '/cfg');
    expect(out.argv).toEqual(['fake-agent', 'resume', spec.sessionId]);
    expect(out.env).toEqual({ RELAY_TOKEN: spec.token, RELAY_MCP_URL: spec.mcpUrl, RELAY_SESSION_ID: spec.sessionId });
    expect(rt.calls).toEqual([{ spec, configDir: '/cfg', mode: 'resume' }]);
  });
});
