//! The state machine: what is selected, which panel has focus, whether the inspector / help / an inline
//! editor is open, the pane grid and the focused pane. `App` is pure — keys go in, `Effect`s (HTTP posts,
//! WebSocket frames, fetches) come out — so every rule here is unit-testable without a terminal or a server.
//! The rules mirror `apps/tui/src/keys.ts` and `App.tsx` (see `keys.rs` for the map).

use crate::keys::{Key, KeyCode, Mouse, MouseKind};
use crate::metrics::FrameStats;
use crate::model::*;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Live,
    Replay,
}

/// Panels in Tab order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Tree,
    Graph,
    Panes,
    Inbox,
}

const REGIONS: [Region; 4] = [Region::Tree, Region::Graph, Region::Panes, Region::Inbox];

impl Region {
    pub fn title(self) -> &'static str {
        match self {
            Region::Tree => "MISSION / WORKTREES",
            Region::Graph => "HANDOFFS",
            Region::Panes => "PANES",
            Region::Inbox => "INBOX",
        }
    }
}

/// A screen rectangle, in `App`'s own terms so the state machine never depends on a terminal library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Viewport {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl Viewport {
    pub const EMPTY: Viewport = Viewport {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
    };

    pub fn contains(&self, col: u16, row: u16) -> bool {
        self.width > 0
            && self.height > 0
            && col >= self.x
            && row >= self.y
            && col < self.x + self.width
            && row < self.y + self.height
    }
}

/// Pan and zoom over the graph's fixed world box. The nodes never move; this does.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GraphView {
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
}

impl Default for GraphView {
    fn default() -> Self {
        Self {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        }
    }
}

impl GraphView {
    pub const MIN_ZOOM: f64 = 0.5;
    pub const MAX_ZOOM: f64 = 6.0;
    /// Panning stops here, so the network can never be dragged off screen and lost.
    pub const MAX_PAN: f64 = 90.0;

    pub fn zoom_by(&mut self, factor: f64) {
        self.zoom = (self.zoom * factor).clamp(Self::MIN_ZOOM, Self::MAX_ZOOM);
    }

    /// Pan in world units; the step shrinks as you zoom in, so it always feels the same on screen.
    pub fn pan_by(&mut self, dx: f64, dy: f64) {
        self.pan_x = (self.pan_x + dx / self.zoom).clamp(-Self::MAX_PAN, Self::MAX_PAN);
        self.pan_y = (self.pan_y + dy / self.zoom).clamp(-Self::MAX_PAN, Self::MAX_PAN);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Answer,
    Reply,
    ReviewFailure,
    CancelConfirm,
    /// `X`: close the focused pane. Kills a process, so it asks first.
    ClosePaneConfirm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    Connecting,
    Live,
    Replay,
    Disconnected(String),
}

impl Connection {
    pub fn label(&self) -> String {
        match self {
            Connection::Connecting => "○ connecting".into(),
            Connection::Live => "● live".into(),
            Connection::Replay => "▶ replay".into(),
            Connection::Disconnected(why) => format!("✗ disconnected ({why})"),
        }
    }
}

/// What the inspector shows for one object: `describe`, the story tail and the actions.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Inspector {
    pub reference: Option<GraphObjectRef>,
    pub description: ObjectDescription,
    pub story: Vec<String>,
    pub actions: Vec<ObjectAction>,
    pub loaded: bool,
}

/// One live terminal: its `PaneInfo` and the screen model fed by the `/pty/:id` WebSocket.
pub struct PaneState {
    pub info: PaneInfo,
    pub parser: vt100::Parser,
    pub connected: bool,
    pub exit_code: Option<i64>,
    pub bytes: u64,
}

impl PaneState {
    fn new(info: PaneInfo) -> Self {
        let parser = vt100::Parser::new(info.rows.max(1), info.cols.max(1), 1000);
        Self {
            info,
            parser,
            connected: false,
            exit_code: None,
            bytes: 0,
        }
    }

    /// (cols, rows) of the screen model.
    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols, rows)
    }

    pub fn alive(&self) -> bool {
        self.info.alive && self.exit_code.is_none()
    }
}

/// A `POST` the Ink `commands.ts` would send; `route()` / `body()` are exactly its URL and JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Clarify {
        task_id: String,
        question_id: String,
        answer: String,
    },
    MissionClarify {
        mission_id: String,
        question_id: String,
        answer: String,
    },
    Review {
        task_id: String,
        criterion_id: String,
        status: &'static str,
        observed_failure: Option<String>,
    },
    Reply {
        task_id: String,
        message: String,
    },
    Cancel {
        task_id: String,
    },
}

impl Command {
    pub fn route(&self) -> String {
        match self {
            Command::Clarify { task_id, .. } => format!("/tasks/{task_id}/clarify"),
            Command::MissionClarify { mission_id, .. } => format!("/missions/{mission_id}/clarify"),
            Command::Review { task_id, .. } => format!("/tasks/{task_id}/review"),
            Command::Reply { task_id, .. } => format!("/tasks/{task_id}/reply"),
            Command::Cancel { task_id } => format!("/tasks/{task_id}/cancel"),
        }
    }

