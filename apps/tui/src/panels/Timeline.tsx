import type { Event } from '@relay/protocol';
import { Text } from 'ink';
import React from 'react';

export interface TimelineProps {
  events: Event[];
  height: number;
}

export function eventHint(event: Event): string {
  switch (event.type) {
    case 'contract_revised': return `→ v${event.payload.contract.version}`;
    case 'task_proposed': return `→ v${event.payload.contract.version}`;
    case 'task_accepted': return `v${event.payload.contract_version} ✓`;
    case 'clarification_requested': return `? ${event.payload.response.questions.length}`;
    case 'clarification_answered': return `${event.payload.answers.length} answered`;
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

export function Timeline({ events, height }: TimelineProps) {
  const visible = [...events]
    .sort((left, right) => left.seq - right.seq)
    .slice(-Math.max(0, height));
  return <Text>{visible.map(formatTimelineEvent).join('\n')}</Text>;
}
