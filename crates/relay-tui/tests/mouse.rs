//! The mouse across the whole app: the panel under the pointer decides what a click means. Every rule
//! is checked through `App`, which never touches a terminal, so these run without one.

mod support;

use relay_tui::app::{App, Command, Effect, InputMode, Mode, Region, Viewport};
use relay_tui::keys::{Key, KeyCode, Mouse, MouseKind};
use relay_tui::model::*;
use support::*;

/// The app as it is after a draw: each panel has recorded where it was and what its rows mean.
fn drawn_app() -> App {
    let mut app = replay_app("live-1");
    draw_rows(&mut app, 120, 32);
    app
}

fn click(app: &mut App, col: u16, row: u16) -> Vec<Effect> {
    app.handle_mouse(Mouse::new(MouseKind::Down, col, row))
}

#[test]
fn a_draw_records_where_every_panel_is() {
    let app = drawn_app();

    assert!(app.tree_viewport.width > 0, "the tree recorded its area");
    assert!(app.inbox_viewport.width > 0, "so did the inbox");
    assert!(app.graph_viewport.width > 0, "and the graph");
    assert_eq!(
        app.tree_rows.len() as u16,
        app.tree_viewport.height.min(app.tree_rows.len() as u16),
        "a row is recorded for each drawn line"
    );
}

#[test]
fn clicking_an_agent_row_in_the_tree_selects_that_agent() {
    let mut app = drawn_app();
    let (index, wanted) = app
        .tree_rows
        .iter()
        .enumerate()
        .find_map(|(i, r)| r.clone().map(|r| (i, r)))
        .expect("an agent row");
    app.select(None);
    app.region = Region::Panes;

    let (x, y) = (app.tree_viewport.x, app.tree_viewport.y);
    click(&mut app, x + 2, y + index as u16);

    assert_eq!(app.selected, Some(wanted));
    assert_eq!(
        app.region,
        Region::Tree,
        "the click moved focus to the tree"
    );
}

#[test]
fn an_agents_detail_row_selects_the_same_agent_as_its_first_row() {
    let app = drawn_app();
    let refs: Vec<Option<GraphObjectRef>> = app.tree_rows.clone();
    let first = refs.iter().position(|r| r.is_some()).expect("an agent row");

    assert_eq!(
        refs[first],
        refs[first + 1],
        "both rows of an agent point at it, so either is clickable"
    );
}

#[test]
fn clicking_a_header_row_focuses_the_tree_without_changing_the_selection() {
    let mut app = drawn_app();
    app.region = Region::Graph;
    let before = app.selected.clone();

    let (x, y) = (app.tree_viewport.x, app.tree_viewport.y);
    click(&mut app, x + 2, y);

    assert_eq!(app.region, Region::Tree);
    assert_eq!(app.selected, before, "a header carries no object");
}

#[test]
fn the_wheel_walks_the_selection_in_a_list_panel() {
    let mut app = drawn_app();
    let (col, row) = (app.tree_viewport.x + 2, app.tree_viewport.y + 3);
    app.region = Region::Graph;

    app.handle_mouse(Mouse::new(MouseKind::ScrollDown, col, row));
    let after_down = app.selected.clone();
    app.handle_mouse(Mouse::new(MouseKind::ScrollUp, col, row));

    assert_eq!(app.region, Region::Tree);
    assert_ne!(after_down, app.selected, "the wheel moved the selection");
}

#[test]
fn clicking_an_inbox_item_selects_it() {
    let mut app = replay_app("live-7");
    draw_rows(&mut app, 120, 32);
    let Some((index, wanted)) = app
        .inbox_rows
        .iter()
        .enumerate()
        .find_map(|(i, r)| r.clone().map(|r| (i, r)))
    else {
        return; // this fixture's inbox is empty; the empty-state row carries no object
    };

    let (x, y) = (app.inbox_viewport.x, app.inbox_viewport.y);
    click(&mut app, x + 1, y + index as u16);

    assert_eq!(app.selected, Some(wanted));
    assert_eq!(app.region, Region::Inbox);
}

/// An app with two live panes, drawn, so the pane grid has recorded its rectangles.
fn app_with_panes() -> App {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![
            pane("relay:1", Some("t-backend-auth"), "backend", true),
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        Some("relay:1".to_string()),
    );
    draw_rows(&mut app, 120, 32);
    app
}

#[test]
fn clicking_a_pane_focuses_it() {
    let mut app = app_with_panes();
    let rect = *app
        .pane_rects
        .get("relay:2")
        .expect("the second pane was drawn");

    click(&mut app, rect.x + 2, rect.y + 1);

    assert_eq!(app.ws().focused_pane.as_deref(), Some("relay:2"));
    assert_eq!(app.region, Region::Panes);
    assert!(
        !app.terminal_input,
        "the first click focuses, it does not type"
    );
}

#[test]
fn clicking_the_focused_pane_again_starts_typing_into_it() {
    let mut app = app_with_panes();
    let rect = *app
        .pane_rects
        .get("relay:1")
        .expect("the focused pane was drawn");

    click(&mut app, rect.x + 2, rect.y + 1);

    assert!(
        app.terminal_input,
        "clicking into the pane that already has focus types into it, like a text field"
    );
}

#[test]
fn typing_into_a_pane_sends_the_keys_there() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();
    click(&mut app, rect.x + 2, rect.y + 1);

    let effects = app.handle_key(Key::char('x'));

    assert!(
        matches!(effects.as_slice(), [Effect::PaneInput { pane_id, data }] if pane_id == "relay:1" && data == b"x"),
        "{effects:?}"
    );
}