    pub fn body(&self) -> serde_json::Value {
        match self {
            Command::Clarify {
                question_id,
                answer,
                ..
            }
            | Command::MissionClarify {
                question_id,
                answer,
                ..
            } => serde_json::to_value(ClarifyBody {
                answers: vec![ClarifyAnswer {
                    question_id: question_id.clone(),
                    answer: answer.clone(),
                }],
            })
            .unwrap(),
            Command::Review {
                criterion_id,
                status,
                observed_failure,
                ..
            } => serde_json::to_value(ReviewBody {
                criterion_id: criterion_id.clone(),
                status: (*status).to_string(),
                observed_failure: observed_failure.clone(),
            })
            .unwrap(),
            Command::Reply { message, .. } => serde_json::to_value(ReplyBody {
                message: message.clone(),
            })
            .unwrap(),
            Command::Cancel { .. } => serde_json::to_value(CancelBody::default()).unwrap(),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Command::Clarify { task_id, .. } => format!("answer sent to {task_id}"),
            Command::MissionClarify { mission_id, .. } => format!("answer sent for {mission_id}"),
            Command::Review {
                task_id,
                criterion_id,
                status,
                ..
            } => format!("{criterion_id} marked {status} on {task_id}"),
            Command::Reply { task_id, .. } => format!("reply sent to {task_id}"),
            Command::Cancel { task_id } => format!("cancel requested for {task_id}"),
        }
    }
}

/// Side effects the runtime performs; `App` itself never touches the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Load describe + story tail + actions for the inspector.
    FetchInspector(GraphObjectRef),
    /// Load the actions of the newly selected object (drives the inbox strip / status hints).
    FetchActions(GraphObjectRef),
    Post(Command),
    /// Raw bytes for the focused pane (`{ t: "input", data: base64 }`).
    PaneInput {
        pane_id: String,
        data: Vec<u8>,
    },
    /// The focused pane's widget changed size (`{ t: "resize", cols, rows }`).
    PaneResize {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    /// `POST /panes/:id/focus`.
    FocusPane(String),
    /// Grab the mouse for the app, or hand it back to the terminal so the user can select text.
    SetMouseCapture(bool),
    /// `POST /panes/:id/kill` — end the process in a pane.
    KillPane(String),
    /// Open a shell pane beside the agents. The runtime fills in the shell and the repo, since `App`
    /// knows neither the environment nor the filesystem.
    NewShellPane,
    Quit,
}

pub struct App {
    pub mode: Mode,
    pub graph: Graph,
    pub state: State,
    /// Pane ids in `/panes` order.
    pub panes: Vec<String>,
    pub pane_states: BTreeMap<String, PaneState>,
    pub focused_pane: Option<String>,
    pub metrics: Option<HostMetrics>,
    pub region: Region,
    pub selected: Option<GraphObjectRef>,
    /// Actions of the selected node / edge (inbox items carry their own).
    pub actions: Vec<ObjectAction>,
    /// `i` in the pane grid: keys go to the focused pane until Esc.
    pub terminal_input: bool,
    pub inspector_open: bool,
    pub inspector: Inspector,
    pub input_mode: Option<InputMode>,
    pub input_value: String,
    pending_action: Option<ObjectAction>,
    pub help_open: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub connection: Connection,
    pub last_seq: u64,
    pub frames: FrameStats,
    /// (cols, rows) each pane widget was last drawn with; filled by `ui::panes`.
    pub pane_areas: BTreeMap<String, (u16, u16)>,
    /// Where each panel was last drawn, and what its rows mean — filled during render, read to turn a
    /// click into the object under it. `App` stays terminal-free: these are plain rectangles.
    pub graph_viewport: Viewport,
    pub tree_viewport: Viewport,
    /// The object on each row of the mission tree, top to bottom (`None` for headers and detail rows).
    pub tree_rows: Vec<Option<GraphObjectRef>>,
    pub inbox_viewport: Viewport,
    pub inbox_rows: Vec<Option<GraphObjectRef>>,
    /// Where each pane's widget was drawn, so a click can find the pane under it.
    pub pane_rects: BTreeMap<String, Viewport>,
    pub graph_view: GraphView,
    /// True while the app holds the mouse; `m` hands it back so the terminal can select text.
    pub mouse_capture: bool,
    /// Where a background drag started, in cells.
    graph_drag: Option<(u16, u16)>,
    /// Pane the user is being asked about before it is closed.
    pending_pane_close: Option<String>,
    /// Panes the user has closed. relayd keeps a killed pane in `/panes` — the record and its cast
    /// outlive the process — so the grid has to remember what was dismissed or a closed pane comes
    /// straight back on the next poll, looking as though `X` did nothing.
    dismissed_panes: std::collections::BTreeSet<String>,
    pub tick: u64,
}

fn same_task(graph: &Graph, r: &GraphObjectRef, task_id: &str) -> bool {
    graph.task_of(r) == Some(task_id)
}

