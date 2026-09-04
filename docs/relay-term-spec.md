# Relay Terminal — `termd` R1 spec (Rust PTY host)

> Status: R1 implemented in `crates/termd` (branch `wp/termd-rust`). relayd (TypeScript) stays the brain; `termd`
> only owns terminals. It is a drop-in replacement for relayd's TypeScript PTY host: the same HTTP/WebSocket
> protocol as `packages/protocol/src/pty.ts`, the same readiness heuristics and prompt-delivery rules as
> `apps/relayd/src/pty/{readiness,host,pane}.ts`, the same asciinema casts, plus efficiency metrics recorded from
> day one. Not in R1: Ratatui client (R2), the relayd-side `relayterm` TerminalHost (next package), daemon/attach
> (R3), the layouts API, declared/hook readiness tiers, Windows.

## 1. Binary and CLI

```
termd --listen 127.0.0.1:0 --token <hex> --cast-dir <dir> [--first-pane N] [--quiet-ms 400] [--retry-ms 5000] [--timeout-ms 30000]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen` | `127.0.0.1:0` | Bind address; port 0 picks a free port. |
| `--token` | required | Session token required on every route except `GET /health`. |
| `--cast-dir` | required | Casts are written to `<cast-dir>/<pane>.cast` (created on demand). |
| `--first-pane` | `1` | First pane number handed out (`relay:<n>`); relayd passes one past the run's highest pane on restart. |
| `--quiet-ms` | `400` | No output for this long = "quiet" (readiness window and prompt gate). |
| `--retry-ms` | `5000` | Press Enter again this long after the last Enter while the composer still holds the paste. |
| `--timeout-ms` | `30000` | Give up on prompt delivery this long after spawn; the pane is left open. |

On boot `termd` prints **exactly one line** to stdout, which relayd parses:

```
termd listening on http://127.0.0.1:<port>
```

Logs go to stderr (`RUST_LOG=termd=debug`). `Ctrl-C` terminates every pane (SIGTERM, SIGKILL after 3 s) and exits.

Layout: `crates/termd/src/{pty→pane.rs, screen.rs, ring.rs, recorder.rs, readiness.rs, keys.rs, host.rs, api.rs, metrics.rs, main.rs}`;
`termd` is a lib + bin so the integration tests start the server in-process on port 0.

## 2. Authentication

Every route except `GET /health` requires the session token (`docs/security.md`):

- HTTP: `Authorization: Bearer <token>`.
- WebSocket: either the same header or the subprotocol `relay.<token>` (`Sec-WebSocket-Protocol`), which keeps the
  token out of URLs and logs. The server echoes the accepted protocol back on the 101 response.
- Missing token → `401 { "error": "missing session token: send Authorization: Bearer <termd token>" }`;
  wrong token → `401 { "error": "invalid session token" }`. The check happens **before** the WebSocket upgrade and
  before the pane lookup (an unknown pane without a token is 401, with a token 404). Comparison is constant-time.

## 3. Routes

JSON bodies and responses are exactly what the zod schemas in `packages/protocol/src/pty.ts` serialise
(`PaneInfo`, `ScreenSnapshot`, `PaneReadiness`, `WaitOutputResult`, `PaneTimings`, `HostMetrics`). Optional
fields are omitted when undefined. Unknown pane → `404 { "error": "pane not found" }`. Validation failures →
`400 { "errors": ["<field>: <message>", …] }` (invalid JSON → `"(body): invalid JSON"`).

| Method | Route | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `200 { ok: true, version }` (no token) |
| `GET` | `/panes` | — | `200 { panes: PaneInfo[], focused_pane? }` |
| `POST` | `/panes` | `{ name, argv, cwd, env?, cols?, rows?, prompt?, task_id? }` | `201 { pane_id }`. With `prompt` the response waits for delivery; failure → `502 { pane_id, error: "agent prompt failed: …; pane relay:n left open for diagnosis" }` with the pane still open. Empty `argv` → 400; the process cannot be started → `500 { error }`. |
| `GET` | `/panes/:id` | — | `200 PaneInfo` (`timings` always present) |
| `POST` | `/panes/:id/kill` | — | `200 { ok: true }` once the process is gone (SIGTERM, SIGKILL after 3 s; idempotent) |
| `POST` | `/panes/:id/focus` | — | `200 { ok: true }`; recorded as `focused_pane` |
| `POST` | `/panes/:id/resize` | `{ cols, rows }` (positive ints) | `200 { ok: true }`; resizes pty + screen, appends an `r` cast event |
| `GET` | `/panes/:id/cast` | — | `200 text/plain; charset=utf-8` — the cast file bytes; `404 { error: "cast not found" }` if missing |
| `GET` | `/panes/:id/screen?source=&lines=` | `source` ∈ `visible` (default) / `recent`; `lines` 1..5000 (default 200) | `200 ScreenSnapshot` |
| `POST` | `/panes/:id/input` | `PaneInputBody { text?, keys? }` | `200 { ok: true }`; `text` first (bracketed paste when the pane enabled it), then `keys`; an unknown key → `400 { errors: ["keys: unknown key: \"hyper+x\""] }` and **nothing is written** |
| `POST` | `/panes/:id/wait-output` | `WaitOutputBody { match?, regex?, timeout_ms? (default 60000, ≤ 600000), source? (default recent) }` | `200 WaitOutputResult` long-poll: `{ status: "matched", line, at }` / `{ status: "timeout" }` / `{ status: "exited", code }`; neither `match` nor `regex` → 400; invalid regex → 400 |
| `GET` | `/panes/:id/readiness` | — | `200 PaneReadiness` (screen tier) |
| `GET` | `/metrics` | — | `200 HostMetrics` with `host: "relayterm"` |
| `GET` (WS) | `/pty/:id` | — | WebSocket, see §4; `401` / `404` before the upgrade |

