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

## Order of work and integration

1. WP-T1 and WP-T2 start in parallel (the web app can be built entirely against fixtures and a fake WS).
2. Integration day: `RELAY_HOST=relay relay up --planner claude-code`, open `/app`, run the demo mission end to end, record the run, and replay it in the app.
3. Then, optionally, wrap with Tauri (`apps/desktop`) — the web app is unchanged; Tauri only supplies the window and a `relayd` sidecar.

## Definition of done for Phase 2

- The demo (PRD §14) runs entirely inside Relay Terminal: no tmux, no Herdr, no separate CLI.
- A recorded run replays in the same window with panes and events in sync.
- A second layout preset (e.g. "review": verifier column wide, agents small) is loadable without code changes.
