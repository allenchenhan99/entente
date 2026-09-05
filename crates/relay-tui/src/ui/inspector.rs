//! The inspector popup: `describe` (title + facts pinned at the top), the newest story lines filling the rest,
//! the actions with their keys, and the inline single-line editor / y-N prompt when an action asks for text
//! (port of the Ink `Overlay` Story tab and `storyWindow`).

use crate::app::App;
use crate::model::*;
use crate::ui::inbox::action_keys;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

/// Port of `storyWindow`: facts first (at most half the rows), then the newest story lines that fit, with an
/// `… n earlier` marker when some are cut.
pub fn story_window(
    description: &ObjectDescription,
    story: &[String],
    available: usize,
) -> Vec<String> {
    let mut facts = vec![description.title.clone()];
    facts.extend(description.lines.iter().cloned());
    let fact_rows = facts.len().min((available / 2).max(1));
    let head: Vec<String> = facts.into_iter().take(fact_rows).collect();
    let room = available as isize - head.len() as isize - 1;
    if room <= 0 {
        return head.into_iter().take(available).collect();
    }
    let room = room as usize;
    let body: Vec<String> = if story.len() <= room {
        story.to_vec()
    } else if room == 1 {
        story[story.len() - 1..].to_vec()
    } else {
        let shown = &story[story.len() - (room - 1)..];
        let mut v = vec![format!("… {} earlier", story.len() - shown.len())];
        v.extend(shown.iter().cloned());
        v
    };
    let mut out = head;
    out.push(String::new());
    out.extend(body);
    out.truncate(available);
    out
}

