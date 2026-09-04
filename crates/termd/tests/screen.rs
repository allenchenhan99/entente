//! AC-2 — Screen model over HTTP: lines, alternate screen, recent scrollback, resize + cast `r` event.
mod common;

use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn screen_shows_printed_lines_cursor_and_no_alternate_screen() {
    let srv = common::start().await;
    let id = srv.spawn_sh("printf 'a\\nb\\nc\\n'; read x").await;
    srv.until(
        || async { srv.screen(&id, "").await["lines"][2] == "c" },
        Duration::from_secs(10),
    )
    .await;
    let snap = srv.screen(&id, "").await;
    assert_eq!(snap["pane_id"], id);
    assert_eq!(snap["lines"][0], "a");
    assert_eq!(snap["lines"][1], "b");
    assert_eq!(snap["lines"][2], "c");
    assert_eq!(snap["lines"].as_array().unwrap().len(), 40);
    assert_eq!(snap["cols"], 120);
    assert_eq!(snap["rows"], 40);
    assert_eq!(snap["cursor"], json!({ "x": 0, "y": 3 }));
    assert_eq!(snap["alternate"], false);
    assert_eq!(snap["scrollback_lines"], 0);
    srv.shutdown().await;
}

#[tokio::test]
async fn alternate_screen_flips_the_flag() {
    let srv = common::start().await;
    let id = srv
        .spawn_sh("printf 'main\\n'; printf '\\033[?1049h'; printf 'alt'; read x")
        .await;
    srv.until(
        || async {
            srv.screen(&id, "").await["lines"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l == "alt")
        },
        Duration::from_secs(10),
    )
    .await;
    let snap = srv.screen(&id, "").await;
    assert_eq!(snap["alternate"], true);
    assert!(!snap["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l == "main"));
    assert!(srv.host().get(&id).unwrap().alternate_screen());
    srv.shutdown().await;
}

#[tokio::test]
async fn recent_prepends_scrollback_rows_once_more_lines_than_rows_were_printed() {
    let srv = common::start().await;
    let res = srv
        .spawn(json!({
            "name": "backend", "cwd": srv.cwd(), "rows": 10,
            "argv": ["sh", "-c", "i=1; while [ $i -le 50 ]; do echo line$i; i=$((i+1)); done; read x"],
        }))
        .await;
    assert_eq!(res.status, 201);
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    srv.until(
        || async { srv.screen(&id, "").await["scrollback_lines"].as_u64() >= Some(41) },
        Duration::from_secs(10),
    )
    .await;
    let visible = srv.screen(&id, "").await;
    assert_eq!(visible["lines"].as_array().unwrap().len(), 10);
    assert_eq!(visible["lines"][0], "line42");
    assert_eq!(visible["rows"], 10);
    let recent = srv.screen(&id, "?source=recent&lines=5").await;
    assert_eq!(recent["lines"].as_array().unwrap().len(), 15);
    assert_eq!(recent["lines"][0], "line37");
    assert_eq!(recent["scrollback_lines"], 41);
    let all = srv.screen(&id, "?source=recent&lines=200").await;
    assert_eq!(all["lines"].as_array().unwrap().len(), 51);
    assert_eq!(all["lines"][0], "line1");
    assert_eq!(all["lines"][49], "line50");
    // Query validation.
    assert_eq!(
        srv.get(&format!("/panes/{id}/screen?source=sideways"))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.get(&format!("/panes/{id}/screen?lines=0")).await.status,
        400
    );
    assert_eq!(
        srv.get(&format!("/panes/{id}/screen?lines=5001"))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.get(&format!("/panes/{id}/screen?lines=abc"))
            .await
            .status,
        400
    );
    assert_eq!(srv.get("/panes/relay:9/screen").await.status, 404);
    srv.shutdown().await;
}

#[tokio::test]
async fn resize_changes_cols_rows_and_appends_an_r_cast_event() {
    let srv = common::start().await;
    let id = srv.spawn_sh("echo hello; read x").await;
    srv.wait_output(&id, json!({ "match": "hello" })).await;
    let res = srv
        .post(
            &format!("/panes/{id}/resize"),
            json!({ "cols": 80, "rows": 24 }),
        )
        .await;
    assert_eq!(res.body, json!({ "ok": true }));
    let info = srv.pane(&id).await;
    assert_eq!(info["cols"], 80);
    assert_eq!(info["rows"], 24);
    let snap = srv.screen(&id, "").await;
    assert_eq!(snap["cols"], 80);
    assert_eq!(snap["rows"], 24);
    assert_eq!(snap["lines"].as_array().unwrap().len(), 24);
    assert_eq!(snap["lines"][0], "hello");
    // The child sees the new size too.
    srv.post(
        &format!("/panes/{id}/input"),
        json!({ "text": "x", "keys": ["enter"] }),
    )
    .await;
    let events = srv.cast_events(&id).await;
    assert!(
        events.iter().any(|e| e[1] == "r" && e[2] == "80x24"),
        "{events:?}"
    );
    assert_eq!(
        srv.post(
            &format!("/panes/{id}/resize"),
            json!({ "cols": 0, "rows": 24 })
        )
        .await
        .status,
        400
    );
    assert_eq!(
        srv.post(&format!("/panes/{id}/resize"), json!({ "cols": 80 }))
            .await
            .status,
        400
    );
    assert_eq!(
        srv.post("/panes/relay:9/resize", json!({ "cols": 80, "rows": 24 }))
            .await
            .status,
        404
    );
    srv.shutdown().await;
}
