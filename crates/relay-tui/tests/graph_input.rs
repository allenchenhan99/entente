//! Driving the agent network: click to select, drag to pan, wheel to zoom, and the keys that do the same.
//! The mouse is abstracted the way keys are, so every rule here is checked without a terminal.

mod support;

use relay_tui::app::{App, Effect, GraphView, Mode, Region, Viewport};
use relay_tui::keys::{Key, KeyCode, Mouse, MouseKind};
use relay_tui::model::*;
use relay_tui::ui::graph::{cell_to_world, hit_test, layout_net};
use support::*;

/// An app showing the fixture with the graph panel drawn at a known place on screen.
fn app_with_canvas() -> App {
    let mut app = App::new(Mode::Replay);
    app.set_graph(graph("live-1"));
    app.region = Region::Graph;
    app.graph_viewport = Viewport {
        x: 0,
        y: 10,
        width: 46,
        height: 14,
    };
    app
}

/// A cell that lands on the node — what the user's pointer would be over. A row spans several world
/// units, so this asks the same question the app does rather than looking for the exact centre.
fn cell_of(app: &App, node_id: &str) -> (u16, u16) {
    let discs = layout_net(&app.graph);
    let viewport = app.graph_viewport;
    let wanted = Some(GraphObjectRef::node(node_id));
    for row in viewport.y..viewport.y + viewport.height {
        for col in viewport.x..viewport.x + viewport.width {
            let point = cell_to_world(&app.graph_view, viewport, col, row);
            if hit_test(&app.graph, &discs, point) == wanted {
                return (col, row);
            }
        }
    }
    panic!("no cell maps to {node_id}");
}

#[test]
fn clicking_a_node_selects_it_and_focuses_the_graph() {
    let mut app = app_with_canvas();
    app.region = Region::Tree;
    let (col, row) = cell_of(&app, "verifier");

    app.handle_mouse(Mouse::new(MouseKind::Down, col, row));

    assert_eq!(app.selected, Some(GraphObjectRef::node("verifier")));
    assert_eq!(
        app.region,
        Region::Graph,
        "clicking moves focus to the graph"
    );
}

#[test]
fn selecting_a_node_asks_for_its_actions() {
    let mut app = app_with_canvas();
    // The first agent is selected already, and re-selecting it is not a change; click the other one.
    let (col, row) = cell_of(&app, "t-frontend-login");

    let effects = app.handle_mouse(Mouse::new(MouseKind::Down, col, row));

    assert_eq!(app.selected, Some(GraphObjectRef::node("t-frontend-login")));
    assert!(
        effects.iter().any(|e| matches!(
            e,
            Effect::FetchActions(r) if r.id == "t-frontend-login"
        )),
        "{effects:?}"
    );
}

#[test]
fn a_click_outside_the_canvas_is_left_to_the_rest_of_the_app() {
    let mut app = app_with_canvas();
    let before = app.selected.clone();

    let effects = app.handle_mouse(Mouse::new(MouseKind::Down, 5, 2));

    assert!(effects.is_empty());
    assert_eq!(app.selected, before);
}

#[test]
fn dragging_the_background_pans_and_dragging_a_node_does_not() {
    let mut app = app_with_canvas();
    // Start on empty space: the corner of the panel is outside every disc.
    app.handle_mouse(Mouse::new(MouseKind::Down, 0, 10));
    let start = app.graph_view;
    app.handle_mouse(Mouse::new(MouseKind::Drag, 8, 10));
    let panned = app.graph_view;
    assert!(
        panned.pan_x != start.pan_x,
        "dragging the background moves the view"
    );

    app.handle_mouse(Mouse::new(MouseKind::Up, 8, 10));
    let (col, row) = cell_of(&app, "t-backend-auth");
    app.handle_mouse(Mouse::new(MouseKind::Down, col, row));
    let held = app.graph_view;
    app.handle_mouse(Mouse::new(MouseKind::Drag, col + 6, row));
    assert_eq!(
        app.graph_view, held,
        "a press that landed on a node selects it; it does not pan"
    );
}

#[test]
fn dragging_moves_the_world_with_the_pointer() {
    let mut app = app_with_canvas();
    app.handle_mouse(Mouse::new(MouseKind::Down, 0, 10));
    app.handle_mouse(Mouse::new(MouseKind::Drag, 10, 10));

    // Pulling the canvas to the right shows what was to its left, so the view moves left.
    assert!(app.graph_view.pan_x < 0.0, "{:?}", app.graph_view);
}

