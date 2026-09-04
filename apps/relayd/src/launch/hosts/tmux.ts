/**
 * TerminalHost backed by tmux, always inside the session named `relay` (PRD §5.1).
 *
 * spawn:   tmux split-window -t relay -c <cwd> -P -F '#{pane_id}' <shell-quoted argv>
 * focus:   tmux select-pane -t <paneId>
 * isAlive: tmux list-panes -a -F '#{pane_id}'   (output contains the id)
 * kill:    tmux kill-pane -t <paneId>
 *
 * Env vars are prefixed onto the shell command as `env K=V ...` so the same command shape works
 * on every tmux version (split-window -e only exists on tmux ≥ 3.2).
 */
import type { SpawnOptions, TerminalHost } from '../../ports.js';
import { defaultExec, describeFailure, type Exec, type ExecDeps } from '../exec.js';

export const TMUX_SESSION = 'relay';

const SAFE_WORD = /^[A-Za-z0-9_\-./:=@%+,]+$/;

/** POSIX sh single-quoting: safe for spaces, quotes, newlines, `$`, backticks. */
export function shellQuote(arg: string): string {
  if (arg.length > 0 && SAFE_WORD.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

export type TmuxHostDeps = ExecDeps;

export class TmuxHost implements TerminalHost {
  readonly kind = 'tmux' as const;
  private readonly exec: Exec;

  constructor(deps: TmuxHostDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
  }

  async spawn(opts: SpawnOptions): Promise<{ paneId: string }> {
    if (opts.argv.length === 0) throw new Error('tmux host: argv must not be empty');
    const envPrefix = Object.entries(opts.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const fullArgv = opts.prompt === undefined ? opts.argv : [...opts.argv, opts.prompt];
    const command = (envPrefix.length > 0 ? ['env', ...envPrefix] : []).concat(shellJoin(fullArgv)).join(' ');
    const argv = ['tmux', 'split-window', '-t', TMUX_SESSION, '-c', opts.cwd, '-P', '-F', '#{pane_id}', command];
    const result = await this.exec(argv);
    if (result.exitCode !== 0) throw new Error(`tmux host: split-window failed: ${describeFailure(argv, result)}`);
    const paneId = result.stdout.trim().split('\n')[0]?.trim();
    if (!paneId) throw new Error('tmux host: split-window printed no pane id');
    return { paneId };
  }

  async focus(paneId: string): Promise<void> {
    const argv = ['tmux', 'select-pane', '-t', paneId];
    const result = await this.exec(argv);
    if (result.exitCode !== 0) throw new Error(`tmux host: select-pane failed: ${describeFailure(argv, result)}`);
  }

  async isAlive(paneId: string): Promise<boolean> {
    const result = await this.exec(['tmux', 'list-panes', '-a', '-F', '#{pane_id}']);
    if (result.exitCode !== 0) return false;
    return result.stdout.split('\n').map((line) => line.trim()).includes(paneId);
  }

  async kill(paneId: string): Promise<void> {
    const argv = ['tmux', 'kill-pane', '-t', paneId];
    const result = await this.exec(argv);
    if (result.exitCode !== 0) throw new Error(`tmux host: kill-pane failed: ${describeFailure(argv, result)}`);
  }
}