Panes: ids `relay:<n>` counting up from `--first-pane`; a failed spawn does not consume a number. Default size
120×40. The child's environment = the termd process env + body `env` + `TERM=xterm-256color`,
`COLORTERM=truecolor`, `RELAY_PANE_ID=<pane>`. `runtime` is `claude-code` for `claude`/`claude-code`, `codex` for
`codex`, otherwise absent. `pid` is the child's pid. `exit_code` is the process exit code (1 when killed by a
signal). Panes are never removed from the listing; exited panes keep their info, screen, ring and cast.

`wait-output` scans the `source` view (`recent` = up to 200 scrollback rows + the viewport) for the first line
that contains `match` or matches `regex` (Rust `regex` syntax; the subset relayd uses — anchors, classes,
groups, `\w`, `\d` — behaves like JavaScript). It re-scans on every output chunk; on exit it scans once more and
then reports `exited`.

## 4. WebSocket `/pty/:id`

Text frames carrying JSON; terminal bytes are base64 (`PtyServerMessage` / `PtyClientMessage`). Any number of
clients per pane; all receive output, all may send input.

| Direction | Frame | Meaning |
| --- | --- | --- |
| server → client | `{ t: "hello", pane: PaneInfo }` | first frame on connect |
| server → client | `{ t: "scrollback", data }` | second frame: base64 of the raw ring (last 256 KiB) |
| server → client | `{ t: "output", data }` | base64 bytes from the PTY, one frame per read chunk |
| server → client | `{ t: "exit", code }` | after the last `output` of the process; sent immediately after `scrollback` when the pane had already exited |
| server → client | `{ t: "pong" }` | reply to `ping` (works on an exited pane's socket too) |
| client → server | `{ t: "input", data }` | base64 bytes written to the PTY (ignored once exited) |
| client → server | `{ t: "resize", cols, rows }` | positive ints; resizes pty + screen + cast |
| client → server | `{ t: "ping" }` | keep-alive |

Malformed or unknown client frames are ignored. The scrollback replay and the live subscription are taken under
one lock, so a joining client never sees a byte twice or misses one. Each client has a 4096-chunk buffer; a client
that falls further behind loses the oldest chunks (never the exit).

## 5. Screen model

One `vt100` parser per pane, sized like the pty, 5000 rows of scrollback (0 on the alternate screen). Every
output chunk is applied to the parser **before** it is pushed to the ring, the cast and the subscribers, so a
`wait-output` scan or a `scrollback` replay never runs ahead of the screen.

`ScreenSnapshot`: `lines` = rows top to bottom with trailing whitespace trimmed (`recent` prepends up to `lines`
scrollback rows), `cursor` `{x, y}` relative to the viewport, `alternate` while `?1049`/`?47` is active,
`scrollback_lines` = rows available above the viewport. `bracketed_paste` (`?2004`) is tracked for `input`/prompts.

## 6. Readiness (screen tier)

A byte-for-byte port of `apps/relayd/src/pty/readiness.ts` (`crates/termd/src/readiness.rs`, same regexes, same
`detail` strings), evaluated over the visible rows and the time of the last output byte:

1. exited → `{ ready: false, source: "unknown", detail: "pane exited" }`.
2. last output less than `quiet_ms` ago → `ready: false`, `detail: "output flowing (<n> ms ago)"`.
3. take the last **8** non-empty visible lines; none → `detail: "screen is empty"`.
4. drop **chrome** lines: `bypass permissions`, `shift+tab`, leading `⏵`, leading `gpt-<digit>`, `· ~/`,
   trailing `/rc`, and lines made only of box-drawing characters.
5. any remaining line matching `esc to interrupt|Working|Thinking|Running` (case-insensitive) →
   `ready: false`, `detail: "busy: <line ≤ 80 chars>"`.
6. from the bottom up, the first line that is an idle prompt (`^[❯>›$%#]\s*$`), a composer (`^(> |› )`) or a
   trailing question (`\?\s*$`) → `ready: true`, `detail: "prompt: <line>"`.
7. otherwise `ready: false`, `detail: "no prompt: <last non-empty visible line>"`.

`source` is always `screen` (or `unknown` after exit); `observed_at` is the host's ISO clock.

## 7. Prompt delivery (`POST /panes` with `prompt`)

Follows `apps/relayd/src/pty/host.ts` `deliverPrompt` step by step; the deadline is `timeout_ms` from the spawn
request:

1. wait for the first output byte (or exit, or the deadline);
2. poll every 25 ms until the pane has been quiet for ≥ `quiet_ms` **and** readiness says `ready`; exit →
   `process exited with code <c> before taking the prompt`; deadline → `no prompt on screen within <t> ms
   (last line: "<line>")`;
3. remember the last non-empty line, write the prompt (wrapped in `\e[200~ … \e[201~` when the screen has
   bracketed paste on), then `\r`;
4. accepted when the agent is visibly busy (readiness `busy:`), or the composer is clear and the last line
   changed. "Composer still holds the paste" = a visible line containing `[Pasted Content`, or a composer line
   (`❯ `, `› `, `> `, or a bare `›`) that still contains the first 24 characters of the prompt;
5. while not accepted: every `retry_ms` after the last Enter, if the composer still holds the paste and fewer
   than 3 retries were sent, press `\r` again (`prompt_retries` counts them); exit or deadline →
   `prompt not accepted within <t> ms (last line: …)`.

Failure → `502 { pane_id, error: "agent prompt failed: <why>; pane <id> left open for diagnosis" }`, the pane
stays alive, `HostMetrics.prompt_failures` increments.

## 8. Metrics

`PaneTimings` (ms, `std::time::Instant`, absent until reached) on every `PaneInfo` and in `GET /metrics`:

| Field | Mark | Definition |
| --- | --- | --- |
| `spawn_ms` | spawn request → pty process started | `openpty` + fork/exec |
| `first_output_ms` | process started → first output byte | |
| `readiness_ms` | first output → readiness first said `ready` | recorded by any readiness evaluation (prompt delivery or `GET /readiness`) |
| `prompt_write_ms` | readiness → prompt bytes written (paste + Enter) | |
| `prompt_accept_ms` | prompt written → accepted | includes Enter retries |
| `prompt_retries` | | extra Enter presses (0 when accepted first time; set once a prompt was written) |
| `render_p50_ms`, `render_p95_ms` | per chunk: bytes read from the pty → `vt100` finished | rolling window of 512 samples, nearest-rank percentiles |
| `output_bytes`, `output_chunks` | | throughput so far |

`HostMetrics`: `host: "relayterm"`, `uptime_ms`, `panes_spawned` (exited panes included), `panes_alive`,
`prompt_failures`, `panes: [{ pane_id, role, task_id?, timings }]`.

## 9. Cast format

`<cast-dir>/<pane>.cast`, asciinema v2, one JSON value per line, flushed to the OS on every event:

```
{"version":2,"width":120,"height":40,"timestamp":1788536575,"title":"<role>"}
[0.011,"o","hi\r\n"]
[0.357,"r","80x24"]
```

`t` is seconds since the recorder started, rounded to the millisecond. `o` carries the chunk as text (a multibyte
character split across chunks is joined with the next chunk); `r` is written on every resize. The file is closed
when the process exits.

## 10. relayd ↔ termd (next package, not part of R1)

relayd will gain a `relayterm` `TerminalHost`:

1. spawn `termd --listen 127.0.0.1:0 --token <session token> --cast-dir <relayDir>/runs/<run>/casts
   --first-pane <highest recorded pane + 1>` and parse the single stdout line
   `termd listening on http://127.0.0.1:<port>`;
2. forward `/panes*`, `/pty/*` (WebSocket upgrade, subprotocol passed through) and `/metrics` to that base URL
   with the same token, so the web app, `relay pane …` and the TUI keep working unchanged;
3. `spawn(opts)` = `POST /panes` (`name`, `argv`, `cwd`, `env`, `prompt`, `task_id`); `isAlive` = `GET /panes/:id`
   `.alive`; `kill` = `POST /panes/:id/kill`; `focus` = `POST /panes/:id/focus`;
4. stop `termd` with SIGINT on shutdown (it terminates its panes); restart it with `--first-pane` so casts are
   never overwritten.

## 11. Tests

`cargo test` is hermetic and fast (< 10 s locally): unit tests for readiness (every case of
`readiness.test.ts`, plus the 8-line tail and chrome footer), keys, ring, percentiles, recorder, screen; integration
tests under `crates/termd/tests/` start the server on port 0 with a real `sh` (echo/cat/printf, a fake prompt
shell that prints `> ` after 200 ms, bracketed paste via `printf '\e[?2004h'`, alternate screen via
`\e[?1049h`, a Codex-like `[Pasted Content …]` composer). No LLM processes. CI runs `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test` on ubuntu-latest.