/// Everything the popup shows, as styled lines for `height` rows (border excluded).
pub fn inspector_lines(app: &App, height: usize) -> Vec<Line<'static>> {
    let inspector = &app.inspector;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let actions = if inspector.loaded {
        inspector.actions.clone()
    } else {
        app.current_actions().to_vec()
    };
    // While the editor is open those keys do not run their actions — they type into your answer, so
    // listing them says `[x] kill task` about a key that puts an `x` in the field. The line has to
    // say what Enter and Esc do instead, which is also the only place Esc's meaning is ever stated.
    let action_line = match app.input_mode {
        Some(crate::app::InputMode::Answer) => {
            let left = app.pending_questions().len().saturating_sub(1);
            match left {
                0 => "Enter sends it · Esc discards what you typed".to_string(),
                1 => "Enter sends it and moves on · Esc leaves 1 question unanswered".to_string(),
                n => format!("Enter sends it and moves on · Esc leaves {n} questions unanswered"),
            }
        }
        Some(crate::app::InputMode::Reply | crate::app::InputMode::ReviewFailure) => {
            "Enter sends it · Esc discards what you typed".to_string()
        }
        _ => {
            let keys = action_keys(&actions);
            if keys.is_empty() {
                "actions: Esc close".to_string()
            } else {
                format!("actions: {keys} · Esc close")
            }
        }
    };
    let prompt = app.prompt_line();
    let reserved = 1 + usize::from(prompt.is_some()) + usize::from(app.error.is_some());
    let available = height.saturating_sub(reserved).max(1);
    if !inspector.loaded {
        lines.push(Line::styled("loading…", Style::new().fg(Color::DarkGray)));
    } else {
        let window = story_window(&inspector.description, &inspector.story, available);
        for (index, text) in window.into_iter().enumerate() {
            let style = if index == 0 {
                Style::new().bold()
            } else if text.starts_with('…') {
                Style::new().fg(Color::DarkGray)
            } else {
                Style::new()
            };
            lines.push(Line::styled(text, style));
        }
    }
    while lines.len() < available {
        lines.push(Line::from(""));
    }
    lines.push(Line::styled(action_line, Style::new().fg(Color::Cyan)));
    if let Some(p) = prompt {
        lines.push(Line::styled(p, Style::new().fg(Color::Yellow).bold()));
    }
    if let Some(e) = &app.error {
        lines.push(Line::styled(e.clone(), Style::new().fg(Color::Red)));
    }
    lines
}

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let id = app
        .inspector
        .reference
        .as_ref()
        .map(|r| r.id.clone())
        .unwrap_or_default();
    let block = Block::bordered()
        .border_style(Style::new().fg(Color::Cyan))
        .title(Line::styled(
            // Say where you are when you are not at the left, so a half-read line is never mistaken
            // for the whole of one.
            if app.h_scroll > 0 {
                format!(" {id}  describe · story · actions  →{} ", app.h_scroll)
            } else {
                format!(" {id}  describe · story · actions ")
            },
            Style::new().fg(Color::Cyan).bold(),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = inspector_lines(app, inner.height as usize);
    // A question is longer than this popup is wide; ←/→ move along it rather than cutting it short.
    frame.render_widget(Paragraph::new(lines).scroll((0, app.h_scroll)), inner);
    if let Some(p) = app.prompt_line() {
        if app.input_mode != Some(crate::app::InputMode::CancelConfirm) {
            let row =
                inner.y
                    + (lines_len_hint(inner.height) as u16)
                        .saturating_sub(if app.error.is_some() { 2 } else { 1 });
            let col = inner.x + (p.chars().count() as u16).min(inner.width.saturating_sub(1));
            frame.set_cursor_position((col, row));
        }
    }
}

fn lines_len_hint(height: u16) -> usize {
    height as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn description() -> ObjectDescription {
        ObjectDescription {
            title: "backend · t-backend-auth".into(),
            lines: vec!["role: backend".into(), "runtime: idle".into()],
        }
    }

    #[test]
    fn story_window_pins_facts_and_shows_the_newest_lines() {
        let story: Vec<String> = (1..=10).map(|n| format!("line {n}")).collect();
        let window = story_window(&description(), &story, 8);
        assert_eq!(
            window,
            vec![
                "backend · t-backend-auth",
                "role: backend",
                "runtime: idle",
                "",
                "… 7 earlier",
                "line 8",
                "line 9",
                "line 10"
            ]
        );
        let all = story_window(&description(), &story[..2], 8);
        assert_eq!(all[4..], ["line 1", "line 2"]);
        assert_eq!(
            story_window(&description(), &story, 1),
            vec!["backend · t-backend-auth"]
        );
    }
}

#[cfg(test)]
mod snapshots {
    use crate::keys::Key;
    use crate::model::*;
    use crate::testkit::*;

    /// Enter on the selected node loads describe + story tail + actions from the fixture (what the runtime
    /// does with `/graph/:kind/:id/*` in live mode).
    fn open_with_fixture(app: &mut crate::app::App, name: &str) -> GraphObjectRef {
        let f = fixture(name);
        let effects = app.handle_key(Key::ENTER);
        let r = match &effects[0] {
            crate::app::Effect::FetchInspector(r) => r.clone(),
            other => panic!("{other:?}"),
        };
        app.set_inspector(r.clone(), f.describe(&r), f.story(&r), f.actions(&r));
        r
    }

    #[test]
    fn inspector_shows_describe_lines_story_tail_and_actions_of_live_1() {
        let mut app = replay_app("live-1");
        let r = open_with_fixture(&mut app, "live-1");
        assert_eq!(r, GraphObjectRef::node("t-backend-auth"));
        let f = fixture("live-1");
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(
            text.contains("t-backend-auth  describe · story · actions"),
            "{text}"
        );
        let description = f.describe(&r);
        assert!(text.contains(&description.title), "{text}");
        for line in &description.lines {
            let head: String = line.chars().take(60).collect();
            assert!(
                text.contains(head.trim_end()),
                "missing describe line {line:?}:\n{text}"
            );
        }
        let story = f.story(&r);
        for line in story.iter().rev().take(3) {
            let head: String = line.chars().take(60).collect();
            assert!(
                text.contains(head.trim_end()),
                "missing story line {line:?}:\n{text}"
            );
        }
        assert!(
            text.contains("… ") && text.contains("earlier"),
            "older story lines are summarised:\n{text}"
        );
        // The action list is the fixture's actions.json entry for the node.
        let expected = &f.actions["node:t-backend-auth"];
        assert_eq!(app.inspector.actions, *expected);
        assert!(
            text.contains("actions: [Enter] focus · Esc close"),
            "{text}"
        );
    }

    #[test]
    fn inspector_closes_on_esc_and_shows_the_inline_editor() {
        let mut app = replay_app("live-1");
        open_with_fixture(&mut app, "live-1");
        assert!(app.inspector_open);
        app.handle_key(Key::ESC);
        assert!(!app.inspector_open);
        let rows = draw_rows(&mut app, 120, 40);
        assert!(!screen_text(&rows).contains("describe · story · actions"));

        // An inbox question opens the editor inside the inspector.
        app.set_graph(demo_graph());
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        app.handle_key(Key::char('a'));
        for c in "magic".chars() {
            app.handle_key(Key::char(c));
        }
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        // The editor names the question its answer goes to, in its own words, and says where it is in
        // the sequence — this fixture's task asks two, and `a` walks both.
        assert!(text.contains("1/2 Which auth method?> magic"), "{text}");
        assert!(
            // While the editor is open those keys type into the field rather than running, so the
            // line says what Enter and Esc do instead of naming keys that would not work.
            text.contains("Enter sends it and moves on · Esc leaves 1 question unanswered"),
            "{text}"
        );
        app.set_error("POST /tasks/t-backend-auth/clarify failed: 400");
        let rows = draw_rows(&mut app, 120, 40);
        assert!(screen_text(&rows).contains("clarify failed: 400"));
    }

    #[test]
    fn inspector_on_an_edge_shows_the_contract_facts_of_live_7() {
        let mut app = replay_app("live-7");
        app.handle_key(Key::TAB);
        // Ask for the edge rather than counting keystrokes to it: this is about what the inspector
        // shows, and the graph region's object list changes as the network's own rules change.
        app.select(Some(GraphObjectRef::edge("contract:t-token-store")));
        let r = open_with_fixture(&mut app, "live-7");
        assert_eq!(r, GraphObjectRef::edge("contract:t-token-store"));
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        let f = fixture("live-7");
        assert!(text.contains(&f.describe(&r).title), "{text}");
    }
}
