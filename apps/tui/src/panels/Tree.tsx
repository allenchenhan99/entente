import type { HandoffState, State, TaskView } from '@relay/protocol';
import { Box, Text } from 'ink';

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

export function taskDetail(task: TaskView): TaskDetail {
  if (task.blocked_on_dependencies.length > 0) {
    return { text: `◐ blocked on ${task.blocked_on_dependencies.join(', ')}`, dim: false };
  }

  const details: string[] = [];
  if (task.worktree) details.push(`wt ${task.worktree.path}`);
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
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold>MISSION  {missionView.mission.title}  {missionView.status}</Text>
      <Text dimColor>lint: {errorCount} errors · {warningCount} warnings</Text>
      {tasks.slice(0, maxTasks).map((task) => {
        const detail = taskDetail(task);
        return (
          <Box key={task.id} flexDirection="column">
            <Text color={handoffColor(task.handoff_state)} bold={task.id === selectedTaskId}>
              {task.id === selectedTaskId ? '›' : '▸'} {task.contract.recipient}  {taskSummary(task)}
            </Text>
            <Text color={handoffColor(task.handoff_state)} dimColor={detail.dim}>    {detail.text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
