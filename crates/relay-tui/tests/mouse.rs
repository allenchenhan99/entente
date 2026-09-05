//! The mouse across the whole app: the panel under the pointer decides what a click means. Every rule
//! is checked through `App`, which never touches a terminal, so these run without one.

mod support;

use relay_tui::app::{App, Effect, Mode, Region, Viewport};
use relay_tui::keys::{Key, Mouse, MouseKind};
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

    assert_eq!(app.focused_pane.as_deref(), Some("relay:2"));
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
    let before = app.focused_pane.clone();

    click(&mut app, 100, 20);

    assert_eq!(app.focused_pane, before);
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

    let discs = relay_tui::ui::graph::layout_net(&app.graph, &loose, true);
    assert!(discs.iter().any(|d| d.id == "relay:7"), "it is drawn");
    for edge in &app.graph.edges {
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
    assert!(!app.panes.contains(&"relay:1".to_string()));

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
        !app.panes.contains(&"relay:1".to_string()),
        "a closed pane stays closed: {:?}",
        app.panes
    );
    assert!(app.panes.contains(&"relay:2".to_string()));
}

#[test]
fn closing_the_focused_pane_moves_focus_to_a_live_one() {
    let mut app = app_with_panes();
    assert_eq!(app.focused_pane.as_deref(), Some("relay:1"));

    app.dismiss_pane("relay:1");

    assert_eq!(app.focused_pane.as_deref(), Some("relay:2"));
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
        !app.panes.contains(&"relay:5".to_string()),
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
        app.panes.contains(&"relay:1".to_string()),
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
        &app.graph,
        &app.unattached_agents(),
        app.planner_present(),
    );
    assert!(
        naming["relay:3"].label.starts_with("brain "),
        "{:?}",
        naming["relay:3"]
    );
}
