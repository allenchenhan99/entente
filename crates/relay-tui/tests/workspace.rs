//! Opening a second project, against a real `entente daemon`.
//!
//! Ignored by default: it starts relayd processes, which is not something a unit suite should do on
//! every run. `cargo test -p relay-tui --test workspace -- --ignored` when the launcher is built.

use relay_tui::runtime::{open_workspace, Msg};

#[tokio::test]
#[ignore = "spawns a relayd; run explicitly"]
async fn opening_a_project_starts_its_daemon_and_joining_it_again_does_not() {
    let repo = std::env::var("RELAY_TEST_REPO").expect("set RELAY_TEST_REPO to a git repo path");

    let first = open_workspace(&repo).await.expect("a daemon for the repo");
    let (url, started) = match &first {
        Msg::WorkspaceReady { url, started, .. } => (url.clone(), *started),
        other => panic!("{other:?}"),
    };
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");

    // A workspace is a daemon, and a second one on the same repo would overwrite its session token
    // and lock out whoever was already connected. Asking again joins the one that is there.
    let again = open_workspace(&repo).await.expect("the same daemon");
    match again {
        Msg::WorkspaceReady {
            url: u2,
            started: s2,
            ..
        } => {
            assert_eq!(u2, url, "same daemon, same url");
            assert!(!s2, "the second call must not start another");
        }
        other => panic!("{other:?}"),
    }
    let _ = started;
}
