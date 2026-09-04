## Questions

- `GET /panes` is frozen as `PaneInfo[]`, but `PaneInfo` has no focused field and no read endpoint exposes the focused pane. How should `relay pane list` identify the row that receives `*`? Conservative implementation: accept an optional additive `focused: boolean` on each list item, validate the base fields with `PaneInfo`, and render `*` only when that flag is exactly `true`.
