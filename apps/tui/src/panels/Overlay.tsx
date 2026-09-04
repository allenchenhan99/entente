import type {
  Event,
  Graph,
  GraphApi,
  GraphObjectRef,
  State,
  TaskContract,
  TaskView,
} from '@relay/protocol';
import { Box, Text } from 'ink';
import React from 'react';

import type { InputMode, OverlayTab } from '../keys.js';

const TASK_TABS: OverlayTab[] = ['Story', 'Contract', 'Response', 'Questions', 'Evidence', 'History'];

export interface OverlayProps {
  objectRef: GraphObjectRef;
  graph: Graph;
  state: State;
  events: Event[];
  api: GraphApi;
  tab: OverlayTab;
  inputMode?: InputMode;
  inputValue: string;
  error?: string;
  height?: number;
}

export function naiveContractDiff(previous: TaskContract, current: TaskContract): string {
  const before = JSON.stringify(previous, null, 2).split('\n');
  const after = JSON.stringify(current, null, 2).split('\n');
  const output: string[] = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) output.push(`- ${before[index]}`);
    if (after[index] !== undefined) output.push(`+ ${after[index]}`);
  }
  return output.join('\n');
}

function scopedTask(objectRef: GraphObjectRef, graph: Graph, state: State): TaskView | undefined {
  const taskId = objectRef.kind === 'node'
    ? graph.nodes.find((node) => node.id === objectRef.id)?.task_id
    : objectRef.kind === 'edge'
      ? graph.edges.find((edge) => edge.id === objectRef.id)?.task_id
      : graph.inbox.find((item) => item.id === objectRef.id)?.task_id;
  return taskId ? state.tasks[taskId] : undefined;
}

function contractContent(task: TaskView): string {
  const contract = task.contract;
  const lines = [
    `id: ${contract.id}`,
    `mission_id: ${contract.mission_id}`,
    `version: ${contract.version}`,
    `sender: ${contract.sender}`,
    `recipient: ${contract.recipient}`,
    `runtime: ${contract.runtime}`,
    `goal: ${contract.goal}`,
    `inputs: ${contract.inputs.join(', ') || '-'}`,
    `constraints: ${contract.constraints.join(' | ') || '-'}`,
    `non_goals: ${contract.non_goals.join(' | ') || '-'}`,
    `allowed_paths: ${contract.scope.allowed_paths.join(', ') || '-'}`,
    'acceptance_criteria:',
    ...contract.acceptance_criteria.map((criterion) => `  ${criterion.id}: ${criterion.condition} [${criterion.check?.kind ?? 'unverifiable'}]`),
    `output: ${contract.output.type} (${contract.output.evidence_required.join(', ') || 'no evidence'})`,
    `dependencies: ${contract.dependencies.join(', ') || '-'}`,
    `budget: repairs=${contract.budget?.max_repairs ?? '-'} stagnation=${contract.budget?.stagnation_limit ?? '-'}`,
    `clarifications: ${contract.clarifications.map((item) => `${item.question_id}=${item.answer}`).join(' | ') || '-'}`,
  ];
  if (task.versions.length > 1) {
    lines.push('diff vs previous:', naiveContractDiff(task.versions.at(-2)!, task.versions.at(-1)!));
  }
  return lines.join('\n');
}

function responseContent(task: TaskView): string {
  const response = task.response;
  if (!response) return 'No response';
  return [
    `decision: ${response.decision}`,
    `interpretation:\n${response.interpretation.map((item) => `  - ${item}`).join('\n') || '  -'}`,
    `assumptions:\n${response.assumptions.map((item) => `  - ${item}`).join('\n') || '  -'}`,
    `risks:\n${response.risks.map((item) => `  - ${item}`).join('\n') || '  -'}`,
    `verification_plan:\n${Object.entries(response.verification_plan).map(([id, plan]) => `  ${id}: ${plan}`).join('\n') || '  -'}`,
  ].join('\n');
}

function questionsContent(task: TaskView): string {
  if (task.open_questions.length === 0) return 'No open questions';
  return task.open_questions.map((question) => `${question.id}  ${question.text}${question.blocking ? '  [blocking]' : ''}`).join('\n');
}

function evidenceLines(task: TaskView): string[] {
  if (task.attempts.length === 0) return ['No evidence attempts'];
  return task.attempts.flatMap((attempt) => [
    `attempt ${attempt.attempt}  files: ${attempt.changed_files.join(', ') || '-'}`,
    ...Object.entries(attempt.checks).map(([id, check]) => `${id}  ${check.status}${check.observed ? `  ${check.observed}` : ''}${check.output_path ? `  ${check.output_path}` : ''}`),
  ]);
}

function historyContent(task: TaskView): string {
  return [
    `versions: ${task.versions.map((version) => `v${version.version}`).join(' → ')}`,
    ...(task.repairs.length === 0
      ? ['repairs: none']
      : task.repairs.map((repair) => `repair ${repair.id}: ${repair.failed_criteria.join(', ')} — ${repair.observed_failure}`)),
  ].join('\n');
}

function tabHeader(active: OverlayTab, task: TaskView | undefined): string {
  const tabs = task ? TASK_TABS : ['Story'] as const;
  return tabs.map((tab) => tab === active ? `[${tab}]` : tab).join('  ');
}

export function Overlay(props: OverlayProps) {
  const { objectRef, graph, state, events, api, tab, inputMode, inputValue, error, height } = props;
  const task = scopedTask(objectRef, graph, state);
  const description = api.describe(objectRef, graph, state);
  const story = api.storyFor(objectRef, graph, state, events);
  const storyContent = [description.title, ...description.lines, '', ...story].join('\n');
  const activeTab = task ? tab : 'Story';
  const content = activeTab === 'Story' ? storyContent
    : activeTab === 'Contract' ? contractContent(task!)
      : activeTab === 'Response' ? responseContent(task!)
        : activeTab === 'Questions' ? questionsContent(task!)
          : activeTab === 'Evidence' ? evidenceLines(task!).join('\n')
            : historyContent(task!);
  const mismatches = activeTab === 'Evidence' && task
    ? [...new Set(task.attempts.flatMap((attempt) => attempt.self_report_mismatch))]
    : [];
  const prompt = inputMode === 'answer' ? `answer> ${inputValue}`
    : inputMode === 'reply' ? `reply> ${inputValue}`
      : inputMode === 'review-failure' ? `observed failure> ${inputValue}`
        : inputMode === 'cancel-confirm' ? 'cancel task? y/N' : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" height={height} overflow="hidden" paddingX={1}>
      <Box height={1} flexShrink={0}>
        <Text bold color="cyan">{objectRef.id}  {tabHeader(activeTab, task)}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text>{content}</Text>
        {mismatches.length > 0 && <Text color="red" bold>SELF-REPORT MISMATCH: {mismatches.join(', ')}</Text>}
        {prompt && <Text color="yellow" bold>{prompt}</Text>}
        {error && <Text color="red">{error}</Text>}
      </Box>
    </Box>
  );
}
