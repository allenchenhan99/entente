//! AC-5 (keys): the key map matches `apps/tui/src/keys.ts` for every key it binds, plus the pane grid keys.

mod support;

use relay_tui::app::{App, Command, Effect, InputMode, Mode, Region};
use relay_tui::keys::Key;
use relay_tui::model::*;
use support::*;

fn app_with(graph: Graph) -> App {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph);
    app
}

fn keys(app: &mut App, sequence: &str) -> Vec<Effect> {
    sequence
        .chars()
        .flat_map(|c| app.handle_key(Key::char(c)))
        .collect()
}

#[test]
fn keys_initial_selection_is_the_first_agent_in_the_tree() {
    let app = app_with(graph("live-1"));
    assert_eq!(app.region, Region::Tree);
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-backend-auth")));
}

#[test]
fn keys_j_k_and_arrows_move_within_the_region_and_clamp() {
    let mut app = app_with(graph("live-1"));
    app.handle_key(Key::char('j'));
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-frontend-login")));
    app.handle_key(Key::char('j'));
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::node("t-frontend-login")),
        "clamps at the end"
    );
    app.handle_key(Key::UP);
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-backend-auth")));
    app.handle_key(Key::char('k'));
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::node("t-backend-auth")),
        "clamps at the start"
    );
    app.handle_key(Key::DOWN);
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-frontend-login")));
}

#[test]
fn keys_tab_cycles_tree_graph_panes_inbox_and_selects_the_first_object() {
    let mut app = app_with(demo_graph());
    app.set_panes(
        vec![pane("relay:1", Some("t-frontend-login"), "frontend", true)],
        None,
    );
    assert_eq!(app.region, Region::Tree);
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Graph);
    // The human is not an agent on the network, so the first object is the first brain.
    assert_eq!(app.selected, Some(GraphObjectRef::node("planner")));
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Panes);
    assert_eq!(app.focused_pane.as_deref(), Some("relay:1"));
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::node("t-frontend-login")),
        "the pane's task is selected"
    );
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Inbox);
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::inbox("question:t-backend-auth"))
    );
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Tree);
}

#[test]
fn keys_selecting_a_node_fetches_its_actions() {
    let mut app = app_with(graph("live-1"));
    let effects = app.handle_key(Key::char('j'));
    assert_eq!(
        effects,
        vec![Effect::FetchActions(GraphObjectRef::node(
            "t-frontend-login"
        ))]
    );
}

#[test]
fn keys_enter_opens_the_inspector_and_esc_closes_it() {
    let mut app = app_with(graph("live-1"));
    let effects = app.handle_key(Key::ENTER);
    assert!(app.inspector_open);
    assert_eq!(
        effects,
        vec![Effect::FetchInspector(GraphObjectRef::node(
            "t-backend-auth"
        ))]
    );
    app.handle_key(Key::ESC);
    assert!(!app.inspector_open);
    // `i` inspects too, outside the pane grid (Ink).
    app.handle_key(Key::char('i'));
    assert!(app.inspector_open);
}

#[test]
fn keys_enter_on_an_inbox_item_jumps_to_its_ref() {
    let mut app = app_with(demo_graph());
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Inbox);
    let effects = app.handle_key(Key::ENTER);
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::edge("contract:t-backend-auth"))
    );
    assert_eq!(app.region, Region::Graph);
    assert!(app.inspector_open);
    assert!(
        effects.contains(&Effect::FetchInspector(GraphObjectRef::edge(
            "contract:t-backend-auth"
        )))
    );
}

#[test]
fn keys_a_or_c_answers_a_question_with_the_ink_clarify_body() {
    let mut app = app_with(demo_graph());
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    keys(&mut app, "a");
    assert_eq!(app.input_mode, Some(InputMode::Answer));
    assert!(
        app.inspector_open,
        "the inline editor lives in the inspector"
    );
    keys(&mut app, "magic link");
    app.handle_key(Key::BACKSPACE);
    keys(&mut app, "ks");
    assert_eq!(app.prompt_line().as_deref(), Some("answer> magic links"));
    let effects = app.handle_key(Key::ENTER);
    let expected = Command::Clarify {
        task_id: "t-backend-auth".into(),
        question_id: "Q1".into(),
        answer: "magic links".into(),
    };
    assert_eq!(effects, vec![Effect::Post(expected.clone())]);
    assert_eq!(expected.route(), "/tasks/t-backend-auth/clarify");
    assert_eq!(
        expected.body(),
        serde_json::json!({ "answers": [{ "question_id": "Q1", "answer": "magic links" }] })
    );
    assert_eq!(app.input_mode, None);

    // `c` is the contract's alias for the same action.
    keys(&mut app, "c");
    assert_eq!(app.input_mode, Some(InputMode::Answer));
    app.handle_key(Key::ESC);
    assert_eq!(app.input_mode, None, "Esc abandons the editor");
    // An empty answer is not sent.
    keys(&mut app, "c");
    assert_eq!(app.handle_key(Key::ENTER), vec![]);
}