impl App {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            graph: Graph::default(),
            state: State::default(),
            panes: Vec::new(),
            pane_states: BTreeMap::new(),
            focused_pane: None,
            metrics: None,
            region: Region::Tree,
            selected: None,
            actions: Vec::new(),
            terminal_input: false,
            inspector_open: false,
            inspector: Inspector::default(),
            input_mode: None,
            input_value: String::new(),
            pending_action: None,
            help_open: false,
            error: None,
            notice: None,
            connection: match mode {
                Mode::Live => Connection::Connecting,
                Mode::Replay => Connection::Replay,
            },
            last_seq: 0,
            frames: FrameStats::default(),
            pane_areas: BTreeMap::new(),
            graph_viewport: Viewport::EMPTY,
            tree_viewport: Viewport::EMPTY,
            tree_rows: Vec::new(),
            inbox_viewport: Viewport::EMPTY,
            inbox_rows: Vec::new(),
            pane_rects: BTreeMap::new(),
            graph_view: GraphView::default(),
            mouse_capture: true,
            graph_drag: None,
            pending_pane_close: None,
            dismissed_panes: std::collections::BTreeSet::new(),
            tick: 0,
        }
    }

    // --- data in -----------------------------------------------------------------------------------

    /// Port of `refsForRegion` (`App.tsx`): the objects j/k walk in each panel.
    pub fn refs_for_region(&self, region: Region) -> Vec<GraphObjectRef> {
        match region {
            Region::Tree => self
                .graph
                .nodes
                .iter()
                .filter(|n| n.kind == GraphNodeKind::Agent)
                .map(|n| GraphObjectRef::node(n.id.clone()))
                .collect(),
            Region::Graph => self
                .graph
                .nodes
                .iter()
                // Only what the network actually draws, so j/k never lands on an invisible node.
                .filter(|n| crate::ui::graph::is_visible(n, self.planner_present()))
                .map(|n| GraphObjectRef::node(n.id.clone()))
                .chain(
                    self.unattached_agents()
                        .into_iter()
                        .map(|n| GraphObjectRef::node(n.id)),
                )
                .chain(
                    self.graph
                        .edges
                        .iter()
                        .map(|e| GraphObjectRef::edge(e.id.clone())),
                )
                .collect(),
            Region::Inbox => self
                .graph
                .inbox
                .iter()
                .map(|i| GraphObjectRef::inbox(i.id.clone()))
                .collect(),
            Region::Panes => self
                .panes
                .iter()
                .filter_map(|p| self.pane_states.get(p))
                .filter_map(|p| p.info.task_id.clone())
                .filter(|t| self.graph.node(t).is_some())
                .map(GraphObjectRef::node)
                .collect(),
        }
    }

    fn initial_ref(&self) -> Option<GraphObjectRef> {
        self.refs_for_region(Region::Tree)
            .into_iter()
            .next()
            .or_else(|| self.refs_for_region(Region::Graph).into_iter().next())
            .or_else(|| self.refs_for_region(Region::Inbox).into_iter().next())
    }

    /// New graph from `/graph`: keeps the selection when the object still exists, else falls back like the
    /// Ink app; returns the fetches a changed selection needs.
    pub fn set_graph(&mut self, graph: Graph) -> Vec<Effect> {
        self.graph = graph;
        if let Some(seq) = self.graph.seq {
            self.last_seq = self.last_seq.max(seq);
        }
        let mut effects = Vec::new();
        let keep = self
            .selected
            .as_ref()
            .map(|r| self.graph.contains(r))
            .unwrap_or(false);
        if !keep {
            let next = self.initial_ref();
            effects.extend(self.select(next));
        }
        if self.inspector_open {
            if let Some(r) = self.inspector.reference.clone() {
                if self.graph.contains(&r) {
                    effects.push(Effect::FetchInspector(r));
                } else {
                    self.inspector_open = false;
                }
            }
        }
        effects
    }

    pub fn set_state(&mut self, state: State) {
        self.last_seq = self.last_seq.max(state.last_seq);
        self.state = state;
    }

    /// New `/panes` listing: new panes get a screen model sized like the PTY; known ones keep theirs.
    pub fn set_panes(&mut self, panes: Vec<PaneInfo>, focused: Option<String>) -> Vec<Effect> {
        // Forget dismissals for panes the daemon no longer lists, so the set cannot grow forever.
        let listed: std::collections::BTreeSet<String> =
            panes.iter().map(|p| p.pane_id.clone()).collect();
        self.dismissed_panes.retain(|id| listed.contains(id));
        let panes: Vec<PaneInfo> = panes
            .into_iter()
            .filter(|p| !self.dismissed_panes.contains(&p.pane_id))
            .collect();
        self.pane_states
            .retain(|id, _| !self.dismissed_panes.contains(id));

        self.panes = panes.iter().map(|p| p.pane_id.clone()).collect();
        for info in panes {
            match self.pane_states.get_mut(&info.pane_id) {
                Some(existing) => {
                    if info.exit_code.is_some() {
                        existing.exit_code = info.exit_code;
                    }
                    existing.info = info;
                }
                None => {
                    self.pane_states
                        .insert(info.pane_id.clone(), PaneState::new(info));
                }
            }
        }
        let focus_valid = self
            .focused_pane
            .as_ref()
            .map(|p| self.panes.contains(p))
            .unwrap_or(false);
        if !focus_valid {
            self.focused_pane = focused
                .filter(|f| self.panes.contains(f))
                .or_else(|| self.first_alive_pane())
                .or_else(|| self.panes.first().cloned());
        }
        Vec::new()
    }

    fn first_alive_pane(&self) -> Option<String> {
        self.panes
            .iter()
            .find(|p| self.pane_states.get(*p).map(|s| s.alive()).unwrap_or(false))
            .cloned()
    }

    pub fn set_metrics(&mut self, metrics: HostMetrics) {
        self.metrics = Some(metrics);
    }

    /// A frame from `/pty/:id`.
    pub fn apply_pane_frame(&mut self, pane_id: &str, frame: PtyServerMessage) {
        let Some(pane) = self.pane_states.get_mut(pane_id) else {
            return;
        };
        match frame {
            PtyServerMessage::Hello { pane: info } => {
                pane.connected = true;
                pane.info = *info;
            }
            PtyServerMessage::Scrollback { data } | PtyServerMessage::Output { data } => {
                if let Ok(bytes) = BASE64.decode(data.as_bytes()) {
                    pane.bytes += bytes.len() as u64;
                    pane.parser.process(&bytes);
                }
            }
            PtyServerMessage::Exit { code } => {
                pane.exit_code = Some(code);
                pane.info.alive = false;
                if self.terminal_input && self.focused_pane.as_deref() == Some(pane_id) {
                    self.terminal_input = false;
                }
            }
            PtyServerMessage::Pong => {}
        }
    }

    pub fn set_pane_connected(&mut self, pane_id: &str, connected: bool) {
        if let Some(pane) = self.pane_states.get_mut(pane_id) {
            pane.connected = connected;
        }
    }

    pub fn set_inspector(
        &mut self,
        reference: GraphObjectRef,
        description: ObjectDescription,
        story: Vec<String>,
        actions: Vec<ObjectAction>,
    ) {
        if self.inspector.reference.as_ref() != Some(&reference) && self.inspector_open {
            // A stale response for an object we already left.
            if self.inspector.loaded {
                return;
            }
        }
        self.inspector = Inspector {
            reference: Some(reference),
            description,
            story,
            actions,
            loaded: true,
        };
    }

    pub fn set_actions(&mut self, reference: &GraphObjectRef, actions: Vec<ObjectAction>) {
        if self.selected.as_ref() == Some(reference) {
            self.actions = actions;
        }
    }

    pub fn set_error(&mut self, error: impl Into<String>) {
        self.error = Some(error.into());
    }

    pub fn set_notice(&mut self, notice: impl Into<String>) {
        self.notice = Some(notice.into());
    }

    pub fn set_connection(&mut self, connection: Connection) {
        self.connection = connection;
    }

    pub fn note_event(&mut self, seq: u64) {
        self.last_seq = self.last_seq.max(seq);
    }

    // --- queries -----------------------------------------------------------------------------------

    pub fn task_view(&self, task_id: &str) -> Option<&TaskView> {
        self.state.tasks.get(task_id)
    }

    pub fn pane_for_task(&self, task_id: &str) -> Option<String> {
        // Prefer the alive pane (a resumed session gets a new pane id, e.g. relay:3 after relay:1).
        let mut candidates = self
            .panes
            .iter()
            .filter_map(|p| self.pane_states.get(p))
            .filter(|p| p.info.task_id.as_deref() == Some(task_id));
        let first = candidates.next()?;
        let alive = std::iter::once(first)
            .chain(candidates)
            .find(|p| p.alive())
            .unwrap_or(first);
        Some(alive.info.pane_id.clone())
    }

    pub fn focused_pane_state(&self) -> Option<&PaneState> {
        self.focused_pane
            .as_ref()
            .and_then(|p| self.pane_states.get(p))
    }

    /// Actions that apply to the selection: the inbox item's own, else the fetched ones.
    pub fn current_actions(&self) -> &[ObjectAction] {
        match &self.selected {
            Some(r) if r.kind == RefKind::Inbox => self
                .graph
                .inbox_item(&r.id)
                .map(|i| i.actions.as_slice())
                .unwrap_or(&[]),
            _ => &self.actions,
        }
    }

    /// The Ink footer: `a answer · r reply · p pass · f fail · x cancel` for the current actions.
    pub fn action_hints(&self) -> String {
        let mut parts = Vec::new();
        for action in self.current_actions() {
            let label = match action.kind {
                ActionKind::Clarify | ActionKind::MissionClarify => "answer",
                ActionKind::Reply => "reply",
                ActionKind::Review if action.key == "p" => "pass",
                ActionKind::Review => "fail",
                ActionKind::Cancel => "cancel",
                ActionKind::Focus => "focus",
                ActionKind::Inspect => continue,
            };
            let key = if action.kind == ActionKind::Focus {
                "f".to_string()
            } else {
                action.key.clone()
            };
            parts.push(format!("{key} {label}"));
        }
        parts.join(" · ")
    }

    pub fn prompt_line(&self) -> Option<String> {
        match self.input_mode? {
            InputMode::Answer => Some(format!("answer> {}", self.input_value)),
            InputMode::Reply => Some(format!("reply> {}", self.input_value)),
            InputMode::ReviewFailure => Some(format!("observed failure> {}", self.input_value)),
            InputMode::CancelConfirm => Some("cancel task? y/N".to_string()),
            // Naming what is about to die, and what survives it: killing an agent's terminal does not
            // end its task, which then waits for an agent that is gone.
            InputMode::ClosePaneConfirm => {
                let pane_id = self.pending_pane_close.clone().unwrap_or_default();
                Some(
                    match self.pane_states.get(&pane_id).map(|p| p.info.clone()) {
                        Some(info) if info.task_id.is_some() => format!(
                            "close {}'s terminal ({pane_id})? its task keeps waiting for it  y/N",
                            info.role
                        ),
                        Some(info) => format!("close the {} pane ({pane_id})?  y/N", info.role),
                        None => format!("close {pane_id}?  y/N"),
                    },
                )
            }
        }
    }

    // --- selection ---------------------------------------------------------------------------------

    /// Select an object (fetching its actions when it is a node or an edge).
    pub fn select(&mut self, reference: Option<GraphObjectRef>) -> Vec<Effect> {
        if self.selected == reference {
            return Vec::new();
        }
        self.selected = reference.clone();
        self.actions.clear();
        match reference {
            Some(r) if r.kind != RefKind::Inbox => vec![Effect::FetchActions(r)],
            _ => Vec::new(),
        }
    }

    fn move_selection(&mut self, delta: i32) -> Vec<Effect> {
        if self.region == Region::Panes {
            return self.move_pane_focus(delta);
        }
        let refs = self.refs_for_region(self.region);
        if refs.is_empty() {
            return Vec::new();
        }
        let current = refs.iter().position(|r| Some(r) == self.selected.as_ref());
        let next = match current {
            None => 0,
            Some(i) => (i as i32 + delta).clamp(0, refs.len() as i32 - 1) as usize,
        };
        self.select(Some(refs[next].clone()))
    }

    fn move_pane_focus(&mut self, delta: i32) -> Vec<Effect> {
        if self.panes.is_empty() {
            return Vec::new();
        }
        let current = self
            .focused_pane
            .as_ref()
            .and_then(|p| self.panes.iter().position(|x| x == p));
        let next = match current {
            None => 0,
            Some(i) => (i as i32 + delta).clamp(0, self.panes.len() as i32 - 1) as usize,
        };
        let pane = self.panes[next].clone();
        self.focus_pane(pane, false)
    }

    fn cycle_region(&mut self) -> Vec<Effect> {
        let index = REGIONS.iter().position(|r| *r == self.region).unwrap_or(0);
        let next = REGIONS[(index + 1) % REGIONS.len()];
        self.region = next;
        if next == Region::Panes {
            if let Some(p) = self.focused_pane.clone() {
                return self.focus_pane(p, false);
            }
            return Vec::new();
        }
        let first = self.refs_for_region(next).into_iter().next();
        match first {
            Some(r) => self.select(Some(r)),
            None => Vec::new(),
        }
    }

    /// Make `pane_id` the large pane; `post` also tells relayd (`POST /panes/:id/focus`).
    pub fn focus_pane(&mut self, pane_id: String, post: bool) -> Vec<Effect> {
        if !self.panes.contains(&pane_id) {
            return Vec::new();
        }
        let mut effects = Vec::new();
        if self.focused_pane.as_ref() != Some(&pane_id) {
            self.focused_pane = Some(pane_id.clone());
            self.terminal_input = false;
        }
        if post {
            effects.push(Effect::FocusPane(pane_id.clone()));
        }
        let task_node = self
            .pane_states
            .get(&pane_id)
            .and_then(|p| p.info.task_id.clone())
            .filter(|t| self.graph.node(t).is_some())
            .map(GraphObjectRef::node);
        if let Some(r) = task_node {
            effects.extend(self.select(Some(r)));
        }
        effects
    }

    fn open_inspector(&mut self, reference: Option<GraphObjectRef>) -> Vec<Effect> {
        let Some(reference) = reference else {
            return Vec::new();
        };
        if !self.graph.contains(&reference) {
            return Vec::new();
        }
        self.inspector_open = true;
        if self.inspector.reference.as_ref() != Some(&reference) {
            self.inspector = Inspector {
                reference: Some(reference.clone()),
                ..Inspector::default()
            };
        }
        vec![Effect::FetchInspector(reference)]
    }

    pub fn close_inspector(&mut self) {
        self.inspector_open = false;
        self.reset_input();
    }

    fn reset_input(&mut self) {
        self.input_mode = None;
        self.input_value.clear();
        self.pending_action = None;
        self.pending_pane_close = None;
    }

    fn begin_input(&mut self, action: ObjectAction, mode: InputMode) -> Vec<Effect> {
        self.input_value.clear();
        self.input_mode = Some(mode);
        self.pending_action = Some(action);
        self.error = None;
        // The inline editor lives in the inspector, like the Ink overlay tabs.
        let target = self.selected.clone();
        self.open_inspector(target)
    }

    fn selected_task_id(&self) -> Option<String> {
        let r = self.selected.as_ref()?;
        self.graph.task_of(r).map(str::to_string)
    }

    fn find_action(&self, key: char) -> Option<ObjectAction> {
        let actions = self.current_actions();
        let by_key = actions.iter().find(|a| a.key == key.to_string()).cloned();
        if by_key.is_some() {
            return by_key;
        }
        // Contract aliases on top of the server-assigned keys.
        let alias = |kind: ActionKind, key: Option<&str>| {
            actions
                .iter()
                .find(|a| a.kind == kind && key.is_none_or(|k| a.key == k))
                .cloned()
        };
        match key {
            'c' => {
                alias(ActionKind::Clarify, None).or_else(|| alias(ActionKind::MissionClarify, None))
            }
            'y' => alias(ActionKind::Review, Some("p")),
            'n' => alias(ActionKind::Review, Some("f")),
            _ => None,
        }
    }

    // --- keys --------------------------------------------------------------------------------------

    /// Port of `useInput` in `keys.ts`, plus the pane grid.
    pub fn handle_key(&mut self, key: Key) -> Vec<Effect> {
        if self.terminal_input {
            if key.code == KeyCode::Esc && !key.ctrl && !key.alt {
                self.terminal_input = false;
                return Vec::new();
            }
            return match self.focused_pane.clone() {
                Some(pane_id) => vec![Effect::PaneInput {
                    pane_id,
                    data: key.encode(),
                }],
                None => {
                    self.terminal_input = false;
                    Vec::new()
                }
            };
        }
        if key.is_ctrl_c() {
            return vec![Effect::Quit];
        }

        if self.input_mode == Some(InputMode::ClosePaneConfirm) {
            let answer = key.plain_char().map(|c| c.to_ascii_lowercase());
            let mut effects = Vec::new();
            if answer == Some('y') {
                if let Some(pane_id) = self.pending_pane_close.clone() {
                    let alive = self
                        .pane_states
                        .get(&pane_id)
                        .map(|p| p.alive())
                        .unwrap_or(false);
                    if alive {
                        effects.push(Effect::KillPane(pane_id));
                    } else {
                        // Nothing to kill; the pane is only a record now.
                        self.dismiss_pane(&pane_id);
                    }
                }
            }
            if answer == Some('y') || answer == Some('n') || key.code == KeyCode::Esc {
                self.reset_input();
            }
            return effects;
        }

        if self.input_mode == Some(InputMode::CancelConfirm) {
            let answer = key.plain_char().map(|c| c.to_ascii_lowercase());
            let mut effects = Vec::new();
            if answer == Some('y') {
                if let Some(task_id) = self
                    .pending_action
                    .as_ref()
                    .filter(|a| a.kind == ActionKind::Cancel)
                    .and_then(|a| a.target.task_id.clone())
                {
                    effects.push(Effect::Post(Command::Cancel { task_id }));
                }
            }
            if answer == Some('y') || answer == Some('n') || key.code == KeyCode::Esc {
                self.reset_input();
            }
            return effects;
        }

        if let Some(mode) = self.input_mode {
            match key.code {
                KeyCode::Esc => {
                    self.reset_input();
                    return Vec::new();
                }
                KeyCode::Enter => {
                    let value = self.input_value.trim().to_string();
                    let Some(action) = self.pending_action.clone() else {
                        self.reset_input();
                        return Vec::new();
                    };
                    if value.is_empty() {
                        return Vec::new();
                    }
                    let command = submit_command(&action, mode, value);
                    self.reset_input();
                    return command.map(|c| vec![Effect::Post(c)]).unwrap_or_default();
                }
                KeyCode::Backspace | KeyCode::Delete => {
                    self.input_value.pop();
                }
                KeyCode::Char(c) if !key.ctrl && !key.alt => self.input_value.push(c),
                _ => {}
            }
            return Vec::new();
        }

        if key.code == KeyCode::Esc {
            if self.help_open {
                self.help_open = false;
            } else if self.inspector_open {
                self.close_inspector();
            }
            return Vec::new();
        }

        let ch = key.plain_char();
        if let Some(c) = ch {
            if let Some(action) = self.find_action(c) {
                match action.kind {
                    ActionKind::Clarify | ActionKind::MissionClarify => {
                        return self.begin_input(action, InputMode::Answer);
                    }
                    ActionKind::Reply => return self.begin_input(action, InputMode::Reply),
                    ActionKind::Review if action.key == "f" => {
                        return self.begin_input(action, InputMode::ReviewFailure);
                    }
                    ActionKind::Review if action.key == "p" => {
                        if let (Some(task_id), Some(criterion_id)) = (
                            action.target.task_id.clone(),
                            action.target.criterion_id.clone(),
                        ) {
                            self.error = None;
                            return vec![Effect::Post(Command::Review {
                                task_id,
                                criterion_id,
                                status: "passed",
                                observed_failure: None,
                            })];
                        }
                        return Vec::new();
                    }
                    ActionKind::Cancel if c == 'x' => {
                        return self.begin_input(action, InputMode::CancelConfirm);
                    }
                    _ => {}
                }
            }
        }

        match (key.code, ch) {
            (KeyCode::Enter, _) => {
                if self.region == Region::Panes {
                    let target = self
                        .focused_pane_state()
                        .and_then(|p| p.info.task_id.clone())
                        .map(GraphObjectRef::node)
                        .or_else(|| self.selected.clone());
                    return self.open_inspector(target);
                }
                if let Some(r) = self.selected.clone() {
                    if r.kind == RefKind::Inbox {
                        let target = self.graph.inbox_item(&r.id).map(|i| i.reference.clone());
                        let mut effects = Vec::new();
                        if let Some(t) = target.clone() {
                            self.region = region_for_ref(&self.graph, &t);
                            effects.extend(self.select(Some(t)));
                        }
                        effects.extend(self.open_inspector(target));
                        return effects;
                    }
                    return self.open_inspector(Some(r));
                }
                Vec::new()
            }
            (_, Some('i')) => {
                if self.region == Region::Panes {
                    if self
                        .focused_pane_state()
                        .map(|p| p.alive())
                        .unwrap_or(false)
                    {
                        self.terminal_input = true;
                    } else {
                        self.set_notice("no live pane to type into");
                    }
                    return Vec::new();
                }
                let target = self.selected.clone();
                self.open_inspector(target)
            }
            (_, Some('f')) => {
                let pane = self
                    .selected_task_id()
                    .and_then(|t| self.pane_for_task(&t))
                    .or_else(|| {
                        if self.region == Region::Panes {
                            self.focused_pane.clone()
                        } else {
                            None
                        }
                    });
                match pane {
                    Some(p) => {
                        self.region = Region::Panes;
                        self.focus_pane(p, true)
                    }
                    None => {
                        self.set_notice("no pane for the selected object");
                        Vec::new()
                    }
                }
            }
            (KeyCode::Tab, _) | (KeyCode::BackTab, _) => self.cycle_region(),
            // In the graph the arrows pan the network; j/k still walk the objects.
            (KeyCode::Left, _) if self.region == Region::Graph => {
                self.graph_view.pan_by(-8.0, 0.0);
                Vec::new()
            }
            (KeyCode::Right, _) if self.region == Region::Graph => {
                self.graph_view.pan_by(8.0, 0.0);
                Vec::new()
            }
            (KeyCode::Up, _) if self.region == Region::Graph => {
                self.graph_view.pan_by(0.0, 8.0);
                Vec::new()
            }
            (KeyCode::Down, _) if self.region == Region::Graph => {
                self.graph_view.pan_by(0.0, -8.0);
                Vec::new()
            }
            (_, Some('+')) | (_, Some('=')) => {
                self.graph_view.zoom_by(1.25);
                Vec::new()
            }
            (_, Some('-')) | (_, Some('_')) => {
                self.graph_view.zoom_by(1.0 / 1.25);
                Vec::new()
            }
            (_, Some('0')) => {
                self.graph_view = GraphView::default();
                Vec::new()
            }
            (_, Some('X')) => {
                match self.focused_pane.clone() {
                    Some(pane_id) => {
                        self.error = None;
                        self.pending_pane_close = Some(pane_id);
                        self.input_mode = Some(InputMode::ClosePaneConfirm);
                    }
                    None => self.set_notice("no pane to close"),
                }
                Vec::new()
            }
            (_, Some('t')) => {
                self.set_notice("opening a shell pane…");
                vec![Effect::NewShellPane]
            }
            (_, Some('m')) => {
                self.mouse_capture = !self.mouse_capture;
                self.graph_drag = None;
                self.set_notice(if self.mouse_capture {
                    "mouse: the app has it (m releases it to the terminal)"
                } else {
                    "mouse: the terminal has it — select text as usual (m takes it back)"
                });
                vec![Effect::SetMouseCapture(self.mouse_capture)]
            }
            (KeyCode::Down, _) | (_, Some('j')) => self.move_selection(1),
            (KeyCode::Up, _) | (_, Some('k')) => self.move_selection(-1),
            (_, Some('?')) => {
                self.help_open = !self.help_open;
                Vec::new()
            }
            (_, Some('q')) => vec![Effect::Quit],
            _ => Vec::new(),
        }
    }

    // --- the graph's own input ---------------------------------------------------------------------

    /// A click, drag or wheel anywhere in the app. The panel under the pointer decides what it means;
    /// what no panel claims is left alone, so the terminal keeps everything the app does not use.
    pub fn handle_mouse(&mut self, mouse: Mouse) -> Vec<Effect> {
        if !self.mouse_capture || self.help_open || self.inspector_open || self.input_mode.is_some()
        {
            return Vec::new();
        }
        if self.tree_viewport.contains(mouse.col, mouse.row) {
            return self.mouse_in_rows(mouse, Region::Tree);
        }
        if self.inbox_viewport.contains(mouse.col, mouse.row) {
            return self.mouse_in_rows(mouse, Region::Inbox);
        }
        if let Some(pane_id) = self.pane_at(mouse.col, mouse.row) {
            return self.mouse_in_pane(mouse, pane_id);
        }
        if !self.graph_viewport.contains(mouse.col, mouse.row) {
            // A press elsewhere ends a drag that started on the canvas; nothing else.
            if mouse.kind == MouseKind::Up {
                self.graph_drag = None;
            }
            return Vec::new();
        }
        match mouse.kind {
            MouseKind::Down => {
                self.region = Region::Graph;
                let hit = self.hit_at(mouse.col, mouse.row);
                match hit {
                    // A press on an object selects it; a press on the background begins a pan.
                    Some(reference) => {
                        self.graph_drag = None;
                        self.select(Some(reference))
                    }
                    None => {
                        self.graph_drag = Some((mouse.col, mouse.row));
                        Vec::new()
                    }
                }
            }
            MouseKind::Drag => {
                let Some((from_col, from_row)) = self.graph_drag else {
                    return Vec::new();
                };
                let cells_x = mouse.col as f64 - from_col as f64;
                let cells_y = mouse.row as f64 - from_row as f64;
                let (world_x, world_y) = self.world_per_cell();
                // Drag moves the world with the pointer, so the view moves the other way.
                self.graph_view
                    .pan_by(-cells_x * world_x, cells_y * world_y);
                self.graph_drag = Some((mouse.col, mouse.row));
                Vec::new()
            }
            MouseKind::Up => {
                self.graph_drag = None;
                Vec::new()
            }
            MouseKind::ScrollUp => {
                self.graph_view.zoom_by(1.2);
                Vec::new()
            }
            MouseKind::ScrollDown => {
                self.graph_view.zoom_by(1.0 / 1.2);
                Vec::new()
            }
        }
    }

    /// A list panel: a click selects the row's object, the wheel walks the selection.
    fn mouse_in_rows(&mut self, mouse: Mouse, region: Region) -> Vec<Effect> {
        let (viewport, rows) = match region {
            Region::Inbox => (self.inbox_viewport, &self.inbox_rows),
            _ => (self.tree_viewport, &self.tree_rows),
        };
        match mouse.kind {
            MouseKind::Down => {
                let index = (mouse.row - viewport.y) as usize;
                // Rows that carry nothing (headers, an agent's detail line) still move focus to the
                // panel: the click was deliberate even when it did not land on an object.
                let target = rows.get(index).cloned().flatten();
                self.region = region;
                match target {
                    Some(reference) => self.select(Some(reference)),
                    None => Vec::new(),
                }
            }
            MouseKind::ScrollUp => {
                self.region = region;
                self.move_selection(-1)
            }
            MouseKind::ScrollDown => {
                self.region = region;
                self.move_selection(1)
            }
            _ => Vec::new(),
        }
    }

    /// The pane grid: a click focuses a pane, and a click into the pane that already has focus starts
    /// typing into it — the way clicking into a text field does.
    fn mouse_in_pane(&mut self, mouse: Mouse, pane_id: String) -> Vec<Effect> {
        if mouse.kind != MouseKind::Down {
            return Vec::new();
        }
        self.region = Region::Panes;
        if self.focused_pane.as_deref() == Some(pane_id.as_str()) {
            if self
                .focused_pane_state()
                .map(|p| p.alive())
                .unwrap_or(false)
            {
                self.terminal_input = true;
            } else {
                self.set_notice("that pane's process has exited");
            }
            return Vec::new();
        }
        self.focus_pane(pane_id, true)
    }

    /// Which pane was drawn under a cell.
    fn pane_at(&self, col: u16, row: u16) -> Option<String> {
        self.pane_rects
            .iter()
            .find(|(_, rect)| rect.contains(col, row))
            .map(|(id, _)| id.clone())
    }

    /// Take a closed pane out of the grid. The daemon keeps it — the recording is worth more than the
    /// row it occupied — but this view is done with it.
    pub fn dismiss_pane(&mut self, pane_id: &str) {
        self.dismissed_panes.insert(pane_id.to_string());
        self.panes.retain(|id| id != pane_id);
        self.pane_states.remove(pane_id);
        self.pane_rects.remove(pane_id);
        if self.focused_pane.as_deref() == Some(pane_id) {
            self.terminal_input = false;
            self.focused_pane = self
                .first_alive_pane()
                .or_else(|| self.panes.first().cloned());
        }
        self.set_notice(format!("closed {pane_id}"));
    }

    /// Focus a pane and put the keyboard straight into it — what `t` wants: a terminal you can type in.
    pub fn open_pane_for_typing(&mut self, pane_id: String) -> Vec<Effect> {
        let effects = self.focus_pane(pane_id, true);
        self.region = Region::Panes;
        if self
            .focused_pane_state()
            .map(|p| p.alive())
            .unwrap_or(false)
        {
            self.terminal_input = true;
        }
        effects
    }

    /// World units covered by one cell, horizontally and vertically, at the current view.
    fn world_per_cell(&self) -> (f64, f64) {
        let (x_bounds, y_bounds) =
            crate::ui::graph::view_bounds(&self.graph_view, self.graph_viewport);
        (
            (x_bounds[1] - x_bounds[0]) / self.graph_viewport.width.max(1) as f64,
            (y_bounds[1] - y_bounds[0]) / self.graph_viewport.height.max(1) as f64,
        )
    }

    /// Is a planner agent actually there? The graph always has the node; a pane is what says someone
    /// is doing the job.
    pub fn planner_present(&self) -> bool {
        self.pane_states.values().any(|p| p.info.role == "planner")
    }

    /// Agents relayd is hosting that no contract accounts for; they are on the network too.
    pub fn unattached_agents(&self) -> Vec<GraphNode> {
        crate::ui::graph::unattached_agents(&self.graph, self.pane_states.values().map(|p| &p.info))
    }

    /// The object drawn under a cell, if any.
    pub fn hit_at(&self, col: u16, row: u16) -> Option<GraphObjectRef> {
        let point =
            crate::ui::graph::cell_to_world(&self.graph_view, self.graph_viewport, col, row);
        let discs = crate::ui::graph::layout_net(
            &self.graph,
            &self.unattached_agents(),
            self.planner_present(),
        );
        crate::ui::graph::hit_test(&self.graph, &discs, point)
    }

    // --- pane sizing -------------------------------------------------------------------------------

    /// After a draw: if the focused pane's widget changed size, resize its screen model and tell relayd.
    pub fn sync_pane_sizes(&mut self) -> Vec<Effect> {
        let Some(pane_id) = self.focused_pane.clone() else {
            return Vec::new();
        };
        let Some(&(cols, rows)) = self.pane_areas.get(&pane_id) else {
            return Vec::new();
        };
        if cols == 0 || rows == 0 {
            return Vec::new();
        }
        let Some(pane) = self.pane_states.get_mut(&pane_id) else {
            return Vec::new();
        };
        if pane.size() == (cols, rows) {
            return Vec::new();
        }
        pane.parser.screen_mut().set_size(rows, cols);
        vec![Effect::PaneResize {
            pane_id,
            cols,
            rows,
        }]
    }
}

