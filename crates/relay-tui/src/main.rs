//! `relay-tui [--url http://127.0.0.1:7420] [--token …] [--repo .] [--replay <fixture dir>] [--frames N]
//! [--width W --height H] [--metrics-json]`. With `--frames N` the TUI renders the first frame plus N more
//! headlessly (no raw mode; the last frame is printed to stdout) — the demo fallback and the CI smoke test; otherwise it takes
//! over the terminal until `q`.
#![deny(warnings)]

use anyhow::{Context, Result};
use clap::Parser;
use crossterm::event::{Event, KeyEventKind};
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::Terminal;
use relay_tui::api::{resolve_token, Client};
use relay_tui::replay::Fixture;
use relay_tui::runtime::{Msg, Runtime, Source};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(
    name = "relay-tui",
    version,
    about = "Relay Terminal client for relayd"
)]
struct Args {
    /// relayd base URL.
    #[arg(long, default_value = "http://127.0.0.1:7420")]
    url: String,
    /// Session token (else RELAY_TOKEN, else <repo>/.relay/session.token).
    #[arg(long)]
    token: Option<String>,
    /// Repo root that holds `.relay/session.token`.
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    /// Render from a dumped fixture directory instead of a server.
    #[arg(long)]
    replay: Option<PathBuf>,
    /// Headless: draw the first frame plus this many into a virtual terminal, print the last one, exit.
    #[arg(long)]
    frames: Option<u64>,
    /// Virtual terminal width for --frames.
    #[arg(long, default_value_t = 100)]
    width: u16,
    /// Virtual terminal height for --frames.
    #[arg(long, default_value_t = 30)]
    height: u16,
    /// Print draw-time p50/p95 as JSON on exit.
    #[arg(long)]
    metrics_json: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let source = match &args.replay {
        Some(dir) => Source::Replay(Arc::new(
            Fixture::load(dir).with_context(|| format!("load fixture {}", dir.display()))?,
        )),
        None => {
            let token = resolve_token(
                args.token.clone(),
                std::env::var("RELAY_TOKEN").ok(),
                &args.repo,
            );
            Source::Live(Arc::new(Client::new(args.url.clone(), token)))
        }
    };

    if let Some(frames) = args.frames {
        let terminal = Terminal::new(TestBackend::new(args.width, args.height))?;
        let mut runtime = Runtime::new(terminal, source);
        runtime.start().await?;
        runtime.run(Some(frames.max(1))).await?;
        let buffer = runtime.terminal.backend().buffer().clone();
        for y in 0..buffer.area.height {
            let row: String = (0..buffer.area.width)
                .map(|x| buffer.cell((x, y)).map(|c| c.symbol()).unwrap_or(" "))
                .collect();
            println!("{}", row.trim_end());
        }
        if args.metrics_json {
            println!("{}", serde_json::to_string(&runtime.app.frames.summary())?);
        }
        runtime.shutdown();
        return Ok(());
    }

    crossterm::terminal::enable_raw_mode().context("raw mode (is stdout a terminal?)")?;
    let mut stdout = std::io::stdout();
    crossterm::execute!(stdout, crossterm::terminal::EnterAlternateScreen)?;
    let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
    let mut runtime = Runtime::new(terminal, source);
    let tx = runtime.sender();
    std::thread::spawn(move || loop {
        match crossterm::event::poll(Duration::from_millis(200)) {
            Ok(true) => match crossterm::event::read() {
                Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => {
                    if tx.send(Msg::Key(key.into())).is_err() {
                        return;
                    }
                }
                Ok(Event::Resize(_, _)) => {
                    if tx.send(Msg::Resize).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => return,
            },
            Ok(false) => {
                if tx.is_closed() {
                    return;
                }
            }
            Err(_) => return,
        }
    });
    let result = async {
        runtime.start().await?;
        runtime.run(None).await
    }
    .await;
    runtime.shutdown();
    let summary = runtime.app.frames.summary();
    drop(runtime);
    let _ = crossterm::execute!(std::io::stdout(), crossterm::terminal::LeaveAlternateScreen);
    let _ = crossterm::terminal::disable_raw_mode();
    result?;
    if args.metrics_json {
        println!("{}", serde_json::to_string(&summary)?);
    }
    Ok(())
}
