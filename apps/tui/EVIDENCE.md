# TUI Objects Evidence

Branch: `wp/tui-objects`

Implementation range: `b0c4d2e..c652f95`

All authored paths are under `apps/tui/**`. The root `package-lock.json` modification
was already present before this work package and was neither staged nor changed by
this agent.

## AC-1

Command:

```text
npx vitest run apps/tui -t "selection"
Test Files  1 passed | 11 skipped (12)
Tests       1 passed | 56 skipped (57)
```

The hand-built fixture contains 4 nodes, 4 edges, and 2 inbox items. Ink stdin tests
cover tree → graph → inbox → timeline, graph-object movement, and inverse ID
highlighting. Additional regressions keep selected objects visible when panels scroll.

## AC-2

Command:

```text
npx vitest run apps/tui -t "actions"
Test Files  2 passed | 10 skipped (12)
Tests       6 passed | 51 skipped (57)
```

The tests inject `GraphApi.actionsFor`, verify that only returned keys are displayed
and active, and parse the recorded POST bodies with `ReplyBody`, `ClarifyBody`, and
`ReviewBody`. Task and mission clarify routes, reply, criterion-targeted pass/fail,
and cancel confirmation are covered.

## AC-3

Command:

```text
npx vitest run apps/tui -t "story"
Test Files  2 passed | 10 skipped (12)
Tests       4 passed | 53 skipped (57)
```

Node and edge inspectors assert Story is first, `describe` title/facts precede a
blank line and `storyFor`, and task-only tabs remain available. A replay regression
also proves a requested object stays pending until its graph object arrives.

## AC-4

Command:

```text
npx vitest run apps/tui -t "inbox"
Test Files  3 passed | 9 skipped (12)
Tests       5 passed | 52 skipped (57)
```

Inbox tests cover kind icons, dim details, selection windowing, Enter jumping to
`item.ref`, and `i` inspecting the inbox object's own story.

## AC-5

The managed sandbox prevents the installed `tsx` CLI from creating its coordinator
Unix socket, before application code starts:

```text
Error: listen EPERM: operation not permitted .../tsx-501/*.pipe
```

The equivalent loader invocation bypasses only that CLI coordinator and exercises
the same entry point and arguments:

```text
node --import tsx apps/tui/src/index.tsx --replay fixtures/events-live-4.jsonl --frames 1 --no-tty --select node:planner | wc -l
30
```

The temporary protocol graph stub intentionally produces the empty-graph placeholder;
the process exits 0 and prints the required 20 or more lines. CLI tests also cover all
three `--select` reference kinds and malformed values.

## AC-6

Command:

```text
npx tsc -b && npx vitest run apps/tui
Test Files  12 passed (12)
Tests       58 passed (58)
```

Whole-repository typechecking exits 0. The exact whole-repository test command was
also run: 30 files / 261 tests pass; only 8 out-of-scope relayd tests fail because
the sandbox rejects `tsx` IPC and `127.0.0.1` listeners (`EPERM`). No TUI test fails.

## Diff and review

```text
git diff --check b0c4d2e..c652f95 -- apps/tui
(no output; exit 0)

26 files changed, 1369 insertions(+), 543 deletions(-)
```

Changed code is confined to the TUI dependency context, commands, object navigation,
graph/canvas renderers, Tree/Inbox/Timeline/Overlay panels, CLI parsing, hand-built
fixtures, and their tests. Independent code review found no remaining Critical or
Important issues after remediation.

## Conservative interpretations

- Evidence and handoff files live under `apps/tui/` because the user explicitly
  prohibited writes outside `allowed_paths`, despite the common contract's root-file
  wording.
- Inbox is a normal visible Tab region; `i` inspects its selected object, while Enter
  performs the specified target jump.
- Timeline maintains an event cursor because `GraphObjectRef` deliberately has no
  event variant.

STATUS: done
