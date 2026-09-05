//! The pane grid: the focused pane large (a `tui-term` widget over its `vt100` screen), and every other pane
//! as one titled row beneath it. Records every widget's size in `app.pane_areas` so the runtime can send
//! `resize`.
//!
//! The others are a list, not a wall of thumbnails. Three lines of an agent's scrollback out of context say
//! almost nothing — they are usually mid-sentence — while costing four rows each, so a fleet of seven panes
//! fitted four and hid the rest behind `+3 more`. A row per pane says who it is, what it is on and how it is
//! doing, and they all fit. The order is the network's: brains, each followed by the subs it called, so the
//! list and the graph read the same way.

use crate::app::{pane_matches_selection, App, PaneState, Region};
use crate::ui::tree::status_color;
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use tui_term::widget::PseudoTerminal;

pub const THUMB_LINES: u16 = 3;
/// Rows the list may take before it scrolls, so the focused terminal always keeps most of the panel.
const MAX_LIST_ROWS: u16 = 10;

/// `role · task · status` for a pane: the graph status of its task when known, else alive / exited.
pub fn pane_title(app: &App, pane: &PaneState) -> String {
    let info = &pane.info;
    let task = info.task_id.clone().unwrap_or_else(|| "-".to_string());
    let status = info
        .task_id
        .as_deref()
        .and_then(|t| app.ws().graph.node(t))
        .and_then(|n| serde_json::to_value(n.status).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| {
            if pane.alive() {
                "alive".to_string()
            } else {
                match pane.exit_code.or(info.exit_code) {
                    Some(code) => format!("exited {code}"),
                    None => "exited".to_string(),
                }
            }
        });
    format!("{} · {task} · {status}", info.role)
}

fn title_style(app: &App, pane: &PaneState) -> Style {
    let color = pane
        .info
        .task_id
        .as_deref()
        .and_then(|t| app.ws().graph.node(t))
        .map(|n| status_color(n.status))
        .unwrap_or(if pane.alive() {
            Color::Cyan
        } else {
            Color::DarkGray
        });
    let mut style = Style::new().fg(color);
    if pane_matches_selection(app, pane) {
        style = style.bold();
    }
    style
}

/// The last `n` rows of the screen up to the cursor (what a thumbnail shows).
pub fn tail_lines(pane: &PaneState, n: usize) -> Vec<String> {
    let screen = pane.parser.screen();
    let (rows, cols) = screen.size();
    let (cursor_row, _) = screen.cursor_position();
    let last = (cursor_row as usize + 1).min(rows as usize);
    let all: Vec<String> = screen
        .rows(0, cols)
        .take(last)
        .map(|r| r.trim_end().to_string())
        .collect();
    let start = all.len().saturating_sub(n);
    all[start..].to_vec()
}

/// Where a pane sits on the network, and what the graph calls it: `brain 1`, `sub 1.2`.
///
/// Read from the same `name_nodes` the network draws with, so the two never disagree about who called
/// whom. A pane relayd hosts that no contract accounts for is keyed by its own id; one running a task
/// is keyed by that task.
pub fn pane_label(app: &App, pane: &PaneState) -> Option<crate::ui::network::Naming> {
    let naming = crate::ui::network::name_nodes(
        &app.ws().graph,
        &app.unattached_agents(),
        app.planner_present(),
    );
    let by_task = pane
        .info
        .task_id
        .as_deref()
        .and_then(|task| naming.get(task).cloned());
    by_task.or_else(|| naming.get(&pane.info.pane_id).cloned())
}

