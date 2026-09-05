//! AC-3 — Prompt delivery: quiet + ready gate, bracketed paste, Enter retries, timeout with the pane left open.
mod common;

use serde_json::json;
use std::time::{Duration, Instant};

fn spawn_body(srv: &common::TestServer, script: &str, prompt: &str) -> serde_json::Value {
    json!({ "name": "backend", "cwd": srv.cwd(), "argv": ["sh", "-c", script], "prompt": prompt })
}

#[tokio::test]
async fn prompt_is_written_only_after_the_prompt_line_appears_and_the_screen_is_quiet() {
    let srv = common::start().await;
    let cap = srv.file("cap.txt");
    // Echo stays on: the tty echoes what termd types, so the cast shows *when* the prompt was written.
    let script = format!(
        "sleep 0.2; printf '> '; read x; printf '%s' \"$x\" > {}; echo working; sleep 3",
        cap.display()
    );
    let t0 = Instant::now();
    let res = srv.spawn(spawn_body(&srv, &script, "do the thing")).await;
    assert_eq!(res.status, 201, "{}", res.text);
    let took = t0.elapsed();
    assert!(
        took >= Duration::from_millis(300),
        "delivered after {took:?}"
    );
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    srv.until(
        || async { common::read_file(&cap) == "do the thing" },
        Duration::from_secs(5),
    )
    .await;
    let events = srv.cast_events(&id).await;
    let outputs: Vec<&str> = events[1..]
        .iter()
        .filter(|e| e[1] == "o")
        .map(|e| e[2].as_str().unwrap())
        .collect();
    let prompt_at = outputs
        .iter()
        .position(|o| o.contains("> "))
        .expect("prompt in cast");
    let typed_at = outputs
        .iter()
        .position(|o| o.contains("do the thing"))
        .expect("echoed prompt in cast");
    assert!(
        prompt_at < typed_at,
        "prompt {prompt_at} must precede the typed text {typed_at}: {outputs:?}"
    );
    let info = srv.pane(&id).await;
    let t = &info["timings"];
    assert!(t["readiness_ms"].is_number(), "{t}");
    assert!(t["prompt_write_ms"].is_number(), "{t}");
    assert!(t["prompt_accept_ms"].is_number(), "{t}");
    assert_eq!(t["prompt_retries"], 0);
    assert_eq!(
        srv.host().get(&id).unwrap().last_line().as_deref(),
        Some("working")
    );
    srv.shutdown().await;
}

