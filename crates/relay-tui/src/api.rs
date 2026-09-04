//! The relayd client: typed GET/POST over HTTP, the `/events` SSE loop and the `/pty/:id` WebSocket, all with
//! the session token (`--token`, `RELAY_TOKEN`, or `<repo>/.relay/session.token`) sent as
//! `Authorization: Bearer …` / the `relay.<token>` subprotocol.

use crate::app::Command;
use crate::model::*;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use std::path::Path;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub const SESSION_TOKEN_FILE: &str = ".relay/session.token";

/// `--token` › `RELAY_TOKEN` › `<repo>/.relay/session.token`.
pub fn resolve_token(flag: Option<String>, env_token: Option<String>, repo: &Path) -> Option<String> {
    if let Some(t) = flag.filter(|t| !t.trim().is_empty()) {
        return Some(t.trim().to_string());
    }
    if let Some(t) = env_token.filter(|t| !t.trim().is_empty()) {
        return Some(t.trim().to_string());
    }
    std::fs::read_to_string(repo.join(SESSION_TOKEN_FILE))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

#[derive(Clone)]
pub struct Client {
    base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl Client {
    pub fn new(base: impl Into<String>, token: Option<String>) -> Self {
        let base = base.into().trim_end_matches('/').to_string();
        Self {
            base,
            token,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn ws_url(&self, path: &str) -> String {
        let base = if let Some(rest) = self.base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.base.clone()
        };
        format!("{base}{path}")
    }

    fn authorize(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => req.header(AUTHORIZATION, format!("Bearer {t}")),
            None => req,
        }
    }

    pub async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .authorize(self.http.get(self.url(path)))
            .send()
            .await
            .with_context(|| format!("GET {path}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("GET {path} failed: {} {}", status.as_u16(), text.trim()));
        }
        serde_json::from_str(&text).with_context(|| format!("GET {path}: unexpected JSON"))
    }

    /// `POST` a JSON body; the error text is the Ink `commands.ts` one (`POST <url> failed: <status>`).
    pub async fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
        let response = self
            .authorize(self.http.post(self.url(path)))
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {path}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let detail = text.trim();
            let detail = if detail.is_empty() {
                String::new()
            } else {
                format!(" {detail}")
            };
            return Err(anyhow!("POST {path} failed: {}{detail}", status.as_u16()));
        }
        Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
    }

    pub async fn state(&self) -> Result<State> {
        self.get_json("/state").await
    }

    pub async fn graph(&self) -> Result<Graph> {
        self.get_json("/graph").await
    }

    pub async fn panes(&self) -> Result<(Vec<PaneInfo>, Option<String>)> {
        Ok(self.get_json::<PanesResponse>("/panes").await?.into_panes())
    }

    pub async fn metrics(&self) -> Result<HostMetrics> {
        self.get_json("/metrics").await
    }

    fn object_path(r: &GraphObjectRef, leaf: &str) -> String {
        format!("/graph/{}/{}/{leaf}", r.kind.as_str(), encode_component(&r.id))
    }

    pub async fn describe(&self, r: &GraphObjectRef) -> Result<ObjectDescription> {
        self.get_json(&Self::object_path(r, "describe")).await
    }

    pub async fn story(&self, r: &GraphObjectRef, limit: usize) -> Result<Vec<String>> {
        let path = format!("{}?limit={limit}", Self::object_path(r, "story"));
        Ok(self.get_json::<ObjectStory>(&path).await?.lines)
    }

    pub async fn actions(&self, r: &GraphObjectRef) -> Result<Vec<ObjectAction>> {
        self.get_json(&Self::object_path(r, "actions")).await
    }

    pub async fn story_log(&self, since: u64, limit: usize) -> Result<StoryLog> {
        self.get_json(&format!("/story?since={since}&limit={limit}")).await
    }

    pub async fn command(&self, command: &Command) -> Result<()> {
        self.post_json(&command.route(), &command.body()).await?;
        Ok(())
    }

    pub async fn focus_pane(&self, pane_id: &str) -> Result<()> {
        self.post_json(&format!("/panes/{pane_id}/focus"), &serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// Open `GET /events?since=` and hand every `data:` payload to `on_event` until the stream ends.
    /// Returns when the server closes the stream or the connection drops.
    pub async fn events(&self, since: u64, mut on_event: impl FnMut(EventEnvelope)) -> Result<()> {
        let response = self
            .authorize(self.http.get(self.url(&format!("/events?since={since}"))))
            .header("accept", "text/event-stream")
            .send()
            .await
            .context("GET /events")?;
        if !response.status().is_success() {
            return Err(anyhow!("GET /events failed: {}", response.status().as_u16()));
        }
        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("SSE read")?;
            for message in parser.feed(&chunk) {
                if let Ok(event) = serde_json::from_str::<EventEnvelope>(&message.data) {
                    on_event(event);
                } else if let Some(seq) = message.id.as_deref().and_then(|s| s.parse::<u64>().ok()) {
                    on_event(EventEnvelope {
                        seq,
                        ts: None,
                        task_id: None,
                        event_type: None,
                        extra: Default::default(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Connect the `/pty/:id` WebSocket with the `relay.<token>` subprotocol.
    pub async fn connect_pty(&self, pane_id: &str) -> Result<WsStream> {
        let url = self.ws_url(&format!("/pty/{pane_id}"));
        let mut request = url
            .clone()
            .into_client_request()
            .with_context(|| format!("ws url {url}"))?;
        if let Some(t) = &self.token {
            request.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_str(&format!("relay.{t}")).context("token header")?,
            );
        }
        let (stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .with_context(|| format!("connect {url}"))?;
        Ok(stream)
    }
}

/// `encodeURIComponent` for object ids (`contract:t-a`, `dep:t-a->t-b`).
pub fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// A minimal `text/event-stream` parser: `data:` lines join with `\n`, a blank line dispatches, `:` comments
/// (relayd's `: ping`) are ignored.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
    id: Option<String>,
    event: Option<String>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(SseMessage {
                        id: self.id.take(),
                        event: self.event.take(),
                        data: self.data.join("\n"),
                    });
                    self.data.clear();
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "data" => self.data.push(value.to_string()),
                "id" => self.id = Some(value.to_string()),
                "event" => self.event = Some(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_split_chunks_comments_and_ids() {
        let mut p = SseParser::default();
        assert!(p.feed(b": ping\n\nevent: relay\nid: 7\ndata: {\"seq\":").is_empty());
        let out = p.feed(b" 7}\n\ndata: a\ndata: b\n\n");
        assert_eq!(
            out,
            vec![
                SseMessage {
                    id: Some("7".into()),
                    event: Some("relay".into()),
                    data: "{\"seq\": 7}".into()
                },
                SseMessage {
                    id: None,
                    event: None,
                    data: "a\nb".into()
                }
            ]
        );
        let out = p.feed(b"data:x\r\n\r\n");
        assert_eq!(out[0].data, "x");
    }

    #[test]
    fn encodes_object_ids_like_encode_uri_component() {
        assert_eq!(encode_component("contract:t-backend-auth"), "contract%3At-backend-auth");
        assert_eq!(encode_component("dep:t-a->t-b"), "dep%3At-a-%3Et-b");
        assert_eq!(encode_component("planner"), "planner");
    }

    #[test]
    fn token_resolution_order() {
        let dir = tempfile::Builder::new().prefix("relay-").tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".relay")).unwrap();
        std::fs::write(dir.path().join(SESSION_TOKEN_FILE), "filetoken\n").unwrap();
        assert_eq!(resolve_token(Some("flag".into()), Some("env".into()), dir.path()).as_deref(), Some("flag"));
        assert_eq!(resolve_token(None, Some("env".into()), dir.path()).as_deref(), Some("env"));
        assert_eq!(resolve_token(None, None, dir.path()).as_deref(), Some("filetoken"));
        assert_eq!(resolve_token(Some("  ".into()), None, dir.path()).as_deref(), Some("filetoken"));
        let empty = tempfile::Builder::new().prefix("relay-").tempdir().unwrap();
        assert_eq!(resolve_token(None, None, empty.path()), None);
    }

    #[test]
    fn urls_and_ws_urls() {
        let c = Client::new("http://127.0.0.1:7420/", Some("t".into()));
        assert_eq!(c.url("/graph"), "http://127.0.0.1:7420/graph");
        assert_eq!(c.ws_url("/pty/relay:1"), "ws://127.0.0.1:7420/pty/relay:1");
        assert_eq!(Client::object_path(&GraphObjectRef::edge("contract:t-a"), "story"), "/graph/edge/contract%3At-a/story");
    }
}
