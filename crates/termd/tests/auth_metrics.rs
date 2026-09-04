//! AC-5 — Session token on every route but `/health` (HTTP and before the WS upgrade); `GET /metrics` shape.
mod common;

use common::WsAuth;
use serde_json::json;
use std::collections::BTreeSet;
use std::time::Duration;

#[tokio::test]
async fn token_is_required_everywhere_except_health() {
    let srv = common::start().await;
    let health = srv.request("GET", "/health", None, None).await;
    assert_eq!(health.status, 200);
    assert_eq!(health.body["ok"], true);
    assert!(health.body["version"].is_string());
    let missing = srv.request("GET", "/panes", None, None).await;
    assert_eq!(missing.status, 401);
    assert!(missing.body["error"]
        .as_str()
        .unwrap()
        .contains("missing session token"));
    let wrong = srv.request("GET", "/panes", None, Some("nope")).await;
    assert_eq!(wrong.status, 401);
    assert_eq!(wrong.body, json!({ "error": "invalid session token" }));
    assert_eq!(srv.request("GET", "/metrics", None, None).await.status, 401);
    assert_eq!(
        srv.request("POST", "/panes", Some(json!({})), None)
            .await
            .status,
        401
    );
    assert_eq!(
        srv.request("GET", "/panes/relay:1", None, None)
            .await
            .status,
        401
    );
    let id = srv.spawn_sh("read x").await;
    // WebSocket: 401 before the upgrade and before the pane lookup; 404 for an unknown pane with a token.
    assert_eq!(srv.ws_with(&id, WsAuth::None).await.err(), Some(401));
    assert_eq!(
        srv.ws_with(&id, WsAuth::WrongSubprotocol).await.err(),
        Some(401)
    );
    assert_eq!(srv.ws_with("relay:9", WsAuth::None).await.err(), Some(401));
    assert_eq!(
        srv.ws_with("relay:9", WsAuth::Subprotocol).await.err(),
        Some(404)
    );
    let (mut via_protocol, accepted) = srv
        .ws_with(&id, WsAuth::Subprotocol)
        .await
        .expect("subprotocol auth");
    assert_eq!(
        accepted.as_deref(),
        Some(format!("relay.{}", srv.token).as_str())
    );
    via_protocol.frames_of("hello", 1).await;
    let (mut via_bearer, accepted) = srv.ws_with(&id, WsAuth::Bearer).await.expect("bearer auth");
    assert_eq!(accepted, None);
    via_bearer.frames_of("hello", 1).await;
    srv.shutdown().await;
}

const TIMING_KEYS: [&str; 10] = [
    "spawn_ms",
    "first_output_ms",
    "readiness_ms",
    "prompt_write_ms",
    "prompt_accept_ms",
    "prompt_retries",
    "render_p50_ms",
    "render_p95_ms",
    "output_bytes",
    "output_chunks",
];

fn keys(v: &serde_json::Value) -> BTreeSet<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
}

#[tokio::test]
async fn metrics_match_the_host_metrics_schema() {
    let srv = common::start().await;
    let res = srv
        .spawn(json!({
            "name": "backend", "cwd": srv.cwd(), "task_id": "t-1",
            "argv": ["sh", "-c", "head -c 2000 /dev/zero | tr '\\0' x; echo; echo done; exit 0"],
        }))
        .await;
    assert_eq!(res.status, 201);
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    srv.until(
        || async { srv.pane(&id).await["alive"] == false },
        Duration::from_secs(10),
    )
    .await;
    let alive = srv.spawn_sh("read x").await;

    let m = srv.get("/metrics").await.body;
    assert_eq!(m["host"], "relayterm");
    assert_eq!(
        keys(&m),
        [
            "host",
            "uptime_ms",
            "panes_spawned",
            "panes_alive",
            "prompt_failures",
            "panes"
        ]
        .into()
    );
    assert!(m["uptime_ms"].as_f64().unwrap() >= 0.0);
    assert_eq!(m["panes_spawned"], 2, "exited panes stay counted");
    assert_eq!(m["panes_alive"], 1);
    assert_eq!(m["prompt_failures"], 0);
    let panes = m["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 2);
    assert_eq!(
        keys(&panes[0]),
        ["pane_id", "role", "task_id", "timings"].into()
    );
    assert_eq!(keys(&panes[1]), ["pane_id", "role", "timings"].into());
    assert_eq!(panes[0]["pane_id"], id);
    assert_eq!(panes[0]["task_id"], "t-1");
    assert_eq!(panes[1]["pane_id"], alive);
    let t = &panes[0]["timings"];
    assert!(keys(t).iter().all(|k| TIMING_KEYS.contains(k)), "{t}");
    for key in [
        "spawn_ms",
        "first_output_ms",
        "render_p50_ms",
        "render_p95_ms",
    ] {
        assert!(t[key].as_f64().is_some_and(|v| v >= 0.0), "{key}: {t}");
    }
    let p50 = t["render_p50_ms"].as_f64().unwrap();
    let p95 = t["render_p95_ms"].as_f64().unwrap();
    assert!(p50 <= p95 && p95 < 100.0, "p50={p50} p95={p95}");
    assert!(t["output_bytes"].as_u64().unwrap() >= 2000, "{t}");
    assert!(t["output_chunks"].as_u64().unwrap() >= 1);
    assert!(
        t.get("prompt_retries").is_none(),
        "no prompt was delivered: {t}"
    );
    // PaneInfo carries the same object.
    assert_eq!(srv.pane(&id).await["timings"], *t);
    let fresh = srv.pane(&alive).await["timings"].clone();
    assert!(fresh["spawn_ms"].is_number());
    srv.shutdown().await;
}