fn submit_command(action: &ObjectAction, mode: InputMode, value: String) -> Option<Command> {
    let question_id = action
        .target
        .question_ids
        .as_ref()
        .and_then(|q| q.first().cloned());
    match (action.kind, mode) {
        (ActionKind::Clarify, InputMode::Answer) => Some(Command::Clarify {
            task_id: action.target.task_id.clone()?,
            question_id: question_id?,
            answer: value,
        }),
        (ActionKind::MissionClarify, InputMode::Answer) => Some(Command::MissionClarify {
            mission_id: action.target.mission_id.clone()?,
            question_id: question_id?,
            answer: value,
        }),
        (ActionKind::Reply, InputMode::Reply) => Some(Command::Reply {
            task_id: action.target.task_id.clone()?,
            message: value,
        }),
        (ActionKind::Review, InputMode::ReviewFailure) => Some(Command::Review {
            task_id: action.target.task_id.clone()?,
            criterion_id: action.target.criterion_id.clone()?,
            status: "failed",
            observed_failure: Some(value),
        }),
        _ => None,
    }
}

/// Port of `regionForRef`: where an object lives, so Enter on an inbox item moves focus with it.
pub fn region_for_ref(graph: &Graph, r: &GraphObjectRef) -> Region {
    match r.kind {
        RefKind::Inbox => Region::Inbox,
        RefKind::Edge => Region::Graph,
        RefKind::Node => match graph.node(&r.id) {
            Some(n) if n.kind == GraphNodeKind::Agent => Region::Tree,
            _ => Region::Graph,
        },
    }
}

/// Does the pane's task match the selection (used by the pane grid to highlight the selected task's pane)?
pub fn pane_matches_selection(app: &App, pane: &PaneState) -> bool {
    match (&app.selected, &pane.info.task_id) {
        (Some(r), Some(t)) => same_task(&app.graph, r, t),
        _ => false,
    }
}
