/**
 * `relay` — thin CLI over relayd's HTTP API (PRD §12.7, `@relay/protocol` api.ts).
 *
 *   relay up "<mission title>" [--repo <path>] [--plan plan.yaml | --planner claude-code|codex] [--host herdr|tmux] [--port N]
 *   relay status
 *   relay clarify <task-id> Q1="..." Q2="..."
 *   relay review <task-id> <AC-id> pass|fail ["observed failure"]
 *   relay cancel <task-id> ["reason"]
 *   relay replay <file.jsonl>
 *   relay inbox [--replay file.jsonl]
 *   relay explain <object> [--replay file.jsonl]
 *   relay story [--replay file.jsonl] [--task <task-id>]
 *
 * Base URL: RELAY_URL (default http://127.0.0.1:7420); --port overrides the port.
 * `run()` takes injectable fetch/stdout/env so tests never touch the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PORT,
  Event as EventSchema,
  LoadPlanBody,
  OkOutput,
  PaneId,
  PaneInputBody,
  PaneInfo,
  PaneReadiness,
  ScreenSnapshot,
  WaitOutputBody,
  WaitOutputResult,
  actionsFor,
  buildGraph,
  describe,
  narrate,
  replay as replayEvents,
  routes,
  storyFor,
  ptyRoutes,
} from '@relay/protocol';
import type {
  CancelBody,
  ClarifyBody,
  CreateMissionBody,
  Event,
  Graph,
  GraphApi,
  GraphObjectRef,
  InboxItem,
  PaneInfo as PaneInfoType,
  ReviewBody,
  State,
} from '@relay/protocol';

const defaultGraphApi: GraphApi = { buildGraph, actionsFor, narrate, storyFor, describe };

export interface CliIo {
  fetch: typeof globalThis.fetch;
  stdout: (line: string) => void;
  /** Writes exact stdout bytes without appending a line ending. */
  write: (text: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  graph: GraphApi;
}

export const USAGE = `usage:
  relay up "<mission title>" [--repo <path>] [--plan plan.yaml | --planner claude-code|codex] [--host herdr|tmux] [--port N]
  relay status [--port N]
  relay clarify <task-id|mission-id> Q1="..." [Q2="..."] [--port N]
  relay review <task-id> <AC-id> pass|fail ["observed failure"] [--port N]
  relay cancel <task-id> ["reason"] [--port N]
  relay reply <task-id> "message" [--port N]       answer a blocked agent
  relay replay <file.jsonl>
  relay inbox [--replay file.jsonl] [--port N]
  relay explain <object> [--replay file.jsonl] [--port N]
  relay story [--replay file.jsonl] [--task <task-id>] [--port N]
  relay pane list [--port N]
  relay pane get <id> [--port N]
  relay pane read <id> [--source visible|recent] [--lines N] [--port N]
  relay pane input <id> [--text "…"] [--keys enter,esc,ctrl+c] [--port N]
  relay pane run <id> "<command>" [--port N]
  relay pane wait-output <id> (--match "…" | --regex "…") [--timeout-ms N] [--source visible|recent] [--port N]
  relay pane readiness <id> [--port N]
  relay pane kill <id> [--port N]
  relay pane focus <id> [--port N]
  relay pane cast <id> [--out file] [--port N]

Base URL comes from RELAY_URL (default http://127.0.0.1:${DEFAULT_PORT}).`;

class UsageError extends Error {}
class CommandError extends Error {}