#[test]
fn the_wheel_zooms_within_limits() {
    let mut app = app_with_canvas();
    for _ in 0..40 {
        app.handle_mouse(Mouse::new(MouseKind::ScrollUp, 10, 12));
    }
    assert_eq!(app.graph_view.zoom, GraphView::MAX_ZOOM);

    for _ in 0..80 {
        app.handle_mouse(Mouse::new(MouseKind::ScrollDown, 10, 12));
    }
    assert_eq!(app.graph_view.zoom, GraphView::MIN_ZOOM);
}

#[test]
fn panning_is_bounded_so_the_network_cannot_be_lost() {
    let mut app = app_with_canvas();
    for _ in 0..200 {
        app.handle_key(Key::new(KeyCode::Left));
    }
    assert_eq!(app.graph_view.pan_x, -GraphView::MAX_PAN);
}

#[test]
fn arrows_pan_the_graph_while_j_and_k_still_walk_the_objects() {
    let mut app = app_with_canvas();
    let selected = app.selected.clone();

    app.handle_key(Key::new(KeyCode::Right));
    assert!(app.graph_view.pan_x > 0.0);
    assert_eq!(
        app.selected, selected,
        "panning does not change the selection"
    );

    app.handle_key(Key::char('j'));
    assert_ne!(app.selected, selected, "j still moves the selection");
}

#[test]
fn arrows_outside_the_graph_still_move_the_selection() {
    let mut app = app_with_canvas();
    app.region = Region::Tree;
    let before = app.selected.clone();

    app.handle_key(Key::new(KeyCode::Down));

    assert_eq!(
        app.graph_view,
        GraphView::default(),
        "the tree does not pan"
    );
    assert_ne!(app.selected, before);
}

#[test]
fn zoom_keys_and_the_reset_key_agree_with_the_wheel() {
    let mut app = app_with_canvas();
    app.handle_key(Key::char('+'));
    assert!(app.graph_view.zoom > 1.0);
    app.handle_key(Key::char('-'));
    assert!((app.graph_view.zoom - 1.0).abs() < 0.0001);

    app.handle_key(Key::char('+'));
    app.handle_key(Key::new(KeyCode::Left));
    app.handle_key(Key::char('0'));
    assert_eq!(app.graph_view, GraphView::default(), "0 refits the view");
}

#[test]
fn m_hands_the_mouse_back_to_the_terminal_and_takes_it_again() {
    let mut app = app_with_canvas();
    assert!(app.mouse_capture, "the app starts with the mouse");

    let effects = app.handle_key(Key::char('m'));
    assert!(!app.mouse_capture);
    assert!(matches!(
        effects.as_slice(),
        [Effect::SetMouseCapture(false)]
    ));
    assert!(
        app.notice
            .as_deref()
            .is_some_and(|n| n.contains("terminal")),
        "the user is told who has the mouse: {:?}",
        app.notice
    );

    // While the terminal has it, the app ignores what it is sent.
    let (col, row) = cell_of(&app, "verifier");
    app.selected = None;
    assert!(app
        .handle_mouse(Mouse::new(MouseKind::Down, col, row))
        .is_empty());
    assert_eq!(app.selected, None);

    let effects = app.handle_key(Key::char('m'));
    assert!(app.mouse_capture);
    assert!(matches!(
        effects.as_slice(),
        [Effect::SetMouseCapture(true)]
    ));
}

#[test]
fn an_open_overlay_keeps_the_mouse_out_of_the_graph() {
    let mut app = app_with_canvas();
    app.help_open = true;
    app.selected = None;
    let (col, row) = cell_of(&app, "verifier");

    assert!(app
        .handle_mouse(Mouse::new(MouseKind::Down, col, row))
        .is_empty());
    assert_eq!(app.selected, None, "the help overlay owns the screen");
}

#[test]
fn t_asks_for_a_shell_pane_and_says_so() {
    let mut app = app_with_canvas();

    let effects = app.handle_key(Key::char('t'));

    assert!(matches!(effects.as_slice(), [Effect::NewShellPane]));
    assert!(
        app.notice.as_deref().is_some_and(|n| n.contains("shell")),
        "{:?}",
        app.notice
    );
}

#[test]
fn t_does_not_type_into_a_pane_or_an_editor() {
    let mut app = app_with_canvas();
    app.terminal_input = true;

    let effects = app.handle_key(Key::char('t'));

    assert!(
        !matches!(effects.as_slice(), [Effect::NewShellPane]),
        "while typing into a terminal, t is just a letter"
    );
}
