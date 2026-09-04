//! AC-1: every JSON the dump script writes round-trips through the serde model without losing a field.

use relay_tui::model::*;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn fixture(name: &str, file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str, file: &str) -> T {
    let raw = fixture(name, file);
    let typed: T = serde_json::from_value(raw.clone())
        .unwrap_or_else(|e| panic!("{name}/{file} does not parse: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(back, raw, "{name}/{file} lost fields in the round trip");
    typed
}

#[test]
fn model_round_trips_live_1() {
    let graph: Graph = round_trip("live-1", "graph.json");
    assert_eq!(graph.seq, Some(43));
    assert!(graph.node("t-backend-auth").is_some());
    let state: State = round_trip("live-1", "state.json");
    assert_eq!(state.mission().unwrap().mission.title, "Add secure login to this application.");
    assert!(state.tasks.contains_key("t-backend-auth"));
    let story: StoryLog = round_trip("live-1", "story.json");
    assert_eq!(story.items.first().unwrap().seq, 1);
    let panes: PanesResponse = round_trip("live-1", "panes.json");
    let _ = panes.into_panes();
    round_trip::<BTreeMap<String, ObjectDescription>>("live-1", "describe.json");
    round_trip::<BTreeMap<String, Vec<String>>>("live-1", "stories.json");
    let actions: BTreeMap<String, Vec<ObjectAction>> = round_trip("live-1", "actions.json");
    assert_eq!(actions["node:t-backend-auth"][0].kind, ActionKind::Focus);
}

#[test]
fn model_round_trips_live_7() {
    let graph: Graph = round_trip("live-7", "graph.json");
    assert_eq!(graph.edge("contract:t-token-store").unwrap().label, "sub ✓ merged");
    round_trip::<State>("live-7", "state.json");
    round_trip::<StoryLog>("live-7", "story.json");
    round_trip::<PanesResponse>("live-7", "panes.json");
    round_trip::<BTreeMap<String, ObjectDescription>>("live-7", "describe.json");
    round_trip::<BTreeMap<String, Vec<String>>>("live-7", "stories.json");
    round_trip::<BTreeMap<String, Vec<ObjectAction>>>("live-7", "actions.json");
}

#[test]
fn model_round_trips_pane_info_and_metrics() {
    let pane = serde_json::json!({
        "pane_id": "relay:1", "task_id": "t-backend-auth", "role": "backend", "runtime": "claude-code",
        "cwd": "/tmp/wt", "pid": 42, "alive": true, "cols": 120, "rows": 40,
        "cast_path": "/tmp/casts/relay:1.cast", "started_at": "2026-09-04T10:00:00Z",
        "timings": { "spawn_ms": 12.5, "readiness_ms": 900, "prompt_accept_ms": 210, "render_p95_ms": 0.4, "output_chunks": 3 }
    });
    let typed: PaneInfo = serde_json::from_value(pane.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), pane);
    let panes = serde_json::json!({ "panes": [pane], "focused_pane": "relay:1" });
    let typed: PanesResponse = serde_json::from_value(panes.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), panes);
    let list = serde_json::json!([]);
    let typed: PanesResponse = serde_json::from_value(list.clone()).unwrap();
    assert_eq!(typed.into_panes().0.len(), 0);
    let metrics = serde_json::json!({
        "host": "relay", "uptime_ms": 1000, "panes_spawned": 1, "panes_alive": 1, "prompt_failures": 0,
        "panes": [{ "pane_id": "relay:1", "role": "backend", "timings": { "readiness_ms": 900 } }]
    });
    let typed: HostMetrics = serde_json::from_value(metrics.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), metrics);
    assert_eq!(millis(&typed.pane("relay:1").unwrap().readiness_ms), Some(900.0));
}

#[test]
fn model_pty_frames_match_the_zod_discriminated_unions() {
    let hello = serde_json::json!({ "t": "hello", "pane": { "pane_id": "relay:1", "role": "backend", "cwd": "/x", "alive": true, "cols": 80, "rows": 24, "started_at": "t" } });
    assert!(matches!(serde_json::from_value::<PtyServerMessage>(hello).unwrap(), PtyServerMessage::Hello { .. }));
    let out: PtyServerMessage = serde_json::from_str(r#"{"t":"output","data":"aGk="}"#).unwrap();
    assert_eq!(out, PtyServerMessage::Output { data: "aGk=".into() });
    let exit: PtyServerMessage = serde_json::from_str(r#"{"t":"exit","code":0}"#).unwrap();
    assert_eq!(exit, PtyServerMessage::Exit { code: 0 });
    assert_eq!(serde_json::to_string(&PtyClientMessage::Input { data: "eA==".into() }).unwrap(), r#"{"t":"input","data":"eA=="}"#);
    assert_eq!(serde_json::to_string(&PtyClientMessage::Resize { cols: 100, rows: 30 }).unwrap(), r#"{"t":"resize","cols":100,"rows":30}"#);
    assert_eq!(serde_json::to_string(&PtyClientMessage::Ping).unwrap(), r#"{"t":"ping"}"#);
}
