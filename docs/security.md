# Security model

relayd runs coding agents that have **bypass permissions** inside their own shells, executes the
acceptance-criterion `command` checks those agents' contracts declare, and exposes the agents' terminals over
HTTP and WebSocket. This page says what is protected, how, and what is not.

## What is protected

### 1. Worktree isolation and `diff_scope`

Every task runs in its own git worktree under `<relayDir>/wt/<task>`. The verifier's `diff_scope` check
fails a task whose diff touches files outside the contract's `allowed_paths`, so an agent cannot silently
edit files that belong to another agent or to the human. This is a *review* control, not a containment one:
the agent's process can still read and write anything the daemon's user can (see gaps).

### 2. The check sandbox (`apps/relayd/src/verify/sandbox.ts`)

A `command` acceptance check is a shell command written by the planner (an LLM) or by a human and run by
the daemon. It is executed as `sh -c <run>` with:

| Property | Behaviour |
| --- | --- |
| Environment | Built from an allow-list, never the daemon's `process.env`: `PATH`, `LANG`, `TERM`, `NODE_ENV` (copied when set), `HOME` → scratch dir `<relayDir>/home`, `TMPDIR` → the OS temp dir, `CI=1`, plus any names listed in `RELAY_CHECK_ENV_ALLOW` (comma-separated). API keys, the session token and everything else in the daemon's environment are not inherited. |
| Working directory | The task's worktree. |
| Network (macOS) | Denied entirely (`(deny network*)`, including loopback) by wrapping the shell in `/usr/bin/sandbox-exec` with a generated Seatbelt profile. |
| Filesystem (macOS) | Reads allowed everywhere; writes allowed only under the worktree (and, for a linked worktree, its `.git` directory in the main repository), the task's evidence directory, `TMPDIR`, `/tmp`, `/var/tmp`, the scratch `HOME`, and `/dev/null`, `/dev/tty`, `/dev/fd/*`, `/dev/std*`. |
| Other platforms | No `sandbox-exec`: the check runs unsandboxed but with the same minimal environment. The daemon logs once: `check sandbox: not available on <platform>`. |
| Timeout | The contract's `timeout_ms`; on expiry the whole process group is killed with `SIGKILL`, so background children die too. |
| Output | Captured stdout+stderr are capped at 1 MiB; the tail is kept behind the marker `[relayd: output truncated to the last 1048576 bytes]`. |

`RELAY_CHECK_SANDBOX=off` disables the `sandbox-exec` wrapper (the minimal environment still applies); the
daemon logs `check sandbox: disabled by RELAY_CHECK_SANDBOX=off`. Use it only for checks that genuinely need
a local port or network access, and prefer moving such checks into the agent's own test run instead.

`diff_scope`, `file_exists` and `human_review` checks are evaluated by the daemon itself and never run a
shell.

### 3. The session token (`apps/relayd/src/auth/token.ts`)

At boot the daemon generates a random 32-hex-character token, prints it once as `relayd token: …` and
writes it to `<relayDir>/session.token` with mode `0600`. Clients present it as:

- HTTP: `Authorization: Bearer <token>`
- WebSocket (`/pty/:id`): the subprotocol `relay.<token>` in `Sec-WebSocket-Protocol`. The daemon
  checks it *before* the upgrade and before looking the pane up: a missing or wrong token is refused with
  `HTTP 401` (no pane-id oracle), then an unknown pane with `404`. The chosen subprotocol is echoed back on
  accept, as the WebSocket protocol requires.

Two modes, selected by `RELAY_AUTH`:

| Route | `RELAY_AUTH=optional` (default) | `RELAY_AUTH=required` |
| --- | --- | --- |
| `/panes*`, `/pty/*`, `/runs*` | token required | token required |
| `/state`, `/events*`, `/missions*`, `/tasks*` | open | token required |
| `/health` | open | open |
| `/mcp` | task / planner MCP tokens (unchanged) | task / planner MCP tokens (unchanged) |

The default is `optional` so the existing MCP agent flow — which already authenticates every agent with a
per-task or per-mission token on `/mcp` — and the thin clients keep working without configuration. Task and
planner MCP tokens are **never** accepted on the pane, pty or runs routes: an agent that knows its own task
token cannot read or drive other panes, and neither can any other local process that has not read the
token file. A missing or invalid token answers `401 { "error": … }`.

Clients (`relay` CLI, the TUI) resolve the token in this order: `--token`, `RELAY_TOKEN`, then
`<relayDir>/session.token` where `relayDir` is `RELAY_DIR` or `<--repo | RELAY_REPO | cwd>/.relay`. They
send it on every request. The token changes on every daemon start; a client that keeps reading the file
picks the new one up automatically.

### 4. Agent tokens on `/mcp` (unchanged)

Each spawned agent receives a task token (or the planner a mission token) and can only call the MCP tools
for its own task. This scheme is unchanged by the session token.

## What is not protected — known gaps

- **Agents run with bypass permissions.** An agent's shell is not sandboxed: it runs as the daemon's user
  with the daemon's environment and can read `<relayDir>/session.token`. The session token therefore
  protects panes from *other* local processes and from checks, not from a determined agent. Container or
  VM isolation per agent is out of scope.
- **The check sandbox allows reads everywhere.** A check can read secrets on disk (including the token
  file); it just cannot exfiltrate them over the network on macOS. On Linux and Windows there is no network
  or filesystem restriction at all, only the minimal environment.
- **Loopback is denied for sandboxed checks.** A check that starts a local server, or needs to talk to
  relayd itself, fails under the sandbox. This is deliberate (a check with loopback plus read access to the
  token file could drive panes); the escape hatch is `RELAY_CHECK_SANDBOX=off` for the whole daemon.
- **No per-user auth, no TLS.** relayd binds `127.0.0.1` only; the token is a bearer secret shared by every
  client of that daemon. Anything that can read the daemon's stdout or the token file has full pane access.
- **`RELAY_AUTH=optional` leaves the control routes open.** Any local process can read `/state` and post to
  `/missions*` and `/tasks*` unless `RELAY_AUTH=required` is set. The MCP endpoint is unaffected by either
  mode.
- **The token is printed to stdout.** Logs that capture the daemon's stdout contain it; rotate by
  restarting the daemon.
- **Casts and evidence files are plain files** under `<relayDir>`; filesystem permissions are the only
  protection for recorded terminal sessions.
