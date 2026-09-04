import type { Event } from '@relay/protocol';
import { Box, Text } from 'ink';
import React from 'react';

export interface TimelineProps {
  events: Event[];
  height: number;
  selectedIndex?: number;
}

export function eventHint(event: Event): string {
  switch (event.type) {
    case 'contract_revised': return `→ v${event.payload.contract.version}`;
    case 'task_proposed': return `→ v${event.payload.contract.version}`;
    case 'task_accepted': return `v${event.payload.contract_version} ✓`;
    case 'clarification_requested': return `? ${event.payload.response.questions.length}`;
    case 'clarification_answered': return `${event.payload.answers.length} answered`;
    case 'mission_clarification_requested': return `? ${event.payload.questions.length} for the human`;
    case 'mission_clarification_answered': return `${event.payload.answers.length} answered`;
    case 'blocker_replied': return `↩ ${event.payload.message.slice(0, 40)}`;
    case 'evidence_submitted': return `#${event.payload.submission.attempt}`;
    case 'checks_started': return `#${event.payload.attempt}`;
    case 'check_passed': return `${event.payload.criterion_id} passed`;
    case 'check_failed': return `${event.payload.criterion_id} failed`;
    case 'human_review_recorded': return `${event.payload.criterion_id} ${event.payload.status}`;
    case 'repair_requested': return `→ ${event.payload.repair.id}`;
    case 'task_verified': return `#${event.payload.attempt} ✓`;
    case 'task_blocked': return event.payload.waiting_on ? `on ${event.payload.waiting_on}` : event.payload.reason;
    case 'progress_reported': return event.payload.percent === undefined ? event.payload.message : `${event.payload.percent}%`;
    case 'lint_reported': {
      const errors = event.payload.results.filter((result) => result.severity === 'error').length;
      return errors > 0 ? `${errors} errors` : 'clean';
    }
    default: return '';
  }
}

function eventTime(timestamp: string): string {
  return /T(\d{2}:\d{2})/.exec(timestamp)?.[1] ?? timestamp.slice(0, 5);
}

export function formatTimelineEvent(event: Event): string {
  const task = event.task_id ?? '-';
  const hint = eventHint(event);
  return `${eventTime(event.ts)}  ${event.actor}  ${event.type}  ${task}${hint === '' ? '' : `  ${hint}`}`;
}

export function Timeline({ events, height, selectedIndex }: TimelineProps) {
  const sorted = [...events]
    .sort((left, right) => left.seq - right.seq)
    .map((event, index) => ({ event, index }));
  const windowSize = Math.max(0, height);
  const selected = selectedIndex === undefined
    ? sorted.length - 1
    : Math.max(0, Math.min(sorted.length - 1, selectedIndex));
  const start = selected < windowSize
    ? 0
    : Math.min(selected - windowSize + 1, Math.max(0, sorted.length - windowSize));
  const visible = sorted.slice(start, start + windowSize);
  if (visible.length === 0) return <Text dimColor>&lt;no events&gt;</Text>;
  return (
    <Box flexDirection="column">
      {visible.map(({ event, index }) => (
        <Text key={event.seq} inverse={index === selectedIndex} wrap="truncate">{formatTimelineEvent(event)}</Text>
      ))}
    </Box>
  );
}
