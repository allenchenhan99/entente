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
    serde_json::from_value(serde_json::json!({
        "nodes": [
            { "id": "human", "kind": "human", "label": "human", "column": 0, "status": "attention", "badge": "! 2" },
            { "id": "planner", "kind": "planner", "label": "planner", "column": 0, "status": "done" },
            { "id": "t-backend-auth", "kind": "agent", "label": "backend", "task_id": "t-backend-auth", "runtime": "idle",
              "task_state": "proposed", "handoff_state": "needs_clarification", "column": 1, "status": "attention", "badge": "? 2" },
            { "id": "t-frontend-login", "kind": "agent", "label": "frontend", "task_id": "t-frontend-login", "runtime": "working",
              "task_state": "awaiting_verification", "handoff_state": "evidence_submitted", "column": 1, "status": "working", "badge": "a1" },
            { "id": "t-e2e-tests", "kind": "agent", "label": "e2e", "task_id": "t-e2e-tests", "runtime": "unspawned",
              "task_state": "pending", "handoff_state": "draft", "column": 1, "status": "blocked", "badge": "◐ blocked" },
            { "id": "verifier", "kind": "verifier", "label": "verifier", "column": 2, "status": "working" }
        ],
        "edges": [
            { "id": "contract:t-backend-auth", "kind": "contract", "from": "planner", "to": "t-backend-auth", "task_id": "t-backend-auth",
              "label": "v1 ? 2", "status": "attention", "attention": true, "version": 1 },
            { "id": "contract:t-frontend-login", "kind": "contract", "from": "planner", "to": "t-frontend-login", "task_id": "t-frontend-login",
              "label": "v2 ✓", "status": "done", "attention": false, "version": 2 },
            { "id": "question:t-backend-auth", "kind": "question", "from": "t-backend-auth", "to": "human", "task_id": "t-backend-auth",
              "label": "? 2", "status": "attention", "attention": true },
            { "id": "evidence:t-frontend-login", "kind": "evidence", "from": "t-frontend-login", "to": "verifier", "task_id": "t-frontend-login",
              "label": "AC-3 ⏳", "status": "attention", "attention": true },
            { "id": "dep:t-backend-auth->t-e2e-tests", "kind": "dependency", "from": "t-backend-auth", "to": "t-e2e-tests", "task_id": "t-e2e-tests",
              "label": "waits", "status": "blocked", "attention": false }
        ],
        "inbox": [
            { "id": "question:t-backend-auth", "kind": "task_question", "mission_id": "m-001", "task_id": "t-backend-auth",
              "title": "backend asks 2 questions (v1)", "detail": ["Q1 Which auth method?", "Q2 Link expiry?"], "since": "2026-09-05T10:05:00+08:00",
              "ref": { "kind": "edge", "id": "contract:t-backend-auth" },
              "actions": [
                { "key": "a", "label": "answer Q1", "kind": "clarify", "target": { "task_id": "t-backend-auth", "question_ids": ["Q1", "Q2"] } },
                { "key": "x", "label": "cancel t-backend-auth", "kind": "cancel", "target": { "task_id": "t-backend-auth" } }
              ] },
            { "id": "review:t-frontend-login:AC-3", "kind": "human_review", "mission_id": "m-001", "task_id": "t-frontend-login",
              "title": "frontend needs a human review of AC-3", "detail": ["AC-3: the login page is readable"],
              "ref": { "kind": "edge", "id": "evidence:t-frontend-login" },
              "actions": [
                { "key": "p", "label": "mark AC-3 passed", "kind": "review", "target": { "task_id": "t-frontend-login", "criterion_id": "AC-3" } },
                { "key": "f", "label": "mark AC-3 failed", "kind": "review", "target": { "task_id": "t-frontend-login", "criterion_id": "AC-3" } }
              ] }
        ],
        "seq": 21
    }))
    .unwrap()
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
