//! Shared harness for the integration tests: an in-process termd on port 0, an HTTP helper, and a WebSocket
//! client that collects parsed frames (the Rust twin of `apps/relayd/src/pty/test-server.ts`).
#![allow(dead_code)]

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const TOKEN: &str = "deadbeefcafe0123";

/// Fast prompt timings for tests (the TS suite uses the same numbers).
pub fn fast_timings() -> termd::PromptTimings {
    termd::PromptTimings {
        quiet_ms: 100.0,
        retry_ms: 300,
        timeout_ms: 3000,
    }
}

pub struct Resp {
    pub status: u16,
    pub body: Value,
    pub text: String,
}

pub struct TestServer {
    server: Option<termd::Server>,
    pub addr: SocketAddr,
    pub url: String,
    pub ws_url: String,
    pub token: String,
    pub dir: tempfile::TempDir,
    pub cast_dir: PathBuf,
    http: reqwest::Client,
}

pub async fn start() -> TestServer {
    start_with(fast_timings(), 1).await
}

pub async fn start_with(timings: termd::PromptTimings, first_pane: u64) -> TestServer {
    let dir = tempfile::Builder::new()
        .prefix("relay-")
        .tempdir()
        .expect("tempdir");
    let cast_dir = dir.path().join("casts");
    let server = termd::start(termd::ServerConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: TOKEN.to_string(),
        host: termd::HostConfig {
            cast_dir: cast_dir.clone(),
            first_pane,
            timings,
        },
    })
    .await
    .expect("termd starts");
    let addr = server.addr;
    TestServer {
        server: Some(server),
        addr,
        url: format!("http://{addr}"),
        ws_url: format!("ws://{addr}"),
        token: TOKEN.to_string(),
        dir,
        cast_dir,
        http: reqwest::Client::new(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WsAuth {
    None,
    Subprotocol,
    WrongSubprotocol,
    Bearer,
}

impl TestServer {
    pub fn host(&self) -> &termd::Host {
        &self.server.as_ref().expect("server running").host
    }

    pub fn cwd(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    pub async fn shutdown(mut self) {
        if let Some(server) = self.server.take() {
            server.shutdown(Duration::from_millis(50)).await;
        }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        auth: Option<&str>,
    ) -> Resp {
        let mut req = self
            .http
            .request(method.parse().unwrap(), format!("{}{}", self.url, path));
        if let Some(token) = auth {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        if let Some(body) = body {
            req = req
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let res = req.send().await.expect("request");
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
        Resp { status, body, text }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.request("GET", path, None, Some(&self.token)).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Resp {
        self.request("POST", path, Some(body), Some(&self.token))
            .await
    }

    pub async fn post_raw(&self, path: &str, body: &str) -> Resp {
        let res = self
            .http
            .post(format!("{}{}", self.url, path))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request");
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        Resp {
            status,
            body: serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        }
    }

    /// `POST /panes` with `sh -c <script>` in the temp dir; returns the pane id.
    pub async fn spawn_sh(&self, script: &str) -> String {
        let res = self
            .spawn(json!({ "name": "backend", "argv": ["sh", "-c", script], "cwd": self.cwd() }))
            .await;
        assert_eq!(res.status, 201, "spawn failed: {}", res.text);
        res.body["pane_id"].as_str().expect("pane_id").to_string()
    }

    pub async fn spawn(&self, body: Value) -> Resp {
        self.post("/panes", body).await
    }

    pub async fn pane(&self, pane_id: &str) -> Value {
        let res = self.get(&format!("/panes/{pane_id}")).await;
        assert_eq!(res.status, 200, "{}", res.text);
        res.body
    }

    pub async fn screen(&self, pane_id: &str, query: &str) -> Value {
        let res = self.get(&format!("/panes/{pane_id}/screen{query}")).await;
        assert_eq!(res.status, 200, "{}", res.text);
        res.body
    }

    pub async fn readiness(&self, pane_id: &str) -> Value {
        let res = self.get(&format!("/panes/{pane_id}/readiness")).await;
        assert_eq!(res.status, 200, "{}", res.text);
        res.body
    }

    pub async fn wait_output(&self, pane_id: &str, body: Value) -> Value {
        let res = self
            .post(&format!("/panes/{pane_id}/wait-output"), body)
            .await;
        assert_eq!(res.status, 200, "{}", res.text);
        res.body
    }

    pub async fn cast_events(&self, pane_id: &str) -> Vec<Value> {
        let res = self.get(&format!("/panes/{pane_id}/cast")).await;
        assert_eq!(res.status, 200, "{}", res.text);
        res.text
            .trim_end()
            .split('\n')
            .map(|l| serde_json::from_str(l).expect("cast line is JSON"))
            .collect()
    }

    /// Polls `pred` every 20 ms until it returns true (panics after `timeout`).
    pub async fn until<F, Fut>(&self, mut pred: F, timeout: Duration)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = bool>,
    {
        let end = Instant::now() + timeout;
        while !pred().await {
            assert!(Instant::now() < end, "condition not met in time");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub async fn ws(&self, pane_id: &str) -> Result<WsClient, u16> {
        self.ws_with(pane_id, WsAuth::Subprotocol)
            .await
            .map(|(c, _)| c)
    }

    /// Opens `/pty/:id`; `Err(status)` when refused before the upgrade. Returns the accepted subprotocol.
    pub async fn ws_with(
        &self,
        pane_id: &str,
        auth: WsAuth,
    ) -> Result<(WsClient, Option<String>), u16> {
        self.ws_path(&format!("/pty/{pane_id}"), auth).await
    }

    pub async fn ws_path(
        &self,
        path: &str,
        auth: WsAuth,
    ) -> Result<(WsClient, Option<String>), u16> {
        let mut request = format!("{}{}", self.ws_url, path)
            .into_client_request()
            .expect("ws request");
        match auth {
            WsAuth::None => {}
            WsAuth::Subprotocol => {
                request.headers_mut().insert(
                    "sec-websocket-protocol",
                    HeaderValue::from_str(&format!("relay.{}", self.token)).unwrap(),
                );
            }
            WsAuth::WrongSubprotocol => {
                request.headers_mut().insert(
                    "sec-websocket-protocol",
                    HeaderValue::from_static("relay.nope"),
                );
            }
            WsAuth::Bearer => {
                request.headers_mut().insert(
                    "authorization",
                    HeaderValue::from_str(&format!("Bearer {}", self.token)).unwrap(),
                );
            }
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, response)) => {
                let accepted = response
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                Ok((
                    WsClient {
                        stream,
                        frames: Vec::new(),
                    },
                    accepted,
                ))
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => Err(res.status().as_u16()),
            Err(e) => panic!("ws connect: {e}"),
        }
    }
}

pub struct WsClient {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub frames: Vec<Value>,
}

pub fn b64(s: &str) -> String {
    BASE64.encode(s.as_bytes())
}

pub fn unb64(s: &str) -> String {
    String::from_utf8_lossy(&BASE64.decode(s).expect("base64")).into_owned()
}

impl WsClient {
    pub async fn send(&mut self, msg: Value) {
        self.send_raw(&msg.to_string()).await;
    }

    pub async fn send_raw(&mut self, text: &str) {
        self.stream
            .send(Message::Text(text.to_string().into()))
            .await
            .expect("ws send");
    }

    /// Reads one frame into `frames`; false on timeout or close.
    pub async fn pump(&mut self, timeout: Duration) -> bool {
        match tokio::time::timeout(timeout, self.stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                self.frames
                    .push(serde_json::from_str(text.as_str()).expect("frame is JSON"));
                true
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => false,
            Ok(Some(Ok(_))) => true,
            Err(_) => false,
        }
    }

    pub fn types(&self) -> Vec<String> {
        self.frames
            .iter()
            .map(|f| f["t"].as_str().unwrap_or("?").to_string())
            .collect()
    }

    fn pick(&self, t: &str) -> Vec<Value> {
        self.frames
            .iter()
            .filter(|f| f["t"] == t)
            .cloned()
            .collect()
    }

    /// Waits until `count` frames of type `t` have arrived (from the start) and returns them.
    pub async fn frames_of(&mut self, t: &str, count: usize) -> Vec<Value> {
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            let got = self.pick(t);
            if got.len() >= count {
                return got;
            }
            let left = end.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero() && self.pump(left).await,
                "no {count} {t} frame(s); got {:?}",
                self.types()
            );
        }
    }

    /// Everything the pane has shown this client: the scrollback replayed on connect plus live output.
    pub fn output(&self) -> String {
        self.frames
            .iter()
            .filter(|f| f["t"] == "output" || f["t"] == "scrollback")
            .map(|f| unb64(f["data"].as_str().unwrap_or("")))
            .collect()
    }

    /// Live `output` frames only (what arrived after the replayed scrollback).
    pub fn live(&self) -> String {
        self.frames
            .iter()
            .filter(|f| f["t"] == "output")
            .map(|f| unb64(f["data"].as_str().unwrap_or("")))
            .collect()
    }

    pub async fn wait_output_contains(&mut self, needle: &str) {
        let end = Instant::now() + Duration::from_secs(15);
        while !self.output().contains(needle) {
            let left = end.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero() && self.pump(left).await,
                "{needle:?} never arrived; output={:?}",
                self.output()
            );
        }
    }

    /// Reads frames until nothing arrives for `quiet`.
    pub async fn settle(&mut self, quiet: Duration) {
        while self.pump(quiet).await {}
    }

    pub async fn close(mut self) {
        let _ = self.stream.close(None).await;
    }
}

pub fn read_file(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}
