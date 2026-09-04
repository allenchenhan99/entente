/**
 * Relay Terminal — the PTY host protocol (PRD §23, docs/relay-terminal-plan.md).
 *
 * relayd can host agent terminals itself (`TerminalHost` kind `relay`): each spawned agent gets a PTY whose
 * bytes are streamed to browser clients over a WebSocket at `routes.pty(paneId)`. Messages are JSON text
 * frames; terminal bytes are base64 so binary escape sequences survive. Every pane is also recorded as an
 * asciinema v2 cast next to the run's event log, so replay uses the same files.
 */
import { z } from 'zod';

export const PaneId = z.string().regex(/^relay:[0-9a-z-]+$/, 'relay pane ids look like relay:7');

export const PaneInfo = z.object({
  pane_id: PaneId,
  /** Task this pane hosts, or undefined for the planner. */
  task_id: z.string().optional(),
  /** Agent role shown as the pane title (`backend`, `planner`). */
  role: z.string(),
  runtime: z.enum(['claude-code', 'codex']).optional(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  alive: z.boolean(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Path of the asciinema v2 recording (`.relay/runs/<run>/casts/<pane>.cast`). */
  cast_path: z.string().optional(),
  started_at: z.string(),
  exited_at: z.string().optional(),
  exit_code: z.number().int().optional(),
});
export type PaneInfo = z.infer<typeof PaneInfo>;

/** Browser → relayd. */
export const PtyClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), data: z.string() }),          // base64 bytes typed by the user
  z.object({ t: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ t: z.literal('ping') }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;

/** relayd → browser. */
export const PtyServerMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), pane: PaneInfo }),
  /** Replay of the retained scrollback (base64), sent once right after `hello`. */
  z.object({ t: z.literal('scrollback'), data: z.string() }),
  z.object({ t: z.literal('output'), data: z.string() }),         // base64 bytes from the PTY
  z.object({ t: z.literal('exit'), code: z.number().int() }),
  z.object({ t: z.literal('pong') }),
]);
export type PtyServerMessage = z.infer<typeof PtyServerMessage>;

/** Layout is data: how the web app arranges panes from the graph object model. */
export const LayoutPreset = z.object({
  name: z.string(),
  /** Column per node kind; unspecified kinds fall back to `agent`. */
  columns: z.array(z.object({ kinds: z.array(z.enum(['human', 'planner', 'agent', 'verifier'])), width: z.number().positive() })),
  /** Sort agents inside a column: by dependency depth (default), by task id, or by spawn time. */
  order: z.enum(['dependency', 'id', 'spawn']).default('dependency'),
  /** Visual style per status; values are CSS colour tokens the app maps to its theme. */
  styles: z.record(z.string(), z.object({ border: z.string(), badge: z.string().optional(), pulse: z.boolean().default(false) })).default({}),
  /** Which panels are open: inspector, inbox, timeline. */
  panels: z.object({ inspector: z.boolean().default(true), inbox: z.boolean().default(true), timeline: z.boolean().default(true) }).default({ inspector: true, inbox: true, timeline: true }),
});
export type LayoutPreset = z.infer<typeof LayoutPreset>;

export const ptyRoutes = {
  /** `GET` → PaneInfo[] · `POST /panes/:id/kill` · `POST /panes/:id/focus` (records the focused pane for other clients). */
  panes: '/panes',
  pane: (paneId: string) => `/panes/${paneId}`,
  /** WebSocket. */
  pty: (paneId: string) => `/pty/${paneId}`,
  /** `GET` → the cast file for replay. */
  cast: (paneId: string) => `/panes/${paneId}/cast`,
  /** `GET` → LayoutPreset[] · `PUT /layouts/:name` → save. */
  layouts: '/layouts',
  /** The web app itself (static build of apps/web). */
  app: '/app',
} as const;
