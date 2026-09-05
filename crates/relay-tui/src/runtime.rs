//! The driver: owns the terminal and the `App`, receives `Msg`s from the keyboard, the SSE loop, the pane
//! WebSockets and the periodic fetches, applies them, redraws, and performs the `Effect`s the app returns.
//! Generic over the ratatui backend so the live integration test drives it against a `TestBackend`.

use crate::api::Client;
use crate::app::{App, Command, Connection, Effect, Mode};
use crate::keys::{Key, Mouse};
use crate::model::*;
use crate::replay::Fixture;
use crate::ui;
use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use ratatui::backend::Backend;
use ratatui::Terminal;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

pub const REFRESH_DEBOUNCE: Duration = Duration::from_millis(100);
pub const METRICS_INTERVAL: Duration = Duration::from_secs(2);
pub const TICK: Duration = Duration::from_millis(250);
pub const STORY_TAIL: usize = 50;

/// Messages are moved once from a channel; the size difference between variants does not matter.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum Msg {
    Key(Key),
    Mouse(Mouse),
    Resize,
    Tick,
    /// An SSE event arrived (its seq).
    Event(u64),
    /// The debounce elapsed: re-fetch graph, state and panes.
    Refresh,
    /// Each carries the workspace it came from: several daemons are polled, and a reply must land on
    /// the project it is about.
    Graph(usize, Graph),
    State(usize, State),
    Panes(usize, Vec<PaneInfo>, Option<String>),
    Metrics(usize, HostMetrics),
    Inspector(
        GraphObjectRef,
        ObjectDescription,
        Vec<String>,
        Vec<ObjectAction>,
    ),
    Actions(GraphObjectRef, Vec<ObjectAction>),
    PaneFrame(String, PtyServerMessage),
    PaneClosed(String, String),
    /// Which workspace's daemon, and how it is doing. A workspace is a daemon, so the state belongs
    /// to the one it came from — not to whichever happens to be in front of you when it arrives.
    Connection(usize, Connection),
    /// A pane was created on the daemon; focus it once the refreshed list arrives.
    PaneOpened(String),
    /// `entente daemon` answered: a project is being served here, and this is how to reach it.
    WorkspaceReady {
        url: String,
        token: String,
        name: String,
        repo: String,
        started: bool,
    },
    /// The daemon killed a pane the user closed; take it out of the grid.
    PaneDismissed(String),
    Error(String),
    Notice(String),
    Quit,
}

/// PATH for a shell pane, with `relay` and `entente` on it when the launcher said where they are.
fn shell_env() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Ok(tools) = std::env::var("RELAY_TOOLS") {
        let path = std::env::var("PATH").unwrap_or_default();
        env.insert("PATH".to_string(), format!("{tools}:{path}"));
    }
    env
}

/// How to start a shell pane so that what the launcher put on PATH is still in front once the user's
/// own startup files have run.
///
/// Setting PATH on the child is not enough. An interactive shell sources `~/.bashrc`, and a very
/// ordinary line there — `export PATH="$HOME/.local/bin:$PATH"` — puts that directory back in front
/// of everything we prepended. Anything relying on winning a PATH lookup then quietly loses to the
/// binary it meant to wrap. So for the shells that support it we source the user's own rc first and
/// prepend afterwards, which is the only ordering that holds. `RELAY_SHELL_RC` is written by the
/// launcher; without it, or for a shell we do not know how to do this in, the pane is a plain shell
/// and the wrappers simply do not apply.
fn shell_argv(shell: &str) -> Vec<String> {
    let Ok(rc) = std::env::var("RELAY_SHELL_RC") else {
        return vec![shell.to_string()];
    };
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    match name {
        // `--rcfile` replaces the startup file rather than adding to it, so ours sources theirs.
        "bash" => vec![
            shell.to_string(),
            "--rcfile".to_string(),
            rc,
            "-i".to_string(),
        ],
        _ => vec![shell.to_string()],
    }
}

