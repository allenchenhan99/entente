//! The pane grid: the focused pane large (a `tui-term` widget over its `vt100` screen), the others as thumbnails
//! showing their last three lines, each under a title bar `role · task · status`. Records every widget's size
//! in `app.pane_areas` so the runtime can send `resize`.

use crate::app::{pane_matches_selection, App, PaneState, Region};
use crate::ui::tree::status_color;
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use tui_term::widget::PseudoTerminal;

pub const THUMB_LINES: u16 = 3;
pub const MAX_THUMBS: usize = 4;

/// `role · task · status` for a pane: the graph status of its task when known, else alive / exited.
pub fn pane_title(app: &App, pane: &PaneState) -> String {
    let info = &pane.info;
    let task = info.task_id.clone().unwrap_or_else(|| "-".to_string());
    let status = info
        .task_id
        .as_deref()
        .and_then(|t| app.graph.node(t))
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
        .and_then(|t| app.graph.node(t))
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

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    let active = region_active(app, Region::Panes);
    let block = panel_block(Region::Panes.title(), active, Borders::TOP | Borders::LEFT);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    app.pane_areas.clear();
    app.pane_rects.clear();
    if app.panes.is_empty() {
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
        .focused_pane
        .clone()
        .unwrap_or_else(|| app.panes[0].clone());
    let others: Vec<String> = app
        .panes
        .iter()
        .filter(|p| **p != focused)
        .cloned()
        .collect();
    let thumbs_height = if others.is_empty() {
        0
    } else {
        THUMB_LINES + 1
    };
    let [big, strip] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(thumbs_height)]).areas(inner);

    // The focused pane.
    if let Some(pane) = app.pane_states.get(&focused) {
        let mut title = pane_title(app, pane);
        if app.terminal_input {
            title.push_str("  [typing · Esc leaves]");
        } else if active {
            title.push_str("  [i to type]");
        }
        let mut style = title_style(app, pane);
        if app.terminal_input {
            style = style.reversed();
        }
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

    // Thumbnails: last three lines each, side by side.
    if thumbs_height > 0 {
        let shown = others.len().min(MAX_THUMBS);
        let hidden = others.len() - shown;
        let constraints: Vec<Constraint> = (0..shown)
            .map(|_| Constraint::Ratio(1, shown as u32))
            .collect();
        let slots = Layout::horizontal(constraints).split(strip);
        for (index, pane_id) in others.iter().take(shown).enumerate() {
            let Some(pane) = app.pane_states.get(pane_id) else {
                continue;
            };
            let mut title = pane_title(app, pane);
            if index == shown - 1 && hidden > 0 {
                title.push_str(&format!("  +{hidden} more"));
            }
            let block = Block::new()
                .borders(Borders::TOP)
                .border_style(Style::new().fg(Color::DarkGray))
                .title(Line::styled(format!(" {title} "), title_style(app, pane)));
            let slot = slots[index];
            let body = block.inner(slot);
            frame.render_widget(block, slot);
            app.pane_rects.insert(pane_id.clone(), viewport_of(slot));
            let lines: Vec<Line> = tail_lines(pane, THUMB_LINES as usize)
                .into_iter()
                .map(|l| Line::styled(l, Style::new().fg(Color::Gray)))
                .collect();
            frame.render_widget(Paragraph::new(lines), body);
        }
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
        app.pane_states.remove("relay:1").unwrap()
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
    fn pane_grid_shows_the_focused_pane_large_and_the_others_as_thumbnails() {
        let mut app = replay_app("live-1");
        app.set_panes(
            vec![
                demo_pane("relay:1", Some("t-backend-auth"), "backend", true),
                demo_pane("relay:2", Some("t-frontend-login"), "frontend", true),
            ],
            None,
        );
        app.pane_states
            .get_mut("relay:1")
            .unwrap()
            .parser
            .process(b"$ claude\r\n> working on AC-1\r\n");
        app.pane_states
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
        // The thumbnail shows only the last three lines of the other pane.
        assert!(
            text.contains("three") && text.contains("four") && text.contains("five"),
            "{text}"
        );
        assert!(
            !text.contains("two"),
            "thumbnail is limited to three lines:\n{text}"
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
        assert!(screen_text(&rows).contains("[typing · Esc leaves]"));
        let mut empty = replay_app("live-1");
        let rows = draw_rows(&mut empty, 120, 40);
        assert!(screen_text(&rows).contains("<no panes in this fixture>"));
    }
}
