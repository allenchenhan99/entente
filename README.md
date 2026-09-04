# entente · RelayGraph

**Turn fuzzy natural-language handoffs between coding agents into confirmable, trackable, verifiable, retryable work contracts.**

> Agent frameworks tell you whether an agent is running.
> RelayGraph tells you whether agents actually understand each other.

RelayGraph is a coordination control plane for coding agents (Claude Code, Codex) with its own terminal base:
agents keep their runtimes, RelayGraph hosts their terminals and makes every handoff between them an explicit
**Task Contract** with a lifecycle:

```
proposed ──▶ needs_clarification ──▶ revised ──▶ accepted ──▶ evidence_submitted ──▶ verified
                (agent asks)        (human answers)          (relayd runs the checks)   │
                                                                   └── retry_requested ◀─┘  (delta repair, same session)
```

- **Clarify before execution** — a recipient must `accept` (restating its interpretation and a verification
  plan for every criterion) or ask numbered questions. It cannot start writing code before that.
- **Evidence over self-reporting** — every acceptance criterion binds a `check` (`command`, `diff_scope`,
  `file_exists`, `human_review`, `llm_judge`). relayd runs the checks in the agent's git worktree; the agent's
  own claims are only compared against the result (`self_report_mismatch`).
- **Local repair over global retry** — a failed criterion produces a delta *repair contract* delivered to the
  same agent session. Nothing else is re-run.
- **Everything is an event** — an append-only JSONL log is the only state; the TUI, the metrics and replay are
  all derived from it with one reducer.

Built at the FUTUREMODE BUILDMODE Gen-AI Hackathon 2026. The full product design is in [`PRD.md`](PRD.md).

## What is in the box

| Package | What it does |
|---|---|
| `packages/protocol` | zod schemas for contracts, events, state; the state reducer; the communication-debt linter |
| `apps/relayd` | the daemon: JSONL event store, HTTP + SSE API, **MCP server the agents talk to**, git worktree manager, check runner, repair policy, agent launcher (`relay` / `relayterm` hosts, Claude Code / Codex runtimes) |
| `apps/tui` | Ink terminal UI: mission tree, animated handoff graph, event timeline, contract overlay, live (SSE) and replay modes |
| `apps/cli` | `relay up / status / clarify / revise / review / reply / cancel / inbox / explain / story / pane / replay` |
| `demo-repo` | a small Hono app with a user model and session store and **no authentication** — the target of the demo mission |
| `fixtures` | replayable event logs, including a recorded real run (`events-live-1.jsonl`) |
| `examples` | hand-written contracts for the demo mission |

## Quick start

Requirements: Node ≥ 22 and git. Agents need `claude` (Claude Code) and/or `codex` on your PATH and logged in.
RelayGraph hosts the agent terminals itself; no external multiplexer is needed. With a Rust toolchain, `cargo build`
produces the native terminal base (`termd` + `relay-tui`) and `entente` uses it automatically; without it the
TypeScript host and the Ink TUI run instead.

```bash
npm install && npx tsc -b
cargo build -p termd -p relay-tui   # optional: the Rust terminal base (Relay Terminal)

# Materialise the demo app as its own git repository.
bash demo-repo/scripts/init-demo.sh ~/entente-demo/app && (cd ~/entente-demo/app && npm install)

# Start or reuse relayd, wait for health, then hand this terminal to the TUI.
entente --repo ~/entente-demo/app

# Inspect or stop that daemon from another terminal.
entente status --repo ~/entente-demo/app
entente down --repo ~/entente-demo/app
```

`entente` defaults to `entente up` on port 7420. `--host` defaults to `relayterm` when a `termd` binary is
found (`RELAY_TERMD`, `target/release`, `target/debug`) and to the TypeScript `relay` host otherwise; `--tui`
defaults to `rust` when `relay-tui` is built (`RELAY_TUI` overrides) and to `ink` otherwise. Use `--port N` for
another port and `--dir <relayDir>` to move
`relayd.log`, `relayd.pid`, and `session.token`. Pass `--no-spawn` to require an already-running daemon.
`--replay` takes an event log (Ink) or a relay-tui fixture directory (Rust).

Terminal hosts (`RELAY_HOST` for a hand-started `relayd`):

| host | what runs the agent terminals |
| --- | --- |
| `relay` (default) | relayd itself (node-pty); `/panes*`, `/pty/:id`, `/metrics` served in-process |
| `relayterm` | the Rust `termd` (`cargo build -p termd`, or `RELAY_TERMD=<binary>`); relayd spawns it and proxies the same routes to it |

No agents, daemon, or API keys? Replay a recorded run directly:

```bash
entente --replay fixtures/events-live-1.jsonl
```

## How an agent takes part

