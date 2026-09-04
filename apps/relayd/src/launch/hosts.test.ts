import { describe, it, expect } from 'vitest';
import { createTerminalHost } from './index.js';
import { HerdrHost } from './hosts/herdr.js';
import { TmuxHost, shellQuote } from './hosts/tmux.js';
import type { Exec, ExecOptions, ExecResult } from './exec.js';

/** Fake executor: records every invocation and returns canned results (never starts a process). */
function fakeExec(handler: (argv: string[], opts?: ExecOptions) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: { argv: string[]; opts?: ExecOptions }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, opts });
    const r = handler(argv, opts) ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { exec, calls };
}

const splitJson = JSON.stringify({ id: 'cli:pane:split', result: { pane: { pane_id: 'w1:p7', tab_id: 'w1:t1', workspace_id: 'w1' }, type: 'pane_info' } });

describe('herdr host', () => {
  const spawnOpts = {
    name: 'backend',
    cwd: '/repo/.relay/wt/t-backend',
    argv: ['claude', '--session-id', 'abc'],
    env: { RELAY_TOKEN: 'tok', OTHER: 'a b' },
    prompt: 'bootstrap prompt\nline two',
  };

  it('spawn issues pane split, agent start, then delivers the prompt via agent prompt', async () => {
    const { exec, calls } = fakeExec((argv) => (argv[1] === 'pane' && argv[2] === 'split' ? { stdout: splitJson } : { stdout: '{}' }));
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    expect(host.kind).toBe('herdr');
    expect(host).toBeInstanceOf(HerdrHost);

    const { paneId } = await host.spawn(spawnOpts);

    expect(paneId).toBe('w1:p7');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.argv).toEqual([
      'herdr', 'pane', 'split', '--pane', 'w1:p1', '--direction', 'right', '--cwd', '/repo/.relay/wt/t-backend', '--no-focus',
      '--env', 'RELAY_TOKEN=tok', '--env', 'OTHER=a b',
    ]);
    expect(calls[1]!.argv).toEqual([
      'herdr', 'agent', 'start', 'backend', '--kind', 'claude', '--pane', 'w1:p7', '--', '--session-id', 'abc',
    ]);
    expect(calls[2]!.argv).toEqual(['herdr', 'agent', 'prompt', 'backend', 'bootstrap prompt\nline two']);
  });

  it('closes the pane and throws when the prompt cannot be delivered', async () => {
    const { exec, calls } = fakeExec((argv) => {
      if (argv[1] === 'pane' && argv[2] === 'split') return { stdout: splitJson };
      if (argv[1] === 'agent' && argv[2] === 'prompt') return { exitCode: 1, stderr: 'agent_prompt_stalled' };
      return { stdout: '{}' };
    });
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    await expect(host.spawn(spawnOpts)).rejects.toThrow(/agent prompt failed/);
    expect(calls.map((c) => c.argv.slice(0, 3))).toEqual([
      ['herdr', 'pane', 'split'], ['herdr', 'agent', 'start'], ['herdr', 'agent', 'prompt'], ['herdr', 'pane', 'close'],
    ]);
  });

  it('prefers RELAY_ANCHOR_PANE over HERDR_PANE_ID as the split anchor', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: splitJson }));
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1', RELAY_ANCHOR_PANE: 'w9:p2' } });
    await host.spawn(spawnOpts);
    expect(calls[0]!.argv.slice(3, 5)).toEqual(['--pane', 'w9:p2']);
  });

  it('maps runtime executables to herdr agent kinds (claude-code → claude, codex → codex)', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: splitJson }));
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    await host.spawn({ ...spawnOpts, argv: ['codex', '-C', '/x', 'prompt'] });
    expect(calls[1]!.argv).toEqual(['herdr', 'agent', 'start', 'backend', '--kind', 'codex', '--pane', 'w1:p7', '--', '-C', '/x', 'prompt']);
    await host.spawn({ ...spawnOpts, argv: ['/opt/bin/claude-code', 'p'] });
    expect(calls[4]!.argv.slice(4, 6)).toEqual(['--kind', 'claude']);
  });

  it('omits --env when the env is empty', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: splitJson }));
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    await host.spawn({ ...spawnOpts, env: {} });
    expect(calls[0]!.argv).not.toContain('--env');
  });

  it('fails fast without an anchor pane, an invalid name, or an unknown runtime', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: splitJson }));
    await expect(createTerminalHost('herdr', { exec, env: {} }).spawn(spawnOpts)).rejects.toThrow(/RELAY_ANCHOR_PANE|HERDR_PANE_ID/);
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    await expect(host.spawn({ ...spawnOpts, name: 'Bad Name' })).rejects.toThrow(/name/);
    await expect(host.spawn({ ...spawnOpts, argv: ['vim'] })).rejects.toThrow(/runtime|kind/);
    expect(calls).toHaveLength(0);
  });

  it('throws when pane split fails or returns no pane id', async () => {
    const failing = fakeExec(() => ({ exitCode: 1, stderr: '{"error":"no such pane"}' }));
    await expect(createTerminalHost('herdr', { exec: failing.exec, env: { HERDR_PANE_ID: 'w1:p1' } }).spawn(spawnOpts)).rejects.toThrow(/no such pane/);
    const noId = fakeExec(() => ({ stdout: '{"result":{}}' }));
    await expect(createTerminalHost('herdr', { exec: noId.exec, env: { HERDR_PANE_ID: 'w1:p1' } }).spawn(spawnOpts)).rejects.toThrow(/pane_id/);
  });

  it('closes the new pane and throws when agent start fails', async () => {
    const { exec, calls } = fakeExec((argv) => {
      if (argv[1] === 'pane' && argv[2] === 'split') return { stdout: splitJson };
      if (argv[1] === 'agent' && argv[2] === 'start') return { exitCode: 1, stderr: 'agent_start_timeout' };
      return {};
    });
    const host = createTerminalHost('herdr', { exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    await expect(host.spawn(spawnOpts)).rejects.toThrow(/agent_start_timeout/);
    expect(calls.map((c) => c.argv.slice(0, 3))).toEqual([
      ['herdr', 'pane', 'split'],
      ['herdr', 'agent', 'start'],
      ['herdr', 'pane', 'close'],
    ]);
    expect(calls[2]!.argv).toEqual(['herdr', 'pane', 'close', 'w1:p7']);
  });

  it('focus, isAlive and kill build the documented commands', async () => {
    const { exec, calls } = fakeExec((argv) => (argv[3] === 'w1:p9' ? { exitCode: 1, stderr: 'not found' } : {}));
    const host = createTerminalHost('herdr', { exec, env: {} });
    await host.focus('w1:p7');
    expect(await host.isAlive('w1:p7')).toBe(true);
    expect(await host.isAlive('w1:p9')).toBe(false);
    await host.kill('w1:p7');
    expect(calls.map((c) => c.argv)).toEqual([
      ['herdr', 'agent', 'focus', 'w1:p7'],
      ['herdr', 'agent', 'get', 'w1:p7'],
      ['herdr', 'agent', 'get', 'w1:p9'],
      ['herdr', 'pane', 'close', 'w1:p7'],
    ]);
  });
});

