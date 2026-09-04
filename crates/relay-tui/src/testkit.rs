//! Shared helpers for the in-crate snapshot tests: fixtures, a `TestBackend` terminal and buffer-to-text.

use crate::app::{App, Mode};
use crate::model::*;
use crate::replay::Fixture;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;
use std::path::PathBuf;

pub fn fixture_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

pub fn fixture(name: &str) -> Fixture {
    Fixture::load(fixture_dir(name)).unwrap()
}

/// An `App` in replay mode loaded with the fixture (graph, state, panes, metrics).
pub fn replay_app(name: &str) -> App {
    let f = fixture(name);
    let mut app = App::new(Mode::Replay);
    app.set_state(f.state.clone());
    app.set_graph(f.graph.clone());
    app.set_panes(f.panes.clone(), f.focused_pane.clone());
    if let Some(m) = f.metrics.clone() {
        app.set_metrics(m);
    }
    app
}

pub fn demo_graph() -> Graph {
    serde_json::from_str(include_str!("../tests/support/demo-graph.json")).unwrap()
}

pub fn demo_pane(pane_id: &str, task_id: Option<&str>, role: &str, alive: bool) -> PaneInfo {
    PaneInfo {
        pane_id: pane_id.to_string(),
        task_id: task_id.map(str::to_string),
        role: role.to_string(),
        runtime: Some("claude-code".to_string()),
        cwd: "/tmp/wt".to_string(),
        pid: Some(4242),
        alive,
        cols: 120,
        rows: 40,
        cast_path: None,
        started_at: "2026-09-04T10:00:00Z".to_string(),
        exited_at: None,
        exit_code: None,
        timings: Some(PaneTimings {
            readiness_ms: Some(serde_json::Number::from(900)),
            prompt_accept_ms: Some(serde_json::Number::from(210)),
            render_p95_ms: serde_json::Number::from_f64(0.4),
            ..PaneTimings::default()
        }),
    }
}

pub fn terminal(width: u16, height: u16) -> Terminal<TestBackend> {
    Terminal::new(TestBackend::new(width, height)).unwrap()
}

/// Draw one frame and return the screen as trimmed text rows.
pub fn draw_rows(app: &mut App, width: u16, height: u16) -> Vec<String> {
    let mut term = terminal(width, height);
    term.draw(|frame| crate::ui::draw(frame, app)).unwrap();
    buffer_rows(term.backend().buffer())
}

pub fn buffer_rows(buffer: &Buffer) -> Vec<String> {
    let area = buffer.area;
    (0..area.height)
        .map(|y| {
            (0..area.width)
                .map(|x| buffer.cell((x, y)).map(|c| c.symbol()).unwrap_or(" "))
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

pub fn screen_text(rows: &[String]) -> String {
    rows.join("\n")
}