relayd is an MCP server (streamable HTTP at `/mcp`). Each spawned agent gets a bearer token that identifies its
task and a bootstrap prompt describing the lifecycle. The tools:

| Recipient tools | Planner tools |
|---|---|
| `relay_get_contract` · `relay_respond_to_contract` · `relay_await_contract` | `relay_get_mission` · `relay_propose_task` · `relay_list_tasks` |
| `relay_report_progress` · `relay_report_blocker` · `relay_await_reply` | `relay_revise_task` · `relay_answer_clarification` · `relay_ask_human` · `relay_await_answers` |
| `relay_submit_evidence` · `relay_await_verdict` | |

The same server serves Claude Code and Codex; adding a runtime means implementing `AgentRuntime`
(`apps/relayd/src/ports.ts`) — write the agent's config files, return argv/env/prompt. Adding a terminal host
means implementing `TerminalHost` (spawn / focus / isAlive / kill).

## A contract, briefly

```yaml
id: t-backend-auth
recipient: backend
runtime: claude-code
goal: Implement secure login endpoints, reusing the existing user model and session store
inputs: [README.md, src/models/user.ts, src/session/store.ts]
constraints: [Reuse the existing SessionStore; no new paid infrastructure]
non_goals: [OAuth, account recovery, frontend]
scope: { allowed_paths: ["src/auth/**", "src/app.ts", "tests/auth/**"] }
acceptance_criteria:
  - { id: AC-1, condition: A valid credential creates a session, check: { kind: command, run: "npx vitest run tests/auth/valid-login.test.ts" } }
  - { id: AC-3, condition: A credential cannot be reused,         check: { kind: human_review } }
  - { id: AC-4, condition: Changes stay within scope,              check: { kind: diff_scope } }
budget: { max_repairs: 2, stagnation_limit: 2 }
```

A contract without a `check` on every criterion, without `allowed_paths`, or without a budget is a lint
**error** and the agent is never spawned. See PRD §11 for all rules.

## Explain what happened

Every agent, contract and human decision is an object with a story:

```bash
npx tsx apps/cli/src/index.ts inbox   --replay fixtures/events-live-4.jsonl   # what needs a human right now
npx tsx apps/cli/src/index.ts explain planner --replay fixtures/events-live-4.jsonl
npx tsx apps/cli/src/index.ts explain contract:t-auth-routes --replay fixtures/events-live-4.jsonl
npx tsx apps/cli/src/index.ts story   --replay fixtures/events-live-4.jsonl --task t-login-page
```

The same object model (`packages/protocol/src/graph/`) drives the TUI's inspector and inbox.

## Roadmap · Phase 2: Relay Terminal

The next step is our own agent-based terminal: relayd hosts the PTYs, and a browser app arranges panes by the
graph, draws contracts between them, and puts answer / review / reply next to the pane that needs it.
Interfaces are frozen in `packages/protocol/src/pty.ts`; the two work packages (PTY host, web app) are
specified as Task Contracts in [`docs/relay-terminal-plan.md`](docs/relay-terminal-plan.md) — pick one up there.

### Relay Terminal (Rust)

`crates/relay-tui` is the native client (Ratatui): mission tree, explainable graph, live agent panes over
`/pty/:id`, inbox and inspector — HTTP/SSE/WS only, it never runs the reducer.

```bash
cargo run -p relay-tui -- --url http://127.0.0.1:7420          # token: --token / RELAY_TOKEN / .relay/session.token
cargo run -p relay-tui -- --replay crates/relay-tui/tests/fixtures/live-7   # no relayd needed (q quits)
cargo run -p relay-tui -- --replay crates/relay-tui/tests/fixtures/live-1 --frames 1 --metrics-json  # headless frame + draw p50/p95
node scripts/dump-graph-fixture.mjs fixtures/events-live-1.jsonl live-1   # regenerate a replay fixture from a run log
```

## Repository layout and contributing

- `packages/protocol/src/{contract,events,state,api,mcp}.ts` are the integration contract; changes there need a
  reducer/fixture update in the same PR.
- New lint rule: one file under `packages/protocol/src/lint/rules/`, with a positive and a negative test.
- New runtime or host: one file under `apps/relayd/src/launch/{runtimes,hosts}/`, tests use the injected
  fake executor — no real processes in tests.
- `npx vitest run` and `npx tsc -b` must pass. Tests are hermetic (temp git repos, no network, no LLM calls).

This project was built by running its own protocol: six work packages, each a Task Contract with
`allowed_paths` and machine-checked acceptance criteria, executed in parallel by Claude Code and Codex agents
in git worktrees, then merged. The integration bugs found while doing that (prompt
delivery, folder trust, MCP approval, sandbox roots) are documented in the commit history.

## License

MIT
