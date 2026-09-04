/**
 * HTTP + SSE API (PRD §12.7, `@relay/protocol` api.ts). Thin: validates bodies with the frozen zod
 * schemas and delegates to the orchestrator. The MCP endpoint is mounted on the same app.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import { CreateMissionBody, LoadPlanBody, SpawnPlannerBody, ClarifyBody, ReviewBody, CancelBody, ReplyBody, routes } from '@relay/protocol';
import type { EventStore } from '../ports.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { RelayError } from '../orchestrator/errors.js';
import { RELAYD_VERSION } from '../config.js';
import { mountMcp } from '../mcp/server.js';
import { mountRuns } from './runs.js';

export interface AppOptions {
  orchestrator: Orchestrator;
  store: EventStore;
  /** SSE keep-alive comment interval. */
  pingIntervalMs?: number;
  /** Skip mounting the MCP endpoint (tests of the plain HTTP surface). */
  withMcp?: boolean;
}

export const formatIssues = (issues: z.core.$ZodIssue[]): string[] =>
  issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(body)'}: ${i.message}`);

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ errors: ['(body): invalid JSON'] }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: c.json({ errors: formatIssues(parsed.error.issues) }, 400) };
  return { ok: true, data: parsed.data };
}

const parseSince = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

export function createApp(opts: AppOptions): Hono {
  const { orchestrator, store } = opts;
  const pingMs = opts.pingIntervalMs ?? 15_000;
  const app = new Hono();
  mountRuns(app, { store });

  app.onError((err, c) => {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get(routes.health, (c) => c.json({ ok: true, version: RELAYD_VERSION }));
  app.get(routes.state, (c) => c.json(store.state()));

  app.get(routes.eventsLog, (c) => {
    const since = parseSince(c.req.query('since'));
    if (since === undefined) return c.json({ errors: ['since: must be a non-negative integer'] }, 400);
    return c.json(store.all(since));
  });

  app.get(routes.events, (c) => {
    const since = parseSince(c.req.query('since'));
    if (since === undefined) return c.json({ errors: ['since: must be a non-negative integer'] }, 400);
    return streamSSE(c, async (stream) => {
      let open = true;
      let cursor = since;
      const queue: Promise<void>[] = [];
      const send = (event: { seq: number }) => {
        if (!open || event.seq <= cursor) return;
        cursor = event.seq;
        const p = stream.writeSSE({ event: 'relay', id: String(event.seq), data: JSON.stringify(event) }).catch(() => close());
        queue.push(p);
      };
      const unsubscribe = store.subscribe((event) => send(event));
      const ping = setInterval(() => {
        if (open) void stream.write(': ping\n\n').catch(() => close());
      }, pingMs);
      const closed = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          close();
          resolve();
        });
      });
      function close() {
        if (!open) return;
        open = false;
        clearInterval(ping);
        unsubscribe();
      }
      for (const event of store.all(since)) send(event);
      await closed;
      await Promise.allSettled(queue);
    });
  });

  app.post(routes.missions, async (c) => {
    const body = await parseBody(c, CreateMissionBody);
    if (!body.ok) return body.res;
    return c.json(orchestrator.createMission(body.data));
  });

  app.post('/missions/:id/plan', async (c) => {
    const missionId = c.req.param('id');
    if (!orchestrator.getMission(missionId)) throw new RelayError(404, `mission ${missionId} not found`);
    const body = await parseBody(c, LoadPlanBody);
    if (!body.ok) return body.res;
    const task_ids: string[] = [];
    for (const task of body.data.tasks) {
      const out = await orchestrator.proposeTask(missionId, task, 'human');
      task_ids.push(out.task_id);
    }
    store.append({ mission_id: missionId, actor: 'human', type: 'tasks_planned', payload: { task_ids } });
    return c.json({ task_ids });
  });

  app.post('/missions/:id/planner', async (c) => {
    const missionId = c.req.param('id');
    const body = await parseBody(c, SpawnPlannerBody);
    if (!body.ok) return body.res;
    return c.json(await orchestrator.spawnPlanner(missionId, body.data.runtime));
  });

  app.post('/missions/:id/clarify', async (c) => {
    const missionId = c.req.param('id');
    const body = await parseBody(c, ClarifyBody);
    if (!body.ok) return body.res;
    return c.json(orchestrator.clarifyMission(missionId, body.data.answers, 'human'));
  });

  app.post('/tasks/:id/reply', async (c) => {
    const taskId = c.req.param('id');
    const body = await parseBody(c, ReplyBody);
    if (!body.ok) return body.res;
    return c.json(orchestrator.reply(taskId, body.data.message, 'human'));
  });

  app.post('/tasks/:id/clarify', async (c) => {
    const taskId = c.req.param('id');
    const body = await parseBody(c, ClarifyBody);
    if (!body.ok) return body.res;
    return c.json(await orchestrator.clarify(taskId, body.data.answers, 'human'));
  });

  app.post('/tasks/:id/review', async (c) => {
    const taskId = c.req.param('id');
    const body = await parseBody(c, ReviewBody);
    if (!body.ok) return body.res;
    await orchestrator.review(taskId, body.data);
    return c.json({ ok: true });
  });

  app.post('/tasks/:id/cancel', async (c) => {
    const taskId = c.req.param('id');
    const body = await parseBody(c, CancelBody);
    if (!body.ok) return body.res;
    await orchestrator.cancel(taskId, body.data.reason);
    return c.json({ ok: true });
  });

  if (opts.withMcp !== false) mountMcp(app, orchestrator);
  return app;
}
