//! `termd --listen 127.0.0.1:0 --token <hex> --cast-dir <dir> [--first-pane N] [--quiet-ms 400] [--retry-ms 5000]
//! [--timeout-ms 30000]`. Prints exactly one line to stdout on boot: `termd listening on http://127.0.0.1:<port>`
//! (relayd parses it). Logs go to stderr (`RUST_LOG`).
#![deny(warnings)]

use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use termd::{HostConfig, PromptTimings, ServerConfig};

#[derive(Parser, Debug)]
#[command(name = "termd", version, about = "Relay Terminal PTY host")]
struct Args {
    /// Address to bind (port 0 picks a free port).
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
    /// Session token required on every route except GET /health.
    #[arg(long)]
    token: String,
    /// Directory for asciinema casts (`<cast-dir>/<pane>.cast`).
    #[arg(long)]
    cast_dir: PathBuf,
    /// First pane number to hand out (`relay:<n>`).
    #[arg(long, default_value_t = 1)]
    first_pane: u64,
    /// No output for this long = quiet (readiness window).
    #[arg(long, default_value_t = 400)]
    quiet_ms: u64,
    /// Press Enter again this long after the last Enter while the composer still holds the paste.
    #[arg(long, default_value_t = 5000)]
    retry_ms: u64,
    /// Give up on prompt delivery this long after spawn (pane left open).
    #[arg(long, default_value_t = 30_000)]
    timeout_ms: u64,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    if args.token.is_empty() {
        eprintln!("termd: --token must not be empty");
        return std::process::ExitCode::from(2);
    }
    let cfg = ServerConfig {
        listen: args.listen,
        token: args.token,
        host: HostConfig {
            cast_dir: args.cast_dir,
            first_pane: args.first_pane,
            timings: PromptTimings {
                quiet_ms: args.quiet_ms as f64,
                retry_ms: args.retry_ms,
                timeout_ms: args.timeout_ms,
            },
        },
    };
    let server = match termd::start(cfg).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("termd: cannot listen on {}: {e}", args.listen);
            return std::process::ExitCode::from(1);
        }
    };
    println!(
        "termd listening on http://{}:{}",
        server.addr.ip(),
        server.addr.port()
    );
    // SIGINT (ctrl-c) or SIGTERM (relayd's `stop()`): both shut panes down gracefully.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    tracing::info!("termd: shutting down");
    server
        .shutdown(Duration::from_millis(termd::pane::KILL_GRACE_MS))
        .await;
    std::process::ExitCode::SUCCESS
}
