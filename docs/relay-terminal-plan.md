# Relay Terminal — plan for Phase 2 (our own agent-based terminal)

> Status: **WP-T1 (PTY host) is merged and proven live** (`fixtures/events-live-6.jsonl`); WP-T2 (web app) is ready to pick up. Interfaces are frozen in code; the two work packages below are written as
> RelayGraph Task Contracts so they can be executed by a person or by an agent. Owner of WP-T2 (web app):
> the UI teammate. Owner of WP-T1 (PTY host): engine.

## Why we build our own host

tmux keeps panes alive, cmux adds a sidebar and notifications on macOS, Herdr adds lifecycle detection in the
terminal. All three are terminal multiplexers first: they arrange *terminals*, and learn about agents by
watching the screen. RelayGraph already knows more than any of them — every agent's contract, state,
questions and evidence come from the agents themselves through MCP. A host that is driven by that knowledge
can do what none of them can:

- place a pane where the graph says it belongs (planner | agents | verifier), and draw the contracts between panes;
- put the human's actions next to the pane that needs them (answer, review, reply) instead of in a separate CLI;
- record every pane and replay it against the event log in the same window;
- make the layout **data** (a `LayoutPreset`) so it can be customised per team without forking the app.

Herdr and tmux stay supported as external `TerminalHost`s. The new host is a third implementation, `relay`.

## Architecture

