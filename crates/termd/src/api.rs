//! HTTP + WebSocket surface (`ptyRoutes` in `packages/protocol/src/pty.ts` minus `layouts`/`app`, plus
//! `GET /health` and `GET /metrics`). JSON bodies and responses match what the zod schemas serialise.
//! Auth: every route except `GET /health` needs the session token as `Authorization: Bearer <token>`; a
//! WebSocket client may present it as the subprotocol `relay.<token>` instead (echoed back on accept).
//! Port of `apps/relayd/src/http/pty.ts`, `apps/relayd/src/pty/ws.ts`, `apps/relayd/src/auth/token.ts`.

use crate::host::{
    Host, PaneNotFound, SpawnError, SpawnRequest, WaitOutputOptions, WaitOutputResult,
};
use crate::pane::Pane;
use crate::screen::{ScreenQuery, ScreenSource};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub const MISSING_TOKEN: &str = "missing session token: send Authorization: Bearer <termd token>";
pub const INVALID_TOKEN: &str = "invalid session token";
const PANE_NOT_FOUND: &str = "pane not found";

#[derive(Clone)]
pub struct AppState {
    pub host: Arc<Host>,
    pub token: Arc<String>,
}

pub fn router(state: AppState) -> Router {
    let guarded = Router::new()
        .route("/panes", get(list_panes).post(create_pane))
        .route("/panes/{id}", get(get_pane))
        .route("/panes/{id}/kill", post(kill_pane))
        .route("/panes/{id}/focus", post(focus_pane))
        .route("/panes/{id}/resize", post(resize_pane))
        .route("/panes/{id}/cast", get(cast))
        .route("/panes/{id}/screen", get(screen))
        .route("/panes/{id}/input", post(input))
        .route("/panes/{id}/wait-output", post(wait_output))
        .route("/panes/{id}/readiness", get(readiness))
        .route("/metrics", get(metrics))
        .route("/pty/{id}", get(pty_ws))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/health", get(health))
        .merge(guarded)
        .with_state(state)
}

// ---------- errors ----------

enum ApiError {
    NotFound(&'static str),
    BadRequest(Vec<String>),
    Internal(String),
}

impl From<PaneNotFound> for ApiError {
    fn from(_: PaneNotFound) -> Self {
        ApiError::NotFound(PANE_NOT_FOUND)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::NotFound(what) => {
                (StatusCode::NOT_FOUND, Json(json!({ "error": what }))).into_response()
            }
            ApiError::BadRequest(errors) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "errors": errors }))).into_response()
            }
            ApiError::Internal(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error })),
            )
                .into_response(),
        }
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::BadRequest(vec![msg.into()])
}

fn parse_body<T: DeserializeOwned>(bytes: &Bytes) -> Result<T, ApiError> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| bad("(body): invalid JSON"))?;
    if !raw.is_object() {
        return Err(bad("(body): expected an object"));
    }
    serde_json::from_value(raw).map_err(|e| bad(format!("(body): {e}")))
}

fn positive_u16(value: Option<i64>, name: &str) -> Result<Option<u16>, ApiError> {
    match value {
        None => Ok(None),
        Some(n) if n >= 1 && n <= i64::from(u16::MAX) => Ok(Some(n as u16)),
        Some(_) => Err(bad(format!("{name}: expected a positive integer"))),
    }
}

// ---------- auth ----------

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let mut parts = header.trim().splitn(2, char::is_whitespace);
    let scheme = parts.next()?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = parts.next()?.trim();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    Some(token.to_string())
}

/// The token a WebSocket client presented as the `relay.<token>` subprotocol.
pub fn upgrade_token(headers: &HeaderMap) -> Option<String> {
    let entries = headers.get_all(header::SEC_WEBSOCKET_PROTOCOL);
    for value in entries.iter().filter_map(|v| v.to_str().ok()) {
        for entry in value.split(',') {
            if let Some(token) = entry.trim().strip_prefix("relay.") {
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn verify_token(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_token(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let is_upgrade = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let presented = bearer_token(headers).or_else(|| {
        if is_upgrade {
            upgrade_token(headers)
        } else {
            None
        }
    });
    match presented {
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": MISSING_TOKEN })),
        )
            .into_response(),
        Some(t) if !verify_token(&state.token, &t) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": INVALID_TOKEN })),
        )
            .into_response(),
        Some(_) => next.run(req).await,
    }
}

// ---------- routes ----------

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn list_panes(State(state): State<AppState>) -> Json<Value> {
    let panes = state.host.list();
    match state.host.focused_pane() {
        Some(focused) => Json(json!({ "panes": panes, "focused_pane": focused })),
        None => Json(json!({ "panes": panes })),
    }
}

#[derive(Deserialize)]
struct CreatePaneBody {
    name: String,
    argv: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    cols: Option<i64>,
    #[serde(default)]
    rows: Option<i64>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
}

async fn create_pane(State(state): State<AppState>, body: Bytes) -> Result<Response, ApiError> {
    let body: CreatePaneBody = parse_body(&body)?;
    if body.argv.is_empty() {
        return Err(bad("argv: must not be empty"));
    }
    let mut env: Vec<(String, String)> = body.env.unwrap_or_default().into_iter().collect();
    env.sort();
    let req = SpawnRequest {
        name: body.name,
        argv: body.argv,
        cwd: body.cwd,
        env,
        cols: positive_u16(body.cols, "cols")?,
        rows: positive_u16(body.rows, "rows")?,
        prompt: body.prompt,
        task_id: body.task_id,
    };
    match state.host.spawn(req).await {
        Ok(pane_id) => {
            Ok((StatusCode::CREATED, Json(json!({ "pane_id": pane_id }))).into_response())
        }
        Err(SpawnError::EmptyArgv) => Err(bad("argv: must not be empty")),
        Err(SpawnError::Spawn(e)) => Err(ApiError::Internal(e)),
        Err(SpawnError::Prompt { pane_id, message }) => Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "pane_id": pane_id, "error": message })),
        )
            .into_response()),
    }
}

