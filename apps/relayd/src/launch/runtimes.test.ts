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

/** `--dangerously-skip-permissions` needs the global disclaimer already accepted; see claude-code.ts. */
function acceptBypass(home: string): void {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ bypassPermissionsModeAccepted: true }));
}

describe('claude runtime', () => {
  it('prepare writes a valid mcp.json with the bearer header and returns the documented argv', async () => {
    acceptBypass(tmp);
    const runtime = createRuntime('claude-code', { homeDir: tmp });
    expect(runtime.kind).toBe('claude-code');
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
    const configDir = path.join(tmp, 'cfg', 'nested');

    const { argv, env, prompt } = await runtime.prepare(spec, configDir);

    const mcpPath = path.join(configDir, 'mcp.json');
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(parsed).toEqual({
      mcpServers: { relay: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer ${spec.token}` } } },
    });

    expect(env).toEqual({});
    expect(argv[0]).toBe('claude');
    expect(argv.slice(1, 3)).toEqual(['--session-id', spec.sessionId]);
    expect(argv.slice(3, 5)).toEqual(['--mcp-config', mcpPath]);
    expect(argv[5]).toBe('--dangerously-skip-permissions');
    expect(argv[6]).toBe('--allowedTools');
    // Claude's --allowedTools is variadic ("comma or space-separated"), so the tool list is one
    // comma-joined value; otherwise the trailing prompt would be swallowed as another tool name.
    expect(argv[7]).toBe('mcp__relay__*,Bash(npm *),Bash(npx *),Bash(node *),Bash(git *),Read,Edit,Write,Glob,Grep');
    expect(argv).toHaveLength(8);
    expect(prompt).toBe(bootstrapPrompt(spec));
    expect(Buffer.byteLength(prompt!, 'utf8')).toBeLessThan(6 * 1024);
  });

  it('uses the planner prompt for the planner role', async () => {
    acceptBypass(tmp);
    const runtime = createRuntime('claude-code', { homeDir: tmp });
    const { prompt } = await runtime.prepare({ ...spec, role: 'planner' }, tmp);
    expect(prompt).toBe(bootstrapPrompt({ ...spec, role: 'planner' }));
    expect(prompt).toContain('relay_propose_task');
  });

  // Observed live: without the accepted disclaimer Claude stops on the Bypass Permissions dialog with
  // "No, exit" preselected, the prompt's Enter takes it, and the host reports only `agent_not_found`.
  it('refuses to prepare with an actionable error when the bypass disclaimer is not accepted', async () => {
    const runtime = createRuntime('claude-code', { homeDir: tmp, env: {} });
    await expect(runtime.prepare(spec, path.join(tmp, 'cfg'))).rejects.toThrow(
      /has not accepted the Bypass Permissions disclaimer/,
    );
    await expect(runtime.prepare(spec, path.join(tmp, 'cfg'))).rejects.toThrow(
      /claude --dangerously-skip-permissions.*RELAY_ACCEPT_CLAUDE_BYPASS=1/s,
    );
    // It must not have recorded the acceptance on the user's behalf.
    expect(fs.existsSync(path.join(tmp, '.claude.json'))).toBe(false);
  });

  it('accepts the migrated user-settings form of the disclaimer', async () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));

    const runtime = createRuntime('claude-code', { homeDir: tmp, env: {} });
    await expect(runtime.prepare(spec, path.join(tmp, 'cfg'))).resolves.toBeDefined();
  });

  it('records the disclaimer itself only when RELAY_ACCEPT_CLAUDE_BYPASS=1, preserving other config', async () => {
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ projects: { '/keep/me': { hasTrustDialogAccepted: true } } }));
    const runtime = createRuntime('claude-code', { homeDir: tmp, env: { RELAY_ACCEPT_CLAUDE_BYPASS: '1' } });

    await runtime.prepare(spec, path.join(tmp, 'cfg'));

    const written = JSON.parse(fs.readFileSync(path.join(tmp, '.claude.json'), 'utf8'));
    expect(written.bypassPermissionsModeAccepted).toBe(true);
    expect(written.projects['/keep/me']).toEqual({ hasTrustDialogAccepted: true });
    expect(written.projects[spec.cwd]).toMatchObject({ hasTrustDialogAccepted: true });
  });
});

describe('claude runtime folder trust', () => {
  it('marks the worktree as trusted in ~/.claude.json so no trust dialog swallows the bootstrap prompt', async () => {
    const home = path.join(tmp, 'claude-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ bypassPermissionsModeAccepted: true, projects: { '/other': { allowedTools: ['Read'], hasTrustDialogAccepted: true } }, theme: 'dark' }));
    const runtime = createRuntime('claude-code', { homeDir: home, env: {} });
    await runtime.prepare(spec, path.join(tmp, 'cfg-trust'));
    const json = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(json.projects[spec.cwd]).toMatchObject({ hasTrustDialogAccepted: true, allowedTools: [] });
    expect(json.projects['/other']).toEqual({ allowedTools: ['Read'], hasTrustDialogAccepted: true });
    expect(json.theme).toBe('dark');
    expect(json.bypassPermissionsModeAccepted).toBe(true);
  });

  it('creates ~/.claude.json when missing and keeps existing project settings', async () => {
    const home = path.join(tmp, 'claude-home2');
    fs.mkdirSync(home, { recursive: true });
    const runtime = createRuntime('claude-code', { homeDir: home, env: { RELAY_ACCEPT_CLAUDE_BYPASS: '1' } });
    await runtime.prepare(spec, path.join(tmp, 'cfg-trust2'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [spec.cwd]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, extra: 1 } } }));
    await runtime.prepare(spec, path.join(tmp, 'cfg-trust2'));
    const json = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(json.projects[spec.cwd]).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true, extra: 1 });
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

    const { argv, env, prompt } = await runtime.prepare(spec, configDir);

    const toml = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.relay]\n');
    expect(toml).toContain(`url = "${spec.mcpUrl}"\n`);
    expect(toml).toContain('bearer_token_env_var = "RELAY_TOKEN"\n');
    expect(toml).toContain('default_tools_approval_mode = "approve"\n');
    expect(toml).toContain(`[projects."${spec.cwd}"]\ntrust_level = "trusted"\n`);

    expect(env).toEqual({ CODEX_HOME: configDir, RELAY_TOKEN: spec.token });
    expect(argv.slice(0, 7)).toEqual(['codex', '-C', spec.cwd, '-a', 'never', '-s', 'workspace-write']);
    expect(argv).toHaveLength(7);
    expect(prompt).toBe(bootstrapPrompt(spec));
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
    expect(line).not.toContain('node_modules');
    expect(toml).toContain('[features]\napps = false\nbrowser_use = false\ncomputer_use = false\n');
  });

  it('adds the real node_modules directory to writable_roots when the worktree links it from outside', async () => {
    const home = path.join(tmp, 'home4');
    const repo = path.join(tmp, 'repo4');
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const cwd = path.join(repo, '.relay', 'wt', 't-y');
    fs.mkdirSync(cwd, { recursive: true });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
    const runtime = createRuntime('codex', { homeDir: home });
    const configDir = path.join(tmp, 'codex-cfg4');
    await runtime.prepare({ ...spec, cwd }, configDir);
    const line = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8').split('\n').find((l) => l.startsWith('writable_roots = '))!;
    expect(line).toContain(`"${fs.realpathSync(path.join(repo, 'node_modules'))}"`);
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

describe('model selection', () => {
  it('claude-code passes the model when one is configured, and nothing when it is not', async () => {
    acceptBypass(tmp);
    const chosen = new ClaudeCodeRuntime({ homeDir: tmp, env: { HOME: tmp, RELAY_CLAUDE_MODEL: 'haiku' } });
    const { argv } = await chosen.prepare(spec, path.join(tmp, 'cfg'));
    expect(argv.join(' ')).toContain('--model haiku');

    const fallback = new ClaudeCodeRuntime({ homeDir: tmp, env: { HOME: tmp } });
    const plain = await fallback.prepare(spec, path.join(tmp, 'cfg2'));
    expect(plain.argv).not.toContain('--model');
  });

  it('codex passes the model too: its isolated CODEX_HOME ignores the user config.toml', async () => {
    const chosen = new CodexRuntime({ homeDir: tmp, env: { HOME: tmp, RELAY_CODEX_MODEL: 'luna' } });
    const { argv } = await chosen.prepare(spec, path.join(tmp, 'cfg'));
    expect(argv.join(' ')).toContain('--model luna');

    const fallback = new CodexRuntime({ homeDir: tmp, env: { HOME: tmp } });
    const plain = await fallback.prepare(spec, path.join(tmp, 'cfg2'));
    expect(plain.argv).not.toContain('--model');
  });

  it('an explicit dep beats the environment', async () => {
    const runtime = new CodexRuntime({
      homeDir: tmp,
      env: { HOME: tmp, RELAY_CODEX_MODEL: 'from-env' },
      model: 'explicit',
    });
    const { argv } = await runtime.prepare(spec, path.join(tmp, 'cfg'));
    expect(argv.join(' ')).toContain('--model explicit');
  });

  it('the model survives a daemon restart, so a resumed agent is not silently downgraded', async () => {
    acceptBypass(tmp);
    const claude = new ClaudeCodeRuntime({ homeDir: tmp, env: { HOME: tmp, RELAY_CLAUDE_MODEL: 'haiku' } });
    const resumed = await claude.resume(spec, path.join(tmp, 'cfg'));
    expect(resumed.argv.join(' ')).toContain('--model haiku');

    const codex = new CodexRuntime({ homeDir: tmp, env: { HOME: tmp, RELAY_CODEX_MODEL: 'luna' } });
    const codexResumed = await codex.resume(spec, path.join(tmp, 'cfg3'));
    expect(codexResumed.argv.join(' ')).toContain('--model luna');
  });
});
