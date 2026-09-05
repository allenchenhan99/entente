//! The inbox strip: what is waiting on a human, worst first, with how long it has been waiting.
//!
//! Two things separate this from a list of notifications. It is ordered by how much is stuck behind
//! each item rather than by arrival, because a coordination tool exists to keep a fleet moving and
//! time-in-queue is a fairness metric, not a throughput one. And every row carries its age, because
//! "what needs you" without "for how long" does not tell you what to do first — which is the only
//! question the panel is really being asked.

use crate::app::{App, Region};
use crate::clock::{age_label, urgency, Urgency};
use crate::model::*;
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Borders, Paragraph};
use ratatui::Frame;

/// Columns the age reserves at the right: `now`, `41m`, `2h`, `13d` all fit in three, `120d` in four.
const AGE_WIDTH: usize = 4;
/// How many rows of wrapped detail the selected item gets. Enough for a blocker written as prose;
/// the whole of it lives in the inspector.
const DETAIL_ROWS: usize = 3;

pub fn inbox_icon(kind: InboxKind) -> &'static str {
    match kind {
        InboxKind::TaskQuestion | InboxKind::MissionQuestion => "?",
        InboxKind::HumanReview => "◆",
        InboxKind::Blocker => "◐",
        InboxKind::Escalation => "!",
        InboxKind::LintError => "✗",
    }
}

/// The glyphs are close together at one cell — `◆` and `◇` are a fill apart — so colour carries the
/// kind and the shape only confirms it. Costs no columns.
pub fn icon_color(kind: InboxKind) -> Color {
    match kind {
        InboxKind::TaskQuestion | InboxKind::MissionQuestion => Color::Cyan,
        InboxKind::HumanReview => Color::Blue,
        InboxKind::Blocker => Color::Red,
        InboxKind::Escalation => Color::Magenta,
        InboxKind::LintError => Color::Red,
    }
}

/// How much is stuck behind an item. Lower sorts first.
///
/// 0 freezes a whole subtree: a planner that cannot decompose, a contract that can never spawn, an
/// agent that has stopped. 1 holds up one task. 2 only gates accepting work that is already done —
/// real, but nothing is idling on it.
pub fn blocking_tier(kind: InboxKind) -> u8 {
    match kind {
        InboxKind::MissionQuestion | InboxKind::LintError | InboxKind::Blocker => 0,
        InboxKind::TaskQuestion | InboxKind::Escalation => 1,
        InboxKind::HumanReview => 2,
    }
}

/// The colour an age is drawn in, and the colour the panel header takes from its worst item.
pub fn urgency_color(u: Urgency) -> Color {
    match u {
        Urgency::Fresh => Color::DarkGray,
        Urgency::Waiting => Color::Yellow,
        Urgency::Stalled => Color::Red,
    }
}

/// `[a] answer  [x] kill task` — the keys the item's actions bind (inspect is implicit).
///
/// The bracket sits around the key alone, so `a answer` cannot be read as two labels; and it holds
/// for a named key as well as a letter, which `[a]nswer` does not. Cancel says what it does: it
/// kills the task, it does not dismiss the row.
pub fn action_keys(actions: &[ObjectAction]) -> String {
    key_spans(actions)
        .into_iter()
        .map(|(text, _)| text)
        .collect::<Vec<_>>()
        .join("  ")
}

/// Each key hint and whether it destroys something, so the destructive one can be drawn as such.
fn key_spans(actions: &[ObjectAction]) -> Vec<(String, bool)> {
    let mut spans: Vec<(String, bool)> = Vec::new();
    for action in actions {
        if action.kind == ActionKind::Inspect {
            continue;
        }
        let (verb, destructive) = match action.kind {
            ActionKind::Clarify | ActionKind::MissionClarify => ("answer", false),
            ActionKind::Review if action.key == "p" => ("pass", false),
            ActionKind::Review => ("fail", false),
            ActionKind::Reply => ("reply", false),
            // Not "cancel", which in a list you are trying to clear reads as "cancel this prompt".
            ActionKind::Cancel => ("kill task", true),
            ActionKind::Focus => ("focus", false),
            ActionKind::Inspect => ("inspect", false),
        };
        spans.push((format!("[{}] {verb}", action.key), destructive));
    }
    // Whatever destroys something goes last, so the eye reaches it after the safe choices.
    spans.sort_by_key(|(_, destructive)| *destructive);
    spans
}