export async function run(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const full: CliIo = {
    fetch: io.fetch ?? globalThis.fetch,
    stdout: io.stdout ?? ((line) => process.stdout.write(line + '\n')),
    write: io.write ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((line) => process.stderr.write(line + '\n')),
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    graph: io.graph ?? defaultGraphApi,
  };
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'up': return await up(rest, full);
      case 'status': return await status(rest, full);
      case 'clarify': return await clarify(rest, full);
      case 'review': return await review(rest, full);
      case 'cancel': return await cancel(rest, full);
      case 'reply': return await reply(rest, full);
      case 'replay': return replay(rest, full);
      case 'inbox': return await inbox(rest, full);
      case 'explain': return await explain(rest, full);
      case 'story': return await story(rest, full);
      case 'pane': return await pane(rest, full);
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

async function pane(args: string[], io: CliIo): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'list': return paneList(rest, io);
    case 'get': return paneGet(rest, io);
    case 'read': return paneRead(rest, io);
    case 'input': return paneInput(rest, io);
    case 'run': return paneRun(rest, io);
    case 'wait-output': return paneWaitOutput(rest, io);
    case 'readiness': return paneReadinessCommand(rest, io);
    case 'kill': return panePostAction(rest, 'kill', io);
    case 'focus': return panePostAction(rest, 'focus', io);
    case 'cast': return paneCast(rest, io);
    default: throw new UsageError(verb ? `unknown pane command: ${verb}` : 'relay pane needs a command');
  }
}

async function paneList(args: string[], io: CliIo): Promise<number> {
  const { values } = parseKnown(args, { port: { type: 'string' } });
  const raw = await new Client(io, values.port).get<unknown>(ptyRoutes.panes);
  const list = parsePaneList(raw);
  const panes = list.items.map((item, index) => ({
    ...validateResponse(PaneInfo, item, `PaneInfo[] at index ${index}`),
    focused: list.focusedPane === undefined ? isFocusedPane(item, index) : false,
  }));
  if (list.focusedPane !== undefined) {
    for (const pane of panes) pane.focused = pane.pane_id === list.focusedPane;
  }
  const headings = ['pane_id', 'role', 'task_id', 'alive', 'cols×rows', 'cwd'];
  const rows = panes.map((item) => [
    item.pane_id,
    item.role,
    item.task_id ?? '-',
    String(item.alive),
    `${item.cols}×${item.rows}`,
    item.cwd,
  ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]!.length)));
  const renderRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  io.stdout(`  ${renderRow(headings)}`);
  panes.forEach((item, index) => io.stdout(`${item.focused ? '* ' : '  '}${renderRow(rows[index]!)}`));
  return 0;
}

async function paneGet(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane get needs a pane id');
  const raw = await new Client(io, values.port).get<unknown>(ptyRoutes.pane(paneId));
  const info = validateResponse(PaneInfo, raw, 'PaneInfo');
  const fields: ReadonlyArray<keyof PaneInfoType> = [
    'pane_id', 'task_id', 'role', 'runtime', 'cwd', 'pid', 'alive', 'cols', 'rows',
    'cast_path', 'started_at', 'exited_at', 'exit_code',
  ];
  for (const field of fields) io.stdout(`${field}: ${info[field] ?? '-'}`);
  return 0;
}

async function paneRead(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    source: { type: 'string' },
    lines: { type: 'string' },
    port: { type: 'string' },
  });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane read needs a pane id');
  if (values.source !== undefined && values.source !== 'visible' && values.source !== 'recent') {
    throw new UsageError(`--source must be visible or recent, got ${values.source}`);
  }
  const query = new URLSearchParams();
  if (values.source !== undefined) query.set('source', values.source);
  if (values.lines !== undefined) query.set('lines', String(positiveInteger(values.lines, '--lines', 5_000)));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const raw = await new Client(io, values.port).get<unknown>(`${ptyRoutes.screen(paneId)}${suffix}`);
  const snapshot = validateResponse(ScreenSnapshot, raw, 'ScreenSnapshot');
  for (const line of snapshot.lines) io.stdout(line);
  return 0;
}

async function paneInput(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    text: { type: 'string' },
    keys: { type: 'string' },
    port: { type: 'string' },
  });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane input needs a pane id');
  const keys = values.keys === undefined ? undefined : parseKeys(values.keys);
  if (values.text === undefined && keys === undefined) {
    throw new UsageError('relay pane input needs at least one of --text or --keys');
  }
  const body = validateUsage(PaneInputBody, {
    ...(values.text !== undefined ? { text: values.text } : {}),
    ...(keys !== undefined ? { keys } : {}),
  }, 'PaneInputBody');
  return sendPaneInput(paneId, body, values.port, io);
}

