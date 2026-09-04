# RelayGraph TUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the complete Ink RelayGraph terminal UI with live SSE, deterministic JSONL replay, graph animation, overlays, keyboard commands, and headless CI rendering.

**Architecture:** Pure state-to-view and canvas modules sit beneath thin Ink panels and hooks. Both live and replay data are validated by `@relay/protocol` and use its reducer, while external effects are injected for hermetic tests.

**Tech Stack:** TypeScript/NodeNext, React 19, Ink 7, ink-testing-library, Vitest 5, Zod schemas from `@relay/protocol`.

---

### Task 1: Fixtures and character canvas

**Files:**
- Create: `apps/tui/src/__fixtures__/states.ts`
- Create: `apps/tui/src/graph/canvas.ts`
- Test: `apps/tui/src/graph/canvas.test.ts`

1. Write canvas tests for clipping, orthogonal arrows, corner/arrow glyphs, ANSI style,
   and exact display dimensions.
2. Run `npx vitest run apps/tui -t "canvas"` and confirm failures are caused by the
   missing canvas module.
3. Implement the minimal cell grid, bounded drawing operations, ANSI run rendering,
   and plain-text stripping helper.
4. Run the focused test to green, then add three typed hand-written `State` fixtures:
   happy, mid-clarification, and mid-repair.
5. Run the focused test and commit `feat(tui): add state fixtures and graph canvas`.

### Task 2: Fixed graph layout and semantic edges

**Files:**
- Create: `apps/tui/src/graph/layout.ts`
- Create: `apps/tui/src/graph/edges.ts`
- Create: `apps/tui/src/graph/Graph.tsx`
- Test: `apps/tui/src/graph/graph.test.tsx`

1. Write fixture-driven tests for amber `? 2`, accepted `v2 ✓`, repair back-edge
   `AC-2`, dependency markers, and all-happy verified edges.
2. Run `npx vitest run apps/tui -t "graph states"` and observe the missing behavior.
3. Implement sorted fixed columns, planner/task/verifier/done nodes, mapped edge
   semantics, tick-dependent phases, and an Ink graph component.
4. Run the graph test to green and refactor routing labels without changing output.
5. Commit `feat(tui): render animated handoff graph states`.

### Task 3: Tree and timeline panels

**Files:**
- Create: `apps/tui/src/panels/Tree.tsx`
- Create: `apps/tui/src/panels/Timeline.tsx`
- Test: `apps/tui/src/panels/Tree.test.tsx`
- Test: `apps/tui/src/panels/Timeline.test.tsx`

1. Write tree tests covering mission/lint headers, all three task-state layers,
   clarification/worktree/dependency detail lines, and pre-acceptance dim ANSI.
2. Write timeline tests for capped visible tails, chronological display, and payload
   hints such as `→ v2`, `AC-2 failed`, and `? 2`.
3. Run `npx vitest run apps/tui -t "tree|timeline"` to verify red.
4. Implement focused pure formatting helpers and thin Ink components.
5. Run focused tests to green and commit `feat(tui): add mission tree and event timeline`.

### Task 4: Replay data layer with real fixtures

**Files:**
- Create: `apps/tui/src/data/jsonl.ts`
- Create: `apps/tui/src/data/replay.ts`
- Test: `apps/tui/src/data/replay.test.tsx`

1. Write tests that parse both `fixtures/events-happy.jsonl` and
   `fixtures/events-repair.jsonl`, replay them with protocol `replay`, and assert real
   final/repair states.
2. Write hook tests proving `step(+1)` advances cursor and `last_seq` together,
   `step(-1)` rebuilds prior state, and `seek(0)` yields `initialState()`.
3. Run `npx vitest run apps/tui -t "replay"` to verify red.
4. Implement validated JSONL loading, precomputed reducer snapshots, timestamp-based
   playback (`delay / speed`), speed control, toggle, step, and seek.
5. Run focused tests to green and commit `feat(tui): add protocol-backed replay data layer`.

### Task 5: Live SSE data layer

**Files:**
- Create: `apps/tui/src/data/sse.ts`
- Create: `apps/tui/src/data/live.ts`
- Test: `apps/tui/src/data/live.test.tsx`

1. Write tests for SSE `id:`/multiline `data:` parsing, initial `/state`, reduction of
   streamed events, the 200-event ring, and reconnect URL `?since=<last_seq>`.
2. Run the focused test and verify expected failures.
3. Implement the abortable fetch-stream parser and reconnecting `useLiveState` hook.
4. Run the focused tests to green and commit `feat(tui): stream live state over SSE`.

### Task 6: Overlay and validated commands

**Files:**
- Create: `apps/tui/src/commands.ts`
- Create: `apps/tui/src/context.tsx`
- Create: `apps/tui/src/panels/Overlay.tsx`
- Create: `apps/tui/src/keys.ts`
- Test: `apps/tui/src/keys.test.tsx`
- Test: `apps/tui/src/panels/Overlay.test.tsx`

1. Write keyboard tests where `a` opens Questions and submission POSTs a body accepted
   by `ClarifyBody.parse`; write `f` input tests for failed `ReviewBody` with observed
   text. Add pass, cancel-confirmation, and injected focus executor coverage.
2. Write overlay tests for five tabs, full contract fields, naive version diff,
   response, evidence checks/mismatches, and repair/version history.
3. Run `npx vitest run apps/tui -t "keys|overlay"` to verify red.
4. Implement schema-validated POST/focus helpers, input modes, and overlay rendering.
5. Run focused tests to green and commit `feat(tui): add contract overlay and keyboard commands`.

### Task 7: Responsive application shell

**Files:**
- Create: `apps/tui/src/App.tsx`
- Create: `apps/tui/src/tick.ts`
- Test: `apps/tui/src/App.test.tsx`

1. Write tests for stacked 40/35/25 regions, timeline expansion, selection/focus,
   120 ms animation, replay controls, and the exact footer metrics/mode summary.
2. Run the focused tests to verify red.
3. Implement terminal resize tracking, panel orchestration, focus navigation, animation,
   help, and footer rendering.
4. Run focused tests to green and commit `feat(tui): compose responsive RelayGraph app`.

### Task 8: CLI and non-TTY headless rendering

**Files:**
- Modify: `apps/tui/src/index.tsx`
- Test: `apps/tui/src/index.test.tsx`

1. Write CLI parser and spawned-process tests for defaults, all flags, invalid input,
   automatic non-TTY headless mode, and two repair-fixture frames with 20+ lines.
2. Run `npx vitest run apps/tui -t "headless"` and verify red.
3. Implement interactive live/replay startup and deterministic test-renderer headless
   output, stripping ANSI before writing stdout.
4. Run the headless test and the exact contract command:
   `npx tsx apps/tui/src/index.tsx --replay fixtures/events-repair.jsonl --frames 2 --no-tty`.
5. Commit `feat(tui): add CLI and headless replay rendering`.

### Task 9: Integration verification and evidence

**Files:**
- Create or update: `EVIDENCE.md` (contract-authorized root artifact)
- Create if needed: `HANDOFF_NOTES.md` (contract-authorized root artifact)

1. Run every AC command individually and capture trimmed output.
2. Run `npx tsc -b && npx vitest run apps/tui`, then the required whole-repo
   `npx tsc -b && npx vitest run`.
3. Inspect `git diff --check`, `git status --short`, changed paths, and branch name.
4. Write one evidence section per AC, document conservative interpretations, append
   the exact final line `STATUS: done`, and verify the file ending.
5. Commit `docs(tui): record acceptance evidence`.
