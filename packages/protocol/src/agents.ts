/**
 * The agent registry: who has worked on this repo, what they worked on, and the session that still
 * remembers it.
 *
 * A brain delegates by writing a contract for a recipient. Spawning a fresh agent for every subtask
 * throws away everything the last one learned about the code it touched, so an agent that has already
 * done work in an area is worth calling again — its runtime session is resumable, which is the same
 * mechanism a daemon restart uses.
 *
 * Every field here is **derived from the event log**, never self-reported. An agent saying it is good
 * at authentication is a claim; the tasks it completed and the paths its contracts allowed are facts,
 * and this project's whole stance is that the two are not the same. So the registry answers "who has
 * done what, and can be resumed" — it does not rank anyone, and reusing an agent changes nothing about
 * verification: the new task still has its own contract, its own criteria and its own checks.
 */
import type { State, TaskView } from './state.js';
import type { RuntimeKind } from './contract.js';

export interface AgentTask {
  id: string;
  goal: string;
  /** `completed`, `failed`, `canceled`, or whatever it is still doing. */
  state: string;
  /** Whether relayd's own checks passed on it, rather than whether the agent said they did. */
  verified: boolean;
}

export interface AgentEntry {
  /** The recipient name its contracts were addressed to: `backend`, `token-dev`. */
  role: string;
  runtime: RuntimeKind;
  /** The runtime session that still holds what this agent learned; what `resume` reopens. */
  session_id: string;
  /** Whether a process is still running for it, in which case it is busy rather than available. */
  live: boolean;
  /** What it worked on, newest first. */
  tasks: AgentTask[];
  /** Paths its contracts allowed it to change, deduplicated — where it has actually been. */
  paths: string[];
  /** When it was last heard from. */
  last_seen: string | undefined;
}

const LIVE_TASK_STATES = new Set(['proposed', 'accepted', 'executing', 'awaiting_verification', 'repairing']);

function taskOf(task: TaskView): AgentTask {
  return {
    id: task.id,
    goal: task.contract.goal,
    state: task.task_state,
    verified: task.handoff_state === 'verified',
  };
}

/**
 * One entry per agent session. A role can appear more than once — two missions may each have spawned
 * a `backend`, and they remember different things — so the session is the identity, not the name.
 */
export function agentRegistry(state: State): AgentEntry[] {
  const bySession = new Map<string, AgentEntry>();
  const tasks = Object.values(state.tasks)
    .filter((task) => task.agent !== undefined)
    .sort((a, b) => (b.last_seen_at ?? b.proposed_at ?? '').localeCompare(a.last_seen_at ?? a.proposed_at ?? ''));

  for (const task of tasks) {
    const agent = task.agent!;
    const existing = bySession.get(agent.session_id);
    const entry: AgentEntry = existing ?? {
      role: task.contract.recipient,
      runtime: agent.runtime,
      session_id: agent.session_id,
      live: false,
      tasks: [],
      paths: [],
      last_seen: undefined,
    };
    entry.tasks.push(taskOf(task));
    for (const path of task.contract.scope.allowed_paths) {
      if (!entry.paths.includes(path)) entry.paths.push(path);
    }
    // An agent still working on something cannot take on more; the caller needs to know that.
    if (LIVE_TASK_STATES.has(task.task_state)) entry.live = true;
    const seen = task.last_seen_at ?? task.completed_at ?? task.proposed_at;
    if (seen !== undefined && (entry.last_seen === undefined || seen > entry.last_seen)) {
      entry.last_seen = seen;
    }
    if (!existing) bySession.set(agent.session_id, entry);
  }
  return [...bySession.values()];
}

/** Agents that could take a new task now: they have a session to resume and nothing in hand. */
export function availableAgents(state: State): AgentEntry[] {
  return agentRegistry(state).filter((entry) => !entry.live);
}

/**
 * The registry as Markdown, for a human to read and an agent to grep.
 *
 * It is written to `<relayDir>/agents.md` whenever it changes. The wording is deliberately plain
 * about where the facts come from, because a file that looked like a set of recommendations would
 * invite exactly the self-reporting this project refuses.
 */
export function agentRegistryMarkdown(state: State, now: string): string {
  const entries = agentRegistry(state);
  const lines: string[] = [
    '# Agents',
    '',
    'Every agent relayd has spawned in this repository, and the session that still remembers its work.',
    'Resume one instead of starting fresh when it has already worked where your subtask is going:',
    'pass its `session_id` as `reuse_session` to `relay_propose_subtask`.',
    '',
    'Nothing here is self-reported. The tasks are what relayd verified, and the paths are what the',
    'contracts allowed — so this says where an agent has been, not what it is good at.',
    '',
    `_Derived from the event log; rewritten when it changes. Last: ${now}._`,
    '',
  ];
  if (entries.length === 0) {
    lines.push('No agent has been spawned yet.');
    return `${lines.join('\n')}\n`;
  }

  for (const entry of entries) {
    lines.push(`## ${entry.role} · ${entry.runtime}`);
    lines.push('');
    lines.push(`- session: \`${entry.session_id}\``);
    lines.push(`- ${entry.live ? '**busy** — it is working on something' : 'free — it can take a task'}`);
    if (entry.last_seen !== undefined) lines.push(`- last seen: ${entry.last_seen}`);
    if (entry.paths.length > 0) lines.push(`- worked in: ${entry.paths.map((p) => `\`${p}\``).join(', ')}`);
    lines.push('');
    lines.push('| task | state | goal |');
    lines.push('| --- | --- | --- |');
    for (const task of entry.tasks) {
      const state = task.verified ? `${task.state} · verified` : task.state;
      lines.push(`| \`${task.id}\` | ${state} | ${task.goal.replaceAll('|', '\\|')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
