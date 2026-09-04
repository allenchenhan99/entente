//! AC-4 — Readiness over a real PTY and the wait-output long-poll (`matched` / `timeout` / `exited`).
mod common;

use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn not_ready_while_output_streams_and_ready_once_a_prompt_is_idle() {
    let srv = common::start().await;
    let id = srv
        .spawn_sh("yes | head -c 100000; sleep 0.05; printf '$ '; read x")
        .await;
    // The first readiness with output on screen is taken while `yes` streams (or inside the quiet window).
    let mut streaming = None;
    let end = Instant::now() + Duration::from_secs(10);
    while streaming.is_none() {
        assert!(Instant::now() < end, "no output seen");
        let r = srv.readiness(&id).await;
        if r["detail"] != "screen is empty" {
            streaming = Some(r);
        }
    }
    let streaming = streaming.unwrap();
    assert_eq!(streaming["pane_id"], id);
    assert_eq!(streaming["ready"], false, "{streaming}");
    assert_eq!(streaming["source"], "screen");
    assert!(streaming["observed_at"].is_string());
    srv.until(
        || async { srv.readiness(&id).await["ready"] == true },
        Duration::from_secs(5),
    )
    .await;
    let ready = srv.readiness(&id).await;
    assert_eq!(ready["source"], "screen");
    assert!(ready["detail"].as_str().unwrap().contains('$'), "{ready}");
    assert!(srv.pane(&id).await["timings"]["readiness_ms"].is_number());
    assert_eq!(srv.get("/panes/relay:77/readiness").await.status, 404);
    srv.post(&format!("/panes/{id}/kill"), json!({})).await;
    let gone = srv.readiness(&id).await;
    assert_eq!(gone["ready"], false);
    assert_eq!(gone["source"], "unknown");
    assert_eq!(gone["detail"], "pane exited");
    srv.shutdown().await;
}

#[tokio::test]
async fn wait_output_resolves_on_a_later_echo_times_out_and_reports_exit() {
    let srv = common::start().await;
    let id = srv
        .spawn_sh("echo first; read x; echo \"got $x\"; read y; exit 0")
        .await;
    let first = srv
        .wait_output(
            &id,
            json!({ "match": "first", "timeout_ms": 2000, "source": "recent" }),
        )
        .await;
    assert_eq!(first["status"], "matched");
    assert_eq!(first["line"], "first");
    assert!(first["at"].is_string());
    let later = srv.wait_output(&id, json!({ "regex": "^got (\\w+)$", "timeout_ms": 5000 }));
    let typer = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        srv.post(
            &format!("/panes/{id}/input"),
            json!({ "text": "tada", "keys": ["enter"] }),
        )
        .await
    };
    let (later, typed) = tokio::join!(later, typer);
    assert_eq!(typed.body, json!({ "ok": true }));
    assert_eq!(later["status"], "matched");
    assert_eq!(later["line"], "got tada");
    let t0 = Instant::now();
    assert_eq!(
        srv.wait_output(&id, json!({ "match": "never", "timeout_ms": 150 }))
            .await,
        json!({ "status": "timeout" })
    );
    assert!(t0.elapsed() >= Duration::from_millis(150));
    let exiting = srv.wait_output(&id, json!({ "match": "never", "timeout_ms": 5000 }));
    let enter = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        srv.post(&format!("/panes/{id}/input"), json!({ "keys": ["enter"] }))
            .await
    };
    let (exiting, _) = tokio::join!(exiting, enter);
    assert_eq!(exiting, json!({ "status": "exited", "code": 0 }));
    assert_eq!(
        srv.wait_output(&id, json!({ "match": "never", "timeout_ms": 100 }))
            .await,
        json!({ "status": "exited", "code": 0 })
    );
    let visible = srv
        .wait_output(
            &id,
            json!({ "match": "first", "timeout_ms": 100, "source": "visible" }),
        )
        .await;
    assert_eq!(visible["status"], "matched");
    srv.shutdown().await;
}

#[tokio::test]
async fn wait_output_validates_its_body() {
    let srv = common::start().await;
    let id = srv.spawn_sh("read x").await;
    let path = format!("/panes/{id}/wait-output");
    let missing = srv.post(&path, json!({ "timeout_ms": 100 })).await;
    assert_eq!(missing.status, 400);
    assert!(missing.body["errors"][0]
        .as_str()
        .unwrap()
        .contains("match or regex"));
    let bad_regex = srv
        .post(&path, json!({ "regex": "(", "timeout_ms": 100 }))
        .await;
    assert_eq!(bad_regex.status, 400);
    assert!(bad_regex.body["errors"][0]
        .as_str()
        .unwrap()
        .starts_with("regex:"));
    assert_eq!(
        srv.post(&path, json!({ "match": "x", "timeout_ms": -1 }))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.post(&path, json!({ "match": "x", "timeout_ms": 600_001 }))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.post(
            &path,
            json!({ "match": "x", "source": "sideways", "timeout_ms": 100 })
        )
        .await
        .status,
        400
    );
    assert_eq!(srv.post_raw(&path, "[1]").await.status, 400);
    assert_eq!(
        srv.post("/panes/relay:9/wait-output", json!({ "match": "x" }))
            .await
            .status,
        404
    );
    srv.shutdown().await;
}
