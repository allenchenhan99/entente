## Questions

- `GET /panes` is documented in frozen `pty.ts` as `PaneInfo[]`, but `PaneInfo` has no focused field and no read endpoint exposes the focused pane. The parallel server implementation returns `{ panes: PaneInfo[], focused_pane?: string }`. Which shape should clients treat as canonical? Conservative implementation: accept and validate the server envelope, retain compatibility with the frozen raw array, and only use an item-level `focused: boolean` as a legacy fallback.

## Proposed frozen API diff

Reason: the focused marker required by `relay pane list` cannot be derived from `PaneInfo[]`; the schema should describe the response already emitted by the server.

```diff
 export const PaneInfo = z.object({
   // existing fields unchanged
 });
+export const PaneList = z.object({
+  panes: z.array(PaneInfo),
+  focused_pane: PaneId.optional(),
+});

 export const ptyRoutes = {
-  /** `GET` → PaneInfo[] · `POST /panes/:id/kill` · `POST /panes/:id/focus` (records the focused pane for other clients). */
+  /** `GET` → PaneList · `POST /panes/:id/kill` · `POST /panes/:id/focus` (records the focused pane for other clients). */
   panes: '/panes',
```
