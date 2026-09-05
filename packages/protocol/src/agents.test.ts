import { describe, it, expect } from 'vitest';
import { agentRegistry, availableAgents, agentRegistryMarkdown } from './agents.js';
import { replay } from './reducer.js';
import { EventLog, contract, MISSION_ID } from './testkit.test.js';

const mission = () => ({ id: MISSION_ID, repo: '/repo', title: 'Add secure login', success_definition: '' });

/** A log with one spawned agent, optionally carried through to completion. */
function spawned(id: string, session: string, opts: { role?: string; paths?: string[]; done?: boolean } = {}) {
  const log = new EventLog();
  log.add('mission_created', mission());
  log.add('task_proposed', {
    contract: contract({
      id,
      recipient: opts.role ?? 'backend',
      ...(opts.paths ? { scope: { allowed_paths: opts.paths } } : {}),
    }),
  }, { task_id: id });
  log.add('agent_spawned', { runtime: 'codex', pane_id: 'relay:1', session_id: session, cwd: '/repo' }, { task_id: id });
  if (opts.done) {
    log.add('task_verified', { attempt: 1 }, { task_id: id });
    log.add('task_completed', {}, { task_id: id });
  }
  return log;
}

describe('agent registry', () => {
  it('records the session that remembers an agent, with what it worked on', () => {
    const state = replay(spawned('t-a', 'sess-1', { paths: ['src/auth/**'], done: true }).events);

    const [entry] = agentRegistry(state);

    expect(entry!.session_id).toBe('sess-1');
    expect(entry!.role).toBe('backend');
    expect(entry!.runtime).toBe('codex');
    expect(entry!.paths).toEqual(['src/auth/**']);
    expect(entry!.tasks).toEqual([
      { id: 't-a', goal: expect.any(String), state: 'completed', verified: true },
    ]);
  });

  it('a task no agent was spawned for is not an agent', () => {
    const log = new EventLog();
    log.add('mission_created', mission());
    log.add('task_proposed', { contract: contract({ id: 't-a' }) }, { task_id: 't-a' });

    expect(agentRegistry(replay(log.events))).toEqual([]);
  });

  it('an agent still working is busy, and not offered as available', () => {
    const state = replay(spawned('t-a', 'sess-1').events);

    expect(agentRegistry(state)[0]!.live).toBe(true);
    expect(availableAgents(state)).toEqual([]);
  });

  it('an agent whose work is done is free to take another task', () => {
    const state = replay(spawned('t-a', 'sess-1', { done: true }).events);

    expect(availableAgents(state).map((a) => a.session_id)).toEqual(['sess-1']);
  });

  it('the session is the identity, not the role: two backends are two agents', () => {
    const first = spawned('t-a', 'sess-1', { done: true });
    first.add('task_proposed', { contract: contract({ id: 't-b', recipient: 'backend' }) }, { task_id: 't-b' });
    first.add('agent_spawned', { runtime: 'codex', pane_id: 'relay:2', session_id: 'sess-2', cwd: '/repo' }, { task_id: 't-b' });

    const entries = agentRegistry(replay(first.events));

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.session_id))).toEqual(new Set(['sess-1', 'sess-2']));
  });

  it('one agent across two tasks is one entry holding both', () => {
    const log = spawned('t-a', 'sess-1', { done: true });
    log.add('task_proposed', { contract: contract({ id: 't-b', scope: { allowed_paths: ['docs/**'] } }) }, { task_id: 't-b' });
    log.add('agent_spawned', { runtime: 'codex', pane_id: 'relay:1', session_id: 'sess-1', cwd: '/repo' }, { task_id: 't-b' });

    const entries = agentRegistry(replay(log.events));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.tasks.map((t) => t.id).sort()).toEqual(['t-a', 't-b']);
    expect(entries[0]!.paths).toContain('docs/**');
  });

  it('renders a file that says where its facts come from', () => {
    const state = replay(spawned('t-a', 'sess-1', { paths: ['src/auth/**'], done: true }).events);

    const md = agentRegistryMarkdown(state, '2026-09-05T12:00:00Z');

    expect(md).toContain('# Agents');
    expect(md).toContain('sess-1');
    expect(md).toContain('src/auth/**');
    expect(md).toContain('reuse_session');
    // The point of the file is that it is not a set of self-reported recommendations.
    expect(md).toContain('Nothing here is self-reported');
  });

  it('an empty registry says so rather than rendering an empty table', () => {
    const log = new EventLog();
    log.add('mission_created', mission());

    expect(agentRegistryMarkdown(replay(log.events), 'now')).toContain('No agent has been spawned yet');
  });
});