/// Every pane in the order the list shows them: brains first, each followed by the subs it called, and
/// anything the network does not name after those. Sorting on the network's own numbering means the
/// list reads like the graph rather than like the order panes happened to be opened.
pub fn ordered_panes(app: &App) -> Vec<String> {
    let mut panes: Vec<(Option<(usize, String)>, String)> = app
        .ws()
        .panes
        .iter()
        .map(|id| {
            let key = app
                .ws()
                .pane_states
                .get(id)
                .and_then(|pane| pane_label(app, pane))
                .map(|naming| (naming.tier, naming.number));
            (key, id.clone())
        })
        .collect();
    panes.sort_by(|a, b| match (&a.0, &b.0) {
        (Some((_, x)), Some((_, y))) => sort_key(x).cmp(&sort_key(y)).then(a.1.cmp(&b.1)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1),
    });
    panes.into_iter().map(|(_, id)| id).collect()
}

/// Sort key for a network number. `1` then `1.1` then `1.2` then `2`, so a brain is followed by the
/// subs it called — and comparing the parts as numbers, not as text, keeps `1.10` after `1.2`.
///
/// An agent whose caller is not on the graph has no number, and goes last: it is real work and must
/// still be listed, but it is not the first thing to read.
fn sort_key(number: &str) -> (bool, Vec<u32>) {
    (
        number.is_empty(),
        number.split('.').filter_map(|p| p.parse().ok()).collect(),
    )
}

