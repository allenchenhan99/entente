//! Shared helpers for the integration tests: fixture loading and a hand-written graph with an inbox.
#![allow(dead_code)]

use relay_tui::model::*;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub fn fixture_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

pub fn load<T: DeserializeOwned>(name: &str, file: &str) -> T {
    let path = fixture_dir(name).join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn graph(name: &str) -> Graph {
    load(name, "graph.json")
}

pub fn state(name: &str) -> State {
    load(name, "state.json")
}

pub fn actions(name: &str) -> BTreeMap<String, Vec<ObjectAction>> {
    load(name, "actions.json")
}

pub fn describes(name: &str) -> BTreeMap<String, ObjectDescription> {
    load(name, "describe.json")
}

pub fn stories(name: &str) -> BTreeMap<String, Vec<String>> {
    load(name, "stories.json")
}

pub fn pane(pane_id: &str, task_id: Option<&str>, role: &str, alive: bool) -> PaneInfo {
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

/// A graph in the middle of the demo: backend asks a question (attention edge + inbox item with the
/// clarify / cancel actions), frontend awaits a human review, e2e is blocked on backend.
pub fn demo_graph() -> Graph {
    serde_json::from_str(include_str!("demo-graph.json")).unwrap()
}

pub fn reply_actions() -> Vec<ObjectAction> {
    vec![ObjectAction {
        key: "r".into(),
        label: "reply to backend".into(),
        kind: ActionKind::Reply,
        target: ActionTarget {
            task_id: Some("t-backend-auth".into()),
            ..ActionTarget::default()
        },
    }]
}
