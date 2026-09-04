import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Event } from '@relay/protocol';

import { Timeline, eventHint, formatTimelineEvent } from './Timeline.js';

const events = [
  Event.parse({
    seq: 1,
    ts: '2026-09-05T10:01:00+08:00',
    mission_id: 'm-001',
    task_id: 't-backend-auth',
    actor: 'planner',
    type: 'contract_revised',
    payload: {
      previous_version: 1,
      contract: {
        id: 't-backend-auth', mission_id: 'm-001', version: 2, sender: 'planner', recipient: 'backend',
        runtime: 'claude-code', goal: 'Implement secure authentication', inputs: [], constraints: [], non_goals: [],
        scope: { allowed_paths: ['src/auth/**'] }, acceptance_criteria: [],
        output: { type: 'code_change', evidence_required: [] }, dependencies: [],
        budget: { max_repairs: 2, stagnation_limit: 2 }, clarifications: [],
      },
    },
  }),
  Event.parse({
    seq: 2,
    ts: '2026-09-05T10:02:00+08:00',
    mission_id: 'm-001',
    task_id: 't-frontend-login',
    actor: 'agent:frontend',
    type: 'clarification_requested',
    payload: {
      contract_version: 1,
      response: {
        task_id: 't-frontend-login', contract_version: 1, decision: 'needs_clarification',
        interpretation: [], assumptions: [], risks: [], verification_plan: {},
        questions: [
          { id: 'Q1', text: 'One?', blocking: true },
          { id: 'Q2', text: 'Two?', blocking: true },
        ],
      },
    },
  }),
  Event.parse({
    seq: 3,
    ts: '2026-09-05T10:03:00+08:00',
    mission_id: 'm-001',
    task_id: 't-backend-auth',
    actor: 'relayd',
    type: 'check_failed',
    payload: {
      attempt: 1,
      criterion_id: 'AC-2',
      result: { status: 'failed', observed: 'expected 401, received 200' },
    },
  }),
];

describe('timeline', () => {
  it('renders the visible tail oldest-to-newest with payload hints', () => {
    const { lastFrame } = render(<Timeline events={events} height={2} />);
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('10:01');
    expect(frame.indexOf('10:02')).toBeLessThan(frame.indexOf('10:03'));
    expect(frame).toContain('? 2');
    expect(frame).toContain('AC-2 failed');
  });

  it('formats actor, type, task, and version hint', () => {
    expect(formatTimelineEvent(events[0]!)).toBe('10:01  planner  contract_revised  t-backend-auth  → v2');
    expect(eventHint(events[0]!)).toBe('→ v2');
  });
});
