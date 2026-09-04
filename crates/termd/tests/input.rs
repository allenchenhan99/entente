//! `POST /panes/:id/input`: text then keys; an unknown key is a 400 that writes nothing.
mod common;

use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn maps_the_documented_keys_to_bytes_and_rejects_unknown_keys_without_writing() {
    let srv = common::start().await;
    let cap = srv.file("cap.txt");
    // Raw mode: ctrl+c / ctrl+d reach the program as bytes instead of being cooked by the tty.
    let script = format!(
        "stty raw -echo; printf 'ready\\r\\n'; head -c 20 > {}; printf 'done\\r\\n'; sleep 1",
        cap.display()
    );
    let id = srv.spawn_sh(&script).await;
    assert_eq!(
        srv.wait_output(&id, json!({ "match": "ready" })).await["status"],
        "matched"
    );
    let path = format!("/panes/{id}/input");
    let bad = srv
        .post(
            &path,
            json!({ "text": "nope", "keys": ["enter", "hyper+x"] }),
        )
        .await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        bad.body,
        json!({ "errors": ["keys: unknown key: \"hyper+x\""] })
    );
    assert_eq!(
        srv.post(&path, json!({ "keys": "enter" })).await.status,
        400
    );
    assert_eq!(
        srv.post("/panes/relay:9/input", json!({ "keys": ["enter"] }))
            .await
            .status,
        404
    );
    let ok = srv
        .post(
            &path,
            json!({ "text": "ab", "keys": ["enter", "esc", "ctrl+c", "up", "down", "left", "right", "tab", "backspace", "ctrl+d"] }),
        )
        .await;
    assert_eq!(ok.body, json!({ "ok": true }));
    assert_eq!(
        srv.wait_output(&id, json!({ "match": "done" })).await["status"],
        "matched"
    );
    srv.until(
        || async { std::fs::read(&cap).map(|b| b.len() >= 20).unwrap_or(false) },
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        std::fs::read(&cap).unwrap(),
        b"ab\r\x1b\x03\x1b[A\x1b[B\x1b[D\x1b[C\t\x7f\x04"
    );
    srv.shutdown().await;
}
