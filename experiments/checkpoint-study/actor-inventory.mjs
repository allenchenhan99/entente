import fs from 'node:fs';
import path from 'node:path';

/** Independent of rollout discovery: missing agent directories must remain missing cost. */
export function actorInventory(events, missionId) {
  const actors = new Map();
  for (const event of events) {
    if (event.mission_id !== missionId || !['task_proposed', 'agent_spawned'].includes(event.type)) continue;
    if (typeof event.task_id !== 'string' || !event.task_id) throw new Error('actor inventory event missing task_id');
    const actor = actors.get(event.task_id) ?? { task_id: event.task_id, proposed: false, sessions: [] };
    if (event.type === 'task_proposed') actor.proposed = true;
    else {
      const session = event.payload?.session_id;
      if (typeof session !== 'string' || !session) throw new Error(`spawn missing session_id: ${event.task_id}`);
      if (!actor.sessions.includes(session)) actor.sessions.push(session);
    }
    actors.set(event.task_id, actor);
  }
  return [...actors.values()].sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export function readActorInventory(relayDir, missionId) {
  const runs = path.join(relayDir, 'runs');
  if (!fs.existsSync(runs)) return [];
  const events = [];
  for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(runs, entry.name, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { throw new Error(`invalid actor inventory event log: ${file}`); }
    }
  }
  return actorInventory(events, missionId);
}