pub enum Source {
    /// One client per workspace, in the order the urls were given: a workspace is a daemon.
    Live(Vec<Arc<Client>>),
    Replay(Arc<Fixture>),
}

pub struct Runtime<B: Backend> {
    pub terminal: Terminal<B>,
    pub app: App,
    source: Source,
    tx: mpsc::UnboundedSender<Msg>,
    rx: mpsc::UnboundedReceiver<Msg>,
    pane_senders: BTreeMap<String, mpsc::UnboundedSender<PtyClientMessage>>,
    refresh_pending: bool,
    tasks: Vec<JoinHandle<()>>,
    quit: bool,
    /// Working directory a new shell pane starts in; the repo the mission is about.
    pub workdir: String,
    /// Pane this session asked the daemon to open, focused as soon as the daemon reports it.
    pending_pane: Option<String>,
}

impl<B: Backend> Runtime<B> {
    /// Give the app one workspace per url, so the panel and the network know how many projects there
    /// are before any of them has answered.
    pub fn set_workspace_urls(&mut self, urls: &[String]) {
        if urls.len() > 1 {
            self.app = App::with_urls(self.app.mode, urls);
        }
    }

    /// The repo the client was started against, which is the first workspace's.
    ///
    /// Set separately from `workdir` because they answer different questions: `workdir` is a fallback
    /// for when nothing better is known, and this is what the first workspace actually serves.
    pub fn set_launch_repo(&mut self, repo: String) {
        self.app.set_workspace_repo(0, repo);
    }

    /// The daemon of the workspace the user is acting on.
    fn active_client(&self) -> Option<&Arc<Client>> {
        match &self.source {
            Source::Live(clients) => clients.get(self.app.active).or_else(|| clients.first()),
            Source::Replay(_) => None,
        }
    }

    /// Every workspace's daemon, with its index, for the loops that refresh them all.
    fn all_clients(&self) -> Vec<(usize, Arc<Client>)> {
        match &self.source {
            Source::Live(clients) => clients.iter().cloned().enumerate().collect(),
            Source::Replay(_) => Vec::new(),
        }
    }