/// One row of the list: `sub 1.2  backend · t-user-roles · working`.
fn list_row(app: &App, pane: &PaneState, focused: bool) -> Line<'static> {
    let naming = pane_label(app, pane);
    let label = naming
        .as_ref()
        .map(|n| n.label.clone())
        .unwrap_or_else(|| "—".to_string());
    // Subs are indented under the brain that called them, so two layers are visible at a glance.
    let indent = if naming.as_ref().is_some_and(|n| n.tier > 0) {
        "  "
    } else {
        ""
    };
    let marker = if focused { "▸ " } else { "  " };
    let mut style = title_style(app, pane);
    if focused {
        style = style.bold();
    }
    Line::from(vec![
        Span::styled(
            format!("{marker}{indent}"),
            Style::new().fg(Color::DarkGray),
        ),
        Span::styled(format!("{label:<9}"), style),
        Span::styled(pane_title(app, pane), Style::new().fg(Color::Gray)),
    ])
}

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    let active = region_active(app, Region::Panes);
    let block = panel_block(Region::Panes.title(), active, Borders::TOP | Borders::LEFT);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    app.pane_areas.clear();
    app.pane_rects.clear();
    if app.ws().panes.is_empty() {
        let hint = match app.mode {
            crate::app::Mode::Replay => "<no panes in this fixture>",
            crate::app::Mode::Live => {
                "<no panes> — relayd's host has no PTYs (RELAY_HOST=relay serves /panes)"
            }
        };
        frame.render_widget(
            Paragraph::new(Line::styled(hint, Style::new().fg(Color::DarkGray))),
            inner,
        );
        return;
    }
    let focused = app
        .ws()
        .focused_pane
        .clone()
        .unwrap_or_else(|| app.ws().panes[0].clone());
    // Every pane, in the network's order, including the focused one — it keeps its place in the list
    // so the numbering does not shift under you each time you focus a different agent.
    let listed = ordered_panes(app);
    // One row each plus the heading, and never more than half the panel: the focused terminal is what
    // you are reading, and a long list must not squeeze it out.
    let list_height = if listed.len() <= 1 {
        0
    } else {
        (listed.len() as u16 + 1)
            .min(MAX_LIST_ROWS)
            .min(inner.height / 2)
    };
    let [big, strip] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(list_height)]).areas(inner);

    // The focused pane. Scroll it before anything is drawn: `set_scrollback` clamps to the rows the
    // screen actually kept — a full-screen agent owns its own display and has none — so the honoured
    // value is the only one worth reporting, and the title is built from it.
    let wanted = app.pane_scroll_of(&focused);
    let honoured = if let Some(pane) = app.ws_mut().pane_states.get_mut(&focused) {
        pane.parser.screen_mut().set_scrollback(wanted);
        let honoured = pane.parser.screen().scrollback();
        app.set_pane_scroll(&focused, honoured);
        honoured
    } else {
        0
    };

    // The title and the block are worked out first, while `app` is only read; the areas they produce
    // are recorded after, when nothing is holding a borrow of the workspace.
    let framing = app.ws().pane_states.get(&focused).map(|pane| {
        let mut title = pane_title(app, pane);
        // Scrolled back is not the live edge, and output arriving below must not be mistaken for what
        // you are reading, so the title says so.
        if honoured > 0 {
            title.push_str(&format!("  [↑{honoured} · PgDn for live]"));
        } else if app.terminal_input {
            title.push_str("  [typing · Esc Esc leaves]");
        } else if active {
            title.push_str("  [i to type]");
        }
        let mut style = title_style(app, pane);
        if app.terminal_input {
            style = style.reversed();
        }
        (title, style)
    });

    if let Some((title, style)) = framing {
        let block = Block::new()
            .borders(Borders::TOP)
            .border_style(Style::new().fg(Color::DarkGray))
            .title(Line::styled(format!(" {title} "), style));
        let pane_area = block.inner(big);
        frame.render_widget(block, big);
        app.pane_areas
            .insert(focused.clone(), (pane_area.width, pane_area.height));
        // The whole slot, title row included: a click anywhere on a pane means that pane.
        app.pane_rects.insert(focused.clone(), viewport_of(big));
        let pane = app.ws().pane_states.get(&focused).expect("still there");
        let screen = pane.parser.screen();
        let widget = PseudoTerminal::new(screen);
        frame.render_widget(widget, pane_area);
        if app.terminal_input && !screen.hide_cursor() {
            let (row, col) = screen.cursor_position();
            if row < pane_area.height && col < pane_area.width {
                frame.set_cursor_position((pane_area.x + col, pane_area.y + row));
            }
        }
    }

    // The list: a row per pane saying who it is, what it is on and how it is doing. All of them —
    // hiding the rest behind `+3 more` was the whole problem with the thumbnails.
    if list_height > 0 {
        let block = Block::new()
            .borders(Borders::TOP)
            .border_style(Style::new().fg(Color::DarkGray))
            .title(Line::styled(
                format!(" {} panes ", listed.len()),
                Style::new().fg(Color::DarkGray),
            ));
        let body = block.inner(strip);
        frame.render_widget(block, strip);

        // Keep the focused pane's row on screen however far down the list it is.
        let budget = body.height as usize;
        let position = listed.iter().position(|id| *id == focused).unwrap_or(0);
        let start = position
            .saturating_sub(budget.saturating_sub(1))
            .min(listed.len().saturating_sub(budget.max(1)));

        for (offset, pane_id) in listed.iter().skip(start).take(budget).enumerate() {
            let Some(line) = app
                .ws()
                .pane_states
                .get(pane_id)
                .map(|pane| list_row(app, pane, *pane_id == focused))
            else {
                continue;
            };
            let row = Rect::new(body.x, body.y + offset as u16, body.width, 1);
            frame.render_widget(Paragraph::new(line), row);
            // A click anywhere on the row means that pane — except for the focused one, whose
            // clickable area is the terminal above. Recording the row for it too would overwrite that
            // and make clicking into the terminal do nothing.
            if *pane_id != focused {
                app.pane_rects.insert(pane_id.clone(), viewport_of(row));
            }
        }
    }
}

#[cfg(test)]
mod ordering {
    use super::*;
    use crate::app::Mode;
    use crate::model::*;
    use crate::testkit::*;

