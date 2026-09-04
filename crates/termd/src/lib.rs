//! termd — the Relay Terminal PTY host (R1 of PRD §23): a drop-in replacement for relayd's TypeScript PTY host.
//! Same HTTP/WebSocket protocol as `packages/protocol/src/pty.ts`, same readiness heuristics and prompt-delivery
//! rules as `apps/relayd/src/pty/{readiness,host,pane}.ts`, same asciinema casts, plus efficiency metrics.
#![deny(warnings)]

pub mod api;
pub mod host;
pub mod keys;
pub mod metrics;
pub mod pane;
pub mod readiness;
pub mod recorder;
pub mod ring;
pub mod screen;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

pub use host::{Host, HostConfig, PromptTimings};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub token: String,
    pub host: HostConfig,
}

/// A running termd: the bound address, the host (for in-process inspection) and the serving task.
pub struct Server {
    pub addr: SocketAddr,
    pub host: Arc<Host>,
    handle: tokio::task::JoinHandle<()>,
}

impl Server {
    /// Stops accepting connections and terminates every pane (SIGTERM, then SIGKILL after `grace`).
    pub async fn shutdown(self, grace: Duration) {
        self.handle.abort();
        self.host.kill_all(grace).await;
    }
}

/// Binds `cfg.listen` (port 0 = ephemeral) and serves the API in a background task.
pub async fn start(cfg: ServerConfig) -> std::io::Result<Server> {
    let host = Arc::new(Host::new(cfg.host));
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    let addr = listener.local_addr()?;
    let app = api::router(api::AppState {
        host: host.clone(),
        token: Arc::new(cfg.token),
    });
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("termd server stopped: {e}");
        }
    });
    Ok(Server { addr, host, handle })
}