    pub fn new(terminal: Terminal<B>, source: Source) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let mode = match source {
            Source::Live(_) => Mode::Live,
            Source::Replay(_) => Mode::Replay,
        };
        Self {
            terminal,
            app: App::new(mode),
            source,
            tx,
            rx,
            pane_senders: BTreeMap::new(),
            workdir: ".".to_string(),
            pending_pane: None,
            refresh_pending: false,
            tasks: Vec::new(),
            quit: false,
        }
    }

    pub fn sender(&self) -> mpsc::UnboundedSender<Msg> {
        self.tx.clone()
    }

    /// Initial data, background loops (SSE, metrics), first frame.
    pub async fn start(&mut self) -> Result<()> {
        match &self.source {
            Source::Replay(fixture) => {
                let fixture = fixture.clone();
                self.app.set_state(fixture.state.clone());
                let effects = self.app.set_graph(fixture.graph.clone());
                self.run_effects(effects);
                let effects = self
                    .app
                    .set_panes(fixture.panes.clone(), fixture.focused_pane.clone());
                self.run_effects(effects);
                if let Some(m) = fixture.metrics.clone() {
                    self.app.set_metrics(m);
                }
                self.app
                    .set_notice(format!("replay of {}", fixture.dir.display()));
            }
            Source::Live(_) => {
                let Some(client) = self.active_client().cloned() else {
                    return Ok(());
                };
                let client = client.clone();
                let (state, graph, panes) =
                    tokio::join!(client.state(), client.graph(), client.panes());
                match state {
                    Ok(s) => self.app.set_state(s),
                    Err(e) => self.app.set_error(e.to_string()),
                }
                match graph {
                    Ok(g) => {
                        let effects = self.app.set_graph(g);
                        self.run_effects(effects);
                    }
                    Err(e) => self.app.set_error(e.to_string()),
                }
                // No pane routes (hosts other than `relay`): the grid stays empty, nothing else changes.
                if let Ok((panes, focused)) = panes {
                    self.apply_panes(panes, focused);
                }
                self.spawn_sse();
                self.spawn_metrics();
            }
        }
        self.draw()
    }

    /// One event stream per workspace. Every daemon needs its own: a workspace opened later used to
    /// get none at all, so nothing ever told it the stream was up and it sat on "connecting" forever
    /// while its data quietly arrived through the polling refresh.
    fn spawn_sse(&mut self) {
        for (index, client) in self.all_clients() {
            self.spawn_sse_for(index, client);
        }
    }

    fn spawn_sse_for(&mut self, index: usize, client: Arc<Client>) {
        let tx = self.tx.clone();
        let since = self
            .app
            .workspace(index)
            .map(|w| w.last_seq)
            .unwrap_or_default();
        self.tasks.push(tokio::spawn(async move {
            let mut since = since;
            loop {
                let opened = tx.clone();
                let events = tx.clone();
                let result = client
                    .events(
                        since,
                        || {
                            let _ = opened.send(Msg::Connection(index, Connection::Live));
                        },
                        |event| {
                            since = since.max(event.seq);
                            let _ = events.send(Msg::Event(event.seq));
                        },
                    )
                    .await;
                if tx.is_closed() {
                    return;
                }
                let why = match result {
                    Ok(()) => "stream closed".to_string(),
                    Err(e) => e.to_string(),
                };
                let _ = tx.send(Msg::Connection(index, Connection::Disconnected(why)));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }));
    }

    fn spawn_metrics(&mut self) {
        for (index, client) in self.all_clients() {
            self.spawn_metrics_for(index, client);
        }
    }

    /// Host metrics per workspace; the status line shows the active one's.
    fn spawn_metrics_for(&mut self, index: usize, client: Arc<Client>) {
        let tx = self.tx.clone();
        self.tasks.push(tokio::spawn(async move {
            loop {
                if let Ok(m) = client.metrics().await {
                    if tx.send(Msg::Metrics(index, m)).is_err() {
                        return;
                    }
                }
                tokio::time::sleep(METRICS_INTERVAL).await;
                if tx.is_closed() {
                    return;
                }
            }
        }));
    }

    fn apply_panes(&mut self, panes: Vec<PaneInfo>, focused: Option<String>) {
        let effects = self.app.set_panes(panes, focused);
        self.run_effects(effects);
        // A pane this session asked for is the one the user wants to be looking at.
        if let Some(pane_id) = self.pending_pane.clone() {
            if self.app.ws_mut().panes.contains(&pane_id) {
                self.pending_pane = None;
                // `t` asked for a terminal: focus it and put the keyboard in it, Esc Esc to leave.
                let effects = self.app.open_pane_for_typing(pane_id);
                self.run_effects(effects);
            }
        }
        let missing: Vec<String> = self
            .app
            .ws()
            .panes
            .iter()
            .filter(|p| !self.pane_senders.contains_key(*p))
            .cloned()
            .collect();
        for pane_id in missing {
            self.spawn_pane(pane_id);
        }
    }

    /// One WebSocket per pane: server frames become `Msg::PaneFrame`, `PtyClientMessage`s go out as JSON.
    fn spawn_pane(&mut self, pane_id: String) {
        let Some(client) = self.active_client() else {
            return;
        };
        let client = client.clone();
        let tx = self.tx.clone();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<PtyClientMessage>();
        self.pane_senders.insert(pane_id.clone(), out_tx);
        self.tasks.push(tokio::spawn(async move {
            let stream = match client.connect_pty(&pane_id).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Msg::PaneClosed(pane_id, e.to_string()));
                    return;
                }
            };
            let (mut sink, mut source) = stream.split();
            loop {
                tokio::select! {
                    incoming = source.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(frame) = serde_json::from_str::<PtyServerMessage>(&text) {
                                    if tx.send(Msg::PaneFrame(pane_id.clone(), frame)).is_err() {
                                        return;
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let _ = tx.send(Msg::PaneClosed(pane_id, "closed".into()));
                                return;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => {
                                let _ = tx.send(Msg::PaneClosed(pane_id, e.to_string()));
                                return;
                            }
                        }
                    }
                    outgoing = out_rx.recv() => {
                        match outgoing {
                            Some(frame) => {
                                let text = serde_json::to_string(&frame).unwrap_or_default();
                                if sink.send(Message::Text(text.into())).await.is_err() {
                                    let _ = tx.send(Msg::PaneClosed(pane_id, "send failed".into()));
                                    return;
                                }
                            }
                            None => {
                                let _ = sink.close().await;
                                return;
                            }
                        }
                    }
                }
            }
        }));
    }

    fn schedule_refresh(&mut self) {
        if self.refresh_pending {
            return;
        }
        self.refresh_pending = true;
        let tx = self.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(REFRESH_DEBOUNCE).await;
            let _ = tx.send(Msg::Refresh);
        });
    }

    /// Every workspace is refreshed, not just the one in front: the network draws all their agents,
    /// so a project you are not looking at still has to be current.
    fn refresh_now(&mut self) {
        for (index, client) in self.all_clients() {
            let tx = self.tx.clone();
            tokio::spawn(async move {
                let (graph, state, panes) =
                    tokio::join!(client.graph(), client.state(), client.panes());
                match graph {
                    Ok(g) => {
                        let _ = tx.send(Msg::Graph(index, g));
                    }
                    Err(e) => {
                        let _ = tx.send(Msg::Error(e.to_string()));
                    }
                }
                if let Ok(s) = state {
                    let _ = tx.send(Msg::State(index, s));
                }
                if let Ok((panes, focused)) = panes {
                    let _ = tx.send(Msg::Panes(index, panes, focused));
                }
            });
        }
    }

    /// Apply one message; returns the effects it produced.
    fn apply(&mut self, msg: Msg) -> Vec<Effect> {
        match msg {
            Msg::Key(key) => {
                self.app.notice = None;
                self.app.handle_key(key)
            }
            Msg::Mouse(mouse) => self.app.handle_mouse(mouse),
            Msg::PaneDismissed(pane_id) => {
                self.app.dismiss_pane(&pane_id);
                Vec::new()
            }
            Msg::WorkspaceReady {
                url,
                token,
                name,
                repo,
                started,
            } => {
                let index =
                    self.app
                        .add_workspace(url.clone(), Some(name.clone()), Some(repo.clone()));
                // One client per workspace, in the same order, so `Msg::Graph(index, …)` and the rest
                // land on the project they came from.
                if let Source::Live(clients) = &mut self.source {
                    if clients.len() <= index {
                        clients.resize_with(index + 1, || {
                            Arc::new(Client::new(url.clone(), Some(token.clone())))
                        });
                    }
                    clients[index] = Arc::new(Client::new(url.clone(), Some(token.clone())));
                }
                self.app.set_notice(format!(
                    "{name} is workspace {} ({url}){}",
                    index + 1,
                    if started {
                        " · started its daemon"
                    } else {
                        ""
                    }
                ));
                // Its own event stream and metrics: a workspace opened after startup got neither, so
                // nothing ever told it its daemon was up and it sat on "connecting" forever while its
                // data quietly arrived through the polling refresh.
                if let Source::Live(clients) = &self.source {
                    if let Some(client) = clients.get(index).cloned() {
                        self.spawn_sse_for(index, client.clone());
                        self.spawn_metrics_for(index, client);
                    }
                }
                let effects = self.app.set_active(index);
                self.run_effects(effects);
                // Its graph, state and panes are fetched now rather than at the next tick, so the new
                // workspace has something in it the moment you are switched to it.
                self.refresh_now();
                Vec::new()
            }
            Msg::PaneOpened(pane_id) => {
                self.pending_pane = Some(pane_id.clone());
                self.app
                    .set_notice(format!("shell pane {pane_id} opening…"));
                self.refresh_now();
                Vec::new()
            }
            Msg::Resize => Vec::new(),
            Msg::Tick => {
                self.app.tick = self.app.tick.wrapping_add(1);
                Vec::new()
            }
            Msg::Event(seq) => {
                self.app.note_event(seq);
                self.schedule_refresh();
                Vec::new()
            }
            Msg::Refresh => {
                self.refresh_pending = false;
                self.refresh_now();
                Vec::new()
            }
            // A reply lands on the workspace it came from; only the active one drives the panels, so
            // the others update quietly behind the network.
            Msg::Graph(index, graph) => self.app.set_graph_for(index, graph),
            Msg::State(index, state) => {
                self.app.set_state_for(index, state);
                Vec::new()
            }
            Msg::Panes(index, panes, focused) => {
                if index == self.app.active {
                    self.apply_panes(panes, focused);
                } else if let Some(ws) = self.app.workspaces.get_mut(index) {
                    ws.panes = panes.iter().map(|p| p.pane_id.clone()).collect();
                }
                Vec::new()
            }
            Msg::Metrics(index, m) => {
                if index == self.app.active {
                    self.app.set_metrics(m);
                }
                Vec::new()
            }
            Msg::Inspector(r, description, story, actions) => {
                self.app.set_inspector(r, description, story, actions);
                Vec::new()
            }
            Msg::Actions(r, actions) => {
                self.app.set_actions(&r, actions);
                Vec::new()
            }
            Msg::PaneFrame(pane_id, frame) => {
                self.app.apply_pane_frame(&pane_id, frame);
                Vec::new()
            }
            Msg::PaneClosed(pane_id, why) => {
                self.app.set_pane_connected(&pane_id, false);
                self.pane_senders.remove(&pane_id);
                if !why.contains("closed") {
                    self.app.set_notice(format!("{pane_id}: {why}"));
                }
                Vec::new()
            }
            Msg::Connection(index, c) => {
                self.app.set_connection_for(index, c);
                Vec::new()
            }
            Msg::Error(e) => {
                self.app.set_error(e);
                Vec::new()
            }
            Msg::Notice(n) => {
                self.app.set_notice(n);
                Vec::new()
            }
            Msg::Quit => vec![Effect::Quit],
        }
    }

    fn run_effects(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            self.run_effect(effect);
        }
    }

    fn run_effect(&mut self, effect: Effect) {
        match effect {
            Effect::Quit => self.quit = true,
            Effect::FetchInspector(r) => match &self.source {
                Source::Replay(f) => {
                    let (d, s, a) = (f.describe(&r), f.story(&r), f.actions(&r));
                    self.app.set_inspector(r, d, s, a);
                }
                Source::Live(_) => {
                    let Some(client) = self.active_client() else {
                        return;
                    };
                    let client = client.clone();
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        let (describe, story, actions) = tokio::join!(
                            client.describe(&r),
                            client.story(&r, STORY_TAIL),
                            client.actions(&r)
                        );
                        match (describe, story, actions) {
                            (Ok(d), Ok(s), Ok(a)) => {
                                let _ = tx.send(Msg::Inspector(r, d, s, a));
                            }
                            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
                                let _ = tx.send(Msg::Error(e.to_string()));
                            }
                        }
                    });
                }
            },
            Effect::FetchActions(r) => match &self.source {
                Source::Replay(f) => {
                    let actions = f.actions(&r);
                    self.app.set_actions(&r, actions);
                }
                Source::Live(_) => {
                    let Some(client) = self.active_client() else {
                        return;
                    };
                    let client = client.clone();
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        match client.actions(&r).await {
                            Ok(a) => {
                                let _ = tx.send(Msg::Actions(r, a));
                            }
                            Err(e) => {
                                let _ = tx.send(Msg::Error(e.to_string()));
                            }
                        }
                    });
                }
            },
            Effect::Post(command) => self.post(command),
            Effect::PaneInput { pane_id, data } => {
                if let Some(sender) = self.pane_senders.get(&pane_id) {
                    let _ = sender.send(PtyClientMessage::Input {
                        data: BASE64.encode(data),
                    });
                }
            }
            Effect::PaneResize {
                pane_id,
                cols,
                rows,
            } => {
                if let Some(sender) = self.pane_senders.get(&pane_id) {
                    let _ = sender.send(PtyClientMessage::Resize { cols, rows });
                }
            }
            // Handing the mouse back to the terminal is the terminal's business, not the app's; the
            // runtime owns the escape sequences.
            // A shell beside the agents, so a mission can be started without leaving the app. The UI never
            // sends a command line: the shell comes from the environment and the cwd from --repo.
            Effect::OpenWorkspace(repo) => {
                if matches!(self.source, Source::Replay(_)) {
                    self.app.set_notice("replay cannot open another project");
                    return;
                }
                self.app.set_notice(format!(
                    "opening {repo} — starting its daemon if it needs one…"
                ));
                let tx = self.tx.clone();
                self.tasks.push(tokio::spawn(async move {
                    match open_workspace(&repo).await {
                        Ok(msg) => {
                            let _ = tx.send(msg);
                        }
                        Err(e) => {
                            let _ = tx.send(Msg::Error(format!("could not open {repo}: {e}")));
                        }
                    }
                }));
            }
            Effect::NewShellPane => {
                let Some(client) = self.active_client() else {
                    self.app
                        .set_notice("replay has no daemon to open a pane on");
                    return;
                };
                let client = client.clone();
                let tx = self.tx.clone();
                // The project this workspace is about, not wherever relay-tui was started. A pane in
                // the wrong repo reads the wrong `.relay/session.token`, and the wrappers inside it
                // then register their agent against another project's daemon — which is where a brain
                // opened in a second workspace was quietly turning up.
                let cwd = self
                    .app
                    .workspace_repo(self.app.active)
                    .map(str::to_string)
                    .unwrap_or_else(|| self.workdir.clone());
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
                // The shell opens in the mission's repo, which is where `.relay/session.token` lives,
                // so `relay status` works there with no `--repo`. It only needs the commands on PATH,
                // and they live in this workspace's node_modules; the launcher says where.
                // `RELAY_URL` and `RELAY_REPO` name this workspace's daemon, so the `claude` and
                // `codex` wrappers ask the daemon that owns the pane they are running in rather than
                // the default port.
                let mut env = shell_env();
                env.insert("RELAY_URL".to_string(), self.app.ws().url.clone());
                env.insert("RELAY_REPO".to_string(), cwd.clone());
                let argv = shell_argv(&shell);
                self.tasks.push(tokio::spawn(async move {
                    let msg = match client
                        .create_pane_with_env("shell", &argv, &cwd, 120, 40, env)
                        .await
                    {
                        Ok(pane_id) => Msg::PaneOpened(pane_id),
                        Err(e) => Msg::Notice(format!("could not open a shell pane: {e}")),
                    };
                    let _ = tx.send(msg);
                }));
            }
            Effect::DeleteTask(task_id) => {
                let Some(client) = self.active_client() else {
                    self.app.set_notice("replay has no daemon to delete on");
                    return;
                };
                let client = client.clone();
                let tx = self.tx.clone();
                self.tasks.push(tokio::spawn(async move {
                    let msg = match client.delete_task(&task_id).await {
                        Ok(()) => Msg::Notice(format!("{task_id} deleted; the event log keeps it")),
                        Err(e) => Msg::Notice(format!("could not delete {task_id}: {e}")),
                    };
                    let _ = tx.send(msg);
                    // The graph is what says it is gone, so ask for it rather than guessing.
                    let _ = tx.send(Msg::Refresh);
                }));
            }
            Effect::KillPane(pane_id) => {
                let Some(client) = self.active_client() else {
                    self.app
                        .set_notice("replay has no daemon to close a pane on");
                    return;
                };
                let client = client.clone();
                let tx = self.tx.clone();
                self.tasks.push(tokio::spawn(async move {
                    // The host forgets the pane, so it stays closed across a restart of this client;
                    // the grid drops it immediately rather than waiting for the next poll.
                    let msg = match client.close_pane(&pane_id).await {
                        Ok(()) => Msg::PaneDismissed(pane_id),
                        Err(e) => Msg::Notice(format!("could not close {pane_id}: {e}")),
                    };
                    let _ = tx.send(msg);
                }));
            }
            Effect::SetMouseCapture(on) => {
                let mut out = std::io::stdout();
                let _ = if on {
                    crossterm::execute!(out, crossterm::event::EnableMouseCapture)
                } else {
                    crossterm::execute!(out, crossterm::event::DisableMouseCapture)
                };
            }
            Effect::FocusPane(pane_id) => {
                if let Some(client) = self.active_client() {
                    let client = client.clone();
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = client.focus_pane(&pane_id).await {
                            let _ = tx.send(Msg::Notice(format!("focus not recorded: {e}")));
                        }
                    });
                }
            }
        }
    }

    fn post(&mut self, command: Command) {
        match &self.source {
            Source::Replay(_) => {
                self.app
                    .set_notice(format!("replay: not sent — {}", command.label()));
            }
            Source::Live(_) => {
                // A command goes to the workspace it is about: the active one.
                let Some(client) = self.active_client().cloned() else {
                    return;
                };
                let tx = self.tx.clone();
                self.app.error = None;
                tokio::spawn(async move {
                    match client.command(&command).await {
                        Ok(()) => {
                            let _ = tx.send(Msg::Notice(command.label()));
                        }
                        // Which command failed, not only which route: answering a question walks
                        // several in a row, and "a POST to /clarify failed" does not say which of
                        // the things you just typed did not arrive.
                        Err(e) => {
                            let _ = tx.send(Msg::Error(format!(
                                "{} did not send — {e}",
                                command.subject()
                            )));
                        }
                    }
                });
            }
        }
    }

    /// Draw one frame, record its duration, and send `resize` for a pane whose widget changed size.
    pub fn draw(&mut self) -> Result<()> {
        let start = Instant::now();
        self.terminal
            .draw(|frame| ui::draw(frame, &mut self.app))
            .map_err(|e| anyhow::anyhow!("draw: {e}"))?;
        self.app.frames.record(start.elapsed());
        let effects = self.app.sync_pane_sizes();
        self.run_effects(effects);
        Ok(())
    }

    /// Wait for the next message (at most `timeout`, then a tick), apply it, redraw. `false` once quit.
    pub async fn step(&mut self, timeout: Duration) -> Result<bool> {
        let msg = match tokio::time::timeout(timeout, self.rx.recv()).await {
            Ok(Some(msg)) => msg,
            Ok(None) => return Ok(false),
            Err(_) => Msg::Tick,
        };
        let mut effects = self.apply(msg);
        // Drain whatever else is queued before drawing (bursts of pane output).
        while let Ok(msg) = self.rx.try_recv() {
            effects.extend(self.apply(msg));
        }
        self.run_effects(effects);
        if self.quit {
            return Ok(false);
        }
        self.draw()?;
        Ok(!self.quit)
    }

    /// Run until quit, or until `max_frames` more frames were drawn.
    pub async fn run(&mut self, max_frames: Option<u64>) -> Result<()> {
        let target = max_frames.map(|n| self.app.frames.frames() + n);
        while !self.quit {
            if let Some(target) = target {
                if self.app.frames.frames() >= target {
                    break;
                }
            }
            if !self.step(TICK).await? {
                break;
            }
        }
        Ok(())
    }

    pub fn shutdown(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.pane_senders.clear();
    }
}

