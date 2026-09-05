//! AC-4: against a fake relayd (axum) serving the fixtures — an SSE event triggers a `/graph` re-fetch and the
//! tree updates; pane WebSocket bytes appear in the pane widget; `i` routes keys to the focused pane as
//! `input` frames; `resize` is sent when the widget size changes; actions POST the Ink bodies and errors
//! land in the status line. No network beyond 127.0.0.1.

mod support;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use relay_tui::api::Client;
use relay_tui::app::Region;
use relay_tui::keys::Key;
use relay_tui::model::*;
use relay_tui::replay::Fixture;
use relay_tui::runtime::{Msg, Runtime, Source};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Notify};

const TOKEN: &str = "deadbeefcafe0123";

struct Fake {
    fixture: Fixture,
    graph: Mutex<Graph>,
    panes: Mutex<Vec<PaneInfo>>,
    extra_actions: Mutex<BTreeMap<String, Vec<ObjectAction>>>,
    graph_gets: Mutex<u32>,
    posts: Mutex<Vec<(String, Value)>>,
    fail_posts: Mutex<bool>,
    client_frames: Mutex<Vec<PtyClientMessage>>,
    frames_changed: Notify,
    sse: broadcast::Sender<(u64, Value)>,
    pane_out: broadcast::Sender<String>,
}

type Shared = Arc<Fake>;

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == format!("Bearer {TOKEN}"))
        .unwrap_or(false)
}

macro_rules! guard {
    ($headers:expr) => {
        if !authorized(&$headers) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "missing session token" }))).into_response();
        }
    };
}

async fn get_state(State(s): State<Shared>, headers: HeaderMap) -> axum::response::Response {
    guard!(headers);
    Json(serde_json::to_value(&s.fixture.state).unwrap()).into_response()
}

async fn get_graph(State(s): State<Shared>, headers: HeaderMap) -> axum::response::Response {
    guard!(headers);
    *s.graph_gets.lock().unwrap() += 1;
    Json(serde_json::to_value(&*s.graph.lock().unwrap()).unwrap()).into_response()
}

async fn get_panes(State(s): State<Shared>, headers: HeaderMap) -> axum::response::Response {
    guard!(headers);
    Json(json!({ "panes": *s.panes.lock().unwrap(), "focused_pane": "relay:1" })).into_response()
}

async fn get_metrics(State(_s): State<Shared>, headers: HeaderMap) -> axum::response::Response {
    guard!(headers);
    Json(json!({
        "host": "relay", "uptime_ms": 1000, "panes_spawned": 1, "panes_alive": 1, "prompt_failures": 0,
        "panes": [{ "pane_id": "relay:1", "role": "backend", "task_id": "t-backend-auth",
                    "timings": { "readiness_ms": 777, "prompt_accept_ms": 33, "render_p95_ms": 0.5 } }]
    }))
    .into_response()
}

async fn get_object(
    State(s): State<Shared>,
    Path((kind, id, leaf)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> axum::response::Response {
    guard!(headers);
    let kind = match kind.as_str() {
        "node" => RefKind::Node,
        "edge" => RefKind::Edge,
        "inbox" => RefKind::Inbox,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "kind" }))).into_response(),
    };
    let r = GraphObjectRef { kind, id };
    if !s.graph.lock().unwrap().contains(&r) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "object not found" })),
        )
            .into_response();
    }
    match leaf.as_str() {
        "describe" => Json(serde_json::to_value(s.fixture.describe(&r)).unwrap()).into_response(),
        "story" => Json(json!({ "ref": r, "lines": s.fixture.story(&r) })).into_response(),
        "actions" => {
            let extra = s.extra_actions.lock().unwrap().get(&r.key()).cloned();
            Json(serde_json::to_value(extra.unwrap_or_else(|| s.fixture.actions(&r))).unwrap())
                .into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn post_task(
    State(s): State<Shared>,
    Path((id, verb)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    guard!(headers);
    s.posts
        .lock()
        .unwrap()
        .push((format!("/tasks/{id}/{verb}"), body));
    if *s.fail_posts.lock().unwrap() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "errors": ["message: too short"] })),
        )
            .into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

async fn post_focus(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    guard!(headers);
    s.posts
        .lock()
        .unwrap()
        .push((format!("/panes/{id}/focus"), json!({})));
    Json(json!({ "ok": true })).into_response()
}