#[test]
fn escape_leaves_a_pane_so_the_keys_are_the_apps_again() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();
    click(&mut app, rect.x + 2, rect.y + 1);
    assert!(app.terminal_input);

    app.handle_key(Key::ESC);

    assert!(!app.terminal_input);
}

#[test]
fn a_click_on_nothing_leaves_everything_alone() {
    let mut app = drawn_app();
    let before = (app.selected.clone(), app.region, app.graph_view);

    // The status line at the bottom belongs to no panel.
    let effects = app.handle_mouse(Mouse::new(MouseKind::Down, 0, 31));

    assert!(effects.is_empty());
    assert_eq!((app.selected.clone(), app.region, app.graph_view), before);
}

#[test]
fn a_pane_that_was_never_drawn_cannot_be_clicked() {
    let mut app = app_with_panes();
    app.pane_rects.clear();
    let before = app.ws().focused_pane.clone();

    click(&mut app, 100, 20);

    assert_eq!(app.ws().focused_pane, before);
}

#[test]
fn releasing_the_mouse_to_the_terminal_stops_every_panel_from_reacting() {
    let mut app = drawn_app();
    app.handle_key(Key::char('m'));
    let before = (app.selected.clone(), app.region);

    let (x, y) = (app.tree_viewport.x, app.tree_viewport.y);
    click(&mut app, x + 2, y + 3);

    assert_eq!((app.selected.clone(), app.region), before);
}

#[test]
fn viewports_are_cleared_when_a_panel_is_not_drawn() {
    let mut app = replay_app("live-1");
    // Too narrow for the pane grid: nothing there can be clicked.
    draw_rows(&mut app, 60, 24);

    assert!(app.pane_rects.is_empty());
    assert_eq!(
        app.pane_rects.values().copied().collect::<Vec<Viewport>>(),
        Vec::new()
    );
}

#[test]
fn x_asks_before_closing_a_pane_and_names_what_survives() {
    let mut app = app_with_panes();

    let effects = app.handle_key(Key::char('X'));

    assert!(
        effects.is_empty(),
        "nothing happens until the question is answered"
    );
    let prompt = app.prompt_line().expect("a question");
    assert!(prompt.contains("relay:1"), "{prompt}");
    assert!(prompt.contains("backend"), "{prompt}");
    assert!(
        prompt.contains("task keeps waiting"),
        "an agent's pane says what closing it does not do: {prompt}"
    );
}

#[test]
fn answering_yes_closes_the_pane() {
    let mut app = app_with_panes();
    app.handle_key(Key::char('X'));

    let effects = app.handle_key(Key::char('y'));

    assert!(
        matches!(effects.as_slice(), [Effect::KillPane(id)] if id == "relay:1"),
        "{effects:?}"
    );
    assert!(app.prompt_line().is_none(), "the question is done");
}

#[test]
fn answering_no_or_escaping_closes_nothing() {
    for answer in [Key::char('n'), Key::ESC] {
        let mut app = app_with_panes();
        app.handle_key(Key::char('X'));

        let effects = app.handle_key(answer);

        assert!(effects.is_empty(), "{effects:?}");
        assert!(app.prompt_line().is_none());
    }
}

#[test]
fn a_shell_pane_is_asked_about_differently_since_no_task_waits_on_it() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![pane("relay:9", None, "shell", true)],
        Some("relay:9".to_string()),
    );
    app.handle_key(Key::char('X'));

    let prompt = app.prompt_line().expect("a question");
    assert!(prompt.contains("shell"), "{prompt}");
    assert!(!prompt.contains("task keeps waiting"), "{prompt}");
}

#[test]
fn x_says_so_when_there_is_no_pane_to_close() {
    let mut app = drawn_app();

    let effects = app.handle_key(Key::char('X'));

    assert!(effects.is_empty());
    assert!(app.prompt_line().is_none(), "no question without a pane");
    assert!(
        app.notice.as_deref().is_some_and(|n| n.contains("no pane")),
        "{:?}",
        app.notice
    );
}

#[test]
fn a_capital_x_typed_into_a_pane_is_just_a_letter() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();
    click(&mut app, rect.x + 2, rect.y + 1);
    assert!(app.terminal_input);

    let effects = app.handle_key(Key::char('X'));

    assert!(
        matches!(effects.as_slice(), [Effect::PaneInput { data, .. }] if data == b"X"),
        "{effects:?}"
    );
    assert!(app.prompt_line().is_none());
}

// --- agents nobody contracted --------------------------------------------------------------------

/// A pane hosting a coding agent that no task accounts for: launched by hand, bound to nothing.
fn loose_agent(pane_id: &str, role: &str, alive: bool) -> PaneInfo {
    PaneInfo {
        task_id: None,
        ..pane(pane_id, None, role, alive)
    }
}

#[test]
fn an_agent_with_no_contract_is_still_on_the_network() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![loose_agent("relay:7", "scout", true)], None);

    let loose = app.unattached_agents();

    assert_eq!(loose.len(), 1, "{loose:?}");
    assert_eq!(loose[0].id, "relay:7");
    assert_eq!(loose[0].label, "scout");
    assert_eq!(
        loose[0].badge.as_deref(),
        Some("no contract"),
        "the node says why it stands alone"
    );
}

#[test]
fn nothing_connects_it_because_nothing_has_been_agreed() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![loose_agent("relay:7", "scout", true)], None);
    let loose = app.unattached_agents();

    let discs = relay_tui::ui::graph::layout_net(&app.ws().graph, &loose, true);
    assert!(discs.iter().any(|d| d.id == "relay:7"), "it is drawn");
    for edge in &app.ws().graph.edges {
        assert_ne!(edge.from, "relay:7");
        assert_ne!(edge.to, "relay:7");
    }
}

