# Fixtures

Recorded or hand-written event logs (`*.jsonl`, one `Event` JSON per line, `seq` ascending) used by:
- the TUI in replay mode (`relay-tui --replay fixtures/events-repair.jsonl`)
- reducer tests in `packages/protocol`
- contributors who have no LLM API key

## Files

Both logs describe the same mission `m-001` ("Add secure login to this application") with three tasks:

| task | recipient / runtime | depends on |
|---|---|---|
| `t-backend-auth` | `backend` / claude-code | — |
| `t-frontend-login` | `frontend` / codex | — |
| `t-e2e-tests` | `e2e` / claude-code | `t-backend-auth` |

- `events-happy.jsonl` (52 events) — every contract lints clean, every task is accepted on the first
  proposal, all checks pass on attempt 1, the mission integrates and is verified.
- `events-repair.jsonl` (69 events) — the demo path:
  1. backend asks two clarification questions (auth method, link expiry) → human answers → v2 accepted;
  2. frontend's v1 has an acceptance criterion without a `check` → `lint_reported` error blocks spawn →
     planner revises to v2 → lint clean → spawned;
  3. frontend reports a blocker while waiting on backend's response shape, then unblocks;
  4. backend's first evidence claims AC-2 passed but the check fails (`self_report_mismatch: ["AC-2"]`) →
     scoped repair `t-backend-auth/r1` → attempt 2 passes → human review of AC-3 → verified;
  5. e2e runs once backend completes; integration and mission verified.

Timestamps start at `2026-09-05T10:00:00+08:00` and advance 20 s–3 min per event. Every line is a valid
`Event`; `lint_reported` payloads are produced by the real `lintContract`.

## Regenerating

```sh
npx tsx fixtures/scripts/generate-events.ts
```

The generator validates each event with `Event.parse` before writing. `packages/protocol/src/fixtures.test.ts`
replays both files and pins the expected end state and metrics.

## Recorded runs

- `events-live-1.jsonl` — first real end-to-end run (2026-09-04): one Claude Code recipient on the demo app,
  contract accepted, evidence with 4 machine checks passing, `human_review` on AC-3 failed by the reviewer,
  delta repair `r1`, agent reports a blocker (cannot reproduce) while still adding regression tests, second
  evidence, reviewer passes AC-3, task verified. The Codex frontend task was canceled in this run (its MCP
  approval config was fixed afterwards). Absolute paths in payloads are from the recording machine.
- `events-live-2.jsonl` — full mission run (2026-09-04): both recipients (Claude Code backend, Codex frontend)
  asked for clarification before writing code (7 answers → contracts v2), worked in parallel, submitted evidence
  verified by relayd's checks plus one human review, then both branches were merged into `relay/integration`,
  the integration check passed and the mission was verified.