```
┌─ apps/web (React + xterm.js, served at /app) ──────────────────────────────────┐
│ graph-driven pane grid │ pane title = contract state │ inspector · inbox · timeline│
└─────────────┬──────────────────────────────────────────────────┬───────────────┘
              │ WebSocket /pty/:pane (PtyClientMessage/PtyServerMessage)          │ SSE /events · HTTP commands
┌─────────────▼──────────────────────────────────────────────────▼───────────────┐
│ relayd                                                                          │
│ TerminalHost 'relay' = node-pty per agent · scrollback · asciinema v2 recorder  │
│ existing: event log · MCP · lint · worktrees · checks · repair · graph model    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Frozen interfaces (do not change without updating both work packages):

- `packages/protocol/src/pty.ts` — `PaneInfo`, `PtyClientMessage`, `PtyServerMessage`, `LayoutPreset`, `ptyRoutes`.
- `packages/protocol/src/graph/types.ts` — the object model the web app renders (`buildGraph`, `actionsFor`,
  `storyFor`, `describe` are implemented and tested; see `relay explain` for what they produce).
- `apps/relayd/src/ports.ts` — `TerminalHost` (spawn / focus / isAlive / kill).

Runtime requirements: Node ≥ 22, `node-pty` (native module; `npm rebuild node-pty` after Node upgrades).

## Launcher

`entente` is the root-package entrypoint for the terminal base. It reuses a healthy relayd or starts one in
the background, waits for `/health`, reads the daemon's session token, and runs the TUI in the foreground.
`entente status` reports the endpoint, PID file, and relay directory; `entente down` safely terminates only a
live PID paired with a healthy endpoint. `entente --replay <file>` opens the TUI without starting relayd.

---

## WP-T1 · Task Contract: `pty-host` — ✅ done (merged 2026-09-04; `apps/relayd/src/pty/`, `relay pane …` CLI)

- id: `t-pty-host` · recipient: engine · branch: `wp/pty-host`
- goal: relayd hosts agent terminals itself: a `TerminalHost` of kind `relay` backed by `node-pty`, a
  WebSocket per pane implementing `PtyServerMessage`/`PtyClientMessage`, HTTP pane listing/kill/focus,
  and an asciinema v2 recording per pane.

### allowed_paths
- `apps/relayd/src/pty/**` (new), `apps/relayd/src/launch/hosts/relay.ts` (new), `apps/relayd/src/http/pty.ts` (new, mounted from `app.ts` with a one-line import), `apps/relayd/src/index.ts` (wire `RELAY_HOST=relay`), `apps/relayd/package.json` (add `node-pty`, `ws`)

### constraints
- `createRelayHost({ store, relayDir, recorder })` implements `TerminalHost`: `spawn(opts)` starts `node-pty` with `opts.argv`, `opts.cwd`, `opts.env` merged over `process.env`, 120×40 default; pane ids `relay:<n>`; if `opts.prompt` is set, write it followed by `\r` **after** the first output byte arrives (Claude Code and Codex drop input that arrives before their TUI is up; wait for output, then 300 ms). `focus` records `focusedPane` (served by `GET /panes`); `isAlive` = process not exited; `kill` sends SIGTERM then SIGKILL after 3 s.
- Scrollback: keep the last 256 KiB per pane; new WebSocket clients get `hello` then `scrollback` then live `output`. Multiple clients per pane are allowed (all receive output; all may send input).
- Recording: append every output chunk to `<relayDir>/runs/<run-id>/casts/<pane>.cast` in asciinema v2 format (`{"version":2,"width","height","timestamp"}` header, then `[t, "o", data]` lines); `resize` writes `[t, "r", "colsxrows"]`.
- HTTP: `GET /panes` → `PaneInfo[]` (+ `focused_pane`); `GET /panes/:id` → `PaneInfo`; `POST /panes/:id/kill`; `POST /panes/:id/focus`; `GET /panes/:id/cast` → the cast file (text/plain). WebSocket upgrade at `/pty/:id` (use `ws`; reject unknown pane with 404 before upgrade).
- Emit nothing new to the event log; `agent_spawned.pane_id` already carries the pane id.
- Replay support: `RELAY_HOST=relay` in replay mode is not needed; the web app plays casts client-side.

### acceptance_criteria
- AC-1 — `createRelayHost().spawn({argv:['sh','-c','echo hi; sleep 30'], …})` returns `relay:1`; a WS client receives `hello`, `scrollback` (may be empty), then an `output` frame decoding to a string containing `hi`; `input` of `exit\r` is written to the PTY; `exit` frame arrives with code 0.
  check: `npx vitest run apps/relayd/src/pty -t "roundtrip"`
- AC-2 — Two clients on one pane both receive the same output; a client connecting late receives the scrollback first.
  check: `npx vitest run apps/relayd/src/pty -t "scrollback"`
- AC-3 — The cast file exists after spawn, has a valid v2 header, and its `o` events concatenate to the observed output; `resize` adds an `r` event.
  check: `npx vitest run apps/relayd/src/pty -t "cast"`
- AC-4 — `prompt` is written only after the first output byte (fake PTY in test): order of writes is observable.
  check: `npx vitest run apps/relayd/src/pty -t "prompt after first output"`
- AC-5 — `RELAY_HOST=relay npx tsx apps/relayd/src/index.ts` starts, `GET /panes` returns `[]`, and the existing orchestrator tests pass with `fakeHost` replaced by the relay host in one integration test that runs `relay up --plan examples/plan-secure-login.yaml` with `argv` overridden to a shell script (no LLM).
  check: `npx tsc -b && npx vitest run apps/relayd`

### Metrics (efficiency instrumentation; `PaneTimings` / `HostMetrics` in `packages/protocol/src/pty.ts`)

The host measures itself on its own monotonic clock (`performance.now()`, never the display `clock`) with no extra
polling: every mark is taken inside code that already runs (spawn, `onData`, the prompt deliverer). The Rust
`termd` must expose the same numbers so a RelayGraph-run agent can be compared with a bare `claude` / `codex`.

Per pane (`PaneInfo.timings`, `relay pane get`, and `GET /metrics`), all in milliseconds, `undefined` = not reached yet:

| number | measured from → to | how to read it |
| --- | --- | --- |
| `spawn_ms` | `spawn()` called → `node-pty` returned | process start cost (fork/exec, worktree cwd) |
| `first_output_ms` | process started → first output byte | agent boot time before anything is drawn |
| `readiness_ms` | first output → readiness detector said "ready" (prompt visible **and** quiet ≥ `quietMs`) | how long until the TUI could take input; includes the mandatory quiet window |
| `prompt_write_ms` | ready → prompt pasted and `\r` written | host overhead between detecting readiness and typing (should be ~0) |
| `prompt_accept_ms` | prompt written → accepted (agent visibly busy, or composer clear and screen moved on) | agent-side acceptance latency; includes every Enter retry |
| `prompt_retries` | count | extra `\r` presses needed (Codex paste placeholder); `0` is the healthy value |
| `render_p50_ms` / `render_p95_ms` | PTY chunk received → headless xterm applied it, nearest-rank percentiles over the last 512 chunks | screen-model latency; what `pane read` / readiness / wait-output lag behind the PTY |
| `output_bytes` / `output_chunks` | running totals of every chunk (`Buffer.byteLength`) | throughput; bytes ÷ chunks is the average chunk size |

A pane spawned **without** a prompt only ever has `spawn_ms`, `first_output_ms` and the render/throughput numbers.
A failed prompt delivery leaves the readiness/prompt marks undefined and bumps the host-level `prompt_failures`.

Host level (`GET /metrics` → `HostMetrics`, session token required like `/panes`): `host: 'relay'`, `uptime_ms`
since the host object was constructed, `panes_spawned` (monotonic, exited panes included), `panes_alive`,
`prompt_failures`, and `panes[]` with `pane_id`, `role`, `task_id` (when the spawner passed one) and `timings`.

CLI: `relay pane metrics` prints one row per pane
(`pane  role  ready(ms)  prompt→accept(ms)  retries  render p50/p95(ms)  bytes`, `-` where undefined);
`relay pane metrics --json` prints the raw `HostMetrics` object. No export, persistence or roll-ups yet: a later
package writes these next to the cast.

---

## WP-T2 · Task Contract: `web-terminal`

- id: `t-web-terminal` · recipient: UI · branch: `wp/web-terminal`
- goal: `apps/web` — the Relay Terminal: a browser app (served by relayd at `/app`, dev via Vite) where every
  agent is an xterm.js pane placed by the graph object model, every contract is an edge you can click, and
  every human action lives next to the pane that needs it.

### inputs
- `packages/protocol/src/pty.ts`, `packages/protocol/src/graph/types.ts`, `packages/protocol/src/api.ts`
- `apps/tui/src/data/live.ts` (SSE client logic to port), `fixtures/events-live-4.jsonl` (+ casts once WP-T1 lands)
- `relay explain planner --replay fixtures/events-live-4.jsonl` to see the narrative the inspector shows

### allowed_paths
- `apps/web/**` (new: Vite + React + TypeScript, xterm.js, no CSS framework required), root `tsconfig.json` (add reference), `apps/relayd/src/http/static.ts` (serve `apps/web/dist` at `/app`; one file)

### constraints
- **Data**: `GET /state` + SSE `/events` (re-snapshot on reconnect, exactly like the TUI), `GET /panes`, one WebSocket per visible pane. Everything rendered is derived from `buildGraph(state)`; never re-derive semantics in the UI.
- **Layout**: `LayoutPreset` drives a CSS grid: columns from `columns`, agents ordered by `order` (dependency depth = longest path from a task with no dependencies). A pane appears when its node exists and has a pane id (`agent_spawned`), sized by the column width; the human and verifier nodes are cards, not terminals. Edges are SVG overlays between pane boxes, styled by `VisualStatus` (`attention` pulses). Presets load from `GET /layouts`; the default preset ships in the app. A preset editor is out of scope; editing the JSON and `PUT /layouts/:name` is enough.
- **Pane**: xterm.js with the `fit` addon; title bar = `role · v<n> <state> · a<attempt> · <checks passed>/<total>`; border colour by node status; a 1-line action strip from `actionsFor(node)` (answer / review pass·fail / reply / cancel) opening an inline form that posts to the existing HTTP routes.
- **Inspector** (right column): for the selected node or edge, `describe` title + lines, then `storyFor` lines (newest last, auto-scroll), then the contract tabs (versions diff, questions & answers, evidence per attempt).
- **Inbox** (right column, above inspector): `graph.inbox` items with their actions; clicking selects the target object and scrolls its pane into view. Badge count in the header.
- **Timeline** (bottom): the last 200 events narrated with `narrate`; a scrubber that, in replay mode, rebuilds state from the JSONL and seeks every pane's cast to the same wall-clock time.
- **Replay mode**: `/app?replay=<run-id>` loads `.relay/runs/<run-id>/events.jsonl` and casts through relayd (`GET /runs/:id/events`, `GET /panes/:id/cast`); with no daemon, a file picker accepts a JSONL (casts optional).
- Keyboard: `j/k` select next/previous object, `Enter` focus its pane, `a/p/f/r/x` as in the TUI, `?` help. Colours must work in light and dark (system preference).

### acceptance_criteria
- AC-1 — With a mocked `/state` + `/panes` (MSW or a tiny fetch stub) built from `fixtures/events-live-4.jsonl`, the grid renders 3 agent panes in the agent column ordered core → routes → login-page, a planner card and a verifier card, and 3 contract edges + 2 dependency edges as SVG paths.
  check: `npx vitest run apps/web -t "layout"`
- AC-2 — Selecting the `contract:t-auth-routes` edge shows the `describe` title `t-auth-routes v1 (verified)` and six `AC-n` lines in the inspector; selecting the planner card shows the six-question story line.
  check: `npx vitest run apps/web -t "inspector"`
- AC-3 — For a state where `t-backend-auth` has open questions, the pane's action strip shows `answer`; submitting the form posts `ClarifyBody` to `/tasks/t-backend-auth/clarify`; for a blocked task `reply` posts `ReplyBody`; for a pending human_review `pass`/`fail` post `ReviewBody`.
  check: `npx vitest run apps/web -t "actions"`
- AC-4 — A pane opens a WebSocket to `/pty/<id>`, writes `hello`/`scrollback`/`output` frames into xterm (decode base64), forwards keystrokes as `input`, and sends `resize` on container resize (jsdom + a fake WS).
  check: `npx vitest run apps/web -t "pty"`
- AC-5 — Replay: loading a JSONL without casts plays the timeline with the scrubber, and the inbox at step 3 of `events-live-4.jsonl` shows the six mission questions.
  check: `npx vitest run apps/web -t "replay"`
- AC-6 — `npm run build -w apps/web` produces `apps/web/dist`; `RELAY_HOST=fake npx tsx apps/relayd/src/index.ts` serves it at `/app` (200, `text/html`); whole repo typechecks.
  check: `npx tsc -b && npx vitest run apps/web && npm run build -w apps/web`

---

## Graph over HTTP (`apps/relayd/src/http/graph.ts`, routes in `packages/protocol/src/api.ts`)

Clients that do not run the TypeScript reducer (the Rust `relay-tui`, curl) get exactly what the Ink TUI computes
locally from `@relay/protocol`'s graph module. Every endpoint is a pure read over the in-memory state (the event log
is only read for stories); mutations still go through the existing `POST` routes and the graph is re-fetched after
an SSE `/events` message. No SSE for the graph itself.

| endpoint | response |
|---|---|
| `GET /graph` | `buildGraph(state)` as-is (`nodes`, `edges`, `inbox`) plus `seq` = last event seq, so a client can tell whether it is current. Empty store → empty graph, `seq: 0`. |
| `GET /graph/:kind/:id/describe` | `describe(ref, graph, state)` → `{ title, lines }` |
| `GET /graph/:kind/:id/actions` | `actionsFor(ref, graph, state)` → `ObjectAction[]` |
| `GET /graph/:kind/:id/story?limit=N` | `{ ref, lines }`: the **last** N lines of `storyFor(ref, graph, state, events)` in seq order (`HH:MM` prefixed like the TUI). `limit` default 50, max 500 (larger values are clamped). |
| `GET /story?since=<seq>&limit=N` | `{ items: [{ seq, ts, task_id?, actor, line }] }`: the narrated event log, `line = narrate(event, state)` with `state` the state **after** that event (one incremental replay over the log, the TUI timeline's lines). `since` is exclusive, default 0; `limit` default 200, max 2000 (clamped). |

- `:kind` is `node`, `edge` or `inbox`; anything else → `400 { error }`. Ids are URL-decoded, so edge ids with `:`
  (`contract:t-backend-auth`) and `->` (`dep:t-a->t-b`) are sent through `routes.graphObject(kind, id)`
  (`encodeURIComponent`). An id that is not in the current graph → `404 { error: 'object not found' }`.
- `since`/`limit` that are not a non-negative / positive integer → `400 { error }`.
- Auth: the same as `/state` — open under `RELAY_AUTH=optional`, `Authorization: Bearer <session token>` required
  under `RELAY_AUTH=required` (401 `{ error }` otherwise). `mountGraph(app, { store, auth })` applies the guard
  itself because `apps/relayd/src/auth/token.ts` lists the guarded prefixes and does not know `/graph` / `/story`
  (proposed diff in the graph-http hand-off notes).
- Tests: `apps/relayd/src/http/graph.test.ts` replays `fixtures/events-live-1.jsonl` / `events-repair.jsonl`
  through the JSONL store and asserts equality with the pure functions; one pinned test fixes the `/story` lines
  of live-1 to what the Ink TUI shows.

---

## Relay Terminal rewrite (Rust)

R1 is `termd`, the PTY host (`docs/relay-term-spec.md`). R2 is the native client below.

### R2 · `relay-tui` (`crates/relay-tui`) — ✅ done (branch `wp/relay-tui-rust`)

A Ratatui client for relayd with the same object-oriented model as the Ink TUI (`apps/tui`), rendered natively
with real terminal panes inside the layout. It talks only HTTP / SSE / WS to relayd and never runs the reducer.

- **Modules**: `api.rs` (typed GET/POST, the `/events` SSE loop, `/pty/:id` WebSocket with the `relay.<token>`
  subprotocol; token from `--token` › `RELAY_TOKEN` › `<repo>/.relay/session.token`), `model.rs` (serde twins of
  `graph/types.ts`, `pty.ts` and the `state.ts` slices the tree needs — every dumped JSON round-trips unchanged),
  `app.rs` (pure state machine: selection, focus region, inspector, inline editor, pane grid; keys in, `Effect`s
  out), `runtime.rs` (the driver: channels, debounce, WebSockets, draw timing), `ui/{tree,graph,panes,inbox,
  inspector,status}.rs`, `keys.rs`, `replay.rs`, `metrics.rs`, `main.rs`.
- **Layout** (best at ≥ 100×30): left column 35 % = mission tree (agents with runtime glyph, task / handoff state,
  version, worktree, questions, blockers) over the graph (four columns human/planner · agents · verifier · done
  when ≥ 70 cols wide, grouped under headings otherwise; one row per edge drawn with box characters and its label,
  attention edges in bold yellow with `!`); right column 65 % = pane grid (focused pane large via `tui-term` over a
  `vt100` screen, the others as three-line thumbnails, title bars `role · task · status`); bottom strip 5 rows =
  inbox items with their action keys; status line = connection, last seq, draw p50/p95, the focused pane's
  `readiness_ms` / `prompt_accept_ms` / `render_p95_ms` from `/metrics`, action hints, errors. Narrower than 80
  cols the pane grid is dropped, shorter than 20 rows the inbox strip.
- **Data flow**: `GET /state`, `/graph`, `/panes` at start; then `/events` SSE — every event schedules one
  re-fetch of `/graph`, `/state`, `/panes` after a 100 ms debounce; `/metrics` every 2 s. One WebSocket per
  listed pane feeds a `vt100::Parser`; the focused pane's parser follows its widget and `resize` is sent whenever
  that size changes. Only the focused pane receives keys (`i` in the pane grid, `Esc` leaves); `Ctrl-C` and `q`
  go to the pane while typing.
- **Keys** (`apps/tui/src/keys.ts`): `Tab` cycles tree → graph → panes → inbox; `j`/`k`/arrows move; `Enter`
  inspects (on an inbox item: jumps to its ref); `i` inspects (pane grid: type into the pane); the action's own
  key from `/graph/:kind/:id/actions` or the inbox item runs it — `a` answer, `r` reply, `p` pass, `f` fail
  (asks for the observed failure), `x` cancel (y/N) — plus the contract aliases `c` (answer), `y` (pass), `n`
  (fail); `f` focuses the selected task's pane when no review action binds it; `?` help; `q` / `Ctrl-C` quit.
  Text goes through the inline editor in the inspector; Enter sends the exact `commands.ts` bodies to the POST
  routes; errors show in the status line.
- **Replay**: `--replay <dir>` renders from the JSON `scripts/dump-graph-fixture.mjs` wrote (`graph`, `state`,
  `story`, `panes`, plus `describe` / `stories` / `actions` per object) with no server; `--frames N` renders
  headlessly into a virtual terminal and prints the last frame, `--metrics-json` prints draw p50/p95 on exit.
- **Fixtures**: `crates/relay-tui/tests/fixtures/{live-1,live-7}` are dumped from a throw-away
  `RELAY_HOST=fake` relayd resumed on a copy of the run log (the resume appends `agent_exited` events for the
  recorded panes, so `seq` is a few past the log's last line; the fake host has no pane routes, so `panes.json`
  is `{ "panes": [] }`).
- **Tests** (`cargo test -p relay-tui`, < 1 s after compilation): serde round-trips of every fixture file,
  `TestBackend` snapshots per panel asserting on key strings, key-map unit tests, one live suite against a fake
  axum relayd (SSE → graph refresh, pane WebSocket bytes → widget, `i` → `input` frames, widget resize →
  `resize`, POST bodies, 401 without a token). Filters that name several tests need cargo's `--`:
  `cargo test -p relay-tui -- ui::tree ui::graph`.
- **Not in R2**: termd control (relayd proxies), daemon/attach (R3), mouse, themes/config file, web.

## Order of work and integration

1. WP-T1 and WP-T2 start in parallel (the web app can be built entirely against fixtures and a fake WS).
2. Integration day: `RELAY_HOST=relay relay up --planner claude-code`, open `/app`, run the demo mission end to end, record the run, and replay it in the app.
3. Then, optionally, wrap with Tauri (`apps/desktop`) — the web app is unchanged; Tauri only supplies the window and a `relayd` sidecar.

## Definition of done for Phase 2

- The demo (PRD §14) runs entirely inside Relay Terminal: no tmux, no Herdr, no separate CLI.
- A recorded run replays in the same window with panes and events in sync.
- A second layout preset (e.g. "review": verifier column wide, agents small) is loadable without code changes.