/// One drawn row and the inbox item it stands for.
pub type InboxRow = (Line<'static>, Option<GraphObjectRef>);

pub fn inbox_lines(app: &App, height: usize) -> Vec<Line<'static>> {
    inbox_rows(app, height)
        .into_iter()
        .map(|(line, _)| line)
        .collect()
}

/// The items in the order the strip shows them: most blocking first, and within that, longest
/// waiting first. The server's own order is by age alone, which puts a two-second review of a
/// finished page above a contract that has frozen a subtree.
pub fn ordered_items(app: &App) -> Vec<&InboxItem> {
    let mut items: Vec<&InboxItem> = app.ws().graph.inbox.iter().collect();
    items.sort_by(|a, b| {
        blocking_tier(a.kind)
            .cmp(&blocking_tier(b.kind))
            // An item with no `since` has no age, so it sorts below ones that do rather than as if
            // it had been waiting forever.
            .then(
                app.inbox_age(b)
                    .unwrap_or(-1)
                    .cmp(&app.inbox_age(a).unwrap_or(-1)),
            )
            .then(a.id.cmp(&b.id))
    });
    items
}

/// The worst wait in the inbox, for the header.
pub fn oldest_age(app: &App) -> Option<i64> {
    app.ws()
        .graph
        .inbox
        .iter()
        .filter_map(|item| app.inbox_age(item))
        .max()
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Break text into at most `rows` lines of `width`, on word boundaries, eliding the rest.
fn wrap(text: &str, width: usize, rows: usize) -> Vec<String> {
    if width == 0 || rows == 0 {
        return Vec::new();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };
        if candidate.chars().count() <= width {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            if lines.len() == rows {
                break;
            }
        }
        current = if word.chars().count() > width {
            // A single unbreakable token longer than the panel: cut it, do not loop.
            truncate(word, width)
        } else {
            word.to_string()
        };
    }
    if lines.len() < rows && !current.is_empty() {
        lines.push(current);
    }
    // Say that there is more rather than ending mid-sentence as if that were all of it.
    if lines.len() == rows && text.split_whitespace().count() > 0 {
        let shown: usize = lines.iter().map(|l| l.split_whitespace().count()).sum();
        if shown < text.split_whitespace().count() {
            let last = lines.last_mut().unwrap();
            *last = format!("{} …", truncate(last, width.saturating_sub(2)));
        }
    }
    lines
}

/// The mark against a question row while `a` is walking the item's questions.
fn question_mark(app: &App, item: &InboxItem, detail: &str) -> Option<&'static str> {
    let pending = app.pending_questions();
    if pending.is_empty() || !answering(app, item) {
        return None;
    }
    let id = crate::model::question_of(detail)?;
    match pending.iter().position(|q| q == id) {
        Some(0) => Some("▸"),
        Some(_) => Some("·"),
        // Not in the queue any more, and it was asked: you answered it a moment ago.
        None => item
            .actions
            .iter()
            .filter_map(|a| a.target.question_ids.as_ref())
            .any(|ids| ids.iter().any(|q| q == id))
            .then_some("✓"),
    }
}

/// Is this the item the editor is open on?
fn answering(app: &App, item: &InboxItem) -> bool {
    matches!(&app.selected, Some(r) if r.kind == RefKind::Inbox && r.id == item.id)
}