#[test]
fn an_agent_the_planner_did_contract_is_not_duplicated() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    // Same role as a task in the graph: this pane is that agent, not a second one.
    app.set_panes(
        vec![pane("relay:1", Some("t-backend-auth"), "backend", true)],
        None,
    );

    assert!(
        app.unattached_agents().is_empty(),
        "a contracted agent already has its node"
    );
}

#[test]
fn a_plain_shell_is_not_an_agent() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    let mut shell = loose_agent("relay:9", "shell", true);
    shell.runtime = None; // `t` opens a shell, not a coding agent
    app.set_panes(vec![shell], None);

    assert!(app.unattached_agents().is_empty());
}

#[test]
fn a_loose_agent_can_be_selected_like_any_other_node() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![loose_agent("relay:7", "scout", true)], None);

    let refs = app.refs_for_region(Region::Graph);

    assert!(
        refs.contains(&GraphObjectRef::node("relay:7")),
        "j/k reaches what the network draws: {refs:?}"
    );
}

#[test]
fn a_loose_agent_whose_process_died_says_so() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![loose_agent("relay:7", "scout", false)], None);

    let loose = app.unattached_agents();
    assert_eq!(loose[0].runtime, Some(RuntimeState::Exited));
}

// --- closing a pane ------------------------------------------------------------------------------

#[test]
fn a_closed_pane_leaves_the_grid_even_though_the_daemon_still_lists_it() {
    let mut app = app_with_panes();
    app.handle_key(Key::char('X'));
    app.handle_key(Key::char('y'));
    // The runtime does this when the daemon confirms the kill.
    app.dismiss_pane("relay:1");
    assert!(!app.ws().panes.contains(&"relay:1".to_string()));

    // relayd keeps a killed pane in /panes, marked dead — the next poll must not bring it back.
    app.set_panes(
        vec![
            PaneInfo {
                alive: false,
                exit_code: Some(0),
                ..pane("relay:1", Some("t-backend-auth"), "backend", false)
            },
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        None,
    );

    assert!(
        !app.ws().panes.contains(&"relay:1".to_string()),
        "a closed pane stays closed: {:?}",
        app.ws().panes
    );
    assert!(app.ws().panes.contains(&"relay:2".to_string()));
}

#[test]
fn closing_the_focused_pane_moves_focus_to_a_live_one() {
    let mut app = app_with_panes();
    assert_eq!(app.ws().focused_pane.as_deref(), Some("relay:1"));

    app.dismiss_pane("relay:1");

    assert_eq!(app.ws().focused_pane.as_deref(), Some("relay:2"));
    assert!(!app.terminal_input, "typing does not survive the pane");
}

#[test]
fn closing_a_pane_whose_process_already_exited_needs_no_kill() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![PaneInfo {
            alive: false,
            exit_code: Some(0),
            ..pane("relay:5", None, "backend", false)
        }],
        Some("relay:5".to_string()),
    );

    app.handle_key(Key::char('X'));
    let effects = app.handle_key(Key::char('y'));

    assert!(effects.is_empty(), "nothing to kill: {effects:?}");
    assert!(
        !app.ws().panes.contains(&"relay:5".to_string()),
        "but it is gone from the grid"
    );
}

#[test]
fn a_dismissal_is_forgotten_once_the_daemon_forgets_the_pane() {
    let mut app = app_with_panes();
    app.dismiss_pane("relay:1");
    // The daemon drops it (a new run, say), then a pane reuses the id.
    app.set_panes(vec![pane("relay:2", None, "frontend", true)], None);
    app.set_panes(
        vec![
            pane("relay:1", None, "scout", true),
            pane("relay:2", None, "frontend", true),
        ],
        None,
    );

    assert!(
        app.ws().panes.contains(&"relay:1".to_string()),
        "a new pane with that id is not the one that was closed"
    );
}

// --- an empty network ----------------------------------------------------------------------------

#[test]
fn a_fresh_launch_with_no_agents_draws_no_brain() {
    // What `entente` shows before you have started anything: relayd is up, no mission, nothing
    // spawned. buildGraph still hands over human, planner and verifier nodes.
    let mut app = App::new(Mode::Replay);
    app.set_graph(Graph {
        nodes: vec![
            GraphNode {
                id: "planner".into(),
                kind: GraphNodeKind::Planner,
                label: "planner".into(),
                task_id: None,
                runtime: None,
                task_state: None,
                handoff_state: None,
                column: 0,
                status: VisualStatus::Verified,
                badge: None,
            },
            GraphNode {
                id: "verifier".into(),
                kind: GraphNodeKind::Verifier,
                label: "verifier".into(),
                task_id: None,
                runtime: None,
                task_state: None,
                handoff_state: None,
                column: 2,
                status: VisualStatus::Pending,
                badge: None,
            },
        ],
        ..Graph::default()
    });
    app.set_panes(vec![], None);

    let text = String::from_iter(draw_rows(&mut app, 100, 30));

    assert!(
        !text.contains("brain 1"),
        "the object model always carries a planner node; nobody is doing that job yet:\n{text}"
    );
    assert!(!app.planner_present());
}

