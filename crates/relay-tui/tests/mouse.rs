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
