//! The inbox strip: one line per item — icon, title, its action keys, and the detail (port of `Inbox.tsx`,
//! condensed to one row per item so five rows show four items).

use crate::app::{App, Region};
use crate::model::*;
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Borders, Paragraph};
use ratatui::Frame;

pub fn inbox_icon(kind: InboxKind) -> &'static str {
    match kind {
        InboxKind::TaskQuestion | InboxKind::MissionQuestion => "?",
        InboxKind::HumanReview => "◆",
        InboxKind::Blocker => "◐",
        InboxKind::Escalation => "!",
        InboxKind::LintError => "✗",
    }
}

/// `a answer · x cancel` — the keys the item's actions bind (inspect is implicit).
pub fn action_keys(actions: &[ObjectAction]) -> String {
    actions
        .iter()
        .filter(|a| a.kind != ActionKind::Inspect)
        .map(|a| {
            let verb = match a.kind {
                ActionKind::Clarify | ActionKind::MissionClarify => "answer",
                ActionKind::Review if a.key == "p" => "pass",
                ActionKind::Review => "fail",
                ActionKind::Reply => "reply",
                ActionKind::Cancel => "cancel",
                ActionKind::Focus => "focus",
                ActionKind::Inspect => "inspect",
            };
            format!("{} {verb}", a.key)
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// One drawn row and the inbox item it stands for.
pub type InboxRow = (Line<'static>, Option<GraphObjectRef>);

pub fn inbox_lines(app: &App, height: usize) -> Vec<Line<'static>> {
    inbox_rows(app, height)
        .into_iter()
        .map(|(line, _)| line)
        .collect()
}

/// Every row the inbox would draw if it had the room: a row per item saying who is asking about
/// what, then one for each thing asked. Two questions on one line read as one; on their own rows
/// they read as two.
pub fn all_inbox_rows(app: &App) -> Vec<InboxRow> {
    let items = &app.ws().graph.inbox;
    if items.is_empty() {
        return vec![(
            Line::styled("<inbox empty>", Style::new().fg(Color::DarkGray)),
            None,
        )];
    }
    let selected = match &app.selected {
        Some(r) if r.kind == RefKind::Inbox => Some(r.id.clone()),
        _ => None,
    };
    let mut rows: Vec<InboxRow> = Vec::new();
    for item in items {
        let reference = GraphObjectRef::inbox(&item.id);
        let active = selected.as_deref() == Some(item.id.as_str());
        let mut title_style = Style::new().fg(Color::Yellow);
        if active {
            title_style = title_style.bold().reversed();
        }
        let mut spans = vec![Span::styled(
            format!("{} {}", inbox_icon(item.kind), item.title),
            title_style,
        )];
        // Which task it is about, said plainly: the title names the role, and a role is not an
        // address — two missions can each have a `backend`.
        if let Some(task) = item.task_id.as_deref() {
            spans.push(Span::styled(
                format!("  {task}"),
                Style::new().fg(Color::Gray),
            ));
        }
        let keys = action_keys(&item.actions);
        if !keys.is_empty() {
            spans.push(Span::styled(
                format!("  [{keys}]"),
                Style::new().fg(Color::Cyan),
            ));
        }
        rows.push((Line::from(spans), Some(reference.clone())));

        let style = Style::new().fg(if active { Color::Gray } else { Color::DarkGray });
        if item.detail.is_empty() {
            rows.push((Line::styled("    -", style), Some(reference)));
        } else {
            for detail in &item.detail {
                rows.push((
                    Line::styled(format!("    {detail}"), style),
                    Some(reference.clone()),
                ));
            }
        }
    }
    rows
}

/// The first row of the selected item, so scrolling can be made to keep it in view.
pub fn selected_row(app: &App) -> Option<usize> {
    let selected = match &app.selected {
        Some(r) if r.kind == RefKind::Inbox => r,
        _ => return None,
    };
    all_inbox_rows(app)
        .iter()
        .position(|(_, r)| r.as_ref() == Some(selected))
}

/// The rows that fit, starting from where the panel is scrolled to.
pub fn inbox_rows(app: &App, height: usize) -> Vec<InboxRow> {
    let rows = all_inbox_rows(app);
    let budget = height.max(1);
    let start = app.inbox_scroll.min(rows.len().saturating_sub(1));
    rows.into_iter().skip(start).take(budget).collect()
}

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    // The selection is what j/k moves, so it has to be on screen whatever the panel is scrolled to.
    let inner_height = area.height.saturating_sub(1) as usize;
    app.reveal_selected_inbox(inner_height);
    let mut title = if app.ws().graph.inbox.is_empty() {
        Region::Inbox.title().to_string()
    } else {
        format!("{} ({})", Region::Inbox.title(), app.ws().graph.inbox.len())
    };
    if app.h_scroll > 0 {
        title.push_str(&format!("  →{}", app.h_scroll));
    }
    // Say what is out of sight, so a strip that has been read to the bottom looks different from one
    // that merely ends there.
    let total = all_inbox_rows(app).len();
    let below = total.saturating_sub(app.inbox_scroll + inner_height);
    if app.inbox_scroll > 0 || below > 0 {
        title.push_str(&format!(
            "  ↕ {}-{} of {total}",
            app.inbox_scroll + 1,
            total - below
        ));
    }
    let block = panel_block(&title, region_active(app, Region::Inbox), Borders::TOP);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = inbox_rows(app, inner.height as usize);
    app.inbox_viewport = viewport_of(inner);
    app.inbox_rows = rows.iter().map(|(_, r)| r.clone()).collect();
    frame.render_widget(
        Paragraph::new(rows.into_iter().map(|(line, _)| line).collect::<Vec<_>>())
            .scroll((0, app.h_scroll)),
        inner,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_follow_the_ink_inbox() {
        assert_eq!(inbox_icon(InboxKind::TaskQuestion), "?");
        assert_eq!(inbox_icon(InboxKind::HumanReview), "◆");
        assert_eq!(inbox_icon(InboxKind::LintError), "✗");
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    use crate::keys::Key;
    use crate::testkit::*;

    #[test]
    fn inbox_strip_lists_items_with_their_action_keys() {
        let mut app = crate::app::App::new(crate::app::Mode::Replay);
        app.set_graph(demo_graph());
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(text.contains("▶ INBOX (2)"), "{text}");
        // A row per item saying who is asking about what, then a row per thing asked.
        assert!(text.contains("? backend asks 2 questions (v1)"), "{text}");
        assert!(text.contains("[a answer · x cancel]"), "{text}");
        assert!(text.contains("    Q1 Which auth method?"), "{text}");
        assert!(
            text.contains("    Q2 Link expiry?"),
            "two questions are two rows:\n{text}"
        );
        // The strip grew to hold both items, so nothing is out of sight and it says nothing about it.
        assert!(!text.contains("↕"), "{text}");
        assert!(
            text.contains("◆ frontend needs a human review of AC-3"),
            "{text}"
        );
        assert!(text.contains("AC-3: the login page is readable"), "{text}");
        // The task the question is about, not just the role that asked it.
        assert!(text.contains("t-backend-auth"), "{text}");
        let empty = replay_app("live-1");
        let lines = inbox_lines(&empty, 4);
        assert_eq!(lines[0].to_string(), "<inbox empty>");
    }
}