async function paneRun(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const [paneId, command] = positionals;
  if (!paneId || command === undefined) throw new UsageError('relay pane run needs a pane id and command');
  return sendPaneInput(paneId, { text: command, keys: ['enter'] }, values.port, io);
}

async function sendPaneInput(paneId: string, body: PaneInputBody, port: string | undefined, io: CliIo): Promise<number> {
  const raw = await new Client(io, port).post<unknown>(ptyRoutes.input(paneId), body);
  validateResponse(OkOutput, raw, '{ ok: true }');
  io.stdout('ok');
  return 0;
}

async function paneWaitOutput(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    match: { type: 'string' },
    regex: { type: 'string' },
    'timeout-ms': { type: 'string' },
    source: { type: 'string' },
    port: { type: 'string' },
  });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane wait-output needs a pane id');
  if ((values.match === undefined) === (values.regex === undefined)) {
    throw new UsageError('relay pane wait-output needs exactly one of --match or --regex');
  }
  if (values.source !== undefined && values.source !== 'visible' && values.source !== 'recent') {
    throw new UsageError(`--source must be visible or recent, got ${values.source}`);
  }
  const timeout = values['timeout-ms'] === undefined
    ? undefined
    : positiveInteger(values['timeout-ms'], '--timeout-ms', 600_000);
  const body = validateUsage(WaitOutputBody, {
    ...(values.match !== undefined ? { match: values.match } : {}),
    ...(values.regex !== undefined ? { regex: values.regex } : {}),
    ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    ...(values.source !== undefined ? { source: values.source } : {}),
  }, 'WaitOutputBody');
  const raw = await new Client(io, values.port).post<unknown>(ptyRoutes.waitOutput(paneId), body);
  const result = validateResponse(WaitOutputResult, raw, 'WaitOutputResult');
  switch (result.status) {
    case 'matched':
      io.stdout(`matched: ${result.line}`);
      return 0;
    case 'timeout':
      io.stdout('timeout');
      return 3;
    case 'exited':
      io.stdout(`exited ${result.code}`);
      return 4;
  }
}

async function paneReadinessCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane readiness needs a pane id');
  const raw = await new Client(io, values.port).get<unknown>(ptyRoutes.readiness(paneId));
  const readiness = validateResponse(PaneReadiness, raw, 'PaneReadiness');
  io.stdout(`ready ${readiness.ready} (${readiness.source}, ${readiness.detail ?? '-'})`);
  return readiness.ready ? 0 : 3;
}

async function panePostAction(args: string[], action: 'kill' | 'focus', io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError(`relay pane ${action} needs a pane id`);
  const raw = await new Client(io, values.port).post<unknown>(`${ptyRoutes.pane(paneId)}/${action}`, {});
  validateResponse(OkOutput, raw, '{ ok: true }');
  io.stdout('ok');
  return 0;
}

