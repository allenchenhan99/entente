//! The status line: connection state, last event seq, the TUI's own draw p50 / p95, the focused pane's host
//! timings (`readiness_ms` / `prompt_accept_ms` / `render_p95_ms` from `/metrics`), the action hints and
//! the last error.

use crate::app::App;
use crate::model::millis;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

fn ms(value: Option<f64>) -> String {
    match value {
        Some(v) if v >= 100.0 => format!("{v:.0}ms"),
        Some(v) => format!("{v:.1}ms"),
        None => "-".to_string(),
    }
}

/// The focused pane's `readiness / accept / render p95` from `/metrics`, falling back to its `PaneInfo.timings`.
pub fn pane_timings_text(app: &App) -> Option<String> {
    let pane = app.focused_pane_state()?;
    let timings = app
        .ws()
        .metrics
        .as_ref()
        .and_then(|m| m.pane(&pane.info.pane_id).cloned())
        .or_else(|| pane.info.timings.clone())?;
    Some(format!(
        "{}: ready {} · accept {} · render p95 {}",
        pane.info.pane_id,
        ms(millis(&timings.readiness_ms)),
        ms(millis(&timings.prompt_accept_ms)),
        ms(millis(&timings.render_p95_ms)),
    ))
}

pub fn status_text(app: &App) -> String {
    let mut parts = vec![
        app.ws().connection.label(),
        format!("seq {}", app.ws().last_seq),
        format!(
            "frame p50 {} p95 {}",
            ms(app.frames.p50_ms()),
            ms(app.frames.p95_ms())
        ),
    ];
    // Errors and notices come before the metrics so they survive truncation on narrow terminals.
    if let Some(e) = &app.error {
        parts.push(format!("ERROR {e}"));
    } else if app.input_mode == Some(crate::app::InputMode::ClosePaneConfirm) {
        // Asked here, not in the inspector: the pane it is about must stay visible.
        if let Some(prompt) = app.prompt_line() {
            parts.push(prompt);
        }
    } else if let Some(n) = &app.notice {
        parts.push(n.clone());
    }
    if let Some(t) = pane_timings_text(app) {
        parts.push(t);
    }
    if !app.ws().graph.inbox.is_empty() {
        // The strip's header can be scrolled off a short terminal; this line cannot, so it carries the
        // worst wait too rather than only the count.
        let waiting = match crate::ui::inbox::oldest_age(app) {
            Some(age) => format!(
                "inbox:{} oldest {}",
                app.ws().graph.inbox.len(),
                crate::clock::age_label(age)
            ),
            None => format!("inbox:{}", app.ws().graph.inbox.len()),
        };
        parts.push(waiting);
    }
    let hints = app.action_hints();
    if !hints.is_empty() {
        parts.push(hints);
    }
    if app.terminal_input {
        parts.push("typing → pane (Ctrl+] leaves)".to_string());
    } else {
        parts.push("? help".to_string());
    }
    parts.join("  ")
}

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let text = status_text(app);
    let style = if app.error.is_some() {
        Style::new().reversed().red()
    } else {
        Style::new().reversed()
    };
    frame.render_widget(Paragraph::new(Line::styled(text, style)), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_milliseconds_compactly() {
        assert_eq!(ms(Some(0.42)), "0.4ms");
        assert_eq!(ms(Some(1234.0)), "1234ms");
        assert_eq!(ms(None), "-");
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    use crate::app::Connection;
    use crate::keys::Key;
    use crate::testkit::*;
    use std::time::Duration;

    #[test]
    fn status_line_shows_connection_seq_frame_p95_and_pane_timings() {
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
        for n in 1..=20 {
            app.frames.record(Duration::from_micros(100 * n));
        }
        let text = status_text(&app);
        assert!(
            text.starts_with("▶ replay  seq 43  frame p50 1.0ms p95 1.9ms"),
            "{text}"
        );
        assert!(
            text.contains("relay:1: ready 900ms · accept 210ms · render p95 0.4ms"),
            "{text}"
        );
        assert!(text.contains("? help"), "{text}");

        // /metrics wins over the pane's own timings; errors are appended.
        app.set_metrics(serde_json::from_value(serde_json::json!({
            "host": "relay", "uptime_ms": 5000, "panes_spawned": 1, "panes_alive": 1, "prompt_failures": 0,
            "panes": [{ "pane_id": "relay:1", "role": "backend", "task_id": "t-backend-auth",
                        "timings": { "readiness_ms": 1234.5, "prompt_accept_ms": 55.5, "render_p95_ms": 2.25 } }]
        })).unwrap());
        app.set_connection(Connection::Live);
        app.set_error("POST /tasks/x/reply failed: 404");
        let text = status_text(&app);
        assert!(text.starts_with("● live"), "{text}");
        assert!(
            text.contains("relay:1: ready 1234ms · accept 55.5ms · render p95 2.2ms"),
            "{text}"
        );
        assert!(
            text.contains("ms  ERROR POST /tasks/x/reply failed: 404  relay:1"),
            "{text}"
        );
    }

    #[test]
    fn status_line_is_drawn_on_the_last_row_with_action_hints() {
        let mut app = crate::app::App::new(crate::app::Mode::Replay);
        app.set_graph(demo_graph());
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        let rows = draw_rows(&mut app, 120, 40);
        let last = rows.last().unwrap();
        assert!(last.contains("frame p50"), "{last}");
        assert!(last.contains("inbox:2"), "{last}");
        assert!(last.contains("[a] answer  [x] kill task"), "{last}");
        app.handle_key(Key::char('j'));
        let rows = draw_rows(&mut app, 120, 40);
        assert!(
            rows.last().unwrap().contains("[p] pass  [f] fail"),
            "{}",
            rows.last().unwrap()
        );
    }
}