#[test]
fn spawning_a_planner_is_what_makes_brain_1_appear() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![], None);
    assert!(!app.planner_present());

    // relayd spawns a planner with `name: planner`, which is the pane's role.
    app.set_panes(vec![pane("relay:1", None, "planner", true)], None);

    assert!(app.planner_present());
    let text = String::from_iter(draw_rows(&mut app, 100, 30));
    assert!(text.contains("brain 1"), "{text}");
}

#[test]
fn an_agent_you_launched_is_a_brain_without_any_planner() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(vec![pane("relay:3", None, "scout", true)], None);

    assert!(!app.planner_present(), "a scout is not a planner");
    let naming = relay_tui::ui::network::name_nodes(
        &app.ws().graph,
        &app.unattached_agents(),
        app.planner_present(),
    );
    assert!(
        naming["relay:3"].label.starts_with("brain "),
        "{:?}",
        naming["relay:3"]
    );
}

// --- scrolling a pane ----------------------------------------------------------------------------

#[test]
fn the_wheel_over_a_pane_scrolls_its_history() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();
    assert_eq!(app.pane_scroll("relay:1"), 0, "starts at the live edge");

    app.handle_mouse(Mouse::new(MouseKind::ScrollUp, rect.x + 2, rect.y + 2));
    let back = app.pane_scroll("relay:1");
    assert!(back > 0, "the wheel went back into the scrollback");

    app.handle_mouse(Mouse::new(MouseKind::ScrollDown, rect.x + 2, rect.y + 2));
    assert!(app.pane_scroll("relay:1") < back);
}

#[test]
fn scrolling_a_pane_does_not_move_the_graph_or_the_selection() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();
    let before = (app.selected.clone(), app.graph_view);

    app.handle_mouse(Mouse::new(MouseKind::ScrollUp, rect.x + 2, rect.y + 2));

    assert_eq!((app.selected.clone(), app.graph_view), before);
}

#[test]
fn a_pane_cannot_scroll_past_the_live_edge() {
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();

    for _ in 0..20 {
        app.handle_mouse(Mouse::new(MouseKind::ScrollDown, rect.x + 2, rect.y + 2));
    }

    assert_eq!(
        app.pane_scroll("relay:1"),
        0,
        "0 is the bottom, not a negative"
    );
}

#[test]
fn page_keys_scroll_the_focused_pane() {
    let mut app = app_with_panes();

    app.handle_key(Key::new(KeyCode::PageUp));
    let back = app.pane_scroll("relay:1");
    assert!(back > 0, "PgUp went back");

    app.handle_key(Key::new(KeyCode::PageDown));
    assert!(app.pane_scroll("relay:1") < back, "PgDn came forward");
}

#[test]
fn typing_returns_the_pane_to_the_live_edge() {
    let mut app = app_with_panes();
    app.handle_key(Key::new(KeyCode::PageUp));
    assert!(app.pane_scroll("relay:1") > 0);
    let rect = *app.pane_rects.get("relay:1").unwrap();
    click(&mut app, rect.x + 2, rect.y + 1); // the focused pane: starts typing

    app.handle_key(Key::char('x'));

    assert_eq!(
        app.pane_scroll("relay:1"),
        0,
        "typing means you want to see what you are typing"
    );
}

#[test]
fn each_pane_keeps_its_own_position() {
    let mut app = app_with_panes();
    let second = *app.pane_rects.get("relay:2").unwrap();

    app.handle_mouse(Mouse::new(MouseKind::ScrollUp, second.x + 2, second.y + 2));

    assert!(app.pane_scroll("relay:2") > 0);
    assert_eq!(app.pane_scroll("relay:1"), 0, "the other pane did not move");
}

#[test]
fn closing_a_hand_launched_agents_pane_takes_it_off_the_network() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![loose_agent("relay:7", "scout", true)],
        Some("relay:7".into()),
    );
    assert_eq!(app.unattached_agents().len(), 1, "it is on the network");

    app.dismiss_pane("relay:7");

    assert!(
        app.unattached_agents().is_empty(),
        "its node came from the pane; with the pane closed there is nothing left to draw"
    );
}

#[test]
fn closing_a_contracted_agents_pane_leaves_its_node_alone() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![pane("relay:1", Some("t-backend-auth"), "backend", true)],
        None,
    );

    app.dismiss_pane("relay:1");

    assert!(
        app.ws().graph.node("t-backend-auth").is_some(),
        "the task still exists: closing a terminal is not cancelling the work"
    );
}

// --- deleting work that is over ------------------------------------------------------------------

/// An app whose selected task is in the given state.
fn app_with_task_state(state: TaskState) -> App {
    let mut app = App::new(Mode::Replay);
    let mut g = graph("live-1");
    for node in g.nodes.iter_mut() {
        if node.id == "t-backend-auth" {
            node.task_state = Some(state);
        }
    }
    app.set_graph(g);
    app.select(Some(GraphObjectRef::node("t-backend-auth")));
    app
}

#[test]
fn d_asks_before_deleting_and_says_what_survives() {
    let mut app = app_with_task_state(TaskState::Canceled);

    let effects = app.handle_key(Key::char('D'));

    assert!(effects.is_empty(), "nothing until the question is answered");
    let prompt = app.prompt_line().expect("a question");
    assert!(prompt.contains("t-backend-auth"), "{prompt}");
    assert!(
        prompt.contains("event log"),
        "deleting is forgetting, not undoing — the prompt says what stays: {prompt}"
    );
}

#[test]
fn answering_yes_deletes_the_task() {
    let mut app = app_with_task_state(TaskState::Canceled);
    app.handle_key(Key::char('D'));

    let effects = app.handle_key(Key::char('y'));

    assert!(
        matches!(effects.as_slice(), [Effect::DeleteTask(id)] if id == "t-backend-auth"),
        "{effects:?}"
    );
}