    /// A brain with two subs, plus a second brain nobody called — the shape of a working fleet.
    ///
    /// Built from nothing rather than by adding to the demo graph: a brain the human started has no
    /// node of its own (it is a pane the network draws as an unattached agent), and the contract edges
    /// have to come from *it* rather than from the demo's planner, or the subs are not its subs.
    fn fleet() -> App {
        let mut app = App::new(Mode::Replay);
        let agent = |id: &str, role: &str| GraphNode {
            id: id.into(),
            kind: GraphNodeKind::Agent,
            label: role.into(),
            task_id: Some(id.into()),
            runtime: Some(RuntimeState::Working),
            task_state: None,
            handoff_state: None,
            column: 1,
            status: VisualStatus::Working,
            badge: None,
        };
        let contract = |task: &str| GraphEdge {
            id: format!("contract:{task}"),
            kind: GraphEdgeKind::Contract,
            from: "planner".into(),
            to: task.into(),
            task_id: Some(task.into()),
            label: "v1".into(),
            version: None,
            status: VisualStatus::Working,
            attention: false,
        };
        let mut planner = agent("planner", "planner");
        planner.kind = GraphNodeKind::Planner;
        planner.task_id = None;
        planner.column = 0;
        app.set_graph(Graph {
            nodes: vec![
                planner,
                agent("t-user-roles", "user_roles"),
                agent("t-session-revocation", "session_revocation"),
            ],
            edges: vec![contract("t-user-roles"), contract("t-session-revocation")],
            inbox: Vec::new(),
            seq: None,
        });
        app.set_panes(
            vec![
                pane_info("relay:33", None, "idle_brain"),
                pane_info(
                    "relay:29",
                    Some("t-session-revocation"),
                    "session_revocation",
                ),
                pane_info("relay:23", None, "brain"),
                pane_info("relay:28", Some("t-user-roles"), "user_roles"),
            ],
            Some("relay:28".into()),
        );
        app
    }

    fn pane_info(id: &str, task: Option<&str>, role: &str) -> PaneInfo {
        let mut info = demo_pane(id, task, role, true);
        info.runtime = Some("claude-code".into());
        info
    }

    #[test]
    fn the_list_reads_like_the_network_not_like_the_order_panes_were_opened() {
        let app = fleet();
        let labelled: Vec<String> = ordered_panes(&app)
            .into_iter()
            .map(|id| {
                let pane = &app.ws().pane_states[&id];
                let label = pane_label(&app, pane).map(|n| n.label).unwrap_or_default();
                format!("{id} {label}")
            })
            .collect();

        // Each brain followed by the subs it called, whatever order the panes arrived in.
        //
        // `brain 1` is the planner node itself, which has no pane of its own, so its subs lead the
        // list and the panes the human opened follow. (The graph draws one planner node however many
        // brains are running, so a second hand-started session is `brain 2` rather than sharing the
        // first one's numbering — a modelling gap in the graph, not in this list.)
        assert_eq!(
            labelled,
            vec![
                "relay:28 sub 1.1".to_string(),
                "relay:29 sub 1.2".to_string(),
                "relay:23 brain 2".to_string(),
                "relay:33 brain 3".to_string(),
            ]
        );
    }

    #[test]
    fn a_sub_is_indented_under_its_brain_and_the_focused_row_is_marked() {
        let app = fleet();
        let row =
            |id: &str| list_row(&app, &app.ws().pane_states[id], id == "relay:28").to_string();

        assert!(
            row("relay:23").starts_with("  brain 2"),
            "{}",
            row("relay:23")
        );
        // Two layers, visible at a glance, without a second source of truth for who called whom.
        assert!(
            row("relay:29").starts_with("    sub 1.2"),
            "{}",
            row("relay:29")
        );
        assert!(
            row("relay:28").starts_with("▸   sub 1.1"),
            "{}",
            row("relay:28")
        );
    }

