import type {
  Event,
  Graph,
  GraphApi,
  GraphObjectRef,
  ObjectAction,
  ObjectDescription,
  State,
} from '@relay/protocol';

export const objectGraph: Graph = {
  nodes: [
    { id: 'planner', kind: 'planner', label: 'planner', column: 0, status: 'working' },
    {
      id: 't-backend-auth',
      kind: 'agent',
      label: 'backend',
      task_id: 't-backend-auth',
      runtime: 'blocked',
      task_state: 'executing',
      handoff_state: 'accepted',
      column: 1,
      status: 'blocked',
      badge: '◐ blocked',
    },
    {
      id: 't-frontend-login',
      kind: 'agent',
      label: 'frontend',
      task_id: 't-frontend-login',
      runtime: 'working',
      task_state: 'executing',
      handoff_state: 'accepted',
      column: 1,
      status: 'working',
      badge: 'a1',
    },
    { id: 'verifier', kind: 'verifier', label: 'verifier', column: 2, status: 'pending' },
  ],
  edges: [
    {
      id: 'edge-backend-contract',
      kind: 'contract',
      from: 'planner',
      to: 't-backend-auth',
      task_id: 't-backend-auth',
      label: 'v2 ✓',
      status: 'done',
      attention: false,
      version: 2,
    },
    {
      id: 'edge-frontend-contract',
      kind: 'contract',
      from: 'planner',
      to: 't-frontend-login',
      task_id: 't-frontend-login',
      label: '? 2',
      status: 'attention',
      attention: true,
      version: 1,
    },
    {
      id: 'edge-backend-evidence',
      kind: 'evidence',
      from: 't-backend-auth',
      to: 'verifier',
      task_id: 't-backend-auth',
      label: 'AC-2 ✗',
      status: 'failed',
      attention: true,
    },
    {
      id: 'edge-frontend-evidence',
      kind: 'evidence',
      from: 't-frontend-login',
      to: 'verifier',
      task_id: 't-frontend-login',
      label: 'awaiting evidence',
      status: 'working',
      attention: false,
    },
  ],
  inbox: [
    {
      id: 'inbox-backend-question',
      kind: 'task_question',
      mission_id: 'm-001',
      task_id: 't-backend-auth',
      title: 'backend asks one question',
      detail: ['Which token expiry should be used?'],
      ref: { kind: 'edge', id: 'edge-backend-contract' },
      actions: [{
        key: 'a',
        label: 'answer',
        kind: 'clarify',
        target: { task_id: 't-backend-auth', question_ids: ['Q1'] },
      }],
    },
    {
      id: 'inbox-backend-blocker',
      kind: 'blocker',
      mission_id: 'm-001',
      task_id: 't-backend-auth',
      title: 'backend is blocked',
      detail: ['Waiting for a product decision'],
      ref: { kind: 'node', id: 't-backend-auth' },
      actions: [{
        key: 'r',
        label: 'reply',
        kind: 'reply',
        target: { task_id: 't-backend-auth' },
      }],
    },
  ],
};

const keyedActions: Record<string, ObjectAction[]> = {
  'node:planner': [{
    key: 'a',
    label: 'answer',
    kind: 'mission_clarify',
    target: { mission_id: 'm-001', question_ids: ['Q9'] },
  }],
  'node:t-backend-auth': [
    { key: 'r', label: 'reply', kind: 'reply', target: { task_id: 't-backend-auth' } },
    { key: 'x', label: 'cancel', kind: 'cancel', target: { task_id: 't-backend-auth' } },
  ],
  'edge:edge-backend-contract': [{
    key: 'a',
    label: 'answer',
    kind: 'clarify',
    target: { task_id: 't-backend-auth', question_ids: ['Q1'] },
  }],
  'edge:edge-backend-evidence': [
    { key: 'p', label: 'pass', kind: 'review', target: { task_id: 't-backend-auth', criterion_id: 'AC-2' } },
    { key: 'f', label: 'fail', kind: 'review', target: { task_id: 't-backend-auth', criterion_id: 'AC-2' } },
  ],
};

function objectKey(ref: GraphObjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

function objectDescription(ref: GraphObjectRef): ObjectDescription {
  const titles: Record<string, string> = {
    'node:planner': 'Mission planner',
    'node:t-backend-auth': 'Backend agent',
    'node:t-frontend-login': 'Frontend agent',
    'node:verifier': 'Verification engine',
    'edge:edge-backend-contract': 'Backend contract',
    'edge:edge-frontend-contract': 'Frontend contract',
    'edge:edge-backend-evidence': 'Backend evidence',
    'edge:edge-frontend-evidence': 'Frontend evidence',
    'inbox:inbox-backend-question': 'Backend question',
    'inbox:inbox-backend-blocker': 'Backend blocker',
  };
  return { title: titles[objectKey(ref)] ?? ref.id, lines: [`id: ${ref.id}`, `kind: ${ref.kind}`] };
}

export function objectGraphApi(actions: Record<string, ObjectAction[]> = keyedActions): GraphApi {
  return {
    buildGraph: (_state: State) => objectGraph,
    actionsFor: (ref) => actions[objectKey(ref)] ?? (
      ref.kind === 'inbox' ? objectGraph.inbox.find((item) => item.id === ref.id)?.actions ?? [] : []
    ),
    narrate: (event: Event) => `${event.actor} ${event.type}`,
    storyFor: (ref) => [`Story begins for ${ref.id}.`, `Story continues for ${ref.id}.`],
    describe: (ref) => objectDescription(ref),
  };
}
