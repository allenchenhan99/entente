# entente · RelayGraph

**Turn fuzzy natural-language handoffs between coding agents into confirmable, trackable, verifiable, retryable work contracts.**

> Agent frameworks tell you whether an agent is running.
> RelayGraph tells you whether agents actually understand each other.

RelayGraph is a coordination control plane that sits *above* coding-agent runtimes (Claude Code, Codex) and
terminal hosts (tmux, [Herdr](https://herdr.dev)). It does not replace them. It makes every handoff between
agents an explicit **Task Contract** with a lifecycle:

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
| `apps/relayd` | the daemon: JSONL event store, HTTP + SSE API, **MCP server the agents talk to**, git worktree manager, check runner, repair policy, agent launcher (Herdr / tmux hosts, Claude Code / Codex runtimes) |
| `apps/tui` | Ink terminal UI: mission tree, animated handoff graph, event timeline, contract overlay, live (SSE) and replay modes |
| `apps/cli` | `relay up / status / clarify / review / cancel / replay` |
| `demo-repo` | a small Hono app with a user model and session store and **no authentication** — the target of the demo mission |
| `fixtures` | replayable event logs, including a recorded real run (`events-live-1.jsonl`) |
| `examples` | hand-written contracts for the demo mission |

## Quick start

Requirements: Node ≥ 22, git, and a terminal host — [Herdr](https://herdr.dev) (run relayd inside a Herdr pane)
or tmux (create a session named `relay` first). Agents: `claude` (Claude Code) and/or `codex` on your PATH, logged in.

```bash
npm install && npx tsc -b

# 1. materialise the demo app as its own git repository
bash demo-repo/scripts/init-demo.sh ~/entente-demo/app && (cd ~/entente-demo/app && npm install)

# 2. start the daemon (inside a Herdr pane; use RELAY_HOST=tmux otherwise)
RELAY_HOST=herdr RELAY_REPO=~/entente-demo/app npx tsx apps/relayd/src/index.ts

# 3. in another pane: the TUI
npx tsx apps/tui/src/index.tsx --url http://127.0.0.1:7420

# 4. in another pane: create the mission — either let a planner agent write the contracts…
npx tsx apps/cli/src/index.ts up "Add secure login to this application." \
  --repo ~/entente-demo/app --planner claude-code --host herdr
#    …or load hand-written contracts (deliberately vague, so recipients must ask first)
npx tsx apps/cli/src/index.ts up "Add secure login to this application." \
  --repo ~/entente-demo/app --plan examples/plan-secure-login.yaml --host herdr

# when an agent asks for clarification / when a human_review criterion is pending:
npx tsx apps/cli/src/index.ts clarify t-backend-auth Q1="email magic link" Q2="15 minutes, single use"
npx tsx apps/cli/src/index.ts review  t-backend-auth AC-3 fail "replaying a used token returned 200"
```

No agents, no API keys? Replay a recorded run:

```bash
npx tsx apps/tui/src/index.tsx --replay fixtures/events-live-1.jsonl
```

## How an agent takes part

relayd is an MCP server (streamable HTTP at `/mcp`). Each spawned agent gets a bearer token that identifies its
task and a bootstrap prompt describing the lifecycle. The tools:

| Recipient tools | Planner tools |
|---|---|
| `relay_get_contract` · `relay_respond_to_contract` · `relay_await_contract` | `relay_get_mission` · `relay_propose_task` · `relay_list_tasks` |
| `relay_report_progress` · `relay_report_blocker` | `relay_revise_task` · `relay_answer_clarification` |
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

## Repository layout and contributing

- `packages/protocol/src/{contract,events,state,api,mcp}.ts` are the integration contract; changes there need a
  reducer/fixture update in the same PR.
- New lint rule: one file under `packages/protocol/src/lint/rules/`, with a positive and a negative test.
- New runtime or host: one file under `apps/relayd/src/launch/{runtimes,hosts}/`, tests use the injected
  fake executor — no real processes in tests.
- `npx vitest run` and `npx tsc -b` must pass. Tests are hermetic (temp git repos, no network, no LLM calls).

This project was built by running its own protocol: six work packages, each a Task Contract with
`allowed_paths` and machine-checked acceptance criteria, executed in parallel by Claude Code and Codex agents
in git worktrees managed through Herdr, then merged. The integration bugs found while doing that (prompt
delivery, folder trust, MCP approval, sandbox roots) are documented in the commit history.

## License

MIT