describe('tmux host', () => {
  const prompt = 'Line one with spaces\n"double" and \'single\' quotes; $HOME `tick`';

  it('shellQuote round-trips through sh', () => {
    expect(shellQuote('plain-arg_1')).toBe('plain-arg_1');
    expect(shellQuote('has space')).toBe("'has space'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('a\nb')).toBe("'a\nb'");
    expect(shellQuote('')).toBe("''");
  });

  it('spawn splits the relay session with a shell-quoted command and returns the pane id', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '%5\n' }));
    const host = createTerminalHost('tmux', { exec });
    expect(host.kind).toBe('tmux');
    expect(host).toBeInstanceOf(TmuxHost);

    const { paneId } = await host.spawn({ name: 'frontend', cwd: '/repo/wt', argv: ['claude', '--session-id', 'abc', prompt], env: {} });

    expect(paneId).toBe('%5');
    expect(calls).toHaveLength(1);
    const argv = calls[0]!.argv;
    expect(argv.slice(0, 9)).toEqual(['tmux', 'split-window', '-t', 'relay', '-c', '/repo/wt', '-P', '-F', '#{pane_id}']);
    expect(argv).toHaveLength(10);
    expect(argv[9]).toBe(`claude --session-id abc 'Line one with spaces\n"double" and '\\''single'\\'' quotes; $HOME \`tick\`'`);
  });

  it('appends the prompt as the final shell-quoted argument', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '%7' }));
    const host = createTerminalHost('tmux', { exec });
    await host.spawn({ name: 'x', cwd: '/w', argv: ['claude', '--session-id', 'abc'], env: {}, prompt: 'do it now' });
    expect(calls[0]!.argv[9]).toBe("claude --session-id abc 'do it now'");
  });

  it('prefixes env assignments with env(1), quoted', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '%6' }));
    const host = createTerminalHost('tmux', { exec });
    await host.spawn({ name: 'x', cwd: '/w', argv: ['codex', 'go now'], env: { CODEX_HOME: '/cfg dir', RELAY_TOKEN: 'tok' } });
    expect(calls[0]!.argv[9]).toBe("env CODEX_HOME='/cfg dir' RELAY_TOKEN=tok codex 'go now'");
  });

  it('throws when split-window fails', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stderr: "can't find session: relay" }));
    const host = createTerminalHost('tmux', { exec });
    await expect(host.spawn({ name: 'x', cwd: '/w', argv: ['claude'], env: {} })).rejects.toThrow(/can't find session/);
  });

  it('focus, isAlive and kill build the documented commands', async () => {
    const { exec, calls } = fakeExec((argv) => (argv[1] === 'list-panes' ? { stdout: '%1\n%10\n%5\n' } : {}));
    const host = createTerminalHost('tmux', { exec });
    await host.focus('%5');
    expect(await host.isAlive('%5')).toBe(true);
    expect(await host.isAlive('%1')).toBe(true);
    expect(await host.isAlive('%0')).toBe(false); // '%0' is not '%10'
    await host.kill('%5');
    expect(calls.map((c) => c.argv)).toEqual([
      ['tmux', 'select-pane', '-t', '%5'],
      ['tmux', 'list-panes', '-a', '-F', '#{pane_id}'],
      ['tmux', 'list-panes', '-a', '-F', '#{pane_id}'],
      ['tmux', 'list-panes', '-a', '-F', '#{pane_id}'],
      ['tmux', 'kill-pane', '-t', '%5'],
    ]);
  });

  it('isAlive is false when tmux is not running', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stderr: 'no server running' }));
    expect(await createTerminalHost('tmux', { exec }).isAlive('%5')).toBe(false);
  });
});