#[test]
fn answering_no_deletes_nothing() {
    let mut app = app_with_task_state(TaskState::Failed);
    app.handle_key(Key::char('D'));

    let effects = app.handle_key(Key::char('n'));

    assert!(effects.is_empty());
    assert!(app.prompt_line().is_none());
}

#[test]
fn live_work_cannot_be_deleted_and_the_key_says_why() {
    let mut app = app_with_task_state(TaskState::Executing);

    let effects = app.handle_key(Key::char('D'));

    assert!(effects.is_empty());
    assert!(app.prompt_line().is_none(), "no question is even asked");
    assert!(
        app.notice
            .as_deref()
            .is_some_and(|n| n.contains("cancelled or failed")),
        "{:?}",
        app.notice
    );
}

#[test]
fn a_failed_task_can_be_deleted_too() {
    let app = app_with_task_state(TaskState::Failed);
    assert_eq!(app.deletable_task().as_deref(), Some("t-backend-auth"));
}

#[test]
fn completed_work_is_not_deletable_it_is_the_record_of_what_was_done() {
    let app = app_with_task_state(TaskState::Completed);
    assert_eq!(app.deletable_task(), None);
}

#[test]
fn a_pane_with_no_history_reports_no_scroll_however_hard_you_try() {
    // The bug this pins: the counter used to climb while the screen stayed put, so the title claimed
    // `↑12` on a pane that had not moved a row.
    let mut app = app_with_panes();
    let rect = *app.pane_rects.get("relay:1").unwrap();

    for _ in 0..10 {
        app.handle_mouse(Mouse::new(MouseKind::ScrollUp, rect.x + 2, rect.y + 2));
    }
    let text = String::from_iter(draw_rows(&mut app, 120, 32));

    assert_eq!(
        app.pane_scroll("relay:1"),
        0,
        "an empty pane has nothing to scroll back through"
    );
    assert!(
        !text.contains("PgDn for live"),
        "and says nothing about it:\n{text}"
    );
}

#[test]
fn a_pane_with_history_scrolls_and_says_how_far() {
    let mut app = app_with_panes();
    // Fill the pane past its own height so there is something above the viewport.
    let pane = app.ws_mut().pane_states.get_mut("relay:1").unwrap();
    for i in 0..80 {
        pane.parser.process(format!("line {i}\r\n").as_bytes());
    }
    let rect = *app.pane_rects.get("relay:1").unwrap();

    app.handle_mouse(Mouse::new(MouseKind::ScrollUp, rect.x + 2, rect.y + 2));
    let text = String::from_iter(draw_rows(&mut app, 120, 32));

    assert!(app.pane_scroll("relay:1") > 0, "it really moved");
    assert!(text.contains("PgDn for live"), "{text}");
}

// --- workspaces ----------------------------------------------------------------------------------

#[test]
fn one_url_is_one_workspace_and_nothing_is_renamed() {
    let app = App::with_urls(Mode::Replay, &["http://127.0.0.1:7420".to_string()]);

    assert_eq!(app.workspaces.len(), 1);
    assert_eq!(app.active, 0);
}

#[test]
fn every_workspace_puts_its_agents_on_the_one_network() {
    let mut app = App::with_urls(
        Mode::Replay,
        &[
            "http://127.0.0.1:7420".into(),
            "http://127.0.0.1:7421".into(),
        ],
    );
    app.workspaces[0].graph = graph("live-1");
    app.workspaces[1].graph = graph("live-7");

    let merged = app.merged_graph();

    let agents: Vec<&str> = merged
        .nodes
        .iter()
        .filter(|n| n.kind == GraphNodeKind::Agent)
        .map(|n| n.id.as_str())
        .collect();
    assert!(agents.iter().any(|id| id.starts_with("0/")), "{agents:?}");
    assert!(agents.iter().any(|id| id.starts_with("1/")), "{agents:?}");
}

#[test]
fn two_projects_can_hold_the_same_task_id_without_becoming_one_agent() {
    let mut app = App::with_urls(Mode::Replay, &["a".into(), "b".into()]);
    app.workspaces[0].graph = graph("live-1");
    app.workspaces[1].graph = graph("live-1");

    let merged = app.merged_graph();
    let backends: Vec<&str> = merged
        .nodes
        .iter()
        .filter(|n| n.id.ends_with("t-backend-auth"))
        .map(|n| n.id.as_str())
        .collect();

    assert_eq!(
        backends.len(),
        2,
        "the same id in two repos is two agents: {backends:?}"
    );
    assert_ne!(backends[0], backends[1]);
}

#[test]
fn edges_stay_inside_their_own_workspace() {
    let mut app = App::with_urls(Mode::Replay, &["a".into(), "b".into()]);
    app.workspaces[0].graph = graph("live-7");
    app.workspaces[1].graph = graph("live-7");

    let merged = app.merged_graph();

    for edge in &merged.edges {
        let (from_ws, _) = edge.from.split_once('/').expect("qualified");
        let (to_ws, _) = edge.to.split_once('/').expect("qualified");
        assert_eq!(from_ws, to_ws, "no contract crosses projects: {}", edge.id);
    }
}

#[test]
fn switching_workspace_moves_the_selection_with_it() {
    let mut app = App::with_urls(Mode::Replay, &["a".into(), "b".into()]);
    app.workspaces[0].graph = graph("live-1");
    app.workspaces[1].graph = graph("live-7");
    app.select(Some(GraphObjectRef::node("t-backend-auth")));

    app.set_active(1);

    assert_eq!(app.active, 1);
    assert!(
        app.selected.is_some(),
        "the new workspace's own first object is selected, not the old one's"
    );
    assert!(
        !app.terminal_input,
        "typing does not follow you across projects"
    );
}

