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
  /** Efficiency instrumentation (see PaneTimings); present on hosts that measure it. */
  timings: z.lazy(() => PaneTimings).optional(),
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

/** Server-side screen model (a headless xterm per pane): what `relay pane read` and readiness detection see. */
export const ScreenSnapshot = z.object({
  pane_id: PaneId,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Visible rows, top to bottom, trailing whitespace trimmed. */
  lines: z.array(z.string()),
  cursor: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
  /** True while the process uses the alternate screen (full-screen TUIs such as Claude Code / Codex). */
  alternate: z.boolean(),
  /** Scrollback lines available above the visible rows. */
  scrollback_lines: z.number().int().nonnegative(),
});
export type ScreenSnapshot = z.infer<typeof ScreenSnapshot>;

export const ReadScreenQuery = z.object({
  /** `visible` = the current viewport; `recent` = viewport plus up to `lines` rows of scrollback. */
  source: z.enum(['visible', 'recent']).default('visible'),
  lines: z.number().int().positive().max(5000).default(200),
});

export const PaneInputBody = z.object({
  /** Literal text to type; `\r` submits. Sent with bracketed paste when the pane has it enabled. */
  text: z.string().optional(),
  /** Logical keys, e.g. `enter`, `esc`, `ctrl+c`, `tab`, `up`; applied after `text`. */
  keys: z.array(z.string()).optional(),
});
export type PaneInputBody = z.infer<typeof PaneInputBody>;

export const WaitOutputBody = z.object({
  match: z.string().optional(),
  regex: z.string().optional(),
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  source: z.enum(['visible', 'recent']).default('recent'),
});
export const WaitOutputResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('matched'), line: z.string(), at: z.string() }),
  z.object({ status: z.literal('timeout') }),
  z.object({ status: z.literal('exited'), code: z.number().int() }),
]);

/**
 * Readiness = can this pane accept a prompt right now? Three tiers, most trustworthy first:
 * declared (the agent's own MCP heartbeat), hook (Claude Code / Codex hooks), screen (prompt heuristics).
 */
export const PaneReadiness = z.object({
  pane_id: PaneId,
  ready: z.boolean(),
  source: z.enum(['declared', 'hook', 'screen', 'unknown']),
  observed_at: z.string(),
  detail: z.string().optional(),
});
export type PaneReadiness = z.infer<typeof PaneReadiness>;

/**
 * Timings every terminal host must record per pane (milliseconds, measured on the host's clock). They are the
 * product's efficiency instrumentation: the same numbers let us compare a RelayGraph-run agent against a bare
 * `claude` / `codex` session. Undefined = not reached yet. Rust `termd` exposes the same object.
 */
export const PaneTimings = z.object({
  /** spawn request → PTY process started. */
  spawn_ms: z.number().nonnegative().optional(),
  /** process start → first output byte. */
  first_output_ms: z.number().nonnegative().optional(),
  /** first output → readiness detector said "ready" (prompt visible & quiet). */
  readiness_ms: z.number().nonnegative().optional(),
  /** readiness → prompt bytes written (paste + Enter). */
  prompt_write_ms: z.number().nonnegative().optional(),
  /** prompt written → accepted (agent visibly busy / composer clear); includes Enter retries. */
  prompt_accept_ms: z.number().nonnegative().optional(),
  /** Number of extra Enter presses the host needed to get the prompt accepted. */
  prompt_retries: z.number().int().nonnegative().optional(),
  /** Rolling p50 / p95 of "PTY byte received → screen model updated" (render latency of the host's screen). */
  render_p50_ms: z.number().nonnegative().optional(),
  render_p95_ms: z.number().nonnegative().optional(),
  /** Bytes and chunks of output seen so far (throughput). */
  output_bytes: z.number().int().nonnegative().optional(),
  output_chunks: z.number().int().nonnegative().optional(),
});
export type PaneTimings = z.infer<typeof PaneTimings>;

/** `GET /metrics`: host-level counters plus every pane's timings; the basis for the "vs bare CLI" comparison. */
export const HostMetrics = z.object({
  host: z.enum(['relay', 'herdr', 'tmux', 'relayterm', 'fake']),
  uptime_ms: z.number().nonnegative(),
  panes_spawned: z.number().int().nonnegative(),
  panes_alive: z.number().int().nonnegative(),
  prompt_failures: z.number().int().nonnegative(),
  panes: z.array(z.object({ pane_id: z.string(), role: z.string(), task_id: z.string().optional(), timings: PaneTimings })),
});
export type HostMetrics = z.infer<typeof HostMetrics>;

export const ptyRoutes = {
  /** `GET` → PaneInfo[] · `POST /panes/:id/kill` · `POST /panes/:id/focus` (records the focused pane for other clients). */
  panes: '/panes',
  pane: (paneId: string) => `/panes/${paneId}`,
  /** WebSocket. */
  pty: (paneId: string) => `/pty/${paneId}`,
  /** `GET` → the cast file for replay. */
  cast: (paneId: string) => `/panes/${paneId}/cast`,
  /** `GET ?source=&lines=` → ScreenSnapshot (server-side headless xterm). */
  screen: (paneId: string) => `/panes/${paneId}/screen`,
  /** `POST` PaneInputBody → { ok: true }. */
  input: (paneId: string) => `/panes/${paneId}/input`,
  /** `POST` WaitOutputBody → WaitOutputResult (long-poll). */
  waitOutput: (paneId: string) => `/panes/${paneId}/wait-output`,
  /** `GET` → PaneReadiness. */
  readiness: (paneId: string) => `/panes/${paneId}/readiness`,
  /** `GET` → HostMetrics (session token required). */
  metrics: '/metrics',
  /** `GET` → LayoutPreset[] · `PUT /layouts/:name` → save. */
  layouts: '/layouts',
  /** The web app itself (static build of apps/web). */
  app: '/app',
} as const;
