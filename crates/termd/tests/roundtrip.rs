//! AC-1 — Round trip over HTTP + WebSocket, plus the client / cast / listing scenarios of `api.test.ts`.
mod common;

use common::{b64, unb64, WsAuth};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn ws_client_gets_hello_scrollback_output_then_exit_and_pane_info_follows() {
    let srv = common::start().await;
    let id = srv.spawn_sh("echo hi; read x; exit 0").await;
    assert_eq!(id, "relay:1");
    let mut client = srv.ws(&id).await.expect("ws connects");
    let hello = &client.frames_of("hello", 1).await[0];
    assert_eq!(hello["pane"]["pane_id"], id);
    assert_eq!(hello["pane"]["role"], "backend");
    assert_eq!(hello["pane"]["alive"], true);
    assert_eq!(hello["pane"]["cols"], 120);
    assert_eq!(hello["pane"]["rows"], 40);
    assert!(
        hello["pane"]["timings"].is_object(),
        "timings always present"
    );
    client.frames_of("scrollback", 1).await;
    assert_eq!(client.types()[..2], ["hello", "scrollback"]);
    client.wait_output_contains("hi").await;
    assert!(
        client.frames[2..].iter().all(|f| f["t"] == "output"),
        "{:?}",
        client.types()
    );
    client
        .send(json!({ "t": "input", "data": b64("\r") }))
        .await;
    let exit = &client.frames_of("exit", 1).await[0];
    assert_eq!(exit["code"], 0);
    let info = srv.pane(&id).await;
    assert_eq!(info["alive"], false);
    assert_eq!(info["exit_code"], 0);
    assert!(info["exited_at"].is_string());
    assert!(
        info["timings"]["first_output_ms"].is_number(),
        "{}",
        info["timings"]
    );
    assert!(info["timings"]["spawn_ms"].is_number());
    // ping/pong still works on an exited pane's socket.
    client.send(json!({ "t": "ping" })).await;
    client.frames_of("pong", 1).await;
    srv.shutdown().await;
}

#[tokio::test]
async fn unknown_pane_is_refused_before_upgrade_and_malformed_client_frames_are_ignored() {
    let srv = common::start().await;
    assert_eq!(srv.ws("relay:404").await.err(), Some(404));
    assert_eq!(
        srv.ws_path("/nope", WsAuth::Subprotocol).await.err(),
        Some(404)
    );
    let id = srv.spawn_sh("read x; echo \"ok:$x\"; sleep 2").await;
    let mut client = srv.ws(&id).await.unwrap();
    client.send_raw("not json").await;
    client.send(json!({ "t": "teleport" })).await;
    client
        .send(json!({ "t": "resize", "cols": 80, "rows": 24 }))
        .await;
    client
        .send(json!({ "t": "input", "data": b64("go\r") }))
        .await;
    client.wait_output_contains("ok:go").await;
    let info = srv.pane(&id).await;
    assert_eq!(info["cols"], 80);
    assert_eq!(info["rows"], 24);
    srv.shutdown().await;
}