// --- selecting an agent shows its terminal --------------------------------------------------------

#[test]
fn selecting_an_agent_focuses_its_pane() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![
            pane("relay:1", Some("t-backend-auth"), "backend", true),
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        Some("relay:1".to_string()),
    );

    app.select(Some(GraphObjectRef::node("t-frontend-login")));

    assert_eq!(
        app.ws().focused_pane.as_deref(),
        Some("relay:2"),
        "picking an agent shows its terminal"
    );
}

#[test]
fn the_focused_pane_is_the_one_drawn_big_and_marked() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![
            pane("relay:1", Some("t-backend-auth"), "backend", true),
            pane("relay:2", Some("t-frontend-login"), "frontend", true),
        ],
        Some("relay:1".to_string()),
    );
    app.select(Some(GraphObjectRef::node("t-frontend-login")));

    let rows = draw_rows(&mut app, 120, 32);
    let big = *app.pane_rects.get("relay:2").expect("drawn");
    let thumb = *app.pane_rects.get("relay:1").expect("drawn");

    assert!(
        big.height > thumb.height,
        "the selected agent's pane gets the room"
    );
    assert!(
        String::from_iter(rows).contains("frontend"),
        "and is named on screen"
    );
}

#[test]
fn selecting_an_agent_with_no_pane_changes_no_focus() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.set_panes(
        vec![pane("relay:1", Some("t-backend-auth"), "backend", true)],
        None,
    );

    app.select(Some(GraphObjectRef::node("t-frontend-login")));

    assert_eq!(app.ws().focused_pane.as_deref(), Some("relay:1"));
}

#[test]
fn the_panel_is_about_projects_even_with_one_open() {
    let mut app = App::new(Mode::Replay);
    app.set_state(state("live-1"));
    app.set_graph(graph("live-1"));

    let text = String::from_iter(draw_rows(&mut app, 120, 32));

    assert!(text.contains("WORKSPACES"), "{text}");
    assert!(!text.contains("MISSION / WORKTREES"), "{text}");
    // Named after its repo, which the mission says, rather than the port it was addressed on.
    assert_eq!(app.ws().name, "app", "{}", app.ws().name);
}

#[test]
fn a_workspace_goes_by_its_port_until_its_daemon_says_which_repo() {
    let app = App::with_urls(Mode::Live, &["http://127.0.0.1:7421".to_string()]);

    assert_eq!(app.ws().name, ":7421");
}

// --- reading something longer than the panel ------------------------------------------------------

#[test]
fn arrows_scroll_along_a_question_while_the_inspector_is_open() {
    let mut app = replay_app("live-1");
    app.inspector_open = true;

    app.handle_key(Key::new(KeyCode::Right));
    let moved = app.h_scroll;
    assert!(moved > 0, "the text moved right");

    app.handle_key(Key::new(KeyCode::Left));
    assert!(app.h_scroll < moved, "and back left");
}

#[test]
fn it_never_scrolls_past_the_left_edge() {
    let mut app = replay_app("live-1");
    app.inspector_open = true;

    for _ in 0..10 {
        app.handle_key(Key::new(KeyCode::Left));
    }

    assert_eq!(app.h_scroll, 0, "0 is the start, not a negative");
}

#[test]
fn the_graph_keeps_the_arrows_when_nothing_is_being_read() {
    let mut app = replay_app("live-1");
    app.region = Region::Graph;
    assert!(!app.inspector_open);

    app.handle_key(Key::new(KeyCode::Right));

    assert_eq!(app.h_scroll, 0, "the arrows panned the network instead");
    assert!(app.graph_view.pan_x > 0.0);
}

#[test]
fn reading_starts_from_the_left_again_when_the_selection_changes() {
    let mut app = replay_app("live-1");
    app.inspector_open = true;
    app.handle_key(Key::new(KeyCode::Right));
    assert!(app.h_scroll > 0);

    app.select(Some(GraphObjectRef::node("t-frontend-login")));

    assert_eq!(
        app.h_scroll, 0,
        "a different object is read from its own beginning"
    );
}

#[test]
fn the_panel_says_when_you_are_not_at_the_left() {
    let mut app = replay_app("live-1");
    app.inspector_open = true;
    app.handle_key(Key::new(KeyCode::Right));

    let text = String::from_iter(draw_rows(&mut app, 120, 32));

    assert!(
        text.contains("→"),
        "a half-read line is never mistaken for a whole one:\n{text}"
    );
}

// --- an inbox with more than fits -----------------------------------------------------------------

/// A graph whose inbox has many questions, so its rows outgrow any strip.
fn crowded_inbox() -> Graph {
    let mut g = graph("live-1");
    g.inbox = (1..=6)
        .map(|n| InboxItem {
            id: format!("q{n}"),
            kind: InboxKind::TaskQuestion,
            mission_id: "m-1".to_string(),
            task_id: Some(format!("t-{n}")),
            title: format!("agent {n} asks a question"),
            detail: vec![format!("Q1 question {n}"), format!("Q2 also {n}")],
            since: None,
            reference: GraphObjectRef::node(format!("t-{n}")),
            actions: Vec::new(),
        })
        .collect();
    g
}

