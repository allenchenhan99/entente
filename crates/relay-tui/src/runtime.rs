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
    Connection(Connection),
    /// A pane was created on the daemon; focus it once the refreshed list arrives.
    PaneOpened(String),
    /// The daemon killed a pane the user closed; take it out of the grid.
    PaneDismissed(String),
    Error(String),
    Notice(String),
    Quit,
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

    fn spawn_sse(&mut self) {
        let Some(client) = self.active_client() else {
            return;
        };
        let client = client.clone();
        let tx = self.tx.clone();
        let since = self.app.ws_mut().last_seq;
        self.tasks.push(tokio::spawn(async move {
            let mut since = since;
            loop {
                let opened = tx.clone();
                let events = tx.clone();
                let result = client
                    .events(
                        since,
                        || {
                            let _ = opened.send(Msg::Connection(Connection::Live));
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
                let _ = tx.send(Msg::Connection(Connection::Disconnected(why)));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }));
    }

    fn spawn_metrics(&mut self) {
        // Host metrics are about the daemon in front of you; the status line shows one workspace's.
        let index = self.app.active;
        let Some(client) = self.active_client() else {
            return;
        };
        let client = client.clone();
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
                // `t` asked for a terminal: focus it and put the keyboard in it, Esc to leave.
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
            Msg::Connection(c) => {
                self.app.set_connection(c);
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
            Effect::NewShellPane => {
                let Some(client) = self.active_client() else {
                    self.app
                        .set_notice("replay has no daemon to open a pane on");
                    return;
                };
                let client = client.clone();
                let tx = self.tx.clone();
                let cwd = self.workdir.clone();
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
                self.tasks.push(tokio::spawn(async move {
                    let msg = match client.create_pane("shell", &[shell], &cwd, 120, 40).await {
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
                        Err(e) => {
                            let _ = tx.send(Msg::Error(e.to_string()));
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