#[tokio::test]
async fn two_clients_share_output_a_late_client_gets_scrollback_first_and_the_cast_matches() {
    let srv = common::start().await;
    let id = srv
        .spawn_sh("echo one; read x; echo \"two $x\"; read y; echo three; exit 0")
        .await;
    srv.until(
        || async {
            srv.host()
                .get(&id)
                .unwrap()
                .scrollback()
                .windows(3)
                .any(|w| w == b"one")
        },
        Duration::from_secs(10),
    )
    .await;
    let mut a = srv.ws(&id).await.unwrap();
    let mut b = srv.ws(&id).await.unwrap();
    let sa = a.frames_of("scrollback", 1).await[0].clone();
    let sb = b.frames_of("scrollback", 1).await[0].clone();
    assert!(unb64(sa["data"].as_str().unwrap()).contains("one"));
    assert_eq!(sb["data"], sa["data"]);
    a.send(json!({ "t": "input", "data": b64("x\r") })).await;
    a.wait_output_contains("two x").await;
    b.wait_output_contains("two x").await;
    a.settle(Duration::from_millis(150)).await;
    b.settle(Duration::from_millis(150)).await;
    assert_eq!(a.output(), b.output());
    // A late client receives the retained bytes first, then only what comes after.
    let mut late = srv.ws(&id).await.unwrap();
    let sl = late.frames_of("scrollback", 1).await[0].clone();
    assert_eq!(
        unb64(sl["data"].as_str().unwrap()).as_bytes(),
        srv.host().get(&id).unwrap().scrollback()
    );
    assert!(unb64(sl["data"].as_str().unwrap()).contains("two x"));
    assert_eq!(late.live(), "");
    late.send(json!({ "t": "resize", "cols": 100, "rows": 30 }))
        .await;
    srv.until(
        || async { srv.pane(&id).await["cols"] == 100 },
        Duration::from_secs(5),
    )
    .await;
    b.send(json!({ "t": "input", "data": b64("\r") })).await;
    a.frames_of("exit", 1).await;
    b.frames_of("exit", 1).await;
    late.frames_of("exit", 1).await;
    assert!(late.output().contains("three"));
    assert_eq!(a.output(), b.output());
    // Every client saw every output frame before the exit frame.
    for c in [&a, &b, &late] {
        let types = c.types();
        let exit_at = types.iter().position(|t| t == "exit").unwrap();
        assert!(
            types[exit_at + 1..].iter().all(|t| t != "output"),
            "{types:?}"
        );
    }

    let events = srv.cast_events(&id).await;
    assert_eq!(events[0]["version"], 2);
    assert_eq!(events[0]["width"], 120);
    assert_eq!(events[0]["height"], 40);
    assert_eq!(events[0]["title"], "backend");
    assert!(events[0]["timestamp"].is_number());
    let recorded: String = events[1..]
        .iter()
        .filter(|e| e[1] == "o")
        .map(|e| e[2].as_str().unwrap())
        .collect();
    assert_eq!(recorded, a.output()); // output() already includes the replayed scrollback
    assert!(events.iter().any(|e| e[1] == "r" && e[2] == "100x30"));
    assert!(events[1..]
        .iter()
        .all(|e| e[0].as_f64().is_some_and(|t| t >= 0.0)));
    assert_eq!(srv.get("/panes/relay:9/cast").await.status, 404);
    srv.shutdown().await;
}

#[tokio::test]
async fn listing_focus_and_kill_act_on_known_panes_only() {
    let srv = common::start().await;
    assert_eq!(srv.get("/panes").await.body, json!({ "panes": [] }));
    let id = srv.spawn_sh("read x").await;
    assert_eq!(
        srv.post(&format!("/panes/{id}/focus"), json!({}))
            .await
            .body,
        json!({ "ok": true })
    );
    let list = srv.get("/panes").await.body;
    assert_eq!(list["focused_pane"], id);
    assert_eq!(list["panes"].as_array().unwrap().len(), 1);
    assert_eq!(list["panes"][0]["pane_id"], id);
    assert!(list["panes"][0]["pid"].as_u64().unwrap() > 0);
    assert_eq!(
        list["panes"][0]["cast_path"],
        srv.cast_dir.join("relay:1.cast").to_string_lossy().as_ref()
    );
    assert!(srv.cast_dir.join("relay:1.cast").exists());
    for path in ["/panes/relay:9/focus", "/panes/relay:9/kill"] {
        let res = srv.post(path, json!({})).await;
        assert_eq!(res.status, 404, "{path}");
        assert_eq!(res.body, json!({ "error": "pane not found" }));
    }
    assert_eq!(srv.get("/panes/relay:9").await.status, 404);
    assert_eq!(
        srv.post(&format!("/panes/{id}/kill"), json!({})).await.body,
        json!({ "ok": true })
    );
    assert_eq!(srv.pane(&id).await["alive"], false);
    // Idempotent once exited.
    assert_eq!(
        srv.post(&format!("/panes/{id}/kill"), json!({}))
            .await
            .status,
        200
    );
    srv.shutdown().await;
}

