# RelayGraph TUI Design

## Context and decision

`WORK_CONTRACT.md` and `PRD.md` are the approved product design. The TUI is a thin
Ink client over the frozen `@relay/protocol` types and reducer. It owns no workflow
state transitions: live events and replay events are both parsed with the protocol
schemas and applied with `reduce`/`replay`.

The implementation favors small pure modules under thin React hooks and components.
That keeps canvas routing, graph semantics, timeline formatting, replay transitions,
and command payload construction deterministic and testable without a TTY.

## Alternatives considered

1. Pure Ink layout using nested `<Box>` elements. This is simplest for panels, but
   cannot express stable orthogonal graph routing or frame-by-frame particles well.
2. A whole-screen character framebuffer. This offers total control, but duplicates
   Ink layout and makes input overlays unnecessarily difficult.
3. Hybrid rendering (selected): Ink owns vertical regions, inputs, and lifecycle;
   a bounded character `Canvas` owns only the handoff graph. It preserves exact graph
   geometry while retaining accessible component-level tests and resizing.

## Architecture

- `src/data/`: JSONL parsing, replay timing/navigation, and reconnecting fetch-based
  SSE. The hooks expose derived `State` plus a capped 200-event timeline.
- `src/graph/`: a cell canvas, fixed four-column layout, semantic edge mapping, graph
  frame rendering, and the 120 ms animation tick.
- `src/panels/`: mission/task tree, event timeline, and five-tab overlay.
- `src/commands.ts` and `src/keys.ts`: validated HTTP command bodies, injected fetch
  and focus execution, and keyboard state transitions.
- `src/App.tsx`: terminal sizing, panel proportions, focus/selection, overlay state,
  footer metrics, and live/replay controls.
- `src/index.tsx`: CLI parsing and interactive/headless startup. Headless replay uses
  `ink-testing-library`, emits plain text frames, and exits without TTY APIs.

## Rendering semantics

The tree presents runtime, task, and handoff states for every task, followed by a
context line for the worktree, dependencies, blocker, or clarification count. Graph
columns are planner, sorted coding tasks, virtual verifier, and done. Styles are
16-color ANSI only. The canvas clips every write and returns exactly its configured
height and display-cell width after ANSI is removed.

The timeline keeps events oldest-to-newest within its visible tail, so the newest
event is last. Its hint formatter is event-type aware. The footer summarizes mode,
cursor, speed, and the four demo metrics required by the contract.

## Data flow and error handling

Replay loads and validates every non-empty JSONL line, precomputes cursor states with
the protocol reducer, and schedules the next event using timestamp delta divided by
speed. Seeking zero returns `initialState()`. Invalid files fail startup with a clear
message.

Live mode fetches `/state`, validates the snapshot, then consumes `/events` as SSE.
It parses `id:` and multiline `data:` fields, reduces valid events, and reconnects to
`/events?since=<last_seq>` after stream or network errors. Cleanup aborts fetches and
timers. Only the latest 200 received events are retained.

Command helpers validate `ClarifyBody`, `ReviewBody`, and cancel bodies before POST.
Non-2xx responses surface as UI errors. Focus commands receive argv arrays and an
injected executor, preventing shell interpolation and real process use in tests.

## Testing

Development follows red-green-refactor for each acceptance criterion. Hand-written
`State` fixtures drive panel and graph tests; the merged repository JSONL fixtures
drive protocol replay and headless integration tests. Hooks use fake timers and fake
fetch/streams. Final verification runs every contract command plus the whole-repo
typecheck and test suite from the worktree root.
