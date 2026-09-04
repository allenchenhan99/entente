# TUI Work Package Evidence

Branch: `wp/tui`

Implementation commits:

- `6009682` `docs(tui): plan RelayGraph terminal UI`
- `1393f0e` `feat(tui): add state fixtures and graph canvas`
- `8139cd7` `feat(tui): render animated handoff graph states`
- `3c1a71a` `feat(tui): add mission tree and event timeline`
- `70ab46f` `feat(tui): add protocol-backed replay data layer`
- `1e9bd61` `feat(tui): stream live state over SSE`
- `aa7ff4a` `feat(tui): add contract overlay and keyboard commands`
- `fcff0dc` `feat(tui): compose responsive RelayGraph app`
- `d298d2e` `feat(tui): add CLI and headless replay rendering`
- `6dd6c4c` `fix(tui): stop evidence particle at verifier`
- `e161a86` `fix(tui): support root-level TSX execution`

## AC-1

Command: `npx vitest run apps/tui -t "canvas"`

```text
Test Files  1 passed | 9 skipped (10)
Tests       5 passed | 33 skipped (38)
exit_code=0
```

Canvas coverage proves left/right/vertical clipping, bounded horizontal and vertical
lines, horizontal-then-vertical arrows with `─`/`│`/corner/`▶`, styled ANSI output,
and exact configured dimensions after ANSI removal.

## AC-2

Command: `npx vitest run apps/tui -t "graph states"`

```text
Test Files  1 passed | 9 skipped (10)
Tests       6 passed | 32 skipped (38)
exit_code=0
```

The three hand-written protocol `State` fixtures prove amber/pulsing `? 2`, accepted
`v2 ✓`, dependency and blocked markers, the red `AC-2` verifier back-edge, verified
edges for every happy task, shifted dotted phases, moving evidence, and a particle
that stops rather than wraps at the verifier.

## AC-3

Command: `npx vitest run apps/tui -t "tree"`

```text
Test Files  1 passed | 9 skipped (10)
Tests       3 passed | 35 skipped (38)
exit_code=0
```

The tree tests prove mission/lint summaries, independent runtime/task/handoff layers,
the exact `◐ blocked on t-backend-auth` detail, clarification counts, worktree paths,
and dim pre-acceptance worktree semantics.

## AC-4

Command: `npx vitest run apps/tui -t "timeline|replay"`

```text
Test Files  4 passed | 6 skipped (10)
Tests       10 passed | 28 skipped (38)
exit_code=0
```

The timeline shows its newest-last visible tail and typed hints. Replay tests load
both merged `fixtures/events-happy.jsonl` and `fixtures/events-repair.jsonl` with the
real protocol event parser/reducer. `step(+1)` advances cursor and `last_seq` together;
`seek(0)` restores `initialState()`.

## AC-5

Command: `npx vitest run apps/tui -t "keys"`

```text
Test Files  1 passed | 9 skipped (10)
Tests       3 passed | 35 skipped (38)
exit_code=0
```

With fetch and command execution injected through context, the tests prove `a` opens
Questions and POSTs a `ClarifyBody.parse`-valid body, while `f` collects observed text
and POSTs a failed `ReviewBody.parse`-valid body. Focus argv and cancel confirmation
are also covered without invoking real Herdr/tmux processes.

## AC-6

Command: `npx vitest run apps/tui -t "headless"`

```text
Test Files  1 passed | 9 skipped (10)
Tests       4 passed | 34 skipped (38)
exit_code=0
```

The tests render two frames from the real repair fixture through
`ink-testing-library`, require at least 20 lines per frame, reject ANSI escapes, and
prove non-TTY auto-detection.

Fresh source-runtime check:

```text
$ node --import tsx apps/tui/src/index.tsx --replay fixtures/events-repair.jsonl --frames 2 --no-tty
exit_code=0
rendered_lines=60
```

Fresh compiled-runtime check:

```text
$ node apps/tui/dist/index.js --replay fixtures/events-repair.jsonl --frames 2 --no-tty
exit_code=0
rendered_lines=60
```

The exact `npx tsx ...` wrapper was also attempted. This managed shell rejects tsx's
own pre-start Unix IPC socket with `listen EPERM`; it fails before loading the TUI.
Both the same TSX loader invoked without its IPC wrapper and the compiled entry point
pass, demonstrating that the application path itself exits cleanly.

## AC-7

Command: `npx tsc -b && npx vitest run apps/tui`

```text
Test Files  10 passed (10)
Tests       38 passed (38)
exit_code=0
```

Required whole-repository gate: `npx tsc -b && npx vitest run`

```text
Test Files  18 passed (18)
Tests       153 passed (153)
exit_code=0
```

## Diff and changed paths

`git diff --check` exits 0. The branch audit against `origin/main` reports no changed
implementation path outside `apps/tui/**`. `EVIDENCE.md` is the explicit root-level
output required by the work contract. The working branch is `wp/tui`.

Conservative interpretations used:

- The frozen work contract and PRD are the approved design; no additional approval
  round was introduced because the user required autonomous execution without
  questions.
- Replay timestamp speed uses `delay / speed`, so larger values play faster.
- “Three layers per task” means runtime, task, and handoff state are all visible in
  each task summary, with the second line reserved for worktree/dependency/question
  context as specified by PRD §12.2.
- Headless frames are deterministic snapshots distributed across the replay log;
  this makes repair and terminal states visible in CI without wall-clock waits.

STATUS: done
