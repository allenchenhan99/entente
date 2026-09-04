# Handoff Notes

## Questions

- The contract requires root-level `EVIDENCE.md` and `HANDOFF_NOTES.md`, while both
  `allowed_paths: apps/tui/**` and the user instruction prohibit writes outside that
  scope. Conservative interpretation: keep both artifacts under `apps/tui/` so no
  parallel work package's files are touched.
- The inbox is described both as “toggled with `i`” and as a normal Tab-cycled region,
  while `i` is also specified to inspect any selected object. Conservative
  interpretation: the inbox is an always-rendered region reached by Tab; `i` remains
  the inspector shortcut for a selected object, and an empty selection can use Tab
  to reach the inbox safely.
- Timeline is named as a selection region, but `GraphObjectRef` has no event variant.
  Conservative interpretation: timeline movement uses a separate event cursor and
  does not replace the current graph-object selection.

## Integration

- Tests inject hand-built `Graph` objects. The runtime default uses the protocol graph
  functions and therefore renders placeholders until the parallel graph-model work
  package replaces the current stub.

## Verification environment

- This managed sandbox rejects Unix-domain socket creation by the installed `tsx`
  CLI (`listen EPERM .../tsx-501/*.pipe`) and TCP listeners on `127.0.0.1`. The exact
  headless `npx tsx` smoke command and relayd boot/MCP tests therefore cannot start
  here. `node --import tsx` exercises the same TUI entry point without the CLI IPC
  coordinator and prints 30 lines. All non-listener repository tests pass; the full
  run reports only relayd's one IPC-dependent boot test and seven listener-dependent
  MCP tests as failures.