async fn get_events(
    State(s): State<Shared>,
    Query(_q): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
) -> axum::response::Response {
    guard!(headers);
    let rx = s.sse.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Ok((seq, event)) => Some((
                Ok::<Event, Infallible>(
                    Event::default()
                        .event("relay")
                        .id(seq.to_string())
                        .data(event.to_string()),
                ),
                rx,
            )),
            Err(_) => None,
        }
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_millis(200)))
        .into_response()
}

async fn ws_pty(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    let protocol = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if protocol != format!("relay.{TOKEN}") {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing session token" })),
        )
            .into_response();
    }
    if id != "relay:1" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "pane not found" })),
        )
            .into_response();
    }
    ws.protocols([format!("relay.{TOKEN}")])
        .on_upgrade(move |socket| handle_pane(socket, s))
        .into_response()
}

async fn handle_pane(socket: WebSocket, s: Shared) {
    let (mut sink, mut source) = socket.split();
    let pane = s.panes.lock().unwrap()[0].clone();
    let hello = serde_json::to_string(&PtyServerMessage::Hello {
        pane: Box::new(pane),
    })
    .unwrap();
    sink.send(Message::Text(hello.into())).await.unwrap();
    let scrollback = serde_json::to_string(&PtyServerMessage::Scrollback {
        data: BASE64.encode(b"$ claude\r\n"),
    })
    .unwrap();
    sink.send(Message::Text(scrollback.into())).await.unwrap();
    let mut out = s.pane_out.subscribe();
    loop {
        tokio::select! {
            frame = out.recv() => {
                match frame {
                    Ok(text) => { if sink.send(Message::Text(text.into())).await.is_err() { return; } }
                    Err(_) => return,
                }
            }
            incoming = source.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(frame) = serde_json::from_str::<PtyClientMessage>(text.as_str()) {
                            s.client_frames.lock().unwrap().push(frame);
                            s.frames_changed.notify_waiters();
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn start_fake() -> (Shared, String) {
    let fixture = Fixture::load(fixture_dir("live-1")).unwrap();
    let (sse, _) = broadcast::channel(64);
    let (pane_out, _) = broadcast::channel(64);
    let fake = Arc::new(Fake {
        graph: Mutex::new(fixture.graph.clone()),
        panes: Mutex::new(vec![pane(
            "relay:1",
            Some("t-backend-auth"),
            "backend",
            true,
        )]),
        fixture,
        extra_actions: Mutex::new(BTreeMap::new()),
        graph_gets: Mutex::new(0),
        posts: Mutex::new(Vec::new()),
        fail_posts: Mutex::new(false),
        client_frames: Mutex::new(Vec::new()),
        frames_changed: Notify::new(),
        sse,
        pane_out,
    });
    let app = Router::new()
        .route("/state", get(get_state))
        .route("/graph", get(get_graph))
        .route("/graph/{kind}/{id}/{leaf}", get(get_object))
        .route("/panes", get(get_panes))
        .route("/panes/{id}/focus", post(post_focus))
        .route("/metrics", get(get_metrics))
        .route("/events", get(get_events))
        .route("/tasks/{id}/{verb}", post(post_task))
        .route("/pty/{id}", get(ws_pty))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (fake, format!("http://{addr}"))
}

fn rows(rt: &Runtime<TestBackend>) -> Vec<String> {
    let buffer = rt.terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer.cell((x, y)).map(|c| c.symbol()).unwrap_or(" "))
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

fn screen(rt: &Runtime<TestBackend>) -> String {
    rows(rt).join("\n")
}

/// Step the runtime until `pred` holds (or fail with the screen after 5 s).
async fn until(
    rt: &mut Runtime<TestBackend>,
    what: &str,
    mut pred: impl FnMut(&Runtime<TestBackend>) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pred(rt) {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}:\n{}",
            screen(rt)
        );
        rt.step(Duration::from_millis(50)).await.unwrap();
    }
}

fn press(rt: &Runtime<TestBackend>, key: Key) {
    rt.sender().send(Msg::Key(key)).unwrap();
}

fn frames_of(fake: &Fake) -> Vec<PtyClientMessage> {
    fake.client_frames.lock().unwrap().clone()
}

#[tokio::test]
async fn live_sse_graph_refresh_pane_bytes_input_and_resize() {
    let (fake, url) = start_fake().await;
    let client = Client::new(url, Some(TOKEN.to_string()));
    let terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    let mut rt = Runtime::new(terminal, Source::Live(vec![Arc::new(client)]));
    rt.start().await.unwrap();

    // Boot: tree from /graph, pane from /panes, hello + scrollback over the WebSocket, live via SSE.
    assert!(screen(&rt).contains("› t-backend-auth"), "{}", screen(&rt));
    until(&mut rt, "pane connected", |rt| {
        rt.app
            .ws()
            .pane_states
            .get("relay:1")
            .map(|p| p.connected)
            .unwrap_or(false)
    })
    .await;
    until(&mut rt, "scrollback drawn", |rt| {
        screen(rt).contains("$ claude")
    })
    .await;
    until(&mut rt, "live", |rt| {
        rt.app.ws().connection == relay_tui::app::Connection::Live
    })
    .await;
    until(&mut rt, "metrics", |rt| rt.app.ws().metrics.is_some()).await;
    assert!(
        screen(&rt).contains("relay:1: ready 777ms · accept 33.0ms · render p95 0.5ms"),
        "{}",
        screen(&rt)
    );

    // The widget is smaller than the 120×40 PTY, so a resize frame was sent with the widget's size.
    let (cols, rows_) = rt.app.pane_areas["relay:1"];
    until(&mut rt, "resize frame", |_| {
        frames_of(&fake)
            .iter()
            .any(|f| matches!(f, PtyClientMessage::Resize { .. }))
    })
    .await;
    assert_eq!(
        frames_of(&fake)[0],
        PtyClientMessage::Resize { cols, rows: rows_ }
    );
    assert!(cols < 120 && rows_ < 40, "{cols}x{rows_}");

    // Output bytes appear in the pane widget.
    fake.pane_out
        .send(
            serde_json::to_string(&PtyServerMessage::Output {
                data: BASE64.encode(b"hello from pty\r\n"),
            })
            .unwrap(),
        )
        .unwrap();
    until(&mut rt, "pane output drawn", |rt| {
        screen(rt).contains("hello from pty")
    })
    .await;

    // An SSE event → debounced /graph re-fetch → the tree shows the new task.
    let gets_before = *fake.graph_gets.lock().unwrap();
    *fake.graph.lock().unwrap() = Fixture::load(fixture_dir("live-7")).unwrap().graph;
    fake.sse
        .send((
            44,
            json!({ "seq": 44, "type": "task_proposed", "task_id": "t-token-store" }),
        ))
        .unwrap();
    until(&mut rt, "tree refresh after SSE", |rt| {
        screen(rt).contains("t-token-store")
    })
    .await;
    assert!(*fake.graph_gets.lock().unwrap() > gets_before);
    assert_eq!(rt.app.ws().last_seq, 56, "seq from the refreshed graph");
    assert!(screen(&rt).contains("● live  seq 56"), "{}", screen(&rt));

    // `i` in the pane grid routes keys to the focused pane as base64 input frames.
    press(&rt, Key::TAB);
    press(&rt, Key::TAB);
    until(&mut rt, "panes region", |rt| rt.app.region == Region::Panes).await;
    press(&rt, Key::char('i'));
    press(&rt, Key::char('x'));
    press(&rt, Key::ENTER);
    until(&mut rt, "input frames", |_| {
        frames_of(&fake)
            .iter()
            .filter(|f| matches!(f, PtyClientMessage::Input { .. }))
            .count()
            >= 2
    })
    .await;
    let inputs: Vec<String> = frames_of(&fake)
        .into_iter()
        .filter_map(|f| match f {
            PtyClientMessage::Input { data } => Some(data),
            _ => None,
        })
        .collect();
    assert_eq!(inputs, vec![BASE64.encode(b"x"), BASE64.encode(b"\r")]);
    assert!(
        screen(&rt).contains("[typing · Ctrl+] leaves]"),
        "{}",
        screen(&rt)
    );
    // Esc reaches the agent — it is what stops a run in Claude Code and Codex — so leaving is a chord
    // no full-screen app binds.
    press(&rt, Key::ctrl(']'));
    until(&mut rt, "left typing mode", |rt| !rt.app.terminal_input).await;

    // A terminal resize changes the widget size → another resize frame.
    let resizes_before = frames_of(&fake)
        .iter()
        .filter(|f| matches!(f, PtyClientMessage::Resize { .. }))
        .count();
    rt.terminal.backend_mut().resize(160, 50);
    rt.sender().send(Msg::Resize).unwrap();
    until(&mut rt, "second resize frame", |_| {
        frames_of(&fake)
            .iter()
            .filter(|f| matches!(f, PtyClientMessage::Resize { .. }))
            .count()
            > resizes_before
    })
    .await;
    let last = frames_of(&fake)
        .into_iter()
        .rev()
        .find(|f| matches!(f, PtyClientMessage::Resize { .. }))
        .unwrap();
    let (cols2, rows2) = rt.app.pane_areas["relay:1"];
    assert_eq!(
        last,
        PtyClientMessage::Resize {
            cols: cols2,
            rows: rows2
        }
    );
    assert!(
        cols2 > cols && rows2 > rows_,
        "{cols2}x{rows2} vs {cols}x{rows_}"
    );
    rt.shutdown();
}

#[tokio::test]
async fn live_actions_post_the_ink_bodies_and_errors_reach_the_status_line() {
    let (fake, url) = start_fake().await;
    fake.extra_actions
        .lock()
        .unwrap()
        .insert("node:t-backend-auth".into(), reply_actions());
    let client = Client::new(url, Some(TOKEN.to_string()));
    let terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    let mut rt = Runtime::new(terminal, Source::Live(vec![Arc::new(client)]));
    rt.start().await.unwrap();
    until(&mut rt, "actions fetched", |rt| !rt.app.actions.is_empty()).await;
    assert!(screen(&rt).contains("[r] reply"), "{}", screen(&rt));

    // Enter opens the inspector with describe + story from the server.
    press(&rt, Key::ENTER);
    until(&mut rt, "inspector loaded", |rt| rt.app.inspector.loaded).await;
    let text = screen(&rt);
    assert!(
        text.contains("t-backend-auth  describe · story · actions"),
        "{text}"
    );
    assert!(
        text.contains("role: backend (claude-code, pane wP:p9)"),
        "{text}"
    );
    assert!(text.contains("backend completes t-backend-auth"), "{text}");
    assert!(text.contains("actions: [r] reply · Esc close"), "{text}");

    // r → reply editor → Enter posts { message } to /tasks/:id/reply.
    press(&rt, Key::char('r'));
    for c in "use the stub".chars() {
        press(&rt, Key::char(c));
    }
    until(&mut rt, "editor", |rt| rt.app.input_value == "use the stub").await;
    assert!(
        screen(&rt).contains("reply> use the stub"),
        "{}",
        screen(&rt)
    );
    press(&rt, Key::ENTER);
    until(&mut rt, "reply posted", |_| {
        !fake.posts.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(
        fake.posts.lock().unwrap()[0],
        (
            "/tasks/t-backend-auth/reply".to_string(),
            json!({ "message": "use the stub" })
        )
    );
    until(&mut rt, "notice", |rt| {
        rt.app.notice.as_deref() == Some("reply sent to t-backend-auth")
    })
    .await;

    // A failing POST shows up in the status line.
    *fake.fail_posts.lock().unwrap() = true;
    press(&rt, Key::char('r'));
    press(&rt, Key::char('y'));
    press(&rt, Key::ENTER);
    until(&mut rt, "error in status line", |rt| rt.app.error.is_some()).await;
    let last = rows(&rt).last().unwrap().clone();
    assert!(
        // Which of the things you typed did not arrive, not only which route was called.
        last.contains(
            "ERROR your reply did not send — POST /tasks/t-backend-auth/reply failed: 400"
        ),
        "{last}"
    );

    // f focuses the task's pane and records it on the server.
    press(&rt, Key::ESC);
    press(&rt, Key::char('f'));
    until(&mut rt, "focus posted", |_| {
        fake.posts
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _)| p == "/panes/relay:1/focus")
    })
    .await;
    assert_eq!(rt.app.region, Region::Panes);
    rt.shutdown();
}

#[tokio::test]
async fn live_without_a_token_is_rejected_and_reported() {
    let (_fake, url) = start_fake().await;
    let client = Client::new(url, None);
    let terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    let mut rt = Runtime::new(terminal, Source::Live(vec![Arc::new(client)]));
    rt.start().await.unwrap();
    let text = screen(&rt);
    assert!(text.contains("ERROR GET /graph failed: 401"), "{text}");
    rt.shutdown();
}

use support::{fixture_dir, pane, reply_actions};