async function paneCast(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    out: { type: 'string' },
    port: { type: 'string' },
  });
  const paneId = positionals[0];
  if (!paneId) throw new UsageError('relay pane cast needs a pane id');
  const cast = await new Client(io, values.port).getText(ptyRoutes.cast(paneId));
  if (values.out === undefined) {
    io.write(cast);
    return 0;
  }
  const output = path.resolve(io.cwd, values.out);
  try {
    fs.writeFileSync(output, cast);
  } catch (err) {
    throw new CommandError(`cannot write ${output}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 0;
}

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
  for (const m of Object.values(state.missions)) {
    for (const q of m.open_questions ?? []) io.stdout(`${m.mission.id} ? ${q.id}: ${q.text}`);
  }
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
  if (taskId.startsWith('m-')) {
    const result = await new Client(io, values.port).post<{ answered: number; open_questions: number }>(routes.missionClarify(taskId), body);
    io.stdout(`mission ${taskId}: ${result.answered} answered, ${result.open_questions} open`);
    return 0;
  }
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

async function reply(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, { port: { type: 'string' } });
  const [taskId, message] = positionals;
  if (!taskId || !message) throw new UsageError('relay reply needs a task id and a message');
  const result = await new Client(io, values.port).post<{ delivered: true; unread: number }>(routes.reply(taskId), { message });
  io.stdout(`replied to ${taskId} (${result.unread} unread by the agent)`);
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

async function inbox(args: string[], io: CliIo): Promise<number> {
  const { values } = parseKnown(args, {
    replay: { type: 'string' },
    port: { type: 'string' },
  });
  const { state } = await loadGraphSource(values.replay, values.port, io);
  const items = io.graph.buildGraph(state).inbox;
  if (items.length === 0) {
    io.stdout('inbox empty — nothing needs you');
    return 0;
  }
  items.forEach((item, index) => {
    if (index > 0) io.stdout('');
    io.stdout(`[${item.kind}] ${item.title}`);
    for (const line of item.detail) io.stdout(`  ${line}`);
    io.stdout(`→ ${commandForInboxItem(item)}`);
  });
  return 0;
}

async function explain(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseKnown(args, {
    replay: { type: 'string' },
    port: { type: 'string' },
  });
  const object = positionals[0];
  if (!object) throw new UsageError('relay explain needs an object ref');
  const { state, events } = await loadGraphSource(values.replay, values.port, io);
  const graph = io.graph.buildGraph(state);
  const valid = validGraphRefs(graph);
  if (valid.length === 0 && hasGraphRefSyntax(object)) {
    io.stdout('explain empty — nothing to show');
    return 0;
  }
  const ref = resolveGraphRef(object, graph);
  if (!ref) {
    throw new UsageError(`unknown object: ${object}\nvalid refs: ${valid.length > 0 ? valid.join(', ') : '(none)'}`);
  }
  const description = io.graph.describe(ref, graph, state);
  io.stdout(description.title);
  for (const line of description.lines) io.stdout(line);
  io.stdout('');
  const story = io.graph.storyFor(ref, graph, state, events);
  if (story.length === 0) io.stdout('nothing to show');
  else for (const line of story) io.stdout(line);
  return 0;
}

async function story(args: string[], io: CliIo): Promise<number> {
  const { values } = parseKnown(args, {
    replay: { type: 'string' },
    task: { type: 'string' },
    port: { type: 'string' },
  });
  const { state, events } = await loadGraphSource(values.replay, values.port, io);
  const selected = values.task === undefined ? events : events.filter((event) => event.task_id === values.task);
  if (selected.length === 0) {
    io.stdout('story empty — nothing to show');
    return 0;
  }
  for (const event of selected) {
    io.stdout(`${formatTimestamp(event.ts).slice(0, 5)}  ${io.graph.narrate(event, state)}`);
  }
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

async function loadGraphSource(replayFile: string | undefined, port: string | undefined, io: CliIo): Promise<{ state: State; events: Event[] }> {
  if (replayFile !== undefined) {
    const events = loadReplayEvents(path.resolve(io.cwd, replayFile));
    return { state: replayEvents(events), events };
  }
  const client = new Client(io, port);
  const state = await client.get<State>(routes.state);
  const events = await client.get<Event[]>(`${routes.eventsLog}?since=0`);
  return { state, events };
}

function loadReplayEvents(file: string): Event[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CommandError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return text.split('\n').flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CommandError(`${file}:${index + 1}: invalid JSON`);
    }
    const parsed = EventSchema.safeParse(value);
    if (!parsed.success) throw new CommandError(`${file}:${index + 1}: invalid event: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    return [parsed.data];
  });
}

