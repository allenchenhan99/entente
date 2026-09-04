//! AC-6 — the binary prints exactly one listening line on stdout and serves `/health` there.
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[tokio::test]
async fn binary_prints_the_listening_line_and_serves_health() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_termd"))
        .args(["--listen", "127.0.0.1:0", "--token", "abc", "--cast-dir"])
        .arg(dir.path().join("casts"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("termd starts");
    let stdout = child.stdout.take().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let line = line.trim_end().to_string();
    let url = line
        .strip_prefix("termd listening on ")
        .unwrap_or_else(|| panic!("unexpected line {line:?}"));
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    assert!(
        url["http://127.0.0.1:".len()..].parse::<u16>().is_ok(),
        "{url}"
    );
    let client = reqwest::Client::new();
    let health: serde_json::Value = client
        .get(format!("{url}/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["ok"], true);
    assert_eq!(
        client
            .get(format!("{url}/panes"))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    let panes = client
        .get(format!("{url}/panes"))
        .bearer_auth("abc")
        .send()
        .await
        .unwrap();
    assert_eq!(panes.status().as_u16(), 200);
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn binary_requires_a_token() {
    let out = Command::new(env!("CARGO_BIN_EXE_termd"))
        .args(["--cast-dir", "/tmp/x"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--token"));
}
