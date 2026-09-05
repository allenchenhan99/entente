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

/// Rows a wheel notch or a page key moves a pane's scrollback.
const SCROLL_ROWS: i32 = 3;
const PAGE_ROWS: i32 = 10;
/// Columns an arrow moves the text panels, and how far right they will go at all.
const H_SCROLL_COLUMNS: i32 = 8;
const MAX_H_SCROLL: u16 = 400;

impl Region {
    pub fn title(self) -> &'static str {
        match self {
            Region::Tree => "WORKSPACES",
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
    /// `D`: forget a cancelled or failed task. Asks first, and says what survives.
    DeleteTaskConfirm,
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
            Command::Clarify {
                task_id,
                question_id,
                ..
            } => format!("{question_id} answered on {task_id}"),
            Command::MissionClarify {
                mission_id,
                question_id,
                ..
            } => format!("{question_id} answered on {mission_id}"),
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

    /// What the command was about, in a form that reads correctly after "did not send". `label` is
    /// written as a thing that happened, which is exactly wrong for a request that never arrived.
    ///
    /// Kept short, and free of the task id: the error it is prefixed to already carries the route,
    /// and the status line is one row. What the route cannot say is *which question* — and answering
    /// walks several in a row, so that is the part worth the columns.
    pub fn subject(&self) -> String {
        match self {
            Command::Clarify { question_id, .. } | Command::MissionClarify { question_id, .. } => {
                format!("your answer to {question_id}")
            }
            Command::Review {
                criterion_id,
                status,
                ..
            } => format!("marking {criterion_id} {status}"),
            Command::Reply { .. } => "your reply".to_string(),
            Command::Cancel { .. } => "the cancel".to_string(),
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
    /// `DELETE /tasks/:id` — forget work that is over. The event log keeps it.
    DeleteTask(String),
    /// Open a shell pane beside the agents. The runtime fills in the shell and the repo, since `App`
    /// knows neither the environment nor the filesystem.
    NewShellPane,
    Quit,
}

/// One project: the relayd hosting it and everything derived from that daemon.
///
/// A workspace is a daemon, not a folder — its event log lives in its own repo's `.relay`, it has its
/// own worktrees, its own panes and its own port. Several can be open at once, and the handoff network
/// draws all their agents together, each belonging to its own.
pub struct Workspace {
    /// Short name shown in the panel: the repo's own directory name, or the url when it has no repo yet.
    pub name: String,
    pub url: String,
    pub graph: Graph,
    pub state: State,
    /// Pane ids in `/panes` order.
    pub panes: Vec<String>,
    pub pane_states: BTreeMap<String, PaneState>,
    pub focused_pane: Option<String>,
    pub metrics: Option<HostMetrics>,
    pub connection: Connection,
    pub last_seq: u64,
}

impl Workspace {
    pub fn new(url: impl Into<String>, mode: Mode) -> Self {
        let url = url.into();
        Self {
            name: workspace_name(&url),
            url,
            graph: Graph::default(),
            state: State::default(),
            panes: Vec::new(),
            pane_states: BTreeMap::new(),
            focused_pane: None,
            metrics: None,
            connection: match mode {
                Mode::Live => Connection::Connecting,
                Mode::Replay => Connection::Replay,
            },
            last_seq: 0,
        }
    }

    /// The repo this workspace is for, once its state says; that is the name worth showing.
    pub fn refresh_name(&mut self) {
        // `repo` rides in the mission's flattened extras rather than a named field.
        let repo = self
            .state
            .mission()
            .and_then(|m| m.mission.extra.get("repo"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if let Some(base) = repo
            .as_deref()
            .and_then(|r| r.rsplit('/').find(|s| !s.is_empty()))
        {
            self.name = base.to_string();
        }
    }
}

/// A readable name for a daemon we have not heard from yet: its port, which is how it was addressed.
fn workspace_name(url: &str) -> String {
    url.rsplit(':')
        .next()
        .filter(|p| p.chars().all(|c| c.is_ascii_digit()))
        .map(|port| format!(":{port}"))
        .unwrap_or_else(|| url.to_string())
}

pub struct App {
    pub mode: Mode,
    /// Every open project. There is always at least one, so `ws()` never has to answer "none".
    pub workspaces: Vec<Workspace>,
    /// Which workspace the panels and the keys act on.
    pub active: usize,
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
    /// The questions `a` has still to put to you, the current one first. An item can ask several at
    /// once but the clarify command carries a single id, so answering is a walk: Enter posts this
    /// question's answer and moves to the next, Esc leaves the rest open. Answering one and dropping
    /// the others silently would write your words against a question you were not looking at, into a
    /// log that is the only state and does not take them back.
    pending_questions: Vec<String>,
    /// The questions this walk has already sent. Kept here, not derived from the inbox: the server
    /// deletes a question the instant it is answered, so a row that has been dealt with would simply
    /// vanish from under the cursor mid-walk with nothing to show for it.
    answered_questions: Vec<String>,
    /// The inbox item the walk is on. Question ids are per-task and every agent starts at `Q1`, so
    /// two agents asking at once means two items both carrying a `Q1`; without this the prompt shows
    /// one agent's question while the answer is routed to the other's.
    answering_item: Option<String>,
    /// Test seam: what this client believes the time is, in seconds since the epoch. `None` asks the
    /// system clock. Ages are drawn from it, and a drawn age has to be reproducible in a snapshot.
    pub now_override: Option<i64>,
    pub help_open: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
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
    /// Task the user is being asked about before it is deleted.
    pending_task_delete: Option<String>,
    /// Rows the inbox is scrolled down. Two questions are two rows, so a couple of items outgrow the
    /// strip, and what does not fit has to be reachable rather than simply gone.
    pub inbox_scroll: usize,
    /// Columns the text panels are scrolled right. A question or a blocker is longer than any panel
    /// is wide, and cutting it off is not the same as having read it.
    pub h_scroll: u16,
    /// How far each pane is scrolled back, in rows. A pane at 0 is at the live edge; anything else is
    /// history, and stays put while output arrives so it can actually be read.
    pane_scroll: BTreeMap<String, usize>,
    /// Panes the user has closed. relayd keeps a killed pane in `/panes` — the record and its cast
    /// outlive the process — so the grid has to remember what was dismissed or a closed pane comes
    /// straight back on the next poll, looking as though `X` did nothing.
    dismissed_panes: std::collections::BTreeSet<String>,
    pub tick: u64,
}

/// Cut a string to `width` printed characters, marking that it was cut.
fn truncate_to(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn same_task(graph: &Graph, r: &GraphObjectRef, task_id: &str) -> bool {
    graph.task_of(r) == Some(task_id)
}

impl App {
    /// How much of a question the prompt will show before the field it shares a line with. Agent
    /// prose runs to any length; the field has to survive it.
    const QUESTION_PROMPT_WIDTH: usize = 48;

    pub fn new(mode: Mode) -> Self {
        Self::with_urls(mode, &["http://127.0.0.1:7420".to_string()])
    }

    /// One workspace per daemon url, in the order they were given.
    pub fn with_urls(mode: Mode, urls: &[String]) -> Self {
        let workspaces: Vec<Workspace> = if urls.is_empty() {
            vec![Workspace::new("http://127.0.0.1:7420", mode)]
        } else {
            urls.iter()
                .map(|u| Workspace::new(u.clone(), mode))
                .collect()
        };
        Self {
            mode,
            workspaces,
            active: 0,
            region: Region::Tree,
            selected: None,
            actions: Vec::new(),
            terminal_input: false,
            inspector_open: false,
            inspector: Inspector::default(),
            input_mode: None,
            input_value: String::new(),
            pending_action: None,
            pending_questions: Vec::new(),
            answered_questions: Vec::new(),
            answering_item: None,
            now_override: None,
            help_open: false,
            error: None,
            notice: None,
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
            pending_task_delete: None,
            inbox_scroll: 0,
            h_scroll: 0,
            pane_scroll: BTreeMap::new(),
            dismissed_panes: std::collections::BTreeSet::new(),
            tick: 0,
        }
    }

    // --- data in -----------------------------------------------------------------------------------

    /// Port of `refsForRegion` (`App.tsx`): the objects j/k walk in each panel.
    pub fn refs_for_region(&self, region: Region) -> Vec<GraphObjectRef> {
        match region {
            Region::Tree => self
                .ws()
                .graph
                .nodes
                .iter()
                .filter(|n| n.kind == GraphNodeKind::Agent)
                .map(|n| GraphObjectRef::node(n.id.clone()))
                .collect(),
            Region::Graph => self
                .ws()
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
                    self.ws()
                        .graph
                        .edges
                        .iter()
                        .map(|e| GraphObjectRef::edge(e.id.clone())),
                )
                .collect(),
            // In the order the strip draws them, not the order the server sent them. The panel sorts
            // by what is stuck behind each item; j/k walking the raw list would step through the rows
            // out of order, and Tab into the panel would land on whichever row happened to be first
            // on the wire rather than the one at the top.
            Region::Inbox => crate::ui::inbox::ordered_items(self)
                .into_iter()
                .map(|i| GraphObjectRef::inbox(i.id.clone()))
                .collect(),
            Region::Panes => self
                .ws()
                .panes
                .iter()
                .filter_map(|p| self.ws().pane_states.get(p))
                .filter_map(|p| p.info.task_id.clone())
                .filter(|t| self.ws().graph.node(t).is_some())
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
        self.ws_mut().graph = graph;
        if let Some(seq) = self.ws().graph.seq {
            self.ws_mut().last_seq = self.ws().last_seq.max(seq);
        }
        self.reconcile_input();
        let mut effects = Vec::new();
        let keep = self
            .selected
            .as_ref()
            .map(|r| self.ws().graph.contains(r))
            .unwrap_or(false);
        if !keep {
            let next = self.initial_ref();
            effects.extend(self.select(next));
        }
        if self.inspector_open {
            if let Some(r) = self.inspector.reference.clone() {
                if self.ws().graph.contains(&r) {
                    effects.push(Effect::FetchInspector(r));
                } else {
                    self.inspector_open = false;
                }
            }
        }
        effects
    }

    /// Bring an open editor back in line with what the server now says, on every refresh.
    ///
    /// An editor is a claim about work that still needs doing, and the server can settle that work
    /// while you are typing — the task gets cancelled, or someone answers the same question from the
    /// CLI. Two things went wrong when nothing checked. The item could vanish while `input_mode`
    /// stayed `Some`, and since the editor only draws inside the inspector, the popup went with it:
    /// no prompt, no cursor, and every key still swallowed into a field you could not see. The app
    /// looked frozen. And a question answered elsewhere stayed in the queue, so the prompt named a
    /// question that was no longer being asked and Enter sent a duplicate answer for it.
    fn reconcile_input(&mut self) {
        let Some(item_id) = self.answering_item.clone() else {
            return;
        };
        let open: Vec<String> = match self.ws().graph.inbox_item(&item_id) {
            Some(item) => item
                .actions
                .iter()
                .filter_map(|a| a.target.question_ids.as_ref())
                .flatten()
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        let before = self.pending_questions.len();
        self.pending_questions.retain(|q| open.contains(q));
        if self.pending_questions.is_empty() {
            let answered = self.answered_questions.len();
            self.reset_input();
            self.set_notice(match answered {
                0 => format!("{item_id} is no longer waiting on you · nothing was sent"),
                1 => format!("{item_id} is settled · your 1 answer was sent"),
                n => format!("{item_id} is settled · your {n} answers were sent"),
            });
        } else if self.pending_questions.len() < before {
            self.set_notice(format!(
                "{} of these questions {} answered elsewhere",
                before - self.pending_questions.len(),
                if before - self.pending_questions.len() == 1 {
                    "was"
                } else {
                    "were"
                }
            ));
        }
    }

    pub fn set_state(&mut self, state: State) {
        self.ws_mut().last_seq = self.ws().last_seq.max(state.last_seq);
        self.ws_mut().state = state;
        // A workspace is named after its repo as soon as its state says which one that is; until then
        // it goes by the port it was addressed on.
        self.ws_mut().refresh_name();
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
        let dismissed = self.dismissed_panes.clone();
        self.ws_mut()
            .pane_states
            .retain(|id, _| !dismissed.contains(id));

        self.ws_mut().panes = panes.iter().map(|p| p.pane_id.clone()).collect();
        for info in panes {
            match self.ws_mut().pane_states.get_mut(&info.pane_id) {
                Some(existing) => {
                    if info.exit_code.is_some() {
                        existing.exit_code = info.exit_code;
                    }
                    existing.info = info;
                }
                None => {
                    self.ws_mut()
                        .pane_states
                        .insert(info.pane_id.clone(), PaneState::new(info));
                }
            }
        }
        let focus_valid = self
            .ws()
            .focused_pane
            .as_ref()
            .map(|p| self.ws().panes.contains(p))
            .unwrap_or(false);
        if !focus_valid {
            self.ws_mut().focused_pane = focused
                .filter(|f| self.ws().panes.contains(f))
                .or_else(|| self.first_alive_pane())
                .or_else(|| self.ws().panes.first().cloned());
        }
        Vec::new()
    }

    fn first_alive_pane(&self) -> Option<String> {
        self.ws()
            .panes
            .iter()
            .find(|p| {
                self.ws()
                    .pane_states
                    .get(*p)
                    .map(|s| s.alive())
                    .unwrap_or(false)
            })
            .cloned()
    }

    pub fn set_metrics(&mut self, metrics: HostMetrics) {
        self.ws_mut().metrics = Some(metrics);
    }

    /// A frame from `/pty/:id`.
    pub fn apply_pane_frame(&mut self, pane_id: &str, frame: PtyServerMessage) {
        let Some(pane) = self.ws_mut().pane_states.get_mut(pane_id) else {
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
                if self.terminal_input && self.ws().focused_pane.as_deref() == Some(pane_id) {
                    self.terminal_input = false;
                }
            }
            PtyServerMessage::Pong => {}
        }
    }

    pub fn set_pane_connected(&mut self, pane_id: &str, connected: bool) {
        if let Some(pane) = self.ws_mut().pane_states.get_mut(pane_id) {
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
        self.ws_mut().connection = connection;
    }

    pub fn note_event(&mut self, seq: u64) {
        self.ws_mut().last_seq = self.ws().last_seq.max(seq);
    }

    // --- queries -----------------------------------------------------------------------------------

    pub fn task_view(&self, task_id: &str) -> Option<&TaskView> {
        self.ws().state.tasks.get(task_id)
    }

    pub fn pane_for_task(&self, task_id: &str) -> Option<String> {
        // Prefer the alive pane (a resumed session gets a new pane id, e.g. relay:3 after relay:1).
        let mut candidates = self
            .ws()
            .panes
            .iter()
            .filter_map(|p| self.ws().pane_states.get(p))
            .filter(|p| p.info.task_id.as_deref() == Some(task_id));
        let first = candidates.next()?;
        let alive = std::iter::once(first)
            .chain(candidates)
            .find(|p| p.alive())
            .unwrap_or(first);
        Some(alive.info.pane_id.clone())
    }

    pub fn focused_pane_state(&self) -> Option<&PaneState> {
        self.ws()
            .focused_pane
            .as_ref()
            .and_then(|p| self.ws().pane_states.get(p))
    }

    /// Actions that apply to the selection: the inbox item's own, else the fetched ones.
    pub fn current_actions(&self) -> &[ObjectAction] {
        match &self.selected {
            Some(r) if r.kind == RefKind::Inbox => self
                .ws()
                .graph
                .inbox_item(&r.id)
                .map(|i| i.actions.as_slice())
                .unwrap_or(&[]),
            _ => &self.actions,
        }
    }

    /// The Ink footer: `a answer · r reply · p pass · f fail · x cancel` for the current actions.
    /// The keys of the selection's actions, in the same words and the same shape the inbox uses. One
    /// vocabulary: a key that reads `[x] kill task` in the strip must not read `x cancel` here.
    pub fn action_hints(&self) -> String {
        crate::ui::inbox::action_keys(self.current_actions())
    }

    /// The wording of a question, taken from the one item that asked it. A detail row reads
    /// `Q2: Link expiry?` — the id, then the question — so the id is a prefix to strip.
    ///
    /// Scoped to the item on purpose. Question ids are authored per task and everyone starts at
    /// `Q1`, so searching the whole inbox would show you one agent's question while sending your
    /// answer to another agent's — a wrong answer that looks entirely right.
    fn question_text(&self, id: &str) -> Option<String> {
        let item_id = self.answering_item.as_deref()?;
        self.ws()
            .graph
            .inbox_item(item_id)?
            .detail
            .iter()
            .find(|d| crate::model::question_of(d) == Some(id))
            .map(|d| d[id.len()..].trim_start_matches([':', ' ']).to_string())
    }

    /// The questions still to be put, if `a` is walking some. The inbox marks its detail rows from
    /// this, so you can see what you have already answered without leaving the strip.
    pub fn pending_questions(&self) -> &[String] {
        if self.input_mode == Some(InputMode::Answer) {
            &self.pending_questions
        } else {
            &[]
        }
    }

    /// The questions this walk has already sent.
    pub fn answered_questions(&self) -> &[String] {
        if self.input_mode == Some(InputMode::Answer) {
            &self.answered_questions
        } else {
            &[]
        }
    }

    /// The inbox item `a` is walking, if any.
    pub fn answering_item(&self) -> Option<&str> {
        if self.input_mode == Some(InputMode::Answer) {
            self.answering_item.as_deref()
        } else {
            None
        }
    }

    /// What the selection points at in the network.
    ///
    /// An inbox item is a pointer, not a place: it carries the graph object it is about. Panels that
    /// only know how to highlight a node or an edge went blank while you walked the inbox — the one
    /// panel that resolved through the item was the pane grid — so walking the list told you what
    /// needed you and nothing about where it lived.
    pub fn highlighted(&self) -> Option<GraphObjectRef> {
        let r = self.selected.as_ref()?;
        match r.kind {
            RefKind::Inbox => self
                .ws()
                .graph
                .inbox_item(&r.id)
                .map(|i| i.reference.clone()),
            _ => Some(r.clone()),
        }
    }

    /// Does the selection point at this node — directly, or through the task it is about?
    pub fn highlights_node(&self, node: &GraphNode) -> bool {
        let Some(r) = self.selected.as_ref() else {
            return false;
        };
        if r.kind == RefKind::Node && r.id == node.id {
            return true;
        }
        match node.task_id.as_deref() {
            Some(task) => same_task(&self.ws().graph, r, task),
            None => false,
        }
    }

    /// Does the selection point at this edge?
    pub fn highlights_edge(&self, edge_id: &str) -> bool {
        matches!(self.highlighted(), Some(r) if r.kind == RefKind::Edge && r.id == edge_id)
    }

    /// This client's idea of now, in seconds since the epoch.
    pub fn now_seconds(&self) -> i64 {
        self.now_override.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        })
    }

    /// How long an inbox item has been waiting on a human, in seconds. `None` when the server sent no
    /// `since` — an item with no age is not an item with age zero, and must not sort as one.
    pub fn inbox_age(&self, item: &InboxItem) -> Option<i64> {
        let since = item.since.as_deref().filter(|s| !s.is_empty())?;
        Some(self.now_seconds() - crate::clock::parse_rfc3339(since)?)
    }

    pub fn prompt_line(&self) -> Option<String> {
        match self.input_mode? {
            // Which question, and how many are left. `a` answers one at a time — the command carries a
            // single question_id — so an editor that just said `answer>` sent your words to the first
            // of them and told you nothing about it.
            InputMode::Answer => {
                let label = match self.pending_questions.first() {
                    // The question itself, not its id: `Q2` names a row you would have to go and read
                    // when the whole point of the prompt is that you do not have to.
                    Some(id) => {
                        let done = self.answered_questions.len() + 1;
                        // Counted from what is left, not from what `a` started with, so a question
                        // answered elsewhere shrinks the total instead of shifting the numbering.
                        let total = self.answered_questions.len() + self.pending_questions.len();
                        // Agent prose of any length, and the editor shares one line with it: an
                        // unbounded question pushed the field past the right edge and you typed blind.
                        let text = match self.question_text(id) {
                            Some(text) => truncate_to(&text, Self::QUESTION_PROMPT_WIDTH),
                            // The id alone when nothing spelled the question out, and a warning when
                            // the item that did has stopped listing it — those are different, and
                            // only one of them means your answer is about to go somewhere stale.
                            None if self.answering_item.is_none() => id.clone(),
                            None => format!("{id} (no longer listed)"),
                        };
                        if total > 1 {
                            format!("{done}/{total} {text}")
                        } else {
                            text
                        }
                    }
                    None => "answer".to_string(),
                };
                Some(format!("{label}> {}", self.input_value))
            }
            InputMode::Reply => Some(format!("reply> {}", self.input_value)),
            InputMode::ReviewFailure => Some(format!("observed failure> {}", self.input_value)),
            InputMode::CancelConfirm => Some("cancel task? y/N".to_string()),
            // Naming what is about to die, and what survives it: killing an agent's terminal does not
            // end its task, which then waits for an agent that is gone.
            // Deleting is forgetting, not undoing: say what stays, so the choice is an informed one.
            InputMode::DeleteTaskConfirm => {
                let task = self.pending_task_delete.clone().unwrap_or_default();
                Some(format!(
                    "delete {task} from the board? the event log and its recording keep it  y/N"
                ))
            }
            InputMode::ClosePaneConfirm => {
                let pane_id = self.pending_pane_close.clone().unwrap_or_default();
                Some(
                    match self.ws().pane_states.get(&pane_id).map(|p| p.info.clone()) {
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
        self.h_scroll = 0;
        let mut effects = match &reference {
            Some(r) if r.kind != RefKind::Inbox => vec![Effect::FetchActions(r.clone())],
            _ => Vec::new(),
        };
        // Picking an agent shows its terminal. `focus_pane` selects back, and the guard above stops
        // there, so the two directions agree instead of chasing each other.
        if let Some(pane_id) = self
            .selected_task_id()
            .and_then(|task| self.pane_for_task(&task))
        {
            effects.extend(self.focus_pane(pane_id, true));
        }
        effects
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
        if self.ws().panes.is_empty() {
            return Vec::new();
        }
        let current = self
            .ws()
            .focused_pane
            .as_ref()
            .and_then(|p| self.ws().panes.iter().position(|x| x == p));
        let next = match current {
            None => 0,
            Some(i) => (i as i32 + delta).clamp(0, self.ws().panes.len() as i32 - 1) as usize,
        };
        let pane = self.ws().panes[next].clone();
        self.focus_pane(pane, false)
    }

    fn cycle_region(&mut self) -> Vec<Effect> {
        let index = REGIONS.iter().position(|r| *r == self.region).unwrap_or(0);
        let next = REGIONS[(index + 1) % REGIONS.len()];
        self.region = next;
        if next == Region::Panes {
            if let Some(p) = self.ws().focused_pane.clone() {
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
        if !self.ws().panes.contains(&pane_id) {
            return Vec::new();
        }
        let mut effects = Vec::new();
        if self.ws().focused_pane.as_ref() != Some(&pane_id) {
            self.ws_mut().focused_pane = Some(pane_id.clone());
            self.terminal_input = false;
        }
        if post {
            effects.push(Effect::FocusPane(pane_id.clone()));
        }
        let task_node = self
            .ws()
            .pane_states
            .get(&pane_id)
            .and_then(|p| p.info.task_id.clone())
            .filter(|t| self.ws().graph.node(t).is_some())
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
        if !self.ws().graph.contains(&reference) {
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
        self.pending_questions.clear();
        self.answered_questions.clear();
        self.answering_item = None;
        self.pending_pane_close = None;
        self.pending_task_delete = None;
    }

    fn begin_input(&mut self, action: ObjectAction, mode: InputMode) -> Vec<Effect> {
        self.input_value.clear();
        self.input_mode = Some(mode);
        self.pending_questions = if mode == InputMode::Answer {
            action.target.question_ids.clone().unwrap_or_default()
        } else {
            Vec::new()
        };
        self.answered_questions.clear();
        // The inbox item the walk is on, however you reached it: `a` works from a graph node too, and
        // the item is what carries the question wording and what a refresh has to be checked against.
        self.answering_item = if mode == InputMode::Answer {
            match &self.selected {
                Some(r) if r.kind == RefKind::Inbox => Some(r.id.clone()),
                _ => action.target.task_id.as_deref().and_then(|task| {
                    self.ws()
                        .graph
                        .inbox
                        .iter()
                        .find(|i| i.task_id.as_deref() == Some(task) && !i.detail.is_empty())
                        .map(|i| i.id.clone())
                }),
            }
        } else {
            None
        };
        self.pending_action = Some(action);
        self.error = None;
        // The inline editor lives in the inspector, like the Ink overlay tabs.
        let target = self.selected.clone();
        self.open_inspector(target)
    }

    fn selected_task_id(&self) -> Option<String> {
        let r = self.selected.as_ref()?;
        self.ws().graph.task_of(r).map(str::to_string)
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
            // Esc is the agent's key, not ours. In Claude Code and Codex it stops what the agent is
            // doing, and swallowing it to leave the pane meant the one key you reach for to interrupt
            // a run instead quietly took your keyboard away. Ctrl+] leaves, the way telnet's escape
            // character has always worked, and it is a chord no full-screen app binds.
            if key.ctrl && matches!(key.code, KeyCode::Char(']')) {
                self.terminal_input = false;
                return Vec::new();
            }
            return match self.ws().focused_pane.clone() {
                Some(pane_id) => {
                    // Typing means you want the live edge, as it does in any terminal.
                    self.scroll_pane_to_bottom(&pane_id);
                    vec![Effect::PaneInput {
                        pane_id,
                        data: key.encode(),
                    }]
                }
                None => {
                    self.terminal_input = false;
                    Vec::new()
                }
            };
        }
        if key.is_ctrl_c() {
            return vec![Effect::Quit];
        }

        if self.input_mode == Some(InputMode::DeleteTaskConfirm) {
            let answer = key.plain_char().map(|c| c.to_ascii_lowercase());
            let mut effects = Vec::new();
            if answer == Some('y') {
                if let Some(task_id) = self.pending_task_delete.clone() {
                    effects.push(Effect::DeleteTask(task_id));
                }
            }
            if answer == Some('y') || answer == Some('n') || key.code == KeyCode::Esc {
                self.reset_input();
            }
            return effects;
        }

        if self.input_mode == Some(InputMode::ClosePaneConfirm) {
            let answer = key.plain_char().map(|c| c.to_ascii_lowercase());
            let mut effects = Vec::new();
            if answer == Some('y') {
                if let Some(pane_id) = self.pending_pane_close.clone() {
                    let alive = self
                        .ws()
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
                    let question = self.pending_questions.first().cloned();
                    let Some(command) = submit_command(&action, mode, question.clone(), value)
                    else {
                        // Nothing could be built from this action, so nothing was sent. Saying so
                        // beats closing the editor and dropping what you typed in silence.
                        self.set_error("nothing to send: this action has no question to answer");
                        return Vec::new();
                    };
                    // More questions on this item means the editor stays open on the next one: the
                    // work is "answer what backend asked", not "answer one of the things it asked".
                    if mode == InputMode::Answer && self.pending_questions.len() > 1 {
                        if let Some(id) = question {
                            self.answered_questions.push(id);
                        }
                        self.pending_questions.remove(0);
                        self.input_value.clear();
                        // The error is not cleared here: a POST that failed on the previous question
                        // is the one thing you need to still be able to read on this one.
                        return vec![Effect::Post(command)];
                    }
                    self.reset_input();
                    return vec![Effect::Post(command)];
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
                            // `p` fires straight away while `f` stops for the observed failure, so
                            // the direction that puts an unverified pass into the evidence log was
                            // the unguarded one. It says what it just did instead of asking first:
                            // there is no undo to offer, because reversing it means posting a
                            // failure, and a failure nobody observed is exactly the self-report this
                            // whole project refuses. `f` is the correction, and it is a real one.
                            self.set_notice(format!(
                                "{criterion_id} marked passed on {task_id} · f records a failure if that was wrong"
                            ));
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
                        let target = self
                            .ws()
                            .graph
                            .inbox_item(&r.id)
                            .map(|i| i.reference.clone());
                        let mut effects = Vec::new();
                        if let Some(t) = target.clone() {
                            self.region = region_for_ref(&self.ws().graph, &t);
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
                            self.ws().focused_pane.clone()
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
            (KeyCode::PageUp, _) | (KeyCode::PageDown, _) => {
                let rows = if key.code == KeyCode::PageUp {
                    PAGE_ROWS
                } else {
                    -PAGE_ROWS
                };
                match self.ws().focused_pane.clone() {
                    Some(pane_id) => self.scroll_pane(&pane_id, rows),
                    None => {
                        self.set_notice("no pane to scroll");
                        Vec::new()
                    }
                }
            }
            (KeyCode::Tab, _) | (KeyCode::BackTab, _) => self.cycle_region(),
            // While you are reading, the arrows move the text; the graph gets them the rest of the time.
            (KeyCode::Left, _) if self.inspector_open => {
                self.scroll_horizontally(-H_SCROLL_COLUMNS);
                Vec::new()
            }
            (KeyCode::Right, _) if self.inspector_open => {
                self.scroll_horizontally(H_SCROLL_COLUMNS);
                Vec::new()
            }
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
            (_, Some('D')) => {
                match self.deletable_task() {
                    Some(task_id) => {
                        self.error = None;
                        self.pending_task_delete = Some(task_id);
                        self.input_mode = Some(InputMode::DeleteTaskConfirm);
                    }
                    None => self.set_notice(
                        "only cancelled or failed work can be deleted — x cancels the selected task",
                    ),
                }
                Vec::new()
            }
            (_, Some('X')) => {
                match self.ws().focused_pane.clone() {
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
            // With several projects open the digits pick one; with one they are free for the panes.
            (_, Some(c)) if c.is_ascii_digit() && c != '0' && self.workspaces.len() > 1 => {
                self.set_active(c.to_digit(10).unwrap_or(1) as usize - 1)
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
            MouseKind::ScrollUp if region == Region::Inbox => {
                self.region = region;
                self.scroll_inbox(-1);
                Vec::new()
            }
            MouseKind::ScrollDown if region == Region::Inbox => {
                self.region = region;
                self.scroll_inbox(1);
                Vec::new()
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

    /// How far back a pane is scrolled, in rows.
    pub fn pane_scroll(&self, pane_id: &str) -> usize {
        self.pane_scroll.get(pane_id).copied().unwrap_or(0)
    }

    /// Scroll a pane through its own scrollback. Positive is back into history; the vt100 screen
    /// clamps to what it actually kept, so this cannot run off the end.
    /// Scroll a pane by `rows` (positive is back through history).
    ///
    /// Returns the bytes to send the pane instead, when the scroll is not ours to make. A full-screen
    /// application — every coding agent is one — switches the terminal to its alternate screen, which
    /// by definition keeps no scrollback: there is nothing behind it to scroll to, `set_scrollback`
    /// clamps to zero, and the wheel did nothing at all. What such an app expects is what every
    /// terminal emulator sends it, which is input it can act on itself.
    #[must_use]
    pub fn scroll_pane(&mut self, pane_id: &str, rows: i32) -> Vec<Effect> {
        if let Some(data) = self.pane_scroll_input(pane_id, rows) {
            return vec![Effect::PaneInput {
                pane_id: pane_id.to_string(),
                data,
            }];
        }
        let current = self.pane_scroll(pane_id) as i32;
        let next = (current + rows).max(0) as usize;
        if next == 0 {
            self.pane_scroll.remove(pane_id);
        } else {
            self.pane_scroll.insert(pane_id.to_string(), next);
        }
        Vec::new()
    }

    /// What to send a full-screen application in place of scrolling its (non-existent) scrollback.
    ///
    /// An app that asked for mouse reporting gets wheel events, which is what it is waiting for. One
    /// that did not gets arrow keys — the "alternate scroll" convention every terminal emulator
    /// implements for exactly this case, and what makes the wheel work in `less` and in an agent's
    /// transcript alike. `None` means the pane keeps its own history and the scroll is ours to make.
    fn pane_scroll_input(&self, pane_id: &str, rows: i32) -> Option<Vec<u8>> {
        let pane = self.ws().pane_states.get(pane_id)?;
        let screen = pane.parser.screen();
        if !screen.alternate_screen() || rows == 0 {
            return None;
        }
        let up = rows > 0;
        let notches = rows.unsigned_abs() as usize;
        if screen.mouse_protocol_mode() == vt100::MouseProtocolMode::None {
            // `\x1bOA` rather than `\x1b[A` when the app put the cursor keys in application mode.
            let arrow: &[u8] = match (screen.application_cursor(), up) {
                (true, true) => b"\x1bOA",
                (true, false) => b"\x1bOB",
                (false, true) => b"\x1b[A",
                (false, false) => b"\x1b[B",
            };
            return Some(arrow.repeat(notches));
        }
        // Wheel up is button 64, wheel down 65; the cell is where the pointer is, 1-based.
        let button = if up { 64 } else { 65 };
        let (col, row) = (1u16, 1u16);
        let mut out = Vec::new();
        for _ in 0..notches {
            match screen.mouse_protocol_encoding() {
                vt100::MouseProtocolEncoding::Sgr => {
                    out.extend_from_slice(format!("\x1b[<{button};{col};{row}M").as_bytes());
                }
                // X10: three bytes offset by 32, which is why it cannot address past column 223.
                _ => {
                    out.extend_from_slice(b"\x1b[M");
                    out.push(32 + button as u8);
                    out.push(32 + col.min(223) as u8);
                    out.push(32 + row.min(223) as u8);
                }
            }
        }
        Some(out)
    }

    /// A graph for a workspace that may not be the active one. The active workspace also refreshes
    /// the selection and the inspector; the others just keep their nodes current for the network.
    pub fn set_graph_for(&mut self, index: usize, graph: Graph) -> Vec<Effect> {
        if index == self.active {
            return self.set_graph(graph);
        }
        if let Some(ws) = self.workspaces.get_mut(index) {
            ws.graph = graph;
        }
        Vec::new()
    }

    pub fn set_state_for(&mut self, index: usize, state: State) {
        if index == self.active {
            self.set_state(state);
            return;
        }
        if let Some(ws) = self.workspaces.get_mut(index) {
            ws.state = state;
            ws.refresh_name();
        }
    }

    /// Every workspace's agents in one graph, so the network shows all of them.
    ///
    /// Ids are qualified with the workspace when there is more than one, because two projects can
    /// each have a `t-backend-auth` and they are not the same agent. With a single workspace nothing
    /// is renamed, so everything that addresses a node keeps working unchanged.
    pub fn merged_graph(&self) -> Graph {
        if self.workspaces.len() <= 1 {
            return self.ws().graph.clone();
        }
        let mut merged = Graph::default();
        for (index, ws) in self.workspaces.iter().enumerate() {
            let tag = |id: &str| format!("{index}/{id}");
            for node in &ws.graph.nodes {
                let mut node = node.clone();
                node.id = tag(&node.id);
                merged.nodes.push(node);
            }
            for edge in &ws.graph.edges {
                let mut edge = edge.clone();
                edge.id = tag(&edge.id);
                edge.from = tag(&edge.from);
                edge.to = tag(&edge.to);
                merged.edges.push(edge);
            }
        }
        merged
    }

    /// The workspace the panels and the keys act on. There is always one.
    pub fn ws(&self) -> &Workspace {
        &self.workspaces[self.active.min(self.workspaces.len() - 1)]
    }

    pub fn ws_mut(&mut self) -> &mut Workspace {
        let index = self.active.min(self.workspaces.len() - 1);
        &mut self.workspaces[index]
    }

    /// Look at another workspace by index, for the panels that draw all of them.
    pub fn workspace(&self, index: usize) -> Option<&Workspace> {
        self.workspaces.get(index)
    }

    /// Make a workspace the active one; the selection belongs to whichever that is.
    pub fn set_active(&mut self, index: usize) -> Vec<Effect> {
        if index >= self.workspaces.len() || index == self.active {
            return Vec::new();
        }
        self.active = index;
        self.terminal_input = false;
        let next = self.initial_ref();
        self.select(next)
    }

    /// The stored position, readable without touching the pane map.
    pub fn pane_scroll_of(&self, pane_id: &str) -> usize {
        self.pane_scroll.get(pane_id).copied().unwrap_or(0)
    }

    /// Scroll the inbox. The end stop is the last row, so the panel can always show something.
    pub fn scroll_inbox(&mut self, rows: i32) {
        let last = crate::ui::inbox::all_inbox_rows(self, self.inbox_viewport.width.max(80))
            .len()
            .saturating_sub(1);
        let next = (self.inbox_scroll as i32 + rows).clamp(0, last as i32);
        self.inbox_scroll = next as usize;
    }

    /// Bring the selected item into view, so moving the selection is never a jump into nothing.
    pub fn reveal_selected_inbox(&mut self, height: usize, width: u16) {
        let Some(row) = crate::ui::inbox::selected_row(self, width) else {
            return;
        };
        let budget = height.max(1);
        if row < self.inbox_scroll {
            self.inbox_scroll = row;
        } else if row >= self.inbox_scroll + budget {
            self.inbox_scroll = row + 1 - budget;
        }
    }

    /// Scroll the text panels sideways. Nothing knows how long the longest line is until it is drawn,
    /// so the limit is generous and the panels simply show nothing past their end.
    pub fn scroll_horizontally(&mut self, columns: i32) {
        let next = (self.h_scroll as i32 + columns).clamp(0, MAX_H_SCROLL as i32);
        self.h_scroll = next as u16;
    }

    /// Correct the stored position to what the screen actually honoured, so the UI never reports a
    /// scroll the pane did not make.
    pub fn set_pane_scroll(&mut self, pane_id: &str, rows: usize) {
        if rows == 0 {
            self.pane_scroll.remove(pane_id);
        } else {
            self.pane_scroll.insert(pane_id.to_string(), rows);
        }
    }

    /// Back to the live edge — what typing into a pane should do, the way a terminal does.
    pub fn scroll_pane_to_bottom(&mut self, pane_id: &str) {
        self.pane_scroll.remove(pane_id);
    }

    /// The pane grid: a click focuses a pane, a click into the pane that already has focus starts
    /// typing into it — the way clicking into a text field does — and the wheel scrolls its history.
    fn mouse_in_pane(&mut self, mouse: Mouse, pane_id: String) -> Vec<Effect> {
        match mouse.kind {
            MouseKind::ScrollUp => return self.scroll_pane(&pane_id, SCROLL_ROWS),
            MouseKind::ScrollDown => return self.scroll_pane(&pane_id, -SCROLL_ROWS),
            _ => {}
        }
        if mouse.kind != MouseKind::Down {
            return Vec::new();
        }
        self.region = Region::Panes;
        if self.ws().focused_pane.as_deref() == Some(pane_id.as_str()) {
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
        self.ws_mut().panes.retain(|id| id != pane_id);
        self.ws_mut().pane_states.remove(pane_id);
        self.pane_rects.remove(pane_id);
        if self.ws().focused_pane.as_deref() == Some(pane_id) {
            self.terminal_input = false;
            self.ws_mut().focused_pane = self
                .first_alive_pane()
                .or_else(|| self.ws().panes.first().cloned());
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

    /// The selected task, if it is over and so may be forgotten. relayd is the authority and refuses
    /// anything else; this is so the key can say why rather than posting a request that will fail.
    pub fn deletable_task(&self) -> Option<String> {
        let task_id = self.selected_task_id()?;
        let node = self.ws().graph.node(&task_id)?;
        matches!(
            node.task_state,
            Some(TaskState::Canceled) | Some(TaskState::Failed)
        )
        .then_some(task_id)
    }

    /// Is a planner agent actually there? The graph always has the node; a pane is what says someone
    /// is doing the job.
    /// Is there an agent on the network that the human is prompting directly?
    ///
    /// `planner` is what relayd calls one it spawned itself; `brain` is what it calls one the human
    /// opened in a terminal. Both are the same thing to the network, and only checking for the first
    /// hid the planner node whenever the session had been started by hand — which took the subs'
    /// caller with it, so four agents a brain had called were drawn as four unrelated brains.
    pub fn planner_present(&self) -> bool {
        self.ws()
            .pane_states
            .values()
            .any(|p| p.info.role == "planner" || p.info.role == "brain")
    }

    /// Agents relayd is hosting that no contract accounts for; they are on the network too.
    pub fn unattached_agents(&self) -> Vec<GraphNode> {
        crate::ui::graph::unattached_agents(
            &self.ws().graph,
            self.ws().pane_states.values().map(|p| &p.info),
        )
    }

    /// The object drawn under a cell, if any.
    pub fn hit_at(&self, col: u16, row: u16) -> Option<GraphObjectRef> {
        let point =
            crate::ui::graph::cell_to_world(&self.graph_view, self.graph_viewport, col, row);
        let discs = crate::ui::graph::layout_net(
            &self.ws().graph,
            &self.unattached_agents(),
            self.planner_present(),
        );
        crate::ui::graph::hit_test(&self.ws().graph, &discs, point)
    }

    // --- pane sizing -------------------------------------------------------------------------------

    /// After a draw: if the focused pane's widget changed size, resize its screen model and tell relayd.
    pub fn sync_pane_sizes(&mut self) -> Vec<Effect> {
        let Some(pane_id) = self.ws().focused_pane.clone() else {
            return Vec::new();
        };
        let Some(&(cols, rows)) = self.pane_areas.get(&pane_id) else {
            return Vec::new();
        };
        if cols == 0 || rows == 0 {
            return Vec::new();
        }
        let Some(pane) = self.ws_mut().pane_states.get_mut(&pane_id) else {
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

/// The POST one Enter makes. `question_id` is the question the editor was on, passed in rather than
/// re-derived, so the answer lands against what the prompt said it would.
fn submit_command(
    action: &ObjectAction,
    mode: InputMode,
    question_id: Option<String>,
    value: String,
) -> Option<Command> {
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
        (Some(r), Some(t)) => same_task(&app.ws().graph, r, t),
        _ => false,
    }
}
