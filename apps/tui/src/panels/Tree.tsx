import type { Graph, GraphNode, GraphObjectRef, RuntimeState, State, TaskView } from '@relay/protocol';
import { Box, Text } from 'ink';
import React from 'react';

export interface TreeProps {
  state: State;
  graph: Graph;
  height: number;
  selected?: GraphObjectRef;
}

export function shortWorktree(fullPath: string): string {
  const segments = fullPath.split('/').filter((segment) => segment !== '');
  const relayIndex = segments.lastIndexOf('.relay');
  const kept = relayIndex === -1 ? segments.slice(-3) : segments.slice(relayIndex);
  return kept.join('/');
}

function taskDetail(node: GraphNode, task: TaskView | undefined): string {
  if (task?.blocked_on_dependencies.length) return `◐ blocked on ${task.blocked_on_dependencies.join(', ')}`;
  const details: string[] = [];
  if (task?.worktree) details.push(`wt ${shortWorktree(task.worktree.path)}`);
  if (task?.open_questions.length) details.push(`? ${task.open_questions.length}`);
  if (task?.blocker) details.push(task.blocker.reason);
  if (details.length === 0) details.push(node.badge ?? node.status);
  return details.join(' · ');
}

function statusColor(node: GraphNode): 'yellow' | 'green' | 'red' | 'cyan' | 'gray' {
  if (node.status === 'attention' || node.status === 'blocked') return 'yellow';
  if (node.status === 'done' || node.status === 'verified') return 'green';
  if (node.status === 'failed') return 'red';
  if (node.status === 'working') return 'cyan';
  return 'gray';
}

function runtimeGlyph(runtime: RuntimeState | undefined): string {
  switch (runtime) {
    case 'working': return '●';
    case 'idle': return '○';
    case 'blocked': return '◐';
    case 'done': return '✓';
    case 'exited': return '✗';
    case 'unspawned': return '·';
    default: return '?';
  }
}

export function Tree({ state, graph, height, selected }: TreeProps) {
  const missionView = Object.values(state.missions)[0];
  if (!missionView) return <Text dimColor>No mission</Text>;
  const agents = graph.nodes.filter((node) => node.kind === 'agent');
  const lint = Object.values(state.tasks).flatMap((task) => task.lint);
  const errors = lint.filter((item) => item.severity === 'error').length;
  const warnings = lint.filter((item) => item.severity === 'warning').length;
  const maxAgents = Math.max(0, Math.floor((height - 2) / 2));
  const selectedIndex = selected?.kind === 'node' ? agents.findIndex((node) => node.id === selected.id) : -1;
  const start = selectedIndex < maxAgents
    ? 0
    : Math.min(selectedIndex - maxAgents + 1, Math.max(0, agents.length - maxAgents));

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold wrap="truncate">
        MISSION  {missionView.mission.title}  {missionView.status}
        {(missionView.open_questions?.length ?? 0) > 0
          ? <Text color="yellow">  ? {missionView.open_questions!.length} for you</Text>
          : null}
      </Text>
      <Text dimColor wrap="truncate">lint: {errors} errors · {warnings} warnings</Text>
      {agents.length === 0 ? <Text dimColor>&lt;no agents&gt;</Text> : agents.slice(start, start + maxAgents).map((node) => {
        const task = node.task_id ? state.tasks[node.task_id] : undefined;
        const active = selected?.kind === 'node' && selected.id === node.id;
        return (
          <Box key={node.id} flexDirection="column">
            <Text color={statusColor(node)} bold={active} inverse={active} wrap="truncate">
              {active ? '›' : '▸'} {node.id}  {node.label}  {runtimeGlyph(node.runtime)} {node.runtime ?? '-'}  {node.task_state ?? '-'}  {node.handoff_state ?? '-'}  v{task?.contract.version ?? '-'}
            </Text>
            <Text color={statusColor(node)} dimColor wrap="truncate">    {taskDetail(node, task)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