#[test]
fn every_question_gets_its_own_row() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(crowded_inbox());

    let rows = relay_tui::ui::inbox::all_inbox_rows(&app, 120);
    let text: Vec<String> = rows.iter().map(|(l, _)| l.to_string()).collect();

    assert!(text.iter().any(|l| l.contains("Q1 question 1")), "{text:?}");
    assert!(text.iter().any(|l| l.contains("Q2 also 1")), "{text:?}");
    assert!(
        !text
            .iter()
            .any(|l| l.contains("Q1 question 1") && l.contains("Q2 also 1")),
        "two questions are never one row: {text:?}"
    );
    // A row for the item, then one per question.
    assert_eq!(rows.len(), 6 * 3);
}

#[test]
fn the_inbox_scrolls_down_past_what_fits() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(crowded_inbox());
    draw_rows(&mut app, 120, 32);
    let first = String::from_iter(draw_rows(&mut app, 120, 32));
    assert!(first.contains("↕"), "there is more than fits:\n{first}");

    let rect = app.inbox_viewport;
    for _ in 0..6 {
        app.handle_mouse(Mouse::new(MouseKind::ScrollDown, rect.x + 2, rect.y + 1));
    }
    let later = String::from_iter(draw_rows(&mut app, 120, 32));

    assert!(app.inbox_scroll > 0);
    // What is on screen now was not before: that is the whole of what scrolling means.
    assert!(
        !first.contains("agent 5"),
        "agent 5 was below the fold:\n{first}"
    );
    assert!(later.contains("agent 5"), "and is now in view:\n{later}");
    assert!(
        !later.contains("agent 1"),
        "the first item scrolled away:\n{later}"
    );
}

#[test]
fn it_never_scrolls_past_the_last_row() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(crowded_inbox());

    for _ in 0..200 {
        app.scroll_inbox(1);
    }

    assert!(app.inbox_scroll < relay_tui::ui::inbox::all_inbox_rows(&app, 120).len());
}

#[test]
fn moving_the_selection_brings_it_back_into_view() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(crowded_inbox());
    app.region = Region::Inbox;
    app.select(Some(GraphObjectRef::inbox("q6")));

    draw_rows(&mut app, 120, 32);

    let shown = relay_tui::ui::inbox::inbox_rows(&app, 8);
    let text: Vec<String> = shown.iter().map(|(l, _)| l.to_string()).collect();
    assert!(
        text.iter().any(|l| l.contains("agent 6")),
        "the selected item is on screen: {text:?}"
    );
}

// --- answering questions one at a time ------------------------------------------------------------

/// The demo graph's `t-backend-auth` asks two questions, with the wording in the inbox item's
/// detail rows — the shape `a` has to walk.
fn two_question_app() -> App {
    let mut app = App::new(Mode::Replay);
    app.set_graph(demo_graph());
    app.select(Some(GraphObjectRef::inbox("question:t-backend-auth")));
    app
}

#[test]
fn answering_walks_every_question_the_item_asked() {
    let mut app = two_question_app();

    app.handle_key(Key::char('a'));
    let prompt = app.prompt_line().expect("an editor");
    assert_eq!(
        prompt, "1/2 Which auth method?> ",
        "the question in its own words, and where it is in the sequence"
    );

    for c in "magic links".chars() {
        app.handle_key(Key::char(c));
    }
    let effects = app.handle_key(Key::ENTER);
    assert_eq!(
        effects,
        vec![Effect::Post(Command::Clarify {
            task_id: "t-backend-auth".into(),
            question_id: "Q1".into(),
            answer: "magic links".into(),
        })]
    );

    // The item asked two, so the work is not done and the editor does not close. Answering Q1 and
    // dropping Q2 wrote one answer into an append-only log and told the human it was finished.
    assert_eq!(
        app.prompt_line().as_deref(),
        Some("2/2 Link expiry?> "),
        "moved on to the second, empty"
    );
    for c in "15m".chars() {
        app.handle_key(Key::char(c));
    }
    let effects = app.handle_key(Key::ENTER);
    assert_eq!(
        effects,
        vec![Effect::Post(Command::Clarify {
            task_id: "t-backend-auth".into(),
            question_id: "Q2".into(),
            answer: "15m".into(),
        })]
    );
    assert_eq!(app.input_mode, None, "and now it closes");
}

#[test]
fn the_strip_marks_which_questions_you_have_already_answered() {
    let mut app = two_question_app();
    app.handle_key(Key::char('a'));

    let marks = |app: &App| -> Vec<String> {
        relay_tui::ui::inbox::all_inbox_rows(app, 120)
            .into_iter()
            .map(|(line, _)| line.to_string())
            .filter(|l| l.contains("Which auth method?") || l.contains("Link expiry?"))
            .collect()
    };
    let before = marks(&app);
    assert!(before[0].trim_start().starts_with('▸'), "{before:?}");
    assert!(before[1].trim_start().starts_with('·'), "{before:?}");

    for c in "magic links".chars() {
        app.handle_key(Key::char(c));
    }
    app.handle_key(Key::ENTER);

    let after = marks(&app);
    assert!(after[0].trim_start().starts_with('✓'), "{after:?}");
    assert!(after[1].trim_start().starts_with('▸'), "{after:?}");
}

