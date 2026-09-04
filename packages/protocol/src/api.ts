/**
 * HTTP contract between relayd and thin clients (TUI, CLI). See PRD.md §12.7.
 *
 *   GET  /state                  → State (JSON)
 *   GET  /events?since=<seq>     → text/event-stream; each message `data: <Event JSON>`; id = seq
 *   GET  /events/log?since=<seq> → Event[] (JSON, for replay/bootstrap)
 *   POST /missions               → CreateMissionBody → { mission_id }
 *   POST /missions/:id/plan      → LoadPlanBody      → { task_ids }   (planner fallback: hand-written contracts)
 *   POST /missions/:id/planner   → SpawnPlannerBody  → { pane_id }    (spawn an LLM planner agent for the mission)
 *   POST /missions/:id/clarify   → ClarifyBody       → { answered }    (human answers the planner's mission-level questions)
 *   POST /tasks/:id/clarify      → ClarifyBody       → { contract_version }
 *   POST /tasks/:id/review       → ReviewBody        → { ok: true }
 *   POST /tasks/:id/cancel       → CancelBody        → { ok: true }
 *   POST /tasks/:id/reply        → ReplyBody         → { delivered: true, unread } (human answers a blocked agent)
 *   GET  /health                 → { ok: true, version }
 */
import { z } from 'zod';
import { TaskContractInput, RuntimeKind } from './contract.js';

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
export type CancelBody = z.infer<typeof CancelBody>;

export const DEFAULT_PORT = 7420;
export const routes = {
  state: '/state',
  events: '/events',
  eventsLog: '/events/log',
  missions: '/missions',
  plan: (missionId: string) => `/missions/${missionId}/plan`,
  planner: (missionId: string) => `/missions/${missionId}/planner`,
  missionClarify: (missionId: string) => `/missions/${missionId}/clarify`,
  clarify: (taskId: string) => `/tasks/${taskId}/clarify`,
  review: (taskId: string) => `/tasks/${taskId}/review`,
  cancel: (taskId: string) => `/tasks/${taskId}/cancel`,
  reply: (taskId: string) => `/tasks/${taskId}/reply`,
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