function commandForInboxItem(item: InboxItem): string {
  const action = item.actions.find(({ kind }) => (
    kind === 'clarify' || kind === 'mission_clarify' || kind === 'review' || kind === 'reply'
  )) ?? item.actions[0];
  if (!action) return `relay explain ${item.id}`;
  const taskId = action.target.task_id ?? item.task_id;
  switch (action.kind) {
    case 'clarify': {
      const questions = (action.target.question_ids ?? []).map((id) => `${id}="…"`).join(' ');
      return `relay clarify ${taskId ?? item.ref.id}${questions ? ` ${questions}` : ''}`;
    }
    case 'mission_clarify': {
      const questions = (action.target.question_ids ?? []).map((id) => `${id}="…"`).join(' ');
      return `relay clarify ${action.target.mission_id ?? item.mission_id}${questions ? ` ${questions}` : ''}`;
    }
    case 'review':
      return `relay review ${taskId ?? item.ref.id} ${action.target.criterion_id ?? 'AC-?'} pass|fail`;
    case 'reply':
      return `relay reply ${taskId ?? item.ref.id} "…"`;
    case 'cancel':
      return `relay cancel ${taskId ?? item.ref.id}`;
    case 'focus':
    case 'inspect':
      return `relay explain ${item.ref.id}`;
  }
}

function resolveGraphRef(id: string, graph: Graph): GraphObjectRef | undefined {
  if (graph.nodes.some((node) => node.id === id)) return { kind: 'node', id };
  if (graph.edges.some((edge) => edge.id === id)) return { kind: 'edge', id };
  if (graph.inbox.some((item) => item.id === id)) return { kind: 'inbox', id };
  return undefined;
}

function validGraphRefs(graph: Graph): string[] {
  return [...new Set([
    ...graph.nodes.map((node) => node.id),
    ...graph.edges.map((edge) => edge.id),
    ...graph.inbox.map((item) => item.id),
  ])].sort();
}

function hasGraphRefSyntax(ref: string): boolean {
  return ref === 'planner'
    || ref === 'human'
    || ref === 'verifier'
    || /^t-/.test(ref)
    || /^(contract|evidence):t-/.test(ref);
}

type ResponseSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { toString(): string } };
};

function validateResponse<T>(schema: ResponseSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CommandError(`response does not match ${label}: ${parsed.error.toString()}`);
  return parsed.data;
}

function validateUsage<T>(schema: ResponseSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(`invalid ${label}: ${parsed.error.toString()}`);
  return parsed.data;
}

function positiveInteger(value: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new UsageError(`${flag} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

function parseKeys(value: string): string[] {
  const keys = value.split(',').map((key) => key.trim());
  if (keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw new UsageError('--keys must be a comma-separated list of logical keys');
  }
  return keys;
}

function isFocusedPane(value: unknown, index: number): boolean {
  if (typeof value !== 'object' || value === null || !('focused' in value)) return false;
  const focused = (value as { focused?: unknown }).focused;
  if (typeof focused !== 'boolean') {
    throw new CommandError(`response does not match PaneInfo[] at index ${index}: focused must be a boolean`);
  }
  return focused;
}

function parsePaneList(value: unknown): { items: unknown[]; focusedPane?: string } {
  if (Array.isArray(value)) return { items: value };
  if (typeof value !== 'object' || value === null || !('panes' in value) || !Array.isArray(value.panes)) {
    throw new CommandError('GET /panes response does not match PaneInfo[] or { panes: PaneInfo[]; focused_pane?: PaneId }');
  }
  if (!('focused_pane' in value) || value.focused_pane === undefined) return { items: value.panes };
  return {
    items: value.panes,
    focusedPane: validateResponse(PaneId, value.focused_pane, 'focused_pane PaneId'),
  };
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

  async getText(route: string): Promise<string> {
    return this.requestText(route, { method: 'GET' });
  }

  private async request<T>(route: string, init: RequestInit): Promise<T> {
    const { text, url } = await this.requestTextWithUrl(route, init);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CommandError(`${init.method} ${url}: response is not JSON`);
    }
  }

  private async requestText(route: string, init: RequestInit): Promise<string> {
    return (await this.requestTextWithUrl(route, init)).text;
  }

  private async requestTextWithUrl(route: string, init: RequestInit): Promise<{ text: string; url: string }> {
    const url = this.base + route;
    let response: Response;
    try {
      response = await this.io.fetch(url, init);
    } catch (err) {
      throw new CommandError(`cannot reach relayd at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new CommandError(`${init.method} ${url} → HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
    return { text, url };
  }
}