#[test]
fn keys_p_y_pass_and_f_n_fail_a_human_review() {
    let mut app = app_with(demo_graph());
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    app.handle_key(Key::char('j'));
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::inbox("review:t-frontend-login:AC-3"))
    );
    let pass = Command::Review {
        task_id: "t-frontend-login".into(),
        criterion_id: "AC-3".into(),
        status: "passed",
        observed_failure: None,
    };
    assert_eq!(keys(&mut app, "p"), vec![Effect::Post(pass.clone())]);
    assert_eq!(keys(&mut app, "y"), vec![Effect::Post(pass.clone())]);
    assert_eq!(pass.route(), "/tasks/t-frontend-login/review");
    assert_eq!(
        pass.body(),
        serde_json::json!({ "criterion_id": "AC-3", "status": "passed" })
    );

    keys(&mut app, "f");
    assert_eq!(app.input_mode, Some(InputMode::ReviewFailure));
    keys(&mut app, "button hidden");
    let effects = app.handle_key(Key::ENTER);
    let fail = Command::Review {
        task_id: "t-frontend-login".into(),
        criterion_id: "AC-3".into(),
        status: "failed",
        observed_failure: Some("button hidden".into()),
    };
    assert_eq!(effects, vec![Effect::Post(fail.clone())]);
    assert_eq!(
        fail.body(),
        serde_json::json!({ "criterion_id": "AC-3", "status": "failed", "observed_failure": "button hidden" })
    );
    keys(&mut app, "n");
    assert_eq!(
        app.input_mode,
        Some(InputMode::ReviewFailure),
        "n is the alias for fail"
    );
}

#[test]
fn keys_r_replies_to_a_blocked_agent() {
    let mut app = app_with(demo_graph());
    let selected = app.selected.clone().unwrap();
    app.set_actions(&selected, reply_actions());
    keys(&mut app, "r");
    assert_eq!(app.input_mode, Some(InputMode::Reply));
    keys(&mut app, "use the stub");
    let effects = app.handle_key(Key::ENTER);
    let reply = Command::Reply {
        task_id: "t-backend-auth".into(),
        message: "use the stub".into(),
    };
    assert_eq!(effects, vec![Effect::Post(reply.clone())]);
    assert_eq!(reply.route(), "/tasks/t-backend-auth/reply");
    assert_eq!(
        reply.body(),
        serde_json::json!({ "message": "use the stub" })
    );
}

#[test]
fn keys_x_cancels_after_a_y_n_confirmation() {
    let mut app = app_with(demo_graph());
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    keys(&mut app, "x");
    assert_eq!(app.input_mode, Some(InputMode::CancelConfirm));
    assert_eq!(app.prompt_line().as_deref(), Some("cancel task? y/N"));
    assert_eq!(keys(&mut app, "n"), vec![]);
    assert_eq!(app.input_mode, None);
    keys(&mut app, "x");
    let cancel = Command::Cancel {
        task_id: "t-backend-auth".into(),
    };
    assert_eq!(keys(&mut app, "y"), vec![Effect::Post(cancel.clone())]);
    assert_eq!(cancel.route(), "/tasks/t-backend-auth/cancel");
    assert_eq!(cancel.body(), serde_json::json!({}));
}

