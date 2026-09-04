/**
 * TerminalHost backed by the Herdr CLI (see `herdr --skill`).
 *
 * spawn:   herdr pane split --pane <anchor> --direction right --cwd <cwd> --no-focus [--env K=V]...
 *          → parse `.result.pane.pane_id`
 *          herdr agent start <name> --kind <claude|codex> --pane <paneId> -- <argv[1..]>
 * focus:   herdr agent focus <paneId>
 * isAlive: herdr agent get <paneId>   (exit 0 ⇒ alive)
 * kill:    herdr pane close <paneId>
 *
 * The anchor pane is `RELAY_ANCHOR_PANE`, falling back to Herdr's injected `HERDR_PANE_ID`
 * (the pane relayd itself runs in). Agent names must match `[a-z][a-z0-9_-]{0,31}`.
 */
import path from 'node:path';
import type { SpawnOptions, TerminalHost } from '../../ports.js';
import { defaultExec, describeFailure, type Exec, type ExecDeps } from '../exec.js';

export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export interface HerdrHostDeps extends ExecDeps {
  /** Environment to read the anchor pane from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

type HerdrAgentKind = 'claude' | 'codex';

/** Maps the runtime executable (argv[0]) to a Herdr `--kind`. `claude-code` is Claude Code's runtime id. */
export function herdrAgentKind(executable: string): HerdrAgentKind {
  const base = path.basename(executable);
  if (base === 'claude' || base === 'claude-code') return 'claude';
  if (base === 'codex') return 'codex';
  throw new Error(`herdr host: cannot map runtime executable "${executable}" to a herdr agent kind (expected claude or codex)`);
}

export class HerdrHost implements TerminalHost {
  readonly kind = 'herdr' as const;
  private readonly exec: Exec;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: HerdrHostDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.env = deps.env ?? process.env;
  }

  private anchorPane(): string {
    const anchor = this.env.RELAY_ANCHOR_PANE || this.env.HERDR_PANE_ID;
    if (!anchor) {
      throw new Error('herdr host: no anchor pane; set RELAY_ANCHOR_PANE or run relayd inside a Herdr pane (HERDR_PANE_ID)');
    }
    return anchor;
  }

  async spawn(opts: SpawnOptions): Promise<{ paneId: string }> {
    if (!HERDR_AGENT_NAME.test(opts.name)) {
      throw new Error(`herdr host: agent name "${opts.name}" must match ${HERDR_AGENT_NAME}`);
    }
    const [executable, ...agentArgs] = opts.argv;
    if (!executable) throw new Error('herdr host: argv must not be empty');
    const kind = herdrAgentKind(executable);
    const anchor = this.anchorPane();

    const splitArgv = ['herdr', 'pane', 'split', '--pane', anchor, '--direction', 'right', '--cwd', opts.cwd, '--no-focus'];
    for (const [key, value] of Object.entries(opts.env)) splitArgv.push('--env', `${key}=${value}`);
    const split = await this.exec(splitArgv);
    if (split.exitCode !== 0) throw new Error(`herdr host: pane split failed: ${describeFailure(splitArgv, split)}`);
    const paneId = parsePaneId(split.stdout);
    if (!paneId) throw new Error(`herdr host: pane split returned no .result.pane.pane_id: ${split.stdout.trim()}`);

    const startArgv = ['herdr', 'agent', 'start', opts.name, '--kind', kind, '--pane', paneId, '--', ...agentArgs];
    const start = await this.exec(startArgv);
    if (start.exitCode !== 0) {
      // Do not leave an orphaned shell pane behind; best effort, the original error wins.
      await this.exec(['herdr', 'pane', 'close', paneId]).catch(() => undefined);
      throw new Error(`herdr host: agent start failed: ${describeFailure(startArgv, start)}`);
    }
    if (opts.prompt !== undefined) {
      // `agent start` refuses multi-line arguments; `agent prompt` pastes atomically (bracketed paste + Enter).
      const promptArgv = ['herdr', 'agent', 'prompt', opts.name, opts.prompt];
      const prompted = await this.exec(promptArgv);
      if (prompted.exitCode !== 0) {
        await this.exec(['herdr', 'pane', 'close', paneId]).catch(() => undefined);
        throw new Error(`herdr host: agent prompt failed: ${describeFailure(promptArgv, prompted)}`);
      }
    }
    return { paneId };
  }

  async focus(paneId: string): Promise<void> {
    const argv = ['herdr', 'agent', 'focus', paneId];
    const result = await this.exec(argv);
    if (result.exitCode !== 0) throw new Error(`herdr host: focus failed: ${describeFailure(argv, result)}`);
  }

  async isAlive(paneId: string): Promise<boolean> {
    const result = await this.exec(['herdr', 'agent', 'get', paneId]);
    return result.exitCode === 0;
  }

  async kill(paneId: string): Promise<void> {
    const argv = ['herdr', 'pane', 'close', paneId];
    const result = await this.exec(argv);
    if (result.exitCode !== 0) throw new Error(`herdr host: pane close failed: ${describeFailure(argv, result)}`);
  }
}

function parsePaneId(stdout: string): string | undefined {
  try {
    const json = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const id = json?.result?.pane?.pane_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}