impl<B: Backend> Drop for Runtime<B> {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Ask `entente daemon` to make sure a project is being served, and say where.
///
/// The client does not decide whether a daemon is needed. Two relayds on one repository overwrite
/// each other's session token and lock out whoever was already connected, so exactly one thing gets
/// to answer "is there one already" — the launcher, which has always answered it, and which reuses a
/// healthy daemon serving the same repo or starts one on the next port that is free.
pub async fn open_workspace(repo: &str) -> anyhow::Result<Msg> {
    let entente = entente_binary().ok_or_else(|| {
        anyhow::anyhow!("`entente` is not on PATH (the launcher normally puts it there)")
    })?;
    let out = tokio::process::Command::new(&entente)
        .args(["daemon", "--repo", repo])
        .output()
        .await?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!(
            "{}",
            why.trim()
                .lines()
                .next_back()
                .unwrap_or("entente daemon failed")
        );
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let line = line
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| anyhow::anyhow!("entente daemon said nothing about where it is"))?;
    let answer: serde_json::Value = serde_json::from_str(line)?;
    let url = answer["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no url in {line}"))?
        .to_string();
    let token = answer["token"].as_str().unwrap_or_default().to_string();
    let repo_path = answer["repo"].as_str().unwrap_or(repo);
    Ok(Msg::WorkspaceReady {
        url,
        token,
        repo: repo_path.to_string(),
        name: std::path::Path::new(repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(repo_path)
            .to_string(),
        started: answer["started"].as_bool().unwrap_or(false),
    })
}

