//! Serde twins of the frozen TypeScript contract: `packages/protocol/src/graph/types.ts` (the object model),
//! `packages/protocol/src/pty.ts` (panes, WebSocket frames, metrics) and the slices of `state.ts` the tree
//! needs. Field names and optionality match the zod schemas one for one, so a fixture dumped from relayd
//! re-serialises to the same JSON (see `tests/model.rs`). Structs that mirror only part of a TypeScript type
//! carry a flattened `extra` map so unknown fields survive a round trip.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

// --- graph/types.ts -------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphNodeKind {
    Human,
    Planner,
    Agent,
    Verifier,
}

/// Rendering hint: 0 = human/planner column, 1 = agents, 2 = verifier, 3 = done.
pub type GraphColumn = u8;

/// Coarse visual status shared by nodes and edges; renderers map it to colour/animation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualStatus {
    Pending,
    Working,
    Attention,
    Blocked,
    Done,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Unspawned,
    Idle,
    Working,
    Blocked,
    Done,
    Exited,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Proposed,
    Accepted,
    Executing,
    AwaitingVerification,
    Repairing,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffState {
    Draft,
    Proposed,
    NeedsClarification,
    Revised,
    Accepted,
    Rejected,
    EvidenceSubmitted,
    RetryRequested,
    Verified,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    /// `human`, `planner`, `verifier`, or the task id for agents.
    pub id: String,
    pub kind: GraphNodeKind,
    /// Short display name: role for agents (`backend`), otherwise the kind.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state: Option<TaskState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_state: Option<HandoffState>,
    pub column: GraphColumn,
    pub status: VisualStatus,
    /// Tiny annotation next to the label, e.g. `a2` (attempt 2), `? 2`, `◐ blocked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphEdgeKind {
    Contract,
    Evidence,
    Dependency,
    Question,
    Reply,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub kind: GraphEdgeKind,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Short label drawn on the edge, e.g. `v2 ✓`, `? 2`, `AC-2 ✗`, `awaiting evidence`.
    pub label: String,
    pub status: VisualStatus,
    /// True when a human must act for this edge to progress.
    pub attention: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxKind {
    TaskQuestion,
    MissionQuestion,
    HumanReview,
    Blocker,
    Escalation,
    LintError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Clarify,
    MissionClarify,
    Review,
    Reply,
    Cancel,
    Focus,
    Inspect,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ActionTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criterion_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectAction {
    /// Single key the TUI binds, e.g. `a`, `r`, `p`, `f`, `x`, `Enter`.
    pub key: String,
    pub label: String,
    pub kind: ActionKind,
    pub target: ActionTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Node,
    Edge,
    Inbox,
}

impl RefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RefKind::Node => "node",
            RefKind::Edge => "edge",
            RefKind::Inbox => "inbox",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct GraphObjectRef {
    pub kind: RefKind,
    pub id: String,
}

impl GraphObjectRef {
    pub fn node(id: impl Into<String>) -> Self {
        Self {
            kind: RefKind::Node,
            id: id.into(),
        }
    }
    pub fn edge(id: impl Into<String>) -> Self {
        Self {
            kind: RefKind::Edge,
            id: id.into(),
        }
    }
    pub fn inbox(id: impl Into<String>) -> Self {
        Self {
            kind: RefKind::Inbox,
            id: id.into(),
        }
    }
    /// `kind:id`, the key the fixture maps (`describe.json`, `actions.json`, `stories.json`) use.
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxItem {
    pub id: String,
    pub kind: InboxKind,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// One line, e.g. `backend asks 2 questions (v1)`.
    pub title: String,
    /// The questions / criterion / blocker text, one entry per line.
    pub detail: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// The graph object this item points at (Enter jumps there).
    #[serde(rename = "ref")]
    pub reference: GraphObjectRef,
    pub actions: Vec<ObjectAction>,
}

/// `GET /graph`: `buildGraph(state)` plus `seq` (last event seq) so a client can tell whether it is current.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub inbox: Vec<InboxItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

impl Graph {
    pub fn node(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.id == id)
    }
    pub fn edge(&self, id: &str) -> Option<&GraphEdge> {
        self.edges.iter().find(|e| e.id == id)
    }
    pub fn inbox_item(&self, id: &str) -> Option<&InboxItem> {
        self.inbox.iter().find(|i| i.id == id)
    }
    pub fn contains(&self, r: &GraphObjectRef) -> bool {
        match r.kind {
            RefKind::Node => self.node(&r.id).is_some(),
            RefKind::Edge => self.edge(&r.id).is_some(),
            RefKind::Inbox => self.inbox_item(&r.id).is_some(),
        }
    }
    /// The task an object belongs to (nodes and edges carry `task_id`; inbox items too).
    pub fn task_of(&self, r: &GraphObjectRef) -> Option<&str> {
        match r.kind {
            RefKind::Node => self.node(&r.id).and_then(|n| n.task_id.as_deref()),
            RefKind::Edge => self.edge(&r.id).and_then(|e| e.task_id.as_deref()),
            RefKind::Inbox => self.inbox_item(&r.id).and_then(|i| i.task_id.as_deref()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ObjectDescription {
    pub title: String,
    /// Static facts (goal, scope, criteria with check status, versions…), one per line.
    pub lines: Vec<String>,
}

/// `GET /graph/:kind/:id/story?limit=` → `{ ref, lines }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectStory {
    #[serde(rename = "ref")]
    pub reference: GraphObjectRef,
    pub lines: Vec<String>,
}

/// One narrated event of `GET /story`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoryItem {
    pub seq: u64,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub actor: String,
    pub line: String,
}

/// `GET /story?since=&limit=` → `{ items }`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StoryLog {
    pub items: Vec<StoryItem>,
}

// --- state.ts (the slices the tree shows; everything else rides along in `extra`) ------------------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Mission {
    pub id: String,
    pub title: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct MissionView {
    pub mission: Mission,
    pub status: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_questions: Option<Vec<Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Contract {
    pub id: String,
    pub version: u64,
    pub recipient: String,
    pub runtime: String,
    #[serde(default)]
    pub goal: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AgentInfo {
    pub runtime: String,
    pub pane_id: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Blocker {
    pub reason: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LintItem {
    pub severity: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskView {
    pub id: String,
    pub mission_id: String,
    pub contract: Contract,
    pub runtime: RuntimeState,
    pub task_state: TaskState,
    pub handoff_state: HandoffState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<Blocker>,
    #[serde(default)]
    pub blocked_on_dependencies: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<Value>,
    #[serde(default)]
    pub lint: Vec<LintItem>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct State {
    pub last_seq: u64,
    #[serde(default)]
    pub missions: BTreeMap<String, MissionView>,
    #[serde(default)]
    pub tasks: BTreeMap<String, TaskView>,
    #[serde(default)]
    pub metrics: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl State {
    /// The first mission (the TUI shows one mission per run, like the Ink tree).
    pub fn mission(&self) -> Option<&MissionView> {
        self.missions.values().next()
    }
}

// --- pty.ts ----------------------------------------------------------------------------------------

/// A millisecond value as relayd serialised it (integer or float), so a dump round-trips unchanged.
pub type Millis = serde_json::Number;

/// `Millis` as a float for display.
pub fn millis(value: &Option<Millis>) -> Option<f64> {
    value.as_ref().and_then(|n| n.as_f64())
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PaneTimings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_output_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_write_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_accept_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_retries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_p50_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_p95_ms: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_chunks: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneInfo {
    pub pane_id: String,
    /// Task this pane hosts, or none for the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Agent role shown as the pane title (`backend`, `planner`).
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    pub alive: bool,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cast_path: Option<String>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<PaneTimings>,
}

/// `GET /panes`: relayd and termd answer `{ panes, focused_pane? }`; `pty.ts` documents a bare array.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PanesResponse {
    Object {
        panes: Vec<PaneInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        focused_pane: Option<String>,
    },
    List(Vec<PaneInfo>),
}

impl PanesResponse {
    pub fn into_panes(self) -> (Vec<PaneInfo>, Option<String>) {
        match self {
            PanesResponse::Object {
                panes,
                focused_pane,
            } => (panes, focused_pane),
            PanesResponse::List(panes) => (panes, None),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMetrics {
    pub pane_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub timings: PaneTimings,
}

/// `GET /metrics`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostMetrics {
    pub host: String,
    pub uptime_ms: Millis,
    pub panes_spawned: u64,
    pub panes_alive: u64,
    pub prompt_failures: u64,
    pub panes: Vec<PaneMetrics>,
}

impl HostMetrics {
    pub fn pane(&self, pane_id: &str) -> Option<&PaneTimings> {
        self.panes
            .iter()
            .find(|p| p.pane_id == pane_id)
            .map(|p| &p.timings)
    }
}

/// Client → relayd (`PtyClientMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum PtyClientMessage {
    /// base64 bytes typed by the user.
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Ping,
}

/// relayd → client (`PtyServerMessage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum PtyServerMessage {
    Hello {
        pane: Box<PaneInfo>,
    },
    /// Replay of the retained scrollback (base64), sent once right after `hello`.
    Scrollback {
        data: String,
    },
    /// base64 bytes from the PTY.
    Output {
        data: String,
    },
    Exit {
        code: i64,
    },
    Pong,
}

// --- api.ts request bodies ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClarifyAnswer {
    pub question_id: String,
    pub answer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClarifyBody {
    pub answers: Vec<ClarifyAnswer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewBody {
    pub criterion_id: String,
    /// `passed` | `failed`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyBody {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CancelBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The SSE `data:` payload of `GET /events`: only `seq` matters to the TUI (it re-fetches the graph).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