    #[test]
    fn an_agent_whose_caller_is_not_on_the_graph_is_listed_last_rather_than_first() {
        // No number to sort on. It is real work and must still appear, but an unplaceable agent is
        // not the first thing to read — and an empty key sorts before every real one.
        assert!(sort_key("1") < sort_key(""));
        assert!(sort_key("1.2") < sort_key(""));
        // And the parts compare as numbers: `1.10` comes after `1.2`, not before it.
        assert!(sort_key("1.2") < sort_key("1.10"));
        assert!(sort_key("1") < sort_key("1.1"));
        assert!(sort_key("1.1") < sort_key("2"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Mode;
    use crate::model::PaneInfo;

    fn pane_state(alive: bool) -> PaneState {
        let mut app = App::new(Mode::Replay);
        let info: PaneInfo = serde_json::from_value(serde_json::json!({
            "pane_id": "relay:1", "task_id": "t-backend-auth", "role": "backend", "cwd": "/x",
            "alive": alive, "cols": 20, "rows": 5, "started_at": "t"
        }))
        .unwrap();
        app.set_panes(vec![info], None);
        app.ws_mut().pane_states.remove("relay:1").unwrap()
    }

    #[test]
    fn tail_lines_show_the_last_rows_up_to_the_cursor() {
        let mut pane = pane_state(true);
        pane.parser.process(b"one\r\ntwo\r\nthree\r\nfour");
        assert_eq!(tail_lines(&pane, 3), vec!["two", "three", "four"]);
        assert_eq!(tail_lines(&pane, 10), vec!["one", "two", "three", "four"]);
    }

    #[test]
    fn title_falls_back_to_alive_or_exit_code_without_a_graph_node() {
        let app = App::new(Mode::Replay);
        let mut pane = pane_state(true);
        assert_eq!(pane_title(&app, &pane), "backend · t-backend-auth · alive");
        pane.exit_code = Some(2);
        assert_eq!(
            pane_title(&app, &pane),
            "backend · t-backend-auth · exited 2"
        );
    }
}

#[cfg(test)]
mod snapshots {
    use crate::keys::Key;
    use crate::testkit::*;

    #[test]
    fn pane_grid_shows_the_focused_pane_large_and_the_others_as_titled_rows() {
        let mut app = replay_app("live-1");
        app.set_panes(
            vec![
                demo_pane("relay:1", Some("t-backend-auth"), "backend", true),
                demo_pane("relay:2", Some("t-frontend-login"), "frontend", true),
            ],
            None,
        );
        app.ws_mut()
            .pane_states
            .get_mut("relay:1")
            .unwrap()
            .parser
            .process(b"$ claude\r\n> working on AC-1\r\n");
        app.ws_mut()
            .pane_states
            .get_mut("relay:2")
            .unwrap()
            .parser
            .process(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(
            text.contains("backend · t-backend-auth · verified"),
            "{text}"
        );
        assert!(
            text.contains("frontend · t-frontend-login · failed"),
            "{text}"
        );
        assert!(text.contains("> working on AC-1"), "{text}");
        // The unfocused pane is a titled row, not a window onto its scrollback. Three lines of an
        // agent's output out of context said almost nothing and cost four rows each, which is how a
        // fleet of seven panes ended up showing four.
        assert!(
            !text.contains("three") && !text.contains("four") && !text.contains("five"),
            "an unfocused pane shows its title, not its last lines:\n{text}"
        );
        // The focused pane's widget size is recorded for resize.
        let (cols, rows_) = app.pane_areas["relay:1"];
        assert!(cols > 60 && rows_ > 20, "{cols}x{rows_}");
        assert!(!app.pane_areas.contains_key("relay:2"));
    }

    #[test]
    fn pane_grid_marks_typing_mode_and_handles_no_panes() {
        let mut app = replay_app("live-1");
        app.set_panes(
            vec![demo_pane(
                "relay:1",
                Some("t-backend-auth"),
                "backend",
                true,
            )],
            None,
        );
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        let rows = draw_rows(&mut app, 120, 40);
        assert!(screen_text(&rows).contains("[i to type]"));
        app.handle_key(Key::char('i'));
        let rows = draw_rows(&mut app, 120, 40);
        assert!(screen_text(&rows).contains("[typing · Esc Esc leaves]"));
        let mut empty = replay_app("live-1");
        let rows = draw_rows(&mut empty, 120, 40);
        assert!(screen_text(&rows).contains("<no panes in this fixture>"));
    }
}