/// The `entente` the launcher put on this process's PATH, if it did.
pub fn entente_binary() -> Option<String> {
    let direct = std::env::var("RELAY_ENTENTE").ok();
    if direct.is_some() {
        return direct;
    }
    let tools = std::env::var("RELAY_TOOLS").ok()?;
    tools
        .split(':')
        .map(|dir| std::path::Path::new(dir).join("entente"))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod shell_tests {
    use super::shell_argv;

    /// Setting PATH on the pane's child is not enough: an interactive bash sources `~/.bashrc`, and a
    /// line as ordinary as `export PATH="$HOME/.local/bin:$PATH"` puts the real binaries back in front
    /// of the wrappers. The only ordering that holds is to source the user's file and prepend after it,
    /// which is what the rc file does — so the shell has to be told to use it.
    #[test]
    fn bash_is_started_with_the_rc_that_runs_after_the_users_own() {
        temp_env("RELAY_SHELL_RC", Some("/repo/.relay/shell-rc"), || {
            assert_eq!(
                shell_argv("/bin/bash"),
                vec!["/bin/bash", "--rcfile", "/repo/.relay/shell-rc", "-i"]
            );
        });
    }

    #[test]
    fn a_shell_we_cannot_do_this_in_is_left_exactly_as_it_was() {
        temp_env("RELAY_SHELL_RC", Some("/repo/.relay/shell-rc"), || {
            // Better a plain shell than one started with a flag its shell does not have.
            assert_eq!(shell_argv("/usr/bin/fish"), vec!["/usr/bin/fish"]);
            assert_eq!(shell_argv("/bin/zsh"), vec!["/bin/zsh"]);
        });
    }

    #[test]
    fn without_a_launcher_rc_file_the_pane_is_a_plain_shell() {
        temp_env("RELAY_SHELL_RC", None, || {
            assert_eq!(shell_argv("/bin/bash"), vec!["/bin/bash"]);
        });
    }

    /// `std::env::set_var` is unsafe from Rust 2024 on and these run in one process, so the three
    /// cases take turns under a lock rather than racing each other.
    fn temp_env(key: &str, value: Option<&str>, body: impl FnOnce()) {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var(key).ok();
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        body();
        match previous {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
}