async fn get_pane(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        serde_json::to_value(state.host.require(&id)?.info()).unwrap_or(Value::Null),
    ))
}

async fn kill_pane(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.host.kill(&id, Host::default_grace()).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn focus_pane(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.host.focus(&id)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ResizeBody {
    cols: i64,
    rows: i64,
}

async fn resize_pane(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let pane = state.host.require(&id)?;
    let body: ResizeBody = parse_body(&body)?;
    let cols = positive_u16(Some(body.cols), "cols")?.unwrap_or_default();
    let rows = positive_u16(Some(body.rows), "rows")?.unwrap_or_default();
    pane.resize(cols, rows);
    Ok(Json(json!({ "ok": true })))
}

async fn cast(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let pane = state.host.require(&id)?;
    let bytes = std::fs::read(&pane.cast_path).map_err(|_| ApiError::NotFound("cast not found"))?;
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        bytes,
    )
        .into_response())
}

async fn screen(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let pane = state.host.require(&id)?;
    let source = match query.get("source").map(String::as_str) {
        None | Some("visible") => ScreenSource::Visible,
        Some("recent") => ScreenSource::Recent,
        Some(other) => {
            return Err(bad(format!(
                "source: expected visible or recent, got {other:?}"
            )))
        }
    };
    let lines = match query.get("lines") {
        None => 200,
        Some(raw) => match raw.parse::<i64>() {
            Ok(n) if (1..=5000).contains(&n) => n as usize,
            _ => return Err(bad("lines: expected an integer between 1 and 5000")),
        },
    };
    let snapshot = pane.snapshot(ScreenQuery { source, lines });
    Ok(Json(serde_json::to_value(snapshot).unwrap_or(Value::Null)))
}

#[derive(Deserialize)]
struct InputBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
}

async fn input(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let pane = state.host.require(&id)?;
    let body: InputBody = parse_body(&body)?;
    state
        .host
        .input(
            &pane,
            body.text.as_deref(),
            body.keys.as_deref().unwrap_or(&[]),
        )
        .map_err(|e| bad(format!("keys: {e}")))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct WaitOutputBody {
    #[serde(default, rename = "match")]
    matches: Option<String>,
    #[serde(default)]
    regex: Option<String>,
    #[serde(default)]
    timeout_ms: Option<i64>,
    #[serde(default)]
    source: Option<ScreenSource>,
}

async fn wait_output(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<WaitOutputResult>, ApiError> {
    let pane = state.host.require(&id)?;
    let body: WaitOutputBody = parse_body(&body)?;
    if body.matches.is_none() && body.regex.is_none() {
        return Err(bad("(body): match or regex is required"));
    }
    let regex = match body.regex.as_deref() {
        None => None,
        Some(source) => Some(regex::Regex::new(source).map_err(|e| bad(format!("regex: {e}")))?),
    };
    let timeout_ms = match body.timeout_ms {
        None => 60_000,
        Some(n) if (1..=600_000).contains(&n) => n as u64,
        Some(_) => return Err(bad("timeout_ms: expected a positive integer ≤ 600000")),
    };
    let opts = WaitOutputOptions {
        matches: body.matches,
        regex,
        timeout_ms,
        source: body.source.unwrap_or(ScreenSource::Recent),
    };
    Ok(Json(state.host.wait_output(pane, opts).await))
}

async fn readiness(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let pane = state.host.require(&id)?;
    Ok(Json(
        serde_json::to_value(pane.readiness()).unwrap_or(Value::Null),
    ))
}

async fn metrics(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.host.metrics()).unwrap_or(Value::Null))
}

// ---------- WebSocket ----------

/// Browser → termd.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientMessage {
    Input { data: String },
    Resize { cols: i64, rows: i64 },
    Ping,
}

/// termd → browser.
#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ServerMessage {
    Hello { pane: Box<crate::pane::PaneInfo> },
    Scrollback { data: String },
    Output { data: String },
    Exit { code: i32 },
    Pong,
}

async fn pty_ws(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(pane) = state.host.get(&id) else {
        return ApiError::NotFound(PANE_NOT_FOUND).into_response();
    };
    let protocol = format!("relay.{}", state.token);
    ws.protocols([protocol])
        .on_upgrade(move |socket| attach(socket, pane))
}

