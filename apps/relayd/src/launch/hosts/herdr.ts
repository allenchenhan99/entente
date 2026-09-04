/**
 * TerminalHost backed by the Herdr CLI (see `herdr --skill`).
 *
 * spawn:   herdr pane split --pane <anchor> --direction right --cwd <cwd> --no-focus [--env K=V]...
 *          → parse `.result.pane.pane_id`
 *          herdr agent start <name> --kind <claude|codex> --pane <paneId> -- <argv[1..]>
 * focus:   herdr agent focus <paneId>
 * isAlive: herdr agent get <paneId>   (exit 0 ⇒ alive)
 * kill:    herdr pane close <paneId>
 * read:    herdr pane read <paneId> --source recent-unwrapped   (only to explain a failed spawn)
 *
 * The anchor pane is `RELAY_ANCHOR_PANE`, falling back to Herdr's injected `HERDR_PANE_ID`
 * (the pane relayd itself runs in). Agent names must match `[a-z][a-z0-9_-]{0,31}`.
 */
import path from 'node:path';
import type { SpawnOptions, TerminalHost } from '../../ports.js';
import { defaultExec, describeFailure, type Exec, type ExecDeps } from '../exec.js';

export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export interface HerdrHostDeps extends ExecDeps {
  /** Sleep used between `agent start` retries while the new pane's shell is still starting; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to retry `agent start` on `agent_pane_busy` (500 ms apart). Default 20 (≈10 s). */
  paneReadyRetries?: number;
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

/** How long to wait for the agent to start working after a prompt before applying a recovery step. */
const PROMPT_WAIT_MS = 15_000;

/** How much of a failed pane's output to attach to the spawn error. */
const PANE_TAIL_LINES = 40;

function isPaneBusy(result: { stdout: string; stderr: string }): boolean {
  return /agent_pane_busy/.test(result.stderr) || /agent_pane_busy/.test(result.stdout);
}

export class HerdrHost implements TerminalHost {
  readonly kind = 'herdr' as const;
  private readonly exec: Exec;
  private readonly env: Record<string, string | undefined>;

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paneReadyRetries: number;

  constructor(deps: HerdrHostDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.env = deps.env ?? process.env;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.paneReadyRetries = deps.paneReadyRetries ?? 20;
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
    // The pane's shell is still initialising right after the split; Herdr answers `agent_pane_busy` until the
    // prompt is up, so retry that specific error with a short backoff instead of failing the spawn.
    let start = await this.exec(startArgv);
    for (let attempt = 0; start.exitCode !== 0 && isPaneBusy(start) && attempt < this.paneReadyRetries; attempt++) {
      await this.sleep(500);
      start = await this.exec(startArgv);
    }
    if (start.exitCode !== 0) {
      // Do not leave an orphaned shell pane behind; best effort, the original error wins.
      await this.exec(['herdr', 'pane', 'close', paneId]).catch(() => undefined);
      throw new Error(`herdr host: agent start failed: ${describeFailure(startArgv, start)}`);
    }
    if (opts.prompt !== undefined) {
      await this.deliverPrompt(opts.name, paneId, opts.prompt);
    }
    return { paneId };
  }

  /**
   * `agent start` refuses multi-line arguments, so the prompt goes through `agent prompt`, which pastes and
   * presses Enter atomically and (with --wait) reports whether the agent actually started working. Two
   * observed failure modes are handled: Codex keeps a large paste in its composer without submitting
   * (fixed by one more Enter), and Claude Code drops a paste that arrives while it is still initialising
   * (fixed by sending the prompt again).
   *
   * Anything else throws — but the pane is deliberately LEFT OPEN. When the agent dies during startup the
   * only record of why is what it printed in its own pane, and `agent prompt` then reports the useless
   * `agent_not_found` (Herdr clears the name when its agent exits). Closing the pane here destroyed that
   * evidence. The pane id is named in the error and its tail is attached.
   */
  private async deliverPrompt(name: string, paneId: string, prompt: string): Promise<void> {
    const promptArgv = ['herdr', 'agent', 'prompt', name, prompt, '--wait', '--until', 'working', '--timeout', String(PROMPT_WAIT_MS)];
    let result = await this.exec(promptArgv);
    if (result.exitCode === 0) return;

    await this.exec(['herdr', 'agent', 'send-keys', name, 'enter']).catch(() => undefined);
    const waited = await this.exec(['herdr', 'agent', 'wait', name, '--until', 'working', '--timeout', String(PROMPT_WAIT_MS)]);
    if (waited.exitCode === 0) return;

    result = await this.exec(promptArgv);
    if (result.exitCode === 0) return;

    throw new Error(
      `herdr host: agent prompt failed: ${describeFailure(promptArgv, result)}`
      + `; pane ${paneId} left open for inspection${await this.paneTail(paneId)}`,
    );
  }

  /** Best-effort tail of a pane, appended to spawn errors so a startup crash is diagnosable. */
  private async paneTail(paneId: string): Promise<string> {
    const read = await this.exec(['herdr', 'pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(PANE_TAIL_LINES)])
      .catch(() => undefined);
    const tail = read?.exitCode === 0 ? read.stdout.trim() : '';
    return tail === '' ? '' : `, last output:\n${tail}`;
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
