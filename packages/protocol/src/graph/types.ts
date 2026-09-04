/**
 * Object model of a mission as a graph — the "explainable" view of RelayGraph.
 *
 * Every node and edge is an object with identity, state, a plain-language story and the actions a human
 * can take on it right now. Renderers (TUI, web) only draw these objects; they never re-derive semantics.
 * Everything here is a pure function of `State` (plus the event log for stories), so it replays.
 */
import type { Event } from '../events.js';
import type { HandoffState, RuntimeState, State, TaskState } from '../state.js';

export type GraphNodeKind = 'human' | 'planner' | 'agent' | 'verifier';

/** Rendering hint: 0 = human/planner column, 1 = agents, 2 = verifier, 3 = done. */
export type GraphColumn = 0 | 1 | 2 | 3;

/** Coarse visual status shared by nodes and edges; renderers map it to colour/animation. */
export type VisualStatus = 'pending' | 'working' | 'attention' | 'blocked' | 'done' | 'verified' | 'failed';

export interface GraphNode {
  /** `human`, `planner`, `verifier`, or the task id for agents. */
  id: string;
  kind: GraphNodeKind;
  /** Short display name: role for agents (`backend`), otherwise the kind. */
  label: string;
  task_id?: string;
  runtime?: RuntimeState;
  task_state?: TaskState;
  handoff_state?: HandoffState;
  column: GraphColumn;
  status: VisualStatus;
  /** Tiny annotation next to the label, e.g. `a2` (attempt 2), `? 2`, `◐ blocked`. */
  badge?: string;
}

export type GraphEdgeKind =
  | 'contract'    // planner → agent: the task contract (state = handoff_state, version)
  | 'evidence'    // agent → verifier: evidence / checks / repair loop
  | 'dependency'  // agent → agent: `dependencies`
  | 'question'    // agent → human (task clarification) or planner → human (mission clarification)
  | 'reply';      // human → agent: answers, reviews, blocker replies

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  from: string; // GraphNode.id
  to: string;   // GraphNode.id
  task_id?: string;
  /** Short label drawn on the edge, e.g. `v2 ✓`, `? 2`, `AC-2 ✗`, `awaiting evidence`. */
  label: string;
  status: VisualStatus;
  /** True when a human must act for this edge to progress. */
  attention: boolean;
  version?: number;
}

export type InboxKind =
  | 'task_question'     // a recipient asked for clarification
  | 'mission_question'  // the planner asked the human
  | 'human_review'      // a human_review criterion is pending
  | 'blocker'           // an agent reported it is stuck
  | 'escalation'        // repair loop escalated / budget exhausted
  | 'lint_error';       // a contract cannot be spawned until fixed

export type ActionKind = 'clarify' | 'mission_clarify' | 'review' | 'reply' | 'cancel' | 'focus' | 'inspect';

export interface ObjectAction {
  /** Single key the TUI binds, e.g. `a`, `r`, `p`, `f`, `x`, `Enter`. */
  key: string;
  label: string;
  kind: ActionKind;
  target: { task_id?: string; mission_id?: string; criterion_id?: string; question_ids?: string[] };
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  mission_id: string;
  task_id?: string;
  /** One line, e.g. `backend asks 2 questions (v1)`. */
  title: string;
  /** The questions / criterion / blocker text, one entry per line. */
  detail: string[];
  since?: string;
  /** The graph object this item points at (Enter jumps there). */
  ref: GraphObjectRef;
  actions: ObjectAction[];
}

export interface GraphObjectRef {
  kind: 'node' | 'edge' | 'inbox';
  id: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  inbox: InboxItem[];
}

export interface ObjectDescription {
  title: string;
  /** Static facts (goal, scope, criteria with check status, versions…), one per line. */
  lines: string[];
}

export interface GraphApi {
  /** Pure: derive the whole object graph from state. Deterministic ordering (nodes by column then id). */
  buildGraph(state: State): Graph;
  /** What a human can do to this object right now. Empty when nothing applies. */
  actionsFor(ref: GraphObjectRef, graph: Graph, state: State): ObjectAction[];
  /** One plain-English sentence for an event, e.g. `backend accepted contract v2: "only backend endpoints; reuse the session store"`. */
  narrate(event: Event, state: State): string;
  /** The story of an object: narrated events that concern it, oldest first. */
  storyFor(ref: GraphObjectRef, graph: Graph, state: State, events: Iterable<Event>): string[];
  /** Static description of an object (contract facts for edges, role/state for nodes, the item itself for inbox). */
  describe(ref: GraphObjectRef, graph: Graph, state: State): ObjectDescription;
}
