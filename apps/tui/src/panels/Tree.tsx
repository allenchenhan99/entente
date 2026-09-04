import type { HandoffState, State, TaskView } from '@relay/protocol';
import { Box, Text } from 'ink';
import React from 'react';

export interface TreeProps {
  state: State;
  height: number;
  selectedTaskId?: string;
}

export interface TaskDetail {
  text: string;
  dim: boolean;
}

function runtimeGlyph(task: TaskView): string {
  switch (task.runtime) {
    case 'working': return '●';
    case 'idle': return '○';
    case 'blocked': return '◐';
    case 'done': return '✓';
    case 'exited': return '✗';
    case 'unspawned': return '·';
    default: return '?';
  }
}

function handoffColor(handoff: HandoffState): 'yellow' | 'green' | 'red' | 'gray' | undefined {
  switch (handoff) {
    case 'needs_clarification': return 'yellow';
    case 'accepted':
    case 'evidence_submitted':
    case 'verified': return 'green';
    case 'retry_requested':
    case 'rejected': return 'red';
    case 'proposed':
    case 'revised':
    case 'draft': return 'gray';
    default: return undefined;
  }
}

function wasAccepted(task: TaskView): boolean {
  return task.accepted_at !== undefined
    || ['accepted', 'evidence_submitted', 'retry_requested', 'verified'].includes(task.handoff_state);
}

/**
 * Worktree paths are absolute and can be far longer than the pane is wide (`Tree` gets ~40% of the
 * terminal per PRD §12.1). Only the tail identifies the task, so keep the path from its `.relay`
 * segment onwards and fall back to the last three segments.
 */
export function shortWorktree(fullPath: string): string {
  const segments = fullPath.split('/').filter((segment) => segment !== '');
  const relayIndex = segments.lastIndexOf('.relay');
  const kept = relayIndex === -1 ? segments.slice(-3) : segments.slice(relayIndex);
  return kept.join('/');
}

export function taskDetail(task: TaskView): TaskDetail {
  if (task.blocked_on_dependencies.length > 0) {
    return { text: `◐ blocked on ${task.blocked_on_dependencies.join(', ')}`, dim: false };
  }

  const details: string[] = [];
  if (task.worktree) details.push(`wt ${shortWorktree(task.worktree.path)}`);
  if (task.open_questions.length > 0) details.push(`? ${task.open_questions.length}`);
  if (task.blocker) details.push(`blocked: ${task.blocker.reason}`);
  if (details.length === 0) details.push(`waiting on ${task.contract.dependencies.join(', ') || 'handoff'}`);
  return { text: details.join(' · '), dim: Boolean(task.worktree) && !wasAccepted(task) };
}

function taskSummary(task: TaskView): string {
  return `${runtimeGlyph(task)} ${task.runtime}  ${task.task_state}  ${task.handoff_state}  v${task.contract.version}`;
}

export function Tree({ state, height, selectedTaskId }: TreeProps) {
  const missionView = Object.values(state.missions)[0];
  if (!missionView) return <Text dimColor>No mission</Text>;

  const tasks = missionView.task_ids
    .map((taskId) => state.tasks[taskId])
    .filter((task): task is TaskView => task !== undefined);
  const lint = tasks.flatMap((task) => task.lint);
  const errorCount = lint.filter((result) => result.severity === 'error').length;
  const warningCount = lint.filter((result) => result.severity === 'warning').length;
  const maxTasks = Math.max(0, Math.floor((height - 2) / 2));

  return (
    // Every row must occupy exactly one line: `maxTasks` budgets two lines per task, so a single
    // soft-wrapped row pushes the tasks below it out of this height-clipped box.
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold wrap="truncate">
        MISSION  {missionView.mission.title}  {missionView.status}
        {(missionView.open_questions?.length ?? 0) > 0 ? <Text color="yellow">  ? {missionView.open_questions!.length} for you</Text> : null}
      </Text>
      <Text dimColor wrap="truncate">lint: {errorCount} errors · {warningCount} warnings</Text>
      {tasks.slice(0, maxTasks).map((task) => {
        const detail = taskDetail(task);
        return (
          <Box key={task.id} flexDirection="column">
            <Text color={handoffColor(task.handoff_state)} bold={task.id === selectedTaskId} wrap="truncate">
              {task.id === selectedTaskId ? '›' : '▸'} {task.contract.recipient}  {taskSummary(task)}
            </Text>
            <Text color={handoffColor(task.handoff_state)} dimColor={detail.dim} wrap="truncate">    {detail.text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