/// Every row the inbox would draw if it had the room: a row per item saying who is asking about
/// what and for how long, then its detail. Two questions on one line read as one; on their own rows
/// they read as two.
pub fn all_inbox_rows(app: &App, width: u16) -> Vec<InboxRow> {
    let items = ordered_items(app);
    if items.is_empty() {
        // The good news said as good news, and the follow-up question answered in the same breath:
        // "nothing needs me" is only reassuring if something is still happening.
        let working = app
            .ws()
            .graph
            .nodes
            .iter()
            .filter(|n| n.kind == GraphNodeKind::Agent && n.status == VisualStatus::Working)
            .count();
        let text = match working {
            0 => "nothing is waiting on you".to_string(),
            1 => "nothing is waiting on you · 1 agent working".to_string(),
            n => format!("nothing is waiting on you · {n} agents working"),
        };
        return vec![(Line::styled(text, Style::new().fg(Color::DarkGray)), None)];
    }
    let selected = match &app.selected {
        Some(r) if r.kind == RefKind::Inbox => Some(r.id.clone()),
        _ => None,
    };
    let width = width as usize;
    let detail_width = width.saturating_sub(6).max(10);
    let mut rows: Vec<InboxRow> = Vec::new();
    for item in items {
        let reference = GraphObjectRef::inbox(&item.id);
        let active = selected.as_deref() == Some(item.id.as_str());
        let age = app.inbox_age(item);

        // Right of the title: which task, then the keys. A role is not an address — two missions can
        // each have a `backend` — and an item about a mission has no task, so it says the mission.
        let id_text = item
            .task_id
            .clone()
            .unwrap_or_else(|| item.mission_id.clone());
        let keys = key_spans(&item.actions);
        let keys_width: usize = keys.iter().map(|(t, _)| t.chars().count() + 2).sum();
        let fixed = 2 + id_text.chars().count() + keys_width + 1 + AGE_WIDTH;
        let title = truncate(
            &format!("{} {}", inbox_icon(item.kind), item.title),
            width.saturating_sub(fixed).max(8),
        );

        let mut title_style = Style::new().fg(Color::Yellow);
        if active {
            title_style = title_style.add_modifier(Modifier::BOLD | Modifier::REVERSED);
        }
        let (icon, rest) = title.split_at(inbox_icon(item.kind).len());
        let mut spans = vec![
            Span::styled(
                icon.to_string(),
                if active {
                    title_style
                } else {
                    Style::new().fg(icon_color(item.kind)).bold()
                },
            ),
            Span::styled(rest.to_string(), title_style),
        ];
        let mut used = title.chars().count();
        spans.push(Span::styled(
            format!("  {id_text}"),
            Style::new().fg(Color::Gray),
        ));
        used += 2 + id_text.chars().count();
        for (i, (text, destructive)) in keys.iter().enumerate() {
            let lead = "  ";
            let _ = i;
            used += lead.len() + text.chars().count();
            spans.push(Span::styled(
                format!("{lead}{text}"),
                if *destructive {
                    Style::new().fg(Color::Red)
                } else {
                    Style::new().fg(Color::Cyan)
                },
            ));
        }
        // The age, right-aligned, so the column reads as a column and a glance down it ranks the list.
        let age_text = age.map(age_label).unwrap_or_else(|| "-".to_string());
        let pad = width.saturating_sub(used + AGE_WIDTH);
        spans.push(Span::raw(" ".repeat(pad)));
        spans.push(Span::styled(
            format!("{age_text:>AGE_WIDTH$}"),
            Style::new()
                .fg(age
                    .map(|a| urgency_color(urgency(a)))
                    .unwrap_or(Color::DarkGray))
                .bold(),
        ));
        rows.push((Line::from(spans), Some(reference.clone())));

        let style = Style::new().fg(if active { Color::Gray } else { Color::DarkGray });
        if item.detail.is_empty() {
            rows.push((Line::styled("    -", style), Some(reference)));
            continue;
        }
        for detail in &item.detail {
            let mark = question_mark(app, item, detail);
            let gutter = mark.unwrap_or(" ");
            // The selected item is the one being read, so it gets the room to be read in; the rest
            // stay one row each so the list keeps its shape.
            let lines = if active {
                wrap(detail, detail_width, DETAIL_ROWS)
            } else {
                vec![truncate(detail, detail_width)]
            };
            for (i, text) in lines.into_iter().enumerate() {
                let lead = if i == 0 {
                    format!("  {gutter} ")
                } else {
                    "    ".to_string()
                };
                let style = if mark == Some("▸") {
                    style.fg(Color::White).bold()
                } else if mark == Some("✓") {
                    style.fg(Color::Green)
                } else {
                    style
                };
                rows.push((
                    Line::styled(format!("{lead}{text}"), style),
                    Some(reference.clone()),
                ));
            }
        }
    }
    rows
}

/// The first row of the selected item, so scrolling can be made to keep it in view.
pub fn selected_row(app: &App, width: u16) -> Option<usize> {
    let selected = match &app.selected {
        Some(r) if r.kind == RefKind::Inbox => r,
        _ => return None,
    };
    all_inbox_rows(app, width)
        .iter()
        .position(|(_, r)| r.as_ref() == Some(selected))
}

/// The rows that fit, starting from where the panel is scrolled to.
pub fn inbox_rows(app: &App, height: usize) -> Vec<InboxRow> {
    inbox_rows_at(app, height, app.inbox_viewport.width.max(80))
}

