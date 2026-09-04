/**
 * `relay` — thin CLI over relayd's HTTP API (PRD §12.7, `@relay/protocol` api.ts).
 *
 *   relay up "<mission title>" [--repo <path>] [--plan plan.yaml | --planner claude-code|codex] [--host herdr|tmux] [--port N]
 *   relay status
 *   relay clarify <task-id> Q1="..." Q2="..."
 *   relay review <task-id> <AC-id> pass|fail ["observed failure"]
 *   relay cancel <task-id> ["reason"]
 *   relay replay <file.jsonl>
 *
 * Base URL: RELAY_URL (default http://127.0.0.1:7420); --port overrides the port.
 * `run()` takes injectable fetch/stdout/env so tests never touch the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PORT, LoadPlanBody, routes } from '@relay/protocol';
import type { CreateMissionBody, ClarifyBody, ReviewBody, CancelBody, State } from '@relay/protocol';

export interface CliIo {
  fetch: typeof globalThis.fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export const USAGE = `usage:
  relay up "<mission title>" [--repo <path>] [--plan plan.yaml | --planner claude-code|codex] [--host herdr|tmux] [--port N]
  relay status [--port N]
  relay clarify <task-id> Q1="..." [Q2="..."] [--port N]
  relay review <task-id> <AC-id> pass|fail ["observed failure"] [--port N]
  relay cancel <task-id> ["reason"] [--port N]
  relay replay <file.jsonl>

Base URL comes from RELAY_URL (default http://127.0.0.1:${DEFAULT_PORT}).`;

class UsageError extends Error {}
class CommandError extends Error {}

export async function run(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const full: CliIo = {
    fetch: io.fetch ?? globalThis.fetch,
    stdout: io.stdout ?? ((line) => process.stdout.write(line + '\n')),
    stderr: io.stderr ?? ((line) => process.stderr.write(line + '\n')),
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
  };
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'up': return await up(rest, full);
      case 'status': return await status(rest, full);
      case 'clarify': return await clarify(rest, full);
      case 'review': return await review(rest, full);
      case 'cancel': return await cancel(rest, full);
      case 'replay': return replay(rest, full);
      case '-h': case '--help': case 'help':
        full.stdout(USAGE);
        return 0;
      default:
        throw new UsageError(command ? `unknown command: ${command}` : 'missing command');
    }
  } catch (err) {
    if (err instanceof UsageError) {
      full.stderr(`relay: ${err.message}\n${USAGE}`);
      return 2;
    }
    full.stderr(`relay: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---------------------------------------------------------------- commands

async function up(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    repo: { type: 'string' },
    plan: { type: 'string' },
    planner: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
  });
  const title = positionals[0];
  if (!title) throw new UsageError('relay up needs a mission title');
  if (values.planner !== undefined && values.planner !== 'claude-code' && values.planner !== 'codex') {
    throw new UsageError(`--planner must be claude-code or codex, got ${values.planner}`);
  }
  if (values.host !== undefined && values.host !== 'herdr' && values.host !== 'tmux') {
    throw new UsageError(`--host must be herdr or tmux, got ${values.host}`);
  }
  const plan = values.plan !== undefined ? loadPlan(path.resolve(io.cwd, values.plan)) : undefined;

  const body: CreateMissionBody & { host?: string } = {
    repo: path.resolve(io.cwd, values.repo ?? '.'),
    title,
    ...(values.host !== undefined ? { host: values.host } : {}),
  };
  const client = new Client(io, values.port);
  const created = await client.post<{ mission_id: string }>(routes.missions, body);
  io.stdout(created.mission_id);

  if (plan) {
    const loaded = await client.post<{ task_ids: string[] }>(routes.plan(created.mission_id), plan);
    io.stdout(`planned ${loaded.task_ids.length} task(s): ${loaded.task_ids.join(' ')}`);
  }
  if (values.planner !== undefined) {
    const spawned = await client.post<{ pane_id: string }>(routes.planner(created.mission_id), { runtime: values.planner });
    io.stdout(`planner (${values.planner}) spawned in pane ${spawned.pane_id}`);
  }
  return 0;
}

async function status(args: string[], io: CliIo): Promise<number> {
  const { values } = parseKnown(args, { port: { type: 'string' } });
  const state = await new Client(io, values.port).get<State>(routes.state);
  for (const task of Object.values(state.tasks ?? {})) {
    io.stdout(`${task.id} ${task.runtime}/${task.task_state}/${task.handoff_state} v${task.contract?.version ?? '?'}`);
  }
  return 0;
}

async function clarify(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const [taskId, ...pairs] = positionals;
  if (!taskId) throw new UsageError('relay clarify needs a task id');
  if (pairs.length === 0) throw new UsageError('relay clarify needs at least one Qn="answer"');
  const answers = pairs.map((pair) => {
    const match = /^(Q\d+)=([\s\S]+)$/.exec(pair);
    if (!match) throw new UsageError(`expected Qn="answer", got: ${pair}`);
    return { question_id: match[1]!, answer: match[2]! };
  });
  const body: ClarifyBody = { answers };
  const result = await new Client(io, values.port).post<{ contract_version: number }>(routes.clarify(taskId), body);
  io.stdout(`contract v${result.contract_version}`);
  return 0;
}

async function review(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const [taskId, criterionId, verdict, observed] = positionals;
  if (!taskId || !criterionId || !verdict) throw new UsageError('relay review needs <task-id> <AC-id> pass|fail');
  if (verdict !== 'pass' && verdict !== 'fail') throw new UsageError(`verdict must be pass or fail, got ${verdict}`);
  const body: ReviewBody = {
    criterion_id: criterionId,
    status: verdict === 'pass' ? 'passed' : 'failed',
    ...(observed !== undefined ? { observed_failure: observed } : {}),
  };
  await new Client(io, values.port).post(routes.review(taskId), body);
  io.stdout(`${taskId} ${criterionId} ${body.status}`);
  return 0;
}

async function cancel(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const [taskId, reason] = positionals;
  if (!taskId) throw new UsageError('relay cancel needs a task id');
  const body: CancelBody = reason !== undefined ? { reason } : {};
  await new Client(io, values.port).post(routes.cancel(taskId), body);
  io.stdout(`${taskId} canceled`);
  return 0;
}

function replay(args: string[], io: CliIo): number {
  const file = args[0];
  if (!file) throw new UsageError('relay replay needs a .jsonl file');
  const resolved = path.resolve(io.cwd, file);
  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new CommandError(`cannot read ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  lines.forEach((line, index) => {
    let event: { ts?: string; actor?: string; type?: string; task_id?: string };
    try {
      event = JSON.parse(line);
    } catch {
      throw new CommandError(`${resolved}:${index + 1}: invalid JSON`);
    }
    io.stdout(`${formatTimestamp(event.ts ?? '')} ${event.actor ?? '?'} ${event.type ?? '?'} ${event.task_id ?? '-'}`);
  });
  return 0;
}

// ---------------------------------------------------------------- helpers

/** `HH:MM:SS` in local time; falls back to the raw string if it is not a date. */
export function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts || '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function baseUrl(env: Record<string, string | undefined>, port?: string): string {
  let url = env.RELAY_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`;
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new UsageError(`--port must be a port number, got ${port}`);
    const parsed = new URL(url);
    parsed.port = String(n);
    url = parsed.href;
  }
  return url.replace(/\/+$/, '');
}

type OptionSpec = Record<string, { type: 'string' | 'boolean'; short?: string }>;

function parseKnown<T extends OptionSpec>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function loadPlan(file: string): LoadPlanBody {
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CommandError(`cannot load plan ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const candidate = Array.isArray(raw) ? { tasks: raw } : raw;
  const parsed = LoadPlanBody.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new CommandError(`invalid plan ${file}:\n${issues}`);
  }
  return parsed.data;
}

class Client {
  private readonly base: string;
  constructor(private readonly io: CliIo, port?: string) {
    this.base = baseUrl(io.env, port);
  }

  async get<T>(route: string): Promise<T> {
    return this.request<T>(route, { method: 'GET' });
  }

  async post<T = unknown>(route: string, body: unknown): Promise<T> {
    return this.request<T>(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(route: string, init: RequestInit): Promise<T> {
    const url = this.base + route;
    let response: Response;
    try {
      response = await this.io.fetch(url, init);
    } catch (err) {
      throw new CommandError(`cannot reach relayd at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new CommandError(`${init.method} ${url} → HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CommandError(`${init.method} ${url}: response is not JSON`);
    }
  }
}