#[test]
fn a_single_question_closes_the_editor_once_it_is_answered() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.select(Some(GraphObjectRef::node("t-backend-auth")));
    app.set_actions(
        &GraphObjectRef::node("t-backend-auth"),
        vec![ObjectAction {
            key: "a".into(),
            kind: ActionKind::Clarify,
            label: "answer".into(),
            target: ActionTarget {
                task_id: Some("t-backend-auth".into()),
                question_ids: Some(vec!["Q1".into()]),
                ..Default::default()
            },
        }],
    );

    app.handle_key(Key::char('a'));
    // Nothing in this fixture's inbox spells Q1 out, so the prompt falls back to naming the id
    // rather than pretending to quote a question it cannot find.
    let prompt = app.prompt_line().expect("an editor");
    assert_eq!(prompt, "Q1> ", "one question, so no count");

    for c in "yes".chars() {
        app.handle_key(Key::char(c));
    }
    app.handle_key(Key::ENTER);
    assert_eq!(app.input_mode, None);
}

/// Selecting an inbox item points the other panels at what it is about, instead of leaving them
/// showing nothing while you read the list.
#[test]
fn an_inbox_selection_lights_up_the_network_it_came_from() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(demo_graph());
    app.select(Some(GraphObjectRef::inbox("question:t-backend-auth")));

    assert_eq!(
        app.highlighted(),
        Some(GraphObjectRef::edge("contract:t-backend-auth")),
        "an inbox item is a pointer at a graph object"
    );
    assert!(app.highlights_edge("contract:t-backend-auth"));
    let agent = app
        .ws()
        .graph
        .nodes
        .iter()
        .find(|n| n.task_id.as_deref() == Some("t-backend-auth"))
        .expect("the agent doing the task");
    assert!(
        app.highlights_node(agent),
        "and at the agent that is waiting on you"
    );
    assert_ne!(
        relay_tui::ui::graph::detail_line(&app).to_string().trim(),
        "",
        "the line under the network explains the selection rather than going blank"
    );
}

// --- an editor that outlives what it was answering ------------------------------------------------

/// The demo graph with a second agent that also asks a `Q1` — the normal state of a fleet, since
/// question ids are per task and every agent starts at 1.
fn two_agents_both_asking() -> App {
    let mut app = App::new(Mode::Replay);
    let mut graph = demo_graph();
    graph.inbox.push(InboxItem {
        id: "question:t-frontend-login".into(),
        kind: InboxKind::TaskQuestion,
        mission_id: "m-001".into(),
        task_id: Some("t-frontend-login".into()),
        title: "frontend asks 1 question (v1)".into(),
        detail: vec!["Q1: Which shade of blue?".into()],
        since: Some("2026-09-05T10:30:00+08:00".into()),
        reference: GraphObjectRef::edge("contract:t-frontend-login"),
        actions: vec![ObjectAction {
            key: "a".into(),
            kind: ActionKind::Clarify,
            label: "answer".into(),
            target: ActionTarget {
                task_id: Some("t-frontend-login".into()),
                question_ids: Some(vec!["Q1".into()]),
                ..Default::default()
            },
        }],
    });
    app.set_graph(graph);
    app
}

#[test]
fn the_prompt_quotes_the_question_of_the_item_you_are_answering() {
    let mut app = two_agents_both_asking();
    app.select(Some(GraphObjectRef::inbox("question:t-frontend-login")));

    app.handle_key(Key::char('a'));

    // Both items have a Q1. Searching the whole inbox would show backend's wording above frontend's
    // task id, and you would answer a question you never read.
    assert_eq!(app.prompt_line().as_deref(), Some("Which shade of blue?> "));
}

#[test]
fn an_editor_does_not_outlive_the_item_it_was_answering() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(demo_graph());
    app.select(Some(GraphObjectRef::inbox("question:t-backend-auth")));
    app.handle_key(Key::char('a'));
    for c in "magic links".chars() {
        app.handle_key(Key::char(c));
    }
    app.handle_key(Key::ENTER);
    assert_eq!(app.input_mode, Some(InputMode::Answer), "Q2 is still open");

    // The task is cancelled while you are typing the second answer. The editor only draws inside the
    // inspector, so leaving input_mode set left no prompt, no cursor, and every key still swallowed
    // into a field you could not see — the app looked frozen with no way out but Esc.
    let mut graph = demo_graph();
    graph.inbox.retain(|i| i.id != "question:t-backend-auth");
    app.set_graph(graph);

    assert_eq!(app.input_mode, None, "the editor closed with the item");
    assert!(
        app.notice
            .as_deref()
            .unwrap_or_default()
            .contains("1 answer"),
        "and said what had already been sent: {:?}",
        app.notice
    );
    // Keys reach the app again.
    app.handle_key(Key::TAB);
    assert!(app.input_value.is_empty());
}

#[test]
fn a_question_answered_elsewhere_leaves_the_queue() {
    let mut app = App::new(Mode::Replay);
    app.set_graph(demo_graph());
    app.select(Some(GraphObjectRef::inbox("question:t-backend-auth")));
    app.handle_key(Key::char('a'));
    assert_eq!(
        app.prompt_line().as_deref(),
        Some("1/2 Which auth method?> ")
    );

    // Someone answers Q1 from the CLI. The item survives, so the editor stays — but its queue must
    // follow the server, or the prompt names a question nobody is asking and Enter answers it twice.
    let mut graph = demo_graph();
    for item in &mut graph.inbox {
        if item.id == "question:t-backend-auth" {
            item.detail.retain(|d| !d.starts_with("Q1"));
            for action in &mut item.actions {
                if let Some(ids) = action.target.question_ids.as_mut() {
                    ids.retain(|q| q != "Q1");
                }
            }
        }
    }
    app.set_graph(graph);

    assert_eq!(app.input_mode, Some(InputMode::Answer));
    assert_eq!(
        app.prompt_line().as_deref(),
        Some("Link expiry?> "),
        "one question left, so no count, and it is the right one"
    );
}