#[tokio::test]
async fn prompt_is_wrapped_in_bracketed_paste_markers_when_the_pane_enabled_them() {
    let srv = common::start().await;
    let cap = srv.file("cap.txt");
    let script = format!(
        "printf '\\033[?2004h> '; read x; printf '%s' \"$x\" > {}; echo working; sleep 3",
        cap.display()
    );
    let res = srv.spawn(spawn_body(&srv, &script, "hello")).await;
    assert_eq!(res.status, 201, "{}", res.text);
    srv.until(
        || async { !common::read_file(&cap).is_empty() },
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(common::read_file(&cap), "\x1b[200~hello\x1b[201~");
    srv.shutdown().await;
}

#[tokio::test]
async fn enter_is_pressed_again_while_the_composer_still_holds_the_paste() {
    let srv = common::start().await;
    let cap = srv.file("cap.txt");
    // Like Codex: the first Enter leaves the text in the composer and shows a paste placeholder above the
    // footer; only the second Enter submits, after which the agent is visibly working.
    let script = format!(
        "stty -echo; printf '› Ask Codex to do anything\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'; read a; \
         printf '\\r\\n› [Pasted Content 5 chars]\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'; read b; \
         printf '%s|%s' \"$a\" \"$b\" > {}; printf '\\r\\n• Working (1s • esc to interrupt)\\r\\n'; sleep 3",
        cap.display()
    );
    let t0 = Instant::now();
    let res = srv.spawn(spawn_body(&srv, &script, "hello")).await;
    assert_eq!(res.status, 201, "{}", res.text);
    assert!(
        t0.elapsed() >= Duration::from_millis(300),
        "retry waited retry_ms"
    );
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    srv.until(
        || async { !common::read_file(&cap).is_empty() },
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(common::read_file(&cap), "hello|");
    let info = srv.pane(&id).await;
    assert_eq!(info["timings"]["prompt_retries"], 1, "{}", info["timings"]);
    assert!(info["timings"]["prompt_accept_ms"].as_f64().unwrap() >= 300.0);
    let metrics = srv.get("/metrics").await.body;
    assert_eq!(metrics["panes"][0]["timings"]["prompt_retries"], 1);
    srv.shutdown().await;
}

#[tokio::test]
async fn does_not_accept_on_a_partial_repaint_before_the_paste_placeholder_is_painted() {
    let srv = common::start().await;
    let cap = srv.file("cap.txt");
    // First Enter: the footer moves at once, the `[Pasted Content …]` placeholder only 60 ms later. Without a
    // settle window the host would call that "accepted" (last line changed, no placeholder yet) and never retry.
    let script = format!(
        "stty -echo; printf '› Ask Codex to do anything\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'; read a; \
         printf '\\r\\n  gpt-5.6-sol default · ~/x · 5 chars\\r\\n'; sleep 0.06; \
         printf '\\r\\n› [Pasted Content 5 chars]\\r\\n  gpt-5.6-sol default · ~/x · 5 chars\\r\\n'; read b; \
         printf '%s|%s' \"$a\" \"$b\" > {}; printf '\\r\\n• Working (1s • esc to interrupt)\\r\\n'; sleep 3",
        cap.display()
    );
    let res = srv.spawn(spawn_body(&srv, &script, "hello")).await;
    assert_eq!(res.status, 201, "{}", res.text);
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    srv.until(
        || async { !common::read_file(&cap).is_empty() },
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(common::read_file(&cap), "hello|");
    let info = srv.pane(&id).await;
    assert_eq!(info["timings"]["prompt_retries"], 1, "{}", info["timings"]);
    srv.shutdown().await;
}

#[tokio::test]
async fn an_echoing_shell_keeps_the_submitted_line_above_its_reply_and_that_is_accepted() {
    let srv = common::start().await;
    let t0 = Instant::now();
    let res = srv
        .spawn(spawn_body(
            &srv,
            "printf '> '; read x; echo \"got:$x\"; sleep 5",
            "hello there",
        ))
        .await;
    assert_eq!(res.status, 201, "{}", res.text);
    assert!(
        t0.elapsed() < Duration::from_millis(2500),
        "{:?}",
        t0.elapsed()
    );
    let id = res.body["pane_id"].as_str().unwrap().to_string();
    let info = srv.pane(&id).await;
    assert_eq!(info["timings"]["prompt_retries"], 0, "{}", info["timings"]);
    assert_eq!(
        srv.host().get(&id).unwrap().last_line().as_deref(),
        Some("got:hello there")
    );
    srv.shutdown().await;
}

#[tokio::test]
async fn a_shell_that_never_prompts_fails_with_502_after_timeout_and_the_pane_stays_open() {
    let srv = common::start().await;
    let t0 = Instant::now();
    let res = srv
        .spawn(spawn_body(&srv, "echo still loading; sleep 5", "hello"))
        .await;
    let took = t0.elapsed();
    assert_eq!(res.status, 502, "{}", res.text);
    assert!(
        took >= Duration::from_millis(3000) && took < Duration::from_millis(6000),
        "{took:?}"
    );
    assert_eq!(res.body["pane_id"], "relay:1");
    let error = res.body["error"].as_str().unwrap();
    assert!(
        error.starts_with("agent prompt failed: no prompt on screen within 3000 ms"),
        "{error}"
    );
    assert!(error.contains("still loading"), "{error}");
    assert!(error.contains("left open"), "{error}");
    let info = srv.pane("relay:1").await;
    assert_eq!(info["alive"], true);
    assert!(
        info["timings"].get("prompt_write_ms").is_none(),
        "nothing was written: {}",
        info["timings"]
    );
    assert_eq!(
        srv.get("/panes").await.body["panes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Echo is on, so anything typed would have been echoed into the ring: nothing was.
    assert!(
        !String::from_utf8_lossy(&srv.host().get("relay:1").unwrap().scrollback())
            .contains("hello")
    );
    let metrics = srv.get("/metrics").await.body;
    assert_eq!(metrics["prompt_failures"], 1);
    assert_eq!(metrics["panes_alive"], 1);
    srv.shutdown().await;
}

#[tokio::test]
async fn fails_fast_when_the_process_exits_before_taking_the_prompt() {
    let srv = common::start().await;
    let t0 = Instant::now();
    let res = srv
        .spawn(spawn_body(&srv, "echo bye; exit 2", "hello"))
        .await;
    assert_eq!(res.status, 502, "{}", res.text);
    assert!(t0.elapsed() < Duration::from_millis(2500));
    let error = res.body["error"].as_str().unwrap();
    assert!(
        error.starts_with(
            "agent prompt failed: process exited with code 2 before taking the prompt"
        ),
        "{error}"
    );
    assert_eq!(srv.get("/metrics").await.body["prompt_failures"], 1);
    srv.shutdown().await;
}
