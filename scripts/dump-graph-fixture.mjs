/**
 * Dump what relayd serves for a recorded run, for the Rust relay-tui fixtures.
 *
 *     node scripts/dump-graph-fixture.mjs fixtures/events-live-1.jsonl live-1
 *
 * Starts a throw-away relayd (`RELAY_HOST=fake`, ephemeral port, temp RELAY_DIR) on a copy of the fixture log,
 * then writes the JSON the TUI reads to `crates/relay-tui/tests/fixtures/<name>/`:
 *
 *   graph.json     GET /graph                          state.json   GET /state
 *   story.json     GET /story?limit=2000               panes.json   GET /panes  ({ panes: [] } when the host has no pane routes)
 *   describe.json  { "<kind>:<id>": GET /graph/:kind/:id/describe }   for every node, edge and inbox item
 *   stories.json   { "<kind>:<id>": GET /graph/:kind/:id/story.lines }
 *   actions.json   { "<kind>:<id>": GET /graph/:kind/:id/actions }
 *   metrics.json   GET /metrics (only when the host serves it)
 *
 * Nothing is hand-written: every byte comes from relayd's own responses. Requires a built protocol package
 * (`npx tsc -b packages/protocol`) and Node >= 22; `tsx` is resolved from the root node_modules.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [fixtureArg, nameArg] = process.argv.slice(2);
if (!fixtureArg || !nameArg) {
  console.error('usage: node scripts/dump-graph-fixture.mjs <events.jsonl> <name>');
  process.exit(2);
}
const fixture = path.resolve(root, fixtureArg);
const name = nameArg;
const outDir = path.join(root, 'crates/relay-tui/tests/fixtures', name);

const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const runDir = path.join(relayDir, 'runs', name);
fs.mkdirSync(runDir, { recursive: true });
fs.copyFileSync(fixture, path.join(runDir, 'events.jsonl'));

const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'apps/relayd/src/index.ts')], {
  cwd: root,
  env: { ...process.env, RELAY_HOST: 'fake', RELAY_PORT: '0', RELAY_DIR: relayDir, RELAY_RUN_ID: name, RELAY_REPO: root, RELAY_AUTH: 'optional' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let token;
let url;
const ready = new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('relayd did not report a resumed run within 60 s')), 60_000);
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const tokenMatch = /^relayd token: (\S+)/.exec(line);
      if (tokenMatch) token = tokenMatch[1];
      const urlMatch = /^relayd listening on (\S+)/.exec(line);
      if (urlMatch) url = urlMatch[1];
      // The run log is replayed after the listener is up; only then is /graph the fixture's graph.
      if (/^relayd resumed run /.test(line) && token && url) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code) => reject(new Error(`relayd exited early with code ${code}`)));
});

async function get(route) {
  const response = await fetch(`${url}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return { status: response.status, body: undefined };
  return { status: response.status, body: await response.json() };
}

async function must(route) {
  const { status, body } = await get(route);
  if (body === undefined) throw new Error(`GET ${route} → ${status}`);
  return body;
}

const write = (file, value) => fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(value, null, 2)}\n`);

try {
  await ready;
  fs.mkdirSync(outDir, { recursive: true });
  const graph = await must('/graph');
  write('graph.json', graph);
  write('state.json', await must('/state'));
  write('story.json', await must('/story?limit=2000'));
  const panes = await get('/panes');
  if (panes.body === undefined) console.error(`note: GET /panes → ${panes.status} (fake host has no pane routes); writing { panes: [] }`);
  write('panes.json', panes.body ?? { panes: [] });
  const metrics = await get('/metrics');
  if (metrics.body !== undefined) write('metrics.json', metrics.body);

  const refs = [
    ...graph.nodes.map((n) => ({ kind: 'node', id: n.id })),
    ...graph.edges.map((e) => ({ kind: 'edge', id: e.id })),
    ...graph.inbox.map((i) => ({ kind: 'inbox', id: i.id })),
  ];
  const describe = {};
  const stories = {};
  const actions = {};
  for (const ref of refs) {
    const base = `/graph/${ref.kind}/${encodeURIComponent(ref.id)}`;
    const key = `${ref.kind}:${ref.id}`;
    describe[key] = await must(`${base}/describe`);
    stories[key] = (await must(`${base}/story?limit=50`)).lines;
    actions[key] = await must(`${base}/actions`);
  }
  write('describe.json', describe);
  write('stories.json', stories);
  write('actions.json', actions);
  console.log(`${path.relative(root, outDir)}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.inbox.length} inbox items, seq ${graph.seq}`);
} finally {
  child.kill('SIGTERM');
  fs.rmSync(relayDir, { recursive: true, force: true });
}
