#!/usr/bin/env node
/**
 * The `claude` / `codex` you get inside an entente terminal.
 *
 * RelayGraph's rule is that a session the human opened is a brain and a session an agent opened is a
 * sub. Nothing should have to declare which — you open a terminal, run your agent, and type. But a
 * bare `claude` knows nothing about relayd: no MCP config, no mission, no token, so it could never
 * delegate, and relayd would never see it. This shim closes that gap without changing what you type.
 *
 * It asks relayd to adopt the session (`POST /sessions`), which mints the mission and the token,
 * writes the agent's MCP config, and hands back the flags to start with. Then it `exec`s the real
 * binary. Your first message is the brief; nothing is typed on your behalf.
 *
 * Everything here fails open. Outside an entente pane, with relayd unreachable, or on any error at
 * all, it execs the real binary unchanged — a broken shim must never cost you your agent.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Set by the `claude` / `codex` wrapper that was actually invoked; node resolves symlinks in argv[1],
// so the name the human typed is only knowable if the wrapper passes it on.
const TOOL = process.env.RELAY_SHIM_TOOL === 'codex' ? 'codex' : 'claude';
const RUNTIME = TOOL === 'codex' ? 'codex' : 'claude-code';
const args = process.argv.slice(2);

/** The real binary: the first `TOOL` on PATH that is not this shim's own directory. */
function realBinary() {
  const selfDir = path.resolve(path.dirname(process.argv[1] ?? '.'));
  const skip = new Set([selfDir]);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || skip.has(path.resolve(dir))) continue;
    const candidate = path.join(dir, TOOL);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

function run(binary, argv, env) {
  const child = spawn(binary, argv, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 0)));
  child.on('error', (err) => {
    process.stderr.write(`${TOOL}: ${err.message}\n`);
    process.exit(127);
  });
}

/** relayd's session token, from the environment or the repo it wrote it into. */
function sessionToken(cwd) {
  if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN;
  const dir = process.env.RELAY_DIR ?? path.join(process.env.RELAY_REPO ?? cwd, '.relay');
  try {
    return fs.readFileSync(path.join(dir, 'session.token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

const binary = realBinary();
if (!binary) {
  process.stderr.write(`${TOOL}: not found on PATH (the entente shim found no real ${TOOL} to run)\n`);
  process.exit(127);
}

const paneId = process.env.RELAY_PANE_ID;
const url = process.env.RELAY_URL ?? 'http://127.0.0.1:7420';
const cwd = process.cwd();
const token = sessionToken(cwd);

// Not in an entente pane, or asked for something that is not a session (`--help`, `--version`):
// nothing to adopt, so get out of the way entirely.
const informational = args.some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-V');
if (!paneId || !token || informational) {
  run(binary, args, {});
} else {
  const body = JSON.stringify({ runtime: RUNTIME, pane_id: paneId, cwd, title: `${RUNTIME} session in ${path.basename(cwd)}` });
  const timeout = AbortSignal.timeout(Number(process.env.RELAY_SHIM_TIMEOUT_MS ?? 5000));
  try {
    const res = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
      signal: timeout,
    });
    if (!res.ok) throw new Error(`relayd said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const session = await res.json();
    process.stderr.write(`relay: this session is ${session.mission_id} — agents you delegate to appear in entente\n`);
    run(binary, [...session.argv, ...args], { ...session.env, RELAY_MISSION: session.mission_id });
  } catch (err) {
    // relayd down, or it refused. Say so once — silently dropping to an unwired agent would look
    // like entente ignoring you — and then start the agent anyway.
    process.stderr.write(`relay: starting ${TOOL} unmanaged (${err.message})\n`);
    run(binary, args, {});
  }
}