pub fn inbox_rows_at(app: &App, height: usize, width: u16) -> Vec<InboxRow> {
    let rows = all_inbox_rows(app, width);
    let budget = height.max(1);
    let start = app.inbox_scroll.min(rows.len().saturating_sub(1));
    rows.into_iter().skip(start).take(budget).collect()
}

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    // The selection is what j/k moves, so it has to be on screen whatever the panel is scrolled to.
    let inner_height = area.height.saturating_sub(1) as usize;
    app.reveal_selected_inbox(inner_height, area.width);

    let count = app.ws().graph.inbox.len();
    let oldest = oldest_age(app);
    let mut title = if count == 0 {
        Region::Inbox.title().to_string()
    } else {
        format!("{} ({count})", Region::Inbox.title())
    };
    // The header carries the worst wait, because the header is what is visible from across the room
    // while your eye is in a pane.
    if let Some(age) = oldest {
        title.push_str(&format!(" · oldest {}", age_label(age)));
    }
    let total = all_inbox_rows(app, area.width).len();
    let below = total.saturating_sub(app.inbox_scroll + inner_height);
    if app.inbox_scroll > 0 || below > 0 {
        title.push_str(&format!(
            "  ↕ rows {}-{}/{total}",
            app.inbox_scroll + 1,
            total - below
        ));
    }
    let focused = region_active(app, Region::Inbox);
    let block = panel_block(&title, focused, Borders::TOP);
    // A panel that is grey whether or not three agents have stopped is invisible exactly when it
    // matters, so when something is waiting the header takes that item's urgency instead.
    let block = match oldest.map(urgency) {
        Some(u) if !focused && u != Urgency::Fresh => {
            block.title_style(Style::new().fg(urgency_color(u)).add_modifier(
                if u == Urgency::Stalled {
                    Modifier::BOLD | Modifier::REVERSED
                } else {
                    Modifier::BOLD
                },
            ))
        }
        _ => block,
    };
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = inbox_rows_at(app, inner.height as usize, inner.width);
    app.inbox_viewport = viewport_of(inner);
    app.inbox_rows = rows.iter().map(|(_, r)| r.clone()).collect();
    // No horizontal scroll here: rows are built to the panel's width, and shuttling a strip sideways
    // to read one blocker takes every other item's title off the left edge with it.
    frame.render_widget(
        Paragraph::new(rows.into_iter().map(|(line, _)| line).collect::<Vec<_>>()),
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

    #[test]
    fn what_freezes_a_subtree_outranks_what_holds_up_one_task() {
        assert!(blocking_tier(InboxKind::Blocker) < blocking_tier(InboxKind::TaskQuestion));
        assert!(blocking_tier(InboxKind::LintError) < blocking_tier(InboxKind::TaskQuestion));
        assert!(blocking_tier(InboxKind::MissionQuestion) < blocking_tier(InboxKind::HumanReview));
        assert!(blocking_tier(InboxKind::TaskQuestion) < blocking_tier(InboxKind::HumanReview));
    }

    #[test]
    fn wrapping_keeps_words_whole_and_says_when_it_ran_out() {
        assert_eq!(wrap("one two three", 20, 3), vec!["one two three"]);
        assert_eq!(wrap("one two three", 7, 3), vec!["one two", "three"]);
        let clipped = wrap("a b c d e f g h i j k l", 3, 2);
        assert_eq!(clipped.len(), 2);
        assert!(clipped[1].ends_with('…'), "{clipped:?}");
        // A token longer than the panel is cut, not looped over forever.
        assert_eq!(wrap("supercalifragilistic", 6, 2), vec!["super…"]);
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    use crate::keys::Key;
    use crate::testkit::*;

    fn demo_app() -> crate::app::App {
        let mut app = crate::app::App::new(crate::app::Mode::Replay);
        app.set_graph(demo_graph());
        // The demo's `since` is 2026-09-05T10:05:00+08:00; pin now to 41 minutes after it so the
        // age column is a fact about the fixture and not about when the suite runs.
        app.now_override = Some(crate::clock::parse_rfc3339("2026-09-05T10:46:00+08:00").unwrap());
        app
    }

    #[test]
    fn inbox_strip_lists_items_with_their_action_keys() {
        let mut app = demo_app();
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        app.handle_key(Key::TAB);
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(text.contains("▶ INBOX (2)"), "{text}");
        // A row per item saying who is asking about what, then a row per thing asked.
        assert!(text.contains("? backend asks 2 questions (v1)"), "{text}");
        assert!(text.contains("[a] answer"), "{text}");
        assert!(text.contains("[x] kill task"), "{text}");
        assert!(text.contains("Q1 Which auth method?"), "{text}");
        assert!(
            text.contains("Q2 Link expiry?"),
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
    }

    #[test]
    fn every_row_says_how_long_it_has_been_waiting() {
        let mut app = demo_app();
        let text = screen_text(&draw_rows(&mut app, 120, 40));
        assert!(text.contains("41m"), "the age column:\n{text}");
        assert!(text.contains("oldest 41m"), "and the header:\n{text}");
        // The review item carries no `since`, so it says so rather than claiming to be brand new.
        let rows = all_inbox_rows(&app, 120);
        let review = rows
            .iter()
            .map(|(l, _)| l.to_string())
            .find(|l| l.contains("human review"))
            .unwrap();
        assert!(review.trim_end().ends_with('-'), "{review}");
    }

    #[test]
    fn what_blocks_more_sorts_first_however_old_it_is() {
        let app = demo_app();
        let ordered: Vec<&str> = ordered_items(&app).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ordered,
            vec!["question:t-backend-auth", "review:t-frontend-login:AC-3"],
            "a question that holds up a task outranks a review of finished work"
        );
    }

    #[test]
    fn an_empty_inbox_says_what_is_happening_instead() {
        let app = replay_app("live-1");
        let lines = inbox_lines(&app, 4);
        assert!(
            lines[0]
                .to_string()
                .starts_with("nothing is waiting on you"),
            "{}",
            lines[0]
        );
    }
}

#[cfg(test)]
mod reading {
    use super::*;
    use crate::app::{App, Mode};
    use crate::testkit::*;

    /// A blocker's reason is free agent prose. It used to be one long line you read by shuttling the
    /// whole strip sideways, which took every other item's title off the left edge with it.
    fn app_with_a_long_blocker() -> App {
        let mut app = App::new(Mode::Replay);
        let mut graph = demo_graph();
        graph.inbox.push(InboxItem {
            id: "blocker:t-backend-auth".into(),
            kind: InboxKind::Blocker,
            mission_id: "m-001".into(),
            task_id: Some("t-backend-auth".into()),
            title: "backend is stuck".into(),
            detail: vec![
                "the migration cannot run because the test database still holds a lock from the \
                 previous attempt and nothing in the worktree can release it"
                    .into(),
            ],
            since: Some("2026-09-05T10:00:00+08:00".into()),
            reference: GraphObjectRef::node("t-backend-auth"),
            actions: Vec::new(),
        });
        app.set_graph(graph);
        app.now_override = Some(crate::clock::parse_rfc3339("2026-09-05T10:46:00+08:00").unwrap());
        app
    }

    #[test]
    fn a_long_blocker_wraps_when_it_is_the_one_you_are_reading() {
        let mut app = app_with_a_long_blocker();
        let unselected: Vec<String> = all_inbox_rows(&app, 80)
            .into_iter()
            .map(|(l, _)| l.to_string())
            .filter(|l| l.contains("the migration cannot run"))
            .collect();
        assert_eq!(unselected.len(), 1, "one row each until you select it");
        assert!(unselected[0].ends_with('…'), "{}", unselected[0]);

        app.select(Some(GraphObjectRef::inbox("blocker:t-backend-auth")));
        let selected: Vec<String> = all_inbox_rows(&app, 80)
            .into_iter()
            .map(|(l, _)| l.to_string())
            .filter(|l| !l.trim().is_empty() && l.starts_with("  "))
            .filter(|l| !l.contains("Q1") && !l.contains("Q2") && !l.contains("AC-3"))
            .collect();
        assert!(selected.len() > 1, "the selected item wraps: {selected:?}");
        assert!(selected.len() <= DETAIL_ROWS, "and stops: {selected:?}");
        for line in &selected {
            assert!(line.chars().count() <= 80, "inside the panel: {line:?}");
        }
    }

    #[test]
    fn a_stuck_agent_outranks_a_review_and_a_question() {
        let app = app_with_a_long_blocker();
        let order: Vec<&str> = ordered_items(&app).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "blocker:t-backend-auth",
                "question:t-backend-auth",
                "review:t-frontend-login:AC-3",
            ],
            "an agent that has stopped is what is costing the most"
        );
    }
}