#[test]
fn keys_f_focuses_the_selected_tasks_pane_and_i_routes_input_to_it() {
    let mut app = app_with(graph("live-1"));
    app.set_panes(
        vec![
            pane("relay:1", Some("t-backend-auth"), "backend", true),
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        None,
    );
    app.handle_key(Key::char('j')); // frontend
    let effects = app.handle_key(Key::char('f'));
    assert_eq!(app.region, Region::Panes);
    assert_eq!(app.focused_pane.as_deref(), Some("relay:2"));
    assert!(effects.contains(&Effect::FocusPane("relay:2".into())));

    app.handle_key(Key::char('i'));
    assert!(app.terminal_input);
    let effects = app.handle_key(Key::char('x'));
    assert_eq!(
        effects,
        vec![Effect::PaneInput {
            pane_id: "relay:2".into(),
            data: b"x".to_vec()
        }]
    );
    let effects = app.handle_key(Key::ENTER);
    assert_eq!(
        effects,
        vec![Effect::PaneInput {
            pane_id: "relay:2".into(),
            data: b"\r".to_vec()
        }]
    );
    // Even q / Ctrl-C go to the terminal while typing into it.
    assert!(matches!(
        app.handle_key(Key::char('q'))[0],
        Effect::PaneInput { .. }
    ));
    assert!(matches!(
        app.handle_key(Key::ctrl('c'))[0],
        Effect::PaneInput { .. }
    ));
    app.handle_key(Key::ESC);
    assert!(!app.terminal_input);
    assert_eq!(app.handle_key(Key::char('q')), vec![Effect::Quit]);
}

#[test]
fn keys_j_k_in_the_pane_grid_move_the_focus() {
    let mut app = app_with(graph("live-1"));
    app.set_panes(
        vec![
            pane("relay:1", Some("t-backend-auth"), "backend", true),
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        None,
    );
    app.handle_key(Key::TAB);
    app.handle_key(Key::TAB);
    assert_eq!(app.region, Region::Panes);
    assert_eq!(app.focused_pane.as_deref(), Some("relay:1"));
    app.handle_key(Key::char('j'));
    assert_eq!(app.focused_pane.as_deref(), Some("relay:2"));
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-frontend-login")));
    app.handle_key(Key::char('k'));
    assert_eq!(app.focused_pane.as_deref(), Some("relay:1"));
    // Enter in the grid inspects the focused pane's task.
    let effects = app.handle_key(Key::ENTER);
    assert_eq!(
        effects,
        vec![Effect::FetchInspector(GraphObjectRef::node(
            "t-backend-auth"
        ))]
    );
}

#[test]
fn keys_help_quit_and_ctrl_c() {
    let mut app = app_with(graph("live-1"));
    app.handle_key(Key::char('?'));
    assert!(app.help_open);
    app.handle_key(Key::ESC);
    assert!(!app.help_open);
    assert_eq!(app.handle_key(Key::char('q')), vec![Effect::Quit]);
    assert_eq!(app.handle_key(Key::ctrl('c')), vec![Effect::Quit]);
}

#[test]
fn keys_pane_resize_is_reported_when_the_widget_size_changes() {
    let mut app = app_with(graph("live-1"));
    app.set_panes(
        vec![pane("relay:1", Some("t-backend-auth"), "backend", true)],
        None,
    );
    assert_eq!(app.sync_pane_sizes(), vec![], "nothing drawn yet");
    app.pane_areas.insert("relay:1".into(), (78, 20));
    assert_eq!(
        app.sync_pane_sizes(),
        vec![Effect::PaneResize {
            pane_id: "relay:1".into(),
            cols: 78,
            rows: 20
        }]
    );
    assert_eq!(app.sync_pane_sizes(), vec![], "no change, no frame");
    assert_eq!(app.pane_states["relay:1"].size(), (78, 20));
}

#[test]
fn keys_pane_frames_feed_the_screen_model() {
    let mut app = app_with(graph("live-1"));
    app.set_panes(
        vec![pane("relay:1", Some("t-backend-auth"), "backend", true)],
        None,
    );
    app.apply_pane_frame(
        "relay:1",
        PtyServerMessage::Output {
            data: "aGVsbG8gcGFuZQ==".into(),
        },
    );
    let screen = app.pane_states["relay:1"].parser.screen().contents();
    assert!(screen.starts_with("hello pane"), "{screen:?}");
    app.apply_pane_frame("relay:1", PtyServerMessage::Exit { code: 3 });
    assert_eq!(app.pane_states["relay:1"].exit_code, Some(3));
    assert!(!app.pane_states["relay:1"].alive());
}

#[test]
fn keys_selection_survives_a_graph_refresh_and_falls_back_when_the_object_is_gone() {
    let mut app = app_with(graph("live-1"));
    app.handle_key(Key::char('j'));
    app.set_graph(graph("live-1"));
    assert_eq!(app.selected, Some(GraphObjectRef::node("t-frontend-login")));
    app.set_graph(graph("live-7"));
    assert_eq!(
        app.selected,
        Some(GraphObjectRef::node("t-backend-auth")),
        "falls back to the first agent"
    );
}
