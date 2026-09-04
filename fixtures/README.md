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
- `events-live-3.jsonl` — mission planned by a live Claude Code planner (`relay up --planner claude-code`):
  its first three contracts were blocked by lint (`missing_input`: prose in `inputs` instead of file paths),
  it fixed and re-proposed all three (v2), password-hashing and throttle ran in parallel, the routes task was
  spawned only after both completed with its worktree based on their merged branches, all 15 criteria were
  machine-checked, and the three branches were integrated and verified.
- `events-live-4.jsonl` — planner-asks-first run (2026-09-04): the Claude Code planner raised six mission-level
  questions (mechanism, session transport, surface, credentials, brute-force protection, dependencies) via
  `relay_ask_human` before decomposing; the human answered with `relay clarify m-…`; the planner then proposed a
  serial chain core → routes → login page (Codex), every contract passed lint first time, all 17 criteria were
  machine-checked, and the three branches were integrated and verified.
- `events-live-5.jsonl` — every human action taken inside the object-oriented TUI (2026-09-04): answered a
  clarification from the inbox (`a`), failed a `human_review` criterion (`f`) which opened repair r1, replied to the
  agent's "cannot reproduce" blocker (`r`), passed the criterion on attempt 2 (`p`); Codex frontend verified first
  try; both branches integrated, mission verified.
- `events-live-6.jsonl` — first run on RelayGraph's **own terminal host** (`RELAY_HOST=relay`, 2026-09-04): both
  agents lived in relayd-managed PTYs (`relay:1` Claude Code, `relay:2` Codex) with server-side screen models;
  prompts were delivered by readiness detection, clarifications answered, evidence verified, branches integrated,
  mission verified. Casts (asciinema v2) were recorded under `.relay/runs/<run>/casts/` (not committed: ~1 MB).
- `events-live-7.jsonl` — agent networking on the relay host (2026-09-04): the backend (Claude Code, `relay:1`)
  delegated the token store to a Codex subtask via `relay_propose_subtask` (`parent_task` set, delegation edge in
  the graph), waited with `relay_await_task`, the subtask was verified and merged into the parent's worktree;
  a real `diff_scope` failure exposed a relayd bug (subtask files counted against the parent), the agent explained
  it in a blocker, relayd was fixed and **restarted with `RELAY_RESUME=latest`** (the Claude session was resumed
  in `relay:3`), the human replied to the blocker, the agent resubmitted, and the mission was verified.
- `events-live-8.jsonl` — first run on the **Rust terminal base** (`RELAY_HOST=relayterm`, 2026-09-05): relayd drove
  `termd` (`crates/termd`), both agents (`relay:1` Claude Code backend, `relay:2` Codex frontend) got their prompts
  through termd's readiness detection, asked 8 + 3 clarification questions (the frontend caught an endpoint name
  that contradicted the human's answer to the backend), evidence passed on the first attempt, the human reviewed
  AC-3, the integration branch ran the whole suite inside the check sandbox, mission verified. `metrics-live-8.json`
  is termd's `HostMetrics` for the run: Claude prompt accepted in 30 ms, Codex needed one Enter retry (5 s) for its
  large paste. `crates/relay-tui/tests/fixtures/live-8` is the relay-tui replay dump of this log.
