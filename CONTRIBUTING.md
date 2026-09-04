# Contributing

Everything you need runs offline: tests use temporary git repositories and a fake process executor, and the
TUI can replay recorded runs, so you do not need Claude Code, Codex, Herdr or any API key to work on most of
the code.

```bash
npm install
npx tsc -b            # build all packages (the TUI and relayd import @relay/protocol from dist)
npx vitest run        # all tests (~230, hermetic, < 1 min)
node scripts/gen-protocol-docs.mjs   # regenerate docs/protocol.md + docs/schema after touching packages/protocol
npx tsx apps/tui/src/index.tsx --replay fixtures/events-live-1.jsonl   # see the UI without agents
```

## Where things live

| I want to… | Look at |
|---|---|
| change a contract / event / state field | `packages/protocol/src/{contract,events,state}.ts` — then the reducer, the fixtures and `docs/` in the same PR |
| add a lint rule | `packages/protocol/src/lint/rules/<rule_id>.ts` + `LintRuleId` + tests (one positive, one negative) |
| add an agent runtime or terminal host | `apps/relayd/src/launch/{runtimes,hosts}/` implementing `apps/relayd/src/ports.ts` |
| change how checks run or repairs are decided | `apps/relayd/src/verify/`, `apps/relayd/src/repair/` |
| change the lifecycle (spawn gating, clarification, integration) | `apps/relayd/src/orchestrator/orchestrator.ts` (tests use the fakes in `apps/relayd/src/fakes/`) |
| change the UI | `apps/tui/src/` — panels, `graph/` (character canvas), `data/` (SSE + replay) |
| add a demo | `examples/*.yaml` + `demo-repo/` |

## Rules of the road

- `npx tsc -b && npx vitest run` must pass. CI also checks that `docs/protocol.md` matches the schemas.
- Tests are hermetic: temp dirs, no network, no real agent processes (inject `exec`), no real LLM calls.
- Keep the three state layers independent (runtime / task / handoff) — see PRD §7.
- Prefer machine-verifiable evidence. If a feature makes "done" depend on an agent's word, it is probably wrong.
- Record a real run when you change the lifecycle: `.relay/runs/<run>/events.jsonl` → `fixtures/`.

## Running it for real

See the README quick start. Known runtime requirements we discovered the hard way (all handled in
`apps/relayd/src/launch/`): Herdr refuses multi-line agent arguments (prompt goes through `agent prompt`);
Claude Code needs the worktree pre-trusted in `~/.claude.json`; Codex needs `default_tools_approval_mode =
"approve"` for the relay MCP server and `writable_roots` covering its own home and runtime cache under the
workspace-write sandbox.
