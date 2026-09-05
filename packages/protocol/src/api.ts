/**
 * HTTP contract between relayd and thin clients (TUI, CLI). See PRD.md §12.7.
 *
 *   GET  /state                  → State (JSON)
 *   GET  /events?since=<seq>     → text/event-stream; each message `data: <Event JSON>`; id = seq
 *   GET  /events/log?since=<seq> → Event[] (JSON, for replay/bootstrap)
 *   POST /missions               → CreateMissionBody → { mission_id }
 *   POST /missions/:id/plan      → LoadPlanBody      → { task_ids }   (planner fallback: hand-written contracts)
 *   POST /missions/:id/planner   → SpawnPlannerBody  → { pane_id }    (spawn an LLM planner agent for the mission)
 *   POST /sessions               → OpenSessionBody   → OpenSessionResult (adopt an agent the human started)
 *   POST /missions/:id/clarify   → ClarifyBody       → { answered }    (human answers the planner's mission-level questions)
 *   POST /tasks/:id/clarify      → ClarifyBody       → { contract_version }
 *   POST /tasks/:id/review       → ReviewBody        → { ok: true }
 *   POST /tasks/:id/cancel       → CancelBody        → { ok: true }
 *   POST /tasks/:id/reply        → ReplyBody         → { delivered: true, unread } (human answers a blocked agent)
 *   POST /tasks/:id/revise       → ReviseBody        → { contract_version } (human revises a contract that is not yet verified)
 *   GET  /health                 → { ok: true, version }
 */
import { z } from 'zod';
import { TaskContractInput, RuntimeKind } from './contract.js';
import { TaskContractPatch } from './mcp.js';

export const CreateMissionBody = z.object({
  repo: z.string(),
  title: z.string().min(1),
  success_definition: z.string().optional(),
  integration_check: z.string().optional(),
});
export type CreateMissionBody = z.infer<typeof CreateMissionBody>;

export const LoadPlanBody = z.object({ tasks: z.array(TaskContractInput) });
export type LoadPlanBody = z.infer<typeof LoadPlanBody>;

export const SpawnPlannerBody = z.object({ runtime: RuntimeKind });
export type SpawnPlannerBody = z.infer<typeof SpawnPlannerBody>;

/**
 * `POST /sessions`: an agent the human started by hand asks to be adopted.
 *
 * The inverse of `POST /missions/:id/planner`. There, relayd spawns the process; here the process
 * already exists — you opened a terminal and ran `claude` — and relayd only prepares its config and
 * says what to re-exec with. That is the difference the role turns on: a session the human opened is
 * a brain, and one an agent opened through `propose_subtask` is a sub. Nobody has to declare which.
 */
export const OpenSessionBody = z.object({
  runtime: RuntimeKind,
  /** The pane the agent is running in, so the graph can show it and the pane can be labelled. */
  pane_id: z.string().min(1),
  cwd: z.string().min(1),
  /** What to call the mission this session gets. Defaults to the repo it is in. */
  title: z.string().optional(),
});
export type OpenSessionBody = z.infer<typeof OpenSessionBody>;

export const OpenSessionResult = z.object({
  mission_id: z.string(),
  session_id: z.string(),
  /** Flags to add to the agent's own command line (its MCP config, its session id). */
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /**
   * What the agent needs to know to act as a brain, for the runtime's system-prompt channel. It is
   * not delivered as a turn: the human's own first message is the brief, and a bootstrap turn would
   * have the agent planning before they had said anything.
   */
  instructions: z.string(),
});
export type OpenSessionResult = z.infer<typeof OpenSessionResult>;
export const ClarifyBody = z.object({
  answers: z.array(z.object({ question_id: z.string(), answer: z.string().min(1) })).min(1),
});
export type ClarifyBody = z.infer<typeof ClarifyBody>;

export const ReviewBody = z.object({
  criterion_id: z.string(),
  status: z.enum(['passed', 'failed']),
  observed_failure: z.string().optional(),
});
export type ReviewBody = z.infer<typeof ReviewBody>;

export const CancelBody = z.object({ reason: z.string().optional() });

export const ReplyBody = z.object({ message: z.string().min(1) });
export type ReplyBody = z.infer<typeof ReplyBody>;
/** Same patch the planner sends through `relay_revise_task`; only keys present change. Verified / canceled contracts are immutable (409). */
export const ReviseBody = TaskContractPatch;
export type ReviseBody = z.infer<typeof ReviseBody>;
export type CancelBody = z.infer<typeof CancelBody>;

export const DEFAULT_PORT = 7420;
export const routes = {
  state: '/state',
  events: '/events',
  eventsLog: '/events/log',
  missions: '/missions',
  plan: (missionId: string) => `/missions/${missionId}/plan`,
  planner: (missionId: string) => `/missions/${missionId}/planner`,
  /** `POST` OpenSessionBody — adopt an agent the human started themselves; see OpenSessionBody. */
  sessions: '/sessions',
  missionClarify: (missionId: string) => `/missions/${missionId}/clarify`,
  clarify: (taskId: string) => `/tasks/${taskId}/clarify`,
  review: (taskId: string) => `/tasks/${taskId}/review`,
  cancel: (taskId: string) => `/tasks/${taskId}/cancel`,
  /** `POST` CancelBody — stop a whole mission; every task of it still running is canceled too. */
  cancelMission: (missionId: string) => `/missions/${missionId}/cancel`,
  /**
   * `DELETE` — forget work that is over. The log keeps it: a tombstone is appended, so replay and the
   * recordings are intact and nothing on disk is touched. relayd refuses anything still live.
   */
  task: (taskId: string) => `/tasks/${taskId}`,
  mission: (missionId: string) => `/missions/${missionId}`,
  reply: (taskId: string) => `/tasks/${taskId}/reply`,
  revise: (taskId: string) => `/tasks/${taskId}/revise`,
  mcp: '/mcp',
  health: '/health',
  /**
   * Graph object model over HTTP (for clients that do not run the TypeScript reducer, e.g. the Rust relay-tui):
   * `GET /graph` → Graph · `GET /graph/:kind/:id/describe` → ObjectDescription · `.../story?limit=` → { lines }
   * · `.../actions` → ObjectAction[] · `GET /story?since=<seq>&limit=` → narrated events [{ seq, ts, task_id?, line }].
   */
  graph: '/graph',
  graphObject: (kind: 'node' | 'edge' | 'inbox', id: string) => `/graph/${kind}/${encodeURIComponent(id)}`,
  story: '/story',
} as const;