async fn send(socket: &mut WebSocket, msg: &ServerMessage) -> bool {
    match serde_json::to_string(msg) {
        Ok(text) => socket.send(Message::Text(text.into())).await.is_ok(),
        Err(_) => false,
    }
}

async fn attach(mut socket: WebSocket, pane: Arc<Pane>) {
    let sub = pane.subscribe();
    if !send(
        &mut socket,
        &ServerMessage::Hello {
            pane: Box::new(sub.info),
        },
    )
    .await
    {
        return;
    }
    if !send(
        &mut socket,
        &ServerMessage::Scrollback {
            data: BASE64.encode(&sub.scrollback),
        },
    )
    .await
    {
        return;
    }
    let mut output = sub.output;
    let mut exit = sub.exit;
    let mut exited = sub.exit_code;
    if let Some(code) = exited {
        if !send(&mut socket, &ServerMessage::Exit { code }).await {
            return;
        }
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Text(text))) => {
                    if !handle_client(&pane, text.as_str(), &mut socket).await {
                        break;
                    }
                }
                Some(Ok(_)) => {}
            },
            chunk = output.recv() => match chunk {
                Ok(bytes) => {
                    if !send(&mut socket, &ServerMessage::Output { data: BASE64.encode(bytes.as_slice()) }).await {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            code = async { exit_code_of(exit.wait_for(|v| v.is_some()).await) }, if exited.is_none() => {
                // Publish every chunk that arrived before the exit, then the exit itself.
                while let Ok(bytes) = output.try_recv() {
                    if !send(&mut socket, &ServerMessage::Output { data: BASE64.encode(bytes.as_slice()) }).await {
                        return;
                    }
                }
                if !send(&mut socket, &ServerMessage::Exit { code }).await {
                    return;
                }
                exited = Some(code);
            }
        }
    }
}

/// Reads the exit code out of a watch notification (the guard must not live across an await).
fn exit_code_of(
    changed: Result<tokio::sync::watch::Ref<'_, Option<i32>>, tokio::sync::watch::error::RecvError>,
) -> i32 {
    match changed {
        Ok(value) => value.unwrap_or(1),
        Err(_) => 1,
    }
}

/// Applies one client frame; malformed frames are ignored. Returns false when the socket is gone.
async fn handle_client(pane: &Pane, text: &str, socket: &mut WebSocket) -> bool {
    let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
        return true;
    };
    match msg {
        ClientMessage::Input { data } => {
            if let Ok(bytes) = BASE64.decode(data) {
                pane.write(&bytes);
            }
        }
        ClientMessage::Resize { cols, rows } => {
            if let (Ok(Some(cols)), Ok(Some(rows))) = (
                positive_u16(Some(cols), "cols"),
                positive_u16(Some(rows), "rows"),
            ) {
                pane.resize(cols, rows);
            }
        }
        ClientMessage::Ping => return send(socket, &ServerMessage::Pong).await,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn bearer_header_parsing() {
        assert_eq!(
            bearer_token(&headers(&[("authorization", "Bearer abc")])),
            Some("abc".into())
        );
        assert_eq!(
            bearer_token(&headers(&[("authorization", "bearer   abc  ")])),
            Some("abc".into())
        );
        assert_eq!(
            bearer_token(&headers(&[("authorization", "Basic abc")])),
            None
        );
        assert_eq!(bearer_token(&headers(&[("authorization", "Bearer")])), None);
        assert_eq!(
            bearer_token(&headers(&[("authorization", "Bearer a b")])),
            None
        );
        assert_eq!(bearer_token(&headers(&[])), None);
    }

    #[test]
    fn subprotocol_token_parsing() {
        assert_eq!(
            upgrade_token(&headers(&[("sec-websocket-protocol", "relay.abc")])),
            Some("abc".into())
        );
        assert_eq!(
            upgrade_token(&headers(&[("sec-websocket-protocol", "foo, relay.abc")])),
            Some("abc".into())
        );
        assert_eq!(
            upgrade_token(&headers(&[("sec-websocket-protocol", "relay.")])),
            None
        );
        assert_eq!(
            upgrade_token(&headers(&[("sec-websocket-protocol", "other")])),
            None
        );
        assert_eq!(upgrade_token(&headers(&[])), None);
    }

    #[test]
    fn token_comparison() {
        assert!(verify_token("abc", "abc"));
        assert!(!verify_token("abc", "abd"));
        assert!(!verify_token("abc", "ab"));
    }

    #[test]
    fn client_messages_parse_and_server_messages_serialise() {
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(r#"{"t":"ping"}"#).unwrap(),
            ClientMessage::Ping
        ));
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"teleport"}"#).is_err());
        assert!(serde_json::from_str::<ClientMessage>("not json").is_err());
        assert_eq!(
            serde_json::to_value(ServerMessage::Pong).unwrap(),
            json!({ "t": "pong" })
        );
        assert_eq!(
            serde_json::to_value(ServerMessage::Exit { code: 0 }).unwrap(),
            json!({ "t": "exit", "code": 0 })
        );
    }
}
