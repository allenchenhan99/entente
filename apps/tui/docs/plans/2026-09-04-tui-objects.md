# Object-oriented RelayGraph TUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task.

**Goal:** Make protocol graph nodes, edges, and inbox items selectable objects with object-scoped stories and actions.

**Architecture:** Inject the frozen `GraphApi` through the TUI dependency context, derive one `Graph` per state snapshot, and drive every panel from that graph. Keep one shared `GraphObjectRef` selection across object panels and a separate timeline cursor.

**Tech Stack:** TypeScript/NodeNext, React 19, Ink 7, ink-testing-library, Vitest 5, frozen `@relay/protocol` graph types.

---

### Task 1: Graph test fixture and dependency seam

**Files:**
- Create: `apps/tui/src/__fixtures__/graph.ts`
- Modify: `apps/tui/src/context.tsx`
- Test: `apps/tui/src/App.test.tsx`

1. Add a failing selection test with a hand-built four-node/four-edge/two-inbox graph and fake `GraphApi`.
2. Run `npx vitest run apps/tui -t "selection"` and confirm failure is the missing graph dependency/selection behavior.
3. Add the injectable `GraphApi` defaulting to the protocol exports.
4. Re-run the focused test as far as the next missing behavior and commit the fixture/seam.

### Task 2: Object-backed tree, graph, and inbox panels

**Files:**
- Modify: `apps/tui/src/graph/{Graph,layout,edges}.tsx`
- Modify: `apps/tui/src/panels/Tree.tsx`
- Create: `apps/tui/src/panels/Inbox.tsx`
- Test: `apps/tui/src/graph/graph.test.tsx`
- Test: `apps/tui/src/panels/{Tree,Inbox}.test.tsx`

1. Write failing tests for graph ordering, VisualStatus styles, exact edge labels, selected inverse IDs, agent-only tree rows, inbox icons, and empty placeholders.
2. Run `npx vitest run apps/tui -t "selection|inbox|graph objects"` and verify red.
3. Implement minimal graph-object renderers and selection styling.
4. Run focused tests green, refactor shared status styling, and commit.

### Task 3: GraphObjectRef navigation and Story inspector

**Files:**
- Modify: `apps/tui/src/App.tsx`
- Modify: `apps/tui/src/keys.ts`
- Modify: `apps/tui/src/panels/Overlay.tsx`
- Test: `apps/tui/src/App.test.tsx`
- Test: `apps/tui/src/panels/Overlay.test.tsx`

1. Write failing stdin tests for tree → graph → inbox → timeline, clamped j/k movement, inbox target jump, and node/edge Story output.
2. Run `npx vitest run apps/tui -t "selection|story|inbox"` and verify expected failures.
3. Implement region lists, shared reference selection, contextual tabs, and Story-first overlay rendering.
4. Re-run focused tests green and commit.

### Task 4: Object-gated commands

**Files:**
- Modify: `apps/tui/src/commands.ts`
- Modify: `apps/tui/src/keys.ts`
- Test: `apps/tui/src/keys.test.tsx`

1. Write failing tests proving the exact action footer, absent-key no-ops, task/mission clarification, reply payloads, criterion-targeted pass/fail, and cancel confirmation.
2. Run `npx vitest run apps/tui -t "actions"` and verify red.
3. Add schema-valid mission clarification and reply helpers and dispatch only returned actions.
4. Run focused tests green and commit.

### Task 5: Headless selection

**Files:**
- Modify: `apps/tui/src/index.tsx`
- Test: `apps/tui/src/index.test.tsx`

1. Write failing CLI tests for all valid select refs and malformed refs.
2. Run `npx vitest run apps/tui -t "headless|select"` and verify red.
3. Thread the parsed initial reference into App and open Story when resolvable.
4. Run the required replay/no-TTY command and commit.

### Task 6: Full verification and evidence

**Files:**
- Create: `apps/tui/EVIDENCE.md`
- Create: `apps/tui/HANDOFF_NOTES.md`

1. Run AC-1 through AC-5 commands and capture trimmed outputs.
2. Run `npx tsc -b && npx vitest run apps/tui`, then `npx tsc -b && npx vitest run`.
3. Check `git diff --check`, branch name, status, and changed paths; do not include the pre-existing root `package-lock.json` change.
4. Record one section per AC and append the exact final line `STATUS: done`.
5. Commit the allowed-path evidence artifacts.