#[tokio::test]
async fn spawn_passes_cwd_env_term_and_relay_pane_id_and_numbers_panes_from_first_pane() {
    let srv = common::start_with(common::fast_timings(), 7).await;
    let out = srv.file("env.txt");
    let res = srv
        .spawn(json!({
            "name": "backend",
            "cwd": srv.cwd(),
            "argv": ["sh", "-c", format!("printf '%s|%s|%s|%s|%s' \"$PWD\" \"$TERM\" \"$COLORTERM\" \"$RELAY_PANE_ID\" \"$EXTRA\" > {}", out.display())],
            "env": { "EXTRA": "yes" },
            "task_id": "t-backend",
        }))
        .await;
    assert_eq!(res.status, 201, "{}", res.text);
    assert_eq!(res.body, json!({ "pane_id": "relay:7" }));
    let second = srv
        .spawn(json!({ "name": "planner", "cwd": srv.cwd(), "argv": ["sh", "-c", "read x"] }))
        .await;
    assert_eq!(second.body["pane_id"], "relay:8");
    srv.until(
        || async { srv.pane("relay:7").await["alive"] == false },
        Duration::from_secs(10),
    )
    .await;
    let cwd = std::fs::canonicalize(srv.dir.path()).unwrap();
    let got = common::read_file(&out);
    let parts: Vec<&str> = got.split('|').collect();
    assert_eq!(parts.len(), 5, "{got:?}");
    assert_eq!(std::fs::canonicalize(parts[0]).unwrap(), cwd);
    assert_eq!(
        &parts[1..],
        ["xterm-256color", "truecolor", "relay:7", "yes"]
    );
    let list = srv.get("/panes").await.body;
    let ids: Vec<&str> = list["panes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["pane_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["relay:7", "relay:8"]);
    assert_eq!(list["panes"][0]["task_id"], "t-backend");
    assert!(list["panes"][1].get("task_id").is_none());
    assert_eq!(list["panes"][1]["role"], "planner");
    assert_eq!(list["panes"][1]["alive"], true);
    assert!(list["panes"][1].get("runtime").is_none());
    // Validation: empty argv, bad JSON, wrong types.
    let bad = srv
        .spawn(json!({ "name": "x", "cwd": srv.cwd(), "argv": [] }))
        .await;
    assert_eq!(bad.status, 400);
    assert!(bad.body["errors"][0].as_str().unwrap().contains("argv"));
    assert_eq!(srv.post_raw("/panes", "{nope").await.status, 400);
    assert_eq!(
        srv.spawn(json!({ "name": "x", "cwd": srv.cwd(), "argv": "sh" }))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.spawn(json!({ "name": "x", "cwd": srv.cwd(), "argv": ["sh"], "cols": 0 }))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.get("/panes").await.body["panes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    srv.shutdown().await;
}

#[tokio::test]
async fn closing_a_pane_forgets_it_but_keeps_its_recording() {
    let srv = common::start().await;
    let id = srv.spawn_sh("read x").await;
    assert!(srv.cast_dir.join("relay:1.cast").exists());

    assert_eq!(srv.delete(&format!("/panes/{id}")).await.status, 200);

    // Gone from the list, so a client that closed it does not get it back on the next poll.
    assert_eq!(srv.get("/panes").await.body["panes"], json!([]));
    assert_eq!(srv.get(&format!("/panes/{id}")).await.status, 404);
    // The record of what happened in it is not the pane, and it stays.
    assert!(srv.cast_dir.join("relay:1.cast").exists());
    // A second close is a 404: there is nothing left to close.
    assert_eq!(srv.delete(&format!("/panes/{id}")).await.status, 404);
    srv.shutdown().await;
}

#[tokio::test]
async fn closing_the_focused_pane_clears_the_focus() {
    let srv = common::start().await;
    let id = srv.spawn_sh("read x").await;
    srv.post(&format!("/panes/{id}/focus"), json!({})).await;
    assert_eq!(srv.get("/panes").await.body["focused_pane"], id);

    srv.delete(&format!("/panes/{id}")).await;

    assert_eq!(srv.get("/panes").await.body.get("focused_pane"), None);
    srv.shutdown().await;
}
