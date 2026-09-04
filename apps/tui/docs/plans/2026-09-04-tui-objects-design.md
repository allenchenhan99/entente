# Object-oriented RelayGraph TUI Design

## Context and approved intent

`WORK_CONTRACT.md` is the approved product design for this change. Every protocol
graph node, edge, and inbox item becomes a selectable TUI object. The graph-model
implementation is intentionally unavailable during this work package, so the TUI
depends only on the frozen `GraphApi` interface and all behavioral tests inject
hand-built `Graph` values.

The protocol stub remains the production default until the parallel graph-model
branch lands. An empty graph therefore renders explicit empty placeholders and
keeps keyboard navigation safe.

## Approaches considered

1. Import protocol graph functions directly in every component. This is small, but
   cannot be tested against meaningful graphs while the implementation is a stub.
2. Re-derive graph objects from tasks inside the TUI. This preserves today's UI,
   but violates the frozen object-model boundary and would duplicate semantics.
3. Inject one `GraphApi` dependency and render only its `Graph` output (selected).
   This keeps production wiring minimal, enables hermetic hand-built graph tests,
   and makes the parallel implementation a drop-in replacement.

## Architecture and selection

`DependenciesProvider` supplies the seven-function `GraphApi` alongside fetch and
command execution. `App` calls `buildGraph(state)` and owns one `GraphObjectRef`.
Region-specific ordered references are:

- tree: agent nodes in `graph.nodes` order;
- graph: nodes followed by edges, preserving each protocol array's order;
- inbox: inbox item references in `graph.inbox` order;
- timeline: a separate event cursor, leaving the current object selection intact.

Tab enters the next region and selects its first object when one exists. Movement
clamps within the active region. The same reference drives inverse/bold styling in
every panel that contains the object. Inbox Enter replaces the inbox reference with
the item's target reference before opening the inspector.

## Rendering

The tree is sourced only from agent nodes. The graph canvas lays out graph nodes by
their protocol column and draws every protocol edge in order, using `edge.label`
verbatim. `VisualStatus` selects 16-colour styles and animation phases; selection
adds bold and ANSI inverse. IDs remain visible so selection can be verified in a
terminal frame. Empty nodes, edges, and inbox arrays each have concise placeholders.

The inbox panel renders a stable kind icon and title row plus dim, truncated detail
rows. The footer replaces metrics with `inbox:N` when N is non-zero and otherwise
keeps the prior metrics summary.

## Inspector and actions

The inspector always starts with Story: `describe(ref)` title and fact lines, one
blank line, then `storyFor(ref, graph, state, events)`. Contract, Response,
Questions, Evidence, and History are appended only when the reference resolves to a
task-scoped node, edge, or inbox item.

`actionsFor(selected)` is the sole authority for `a`, `r`, `p`, `f`, and `x`.
The footer lists only returned actionable keys with canonical labels. Clarification
and mission clarification open one-line inputs and POST schema-valid `ClarifyBody`;
reply POSTs `ReplyBody`; reviews use the action's criterion id; cancellation keeps
confirmation. Enter and `i` inspect the selected object, while entering the inbox
region through Tab makes its panel directly navigable.

## Headless mode and errors

`--select node:<id>|edge:<id>|inbox:<id>` is parsed into a `GraphObjectRef` and
opens Story on the first headless frame when the object exists. With the temporary
empty graph stub, the selected object cannot resolve, so the frame renders the
empty-graph placeholder and still exits successfully. Command failures remain
visible inside the inspector and never activate actions absent from `actionsFor`.

## Testing

Acceptance tests build a four-node/four-edge/two-inbox graph by hand and inject a
fake `GraphApi`. Ink stdin tests prove region order, object movement, cross-panel
selection, action gating and request bodies, Story ordering, and inbox jumping.
CLI tests cover `--select` parsing and the required no-TTY replay command. Every
production change follows a witnessed red-green-refactor cycle.
