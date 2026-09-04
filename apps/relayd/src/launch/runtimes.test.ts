import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, bootstrapPrompt } from './index.js';
import { ClaudeCodeRuntime } from './runtimes/claude-code.js';
import { CodexRuntime } from './runtimes/codex.js';
import type { LaunchSpec } from '../ports.js';

const spec: LaunchSpec = {
  taskId: 't-backend-auth',
  token: 'tok-secret-123',
  mcpUrl: 'http://127.0.0.1:7420/mcp',
  sessionId: '2b3f2c1e-1111-4222-8333-444455556666',
  cwd: '/repo/.relay/wt/t-backend-auth',
  role: 'recipient',
  contractSummary: 'Goal: add magic-link login.\nAC-1: tests pass.',
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('claude runtime', () => {
  it('prepare writes a valid mcp.json with the bearer header and returns the documented argv', async () => {
    const runtime = createRuntime('claude-code');
    expect(runtime.kind).toBe('claude-code');
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
    const configDir = path.join(tmp, 'cfg', 'nested');

    const { argv, env } = await runtime.prepare(spec, configDir);

    const mcpPath = path.join(configDir, 'mcp.json');
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(parsed).toEqual({
      mcpServers: { relay: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer ${spec.token}` } } },
    });

    expect(env).toEqual({});
    expect(argv[0]).toBe('claude');
    expect(argv.slice(1, 3)).toEqual(['--session-id', spec.sessionId]);
    expect(argv.slice(3, 5)).toEqual(['--mcp-config', mcpPath]);
    expect(argv.slice(5, 7)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(argv[7]).toBe('--allowedTools');
    // Claude's --allowedTools is variadic ("comma or space-separated"), so the tool list is one
    // comma-joined value; otherwise the trailing prompt would be swallowed as another tool name.
    expect(argv[8]).toBe('mcp__relay__*,Bash(npm *),Bash(npx *),Bash(node *),Bash(git *),Read,Edit,Write,Glob,Grep');
    expect(argv).toHaveLength(10);
    expect(argv[argv.length - 1]).toBe(bootstrapPrompt(spec));
    expect(Buffer.byteLength(argv[argv.length - 1]!, 'utf8')).toBeLessThan(6 * 1024);
  });

  it('uses the planner prompt for the planner role', async () => {
    const runtime = createRuntime('claude-code');
    const { argv } = await runtime.prepare({ ...spec, role: 'planner' }, tmp);
    expect(argv[argv.length - 1]).toBe(bootstrapPrompt({ ...spec, role: 'planner' }));
    expect(argv[argv.length - 1]).toContain('relay_propose_task');
  });
});

describe('codex runtime', () => {
  it('prepare writes config.toml with the relay MCP server and trust entry, and returns argv/env', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const runtime = createRuntime('codex', { homeDir: home });
    expect(runtime.kind).toBe('codex');
    expect(runtime).toBeInstanceOf(CodexRuntime);
    const configDir = path.join(tmp, 'codex-cfg');

    const { argv, env } = await runtime.prepare(spec, configDir);

    const toml = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.relay]\n');
    expect(toml).toContain(`url = "${spec.mcpUrl}"\n`);
    expect(toml).toContain('bearer_token_env_var = "RELAY_TOKEN"\n');
    expect(toml).toContain(`[projects."${spec.cwd}"]\ntrust_level = "trusted"\n`);

    expect(env).toEqual({ CODEX_HOME: configDir, RELAY_TOKEN: spec.token });
    expect(argv.slice(0, 7)).toEqual(['codex', '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write']);
    expect(argv).toHaveLength(8);
    expect(argv[7]).toBe(bootstrapPrompt(spec));
    expect(fs.existsSync(path.join(configDir, 'auth.json'))).toBe(false);
  });

  it('copies ~/.codex/auth.json into the isolated CODEX_HOME when it exists', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"x"}}');
    const runtime = createRuntime('codex', { homeDir: home });
    const configDir = path.join(tmp, 'codex-cfg');

    await runtime.prepare(spec, configDir);

    expect(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8')).toBe('{"tokens":{"access_token":"x"}}');
  });

  it('defaults homeDir to HOME from the injected env', async () => {
    const home = path.join(tmp, 'home2');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
    const runtime = createRuntime('codex', { env: { HOME: home } });
    const configDir = path.join(tmp, 'codex-cfg2');
    await runtime.prepare(spec, configDir);
    expect(fs.existsSync(path.join(configDir, 'auth.json'))).toBe(true);
  });

  it('grants the sandbox the roots the Codex shell host needs (CODEX_HOME, /tmp, runtime cache, git common dir) and disables browser/computer use', async () => {
    const home = path.join(tmp, 'home3');
    fs.mkdirSync(home, { recursive: true });
    // Simulate a linked worktree: <cwd>/.git is a file pointing into the main repo's .git/worktrees/<id>.
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 't-x'), { recursive: true });
    const cwd = path.join(repo, '.relay', 'wt', 't-x');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 't-x')}\n`);
    const runtime = createRuntime('codex', { homeDir: home });
    const configDir = path.join(tmp, 'codex-cfg3');

    await runtime.prepare({ ...spec, cwd }, configDir);

    const toml = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[sandbox_workspace_write]\n');
    const line = toml.split('\n').find((l) => l.startsWith('writable_roots = '))!;
    expect(line).toBeDefined();
    for (const root of [configDir, '/tmp', path.join(home, '.cache', 'codex-runtimes'), path.join(repo, '.git')]) {
      expect(line).toContain(`"${root}"`);
    }
    expect(toml).toContain('[features]\nbrowser_use = false\ncomputer_use = false\n');
  });

  it('escapes quotes and backslashes in the cwd trust key', async () => {
    const runtime = createRuntime('codex', { homeDir: tmp });
    const weird = { ...spec, cwd: 'C:\\repo\\wt "x"' };
    await runtime.prepare(weird, path.join(tmp, 'c'));
    const toml = fs.readFileSync(path.join(tmp, 'c', 'config.toml'), 'utf8');
    expect(toml).toContain('[projects."C:\\\\repo\\\\wt \\"x\\""]');
  });
});

describe('createRuntime', () => {
  it('rejects unknown kinds', () => {
    expect(() => createRuntime('gemini' as never)).toThrow(/runtime/);
  });
});
