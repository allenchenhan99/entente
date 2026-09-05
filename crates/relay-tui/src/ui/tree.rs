//! Mission tree: `MISSION <title> <status>`, the lint counts, then one agent per two rows with the runtime glyph
//! and the three states (port of `apps/tui/src/panels/Tree.tsx`).

use crate::app::{App, Region};
use crate::model::*;
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Borders, Paragraph};
use ratatui::Frame;

pub fn runtime_glyph(runtime: Option<RuntimeState>) -> &'static str {
    match runtime {
        Some(RuntimeState::Working) => "●",
        Some(RuntimeState::Idle) => "○",
        Some(RuntimeState::Blocked) => "◐",
        Some(RuntimeState::Done) => "✓",
        Some(RuntimeState::Exited) => "✗",
        Some(RuntimeState::Unspawned) => "·",
        _ => "?",
    }
}

pub fn status_color(status: VisualStatus) -> Color {
    match status {
        VisualStatus::Attention | VisualStatus::Blocked => Color::Yellow,
        VisualStatus::Done | VisualStatus::Verified => Color::Green,
        VisualStatus::Failed => Color::Red,
        VisualStatus::Working => Color::Cyan,
        VisualStatus::Pending => Color::DarkGray,
    }
}

/// The serde name of an optional state enum (`working`, `repairing`, …), or `-`.
pub fn enum_name<T: serde::Serialize>(value: &Option<T>) -> String {
    value
        .as_ref()
        .and_then(|v| serde_json::to_value(v).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "-".to_string())
}

/// Port of `shortWorktree`: the path from `.relay` on, or the last three segments.
pub fn short_worktree(path: &str) -> String {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let kept: Vec<&str> = match segments.iter().rposition(|s| *s == ".relay") {
        Some(i) => segments[i..].to_vec(),
        None => segments[segments.len().saturating_sub(3)..].to_vec(),
    };
    kept.join("/")
}

fn task_detail(node: &GraphNode, task: Option<&TaskView>) -> String {
    if let Some(t) = task {
        if !t.blocked_on_dependencies.is_empty() {
            return format!("◐ blocked on {}", t.blocked_on_dependencies.join(", "));
        }
    }
    let mut details = Vec::new();
    if let Some(t) = task {
        if let Some(wt) = &t.worktree {
            details.push(format!("wt {}", short_worktree(&wt.path)));
        }
        if !t.open_questions.is_empty() {
            details.push(format!("? {}", t.open_questions.len()));
        }
        if let Some(b) = &t.blocker {
            details.push(b.reason.clone());
        }
    }
    if details.is_empty() {
        details.push(
            node.badge
                .clone()
                .unwrap_or_else(|| enum_name(&Some(node.status))),
        );
    }
    details.join(" · ")
}

/// The tree rows as plain text (two per agent), for tests and the renderer.
/// One drawn row and the object it stands for; `None` where a row is a header or a detail line.
pub type TreeRow = (Line<'static>, Option<GraphObjectRef>);

/// The rows as drawn, so a click on row N and the line on row N always agree about what is there.
/// The workspaces panel: every open project, and the agents inside each. A workspace is a daemon —
/// its own repo, its own event log, its own panes — so several projects are several relayds, and this
/// is the list of them.
pub fn tree_rows(app: &App, height: usize) -> Vec<TreeRow> {
    if app.workspaces.len() > 1 {
        return workspace_rows(app, height);
    }
    let mut lines: Vec<TreeRow> = Vec::new();
    let Some(mission) = app.ws().state.mission() else {
        if app.ws().graph.nodes.is_empty() {
            lines.push((
                Line::styled("No mission", Style::new().fg(Color::DarkGray)),
                None,
            ));
            return lines;
        }
        lines.push((
            Line::styled(
                "MISSION  (state not loaded)",
                Style::new().fg(Color::DarkGray),
            ),
            None,
        ));
        lines.extend(agent_lines(app, height.saturating_sub(1)));
        return lines;
    };
    let mut header = vec![Span::styled(
        format!("MISSION  {}  {}", mission.mission.title, mission.status),
        Style::new().bold(),
    )];
    let open = mission
        .open_questions
        .as_ref()
        .map(|q| q.len())
        .unwrap_or(0);
    if open > 0 {
        header.push(Span::styled(
            format!("  ? {open} for you"),
            Style::new().fg(Color::Yellow),
        ));
    }
    lines.push((Line::from(header), None));
    let lint: Vec<&LintItem> = app
        .ws()
        .state
        .tasks
        .values()
        .flat_map(|t| t.lint.iter())
        .collect();
    let errors = lint.iter().filter(|l| l.severity == "error").count();
    let warnings = lint.iter().filter(|l| l.severity == "warning").count();
    lines.push((
        Line::styled(
            format!("lint: {errors} errors · {warnings} warnings"),
            Style::new().fg(Color::DarkGray),
        ),
        None,
    ));
    lines.extend(agent_lines(app, height.saturating_sub(2)));
    lines
}

/// Just the lines, for callers that only draw.
pub fn tree_lines(app: &App, height: usize) -> Vec<Line<'static>> {
    tree_rows(app, height)
        .into_iter()
        .map(|(line, _)| line)
        .collect()
}

/// One block per workspace: its name and mission line, then its agents. The active one is marked, so
/// it is clear which project the keys and the panes belong to.
fn workspace_rows(app: &App, height: usize) -> Vec<TreeRow> {
    let mut rows: Vec<TreeRow> = Vec::new();
    let per_workspace = (height / app.workspaces.len().max(1)).max(2);
    for (index, ws) in app.workspaces.iter().enumerate() {
        let active = index == app.active;
        let mut header = Style::new().bold();
        if active {
            header = header.fg(Color::Cyan);
        }
        let status = ws
            .state
            .mission()
            .map(|m| m.status.clone())
            .unwrap_or_else(|| ws.connection.label());
        rows.push((
            Line::styled(
                format!(
                    "{} {}  {}  {}",
                    if active { "▶" } else { " " },
                    index + 1,
                    ws.name,
                    status
                ),
                header,
            ),
            None,
        ));
        let agents: Vec<&GraphNode> = ws
            .graph
            .nodes
            .iter()
            .filter(|n| n.kind == GraphNodeKind::Agent)
            .collect();
        if agents.is_empty() {
            rows.push((
                Line::styled("    <no agents>", Style::new().fg(Color::DarkGray)),
                None,
            ));
            continue;
        }
        for node in agents.iter().take(per_workspace.saturating_sub(1)) {
            let selected = active
                && matches!(&app.selected, Some(r) if r.kind == RefKind::Node && r.id == node.id);
            let mut style = Style::new().fg(status_color(node.status));
            if selected {
                style = style.bold().reversed();
            }
            rows.push((
                Line::styled(
                    format!(
                        "    {} {}  {}",
                        runtime_glyph(node.runtime),
                        node.id,
                        node.label
                    ),
                    style,
                ),
                // Only the active workspace's rows select: a click elsewhere switches to it first.
                active.then(|| GraphObjectRef::node(&node.id)),
            ));
        }
    }
    rows
}

fn agent_lines(app: &App, height: usize) -> Vec<TreeRow> {
    let agents: Vec<&GraphNode> = app
        .ws()
        .graph
        .nodes
        .iter()
        .filter(|n| n.kind == GraphNodeKind::Agent)
        .collect();
    if agents.is_empty() {
        return vec![(
            Line::styled("<no agents>", Style::new().fg(Color::DarkGray)),
            None,
        )];
    }
    let max_agents = (height / 2).max(1);
    let selected_index = match &app.selected {
        Some(r) if r.kind == RefKind::Node => agents.iter().position(|n| n.id == r.id),
        _ => None,
    };
    let start = match selected_index {
        Some(i) if i >= max_agents => {
            (i + 1 - max_agents).min(agents.len().saturating_sub(max_agents))
        }
        _ => 0,
    };
    let mut lines = Vec::new();
    for node in agents.iter().skip(start).take(max_agents) {
        let task = node.task_id.as_deref().and_then(|t| app.task_view(t));
        let active = matches!(&app.selected, Some(r) if r.kind == RefKind::Node && r.id == node.id);
        let color = status_color(node.status);
        let mut style = Style::new().fg(color);
        if active {
            style = style.bold().reversed();
        }
        let version = task
            .map(|t| t.contract.version.to_string())
            .unwrap_or_else(|| "-".to_string());
        // Two rows per agent (the Ink tree), compacted for a 35 % column: the runtime glyph stands for
        // the runtime state, the role moves to the detail row.
        let first = format!(
            "{} {}  {} {} · {}  v{}",
            if active { "›" } else { "▸" },
            node.id,
            runtime_glyph(node.runtime),
            enum_name(&node.task_state),
            enum_name(&node.handoff_state),
            version
        );
        let reference = GraphObjectRef::node(&node.id);
        lines.push((Line::styled(first, style), Some(reference.clone())));
        // The detail row belongs to the same agent, so clicking either row selects it.
        lines.push((
            Line::styled(
                format!("    {} · {}", node.label, task_detail(node, task)),
                Style::new().fg(color).dim(),
            ),
            Some(reference),
        ));
    }
    lines
}

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    let block = panel_block(
        Region::Tree.title(),
        region_active(app, Region::Tree),
        Borders::TOP,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = tree_rows(app, inner.height as usize);
    app.tree_viewport = viewport_of(inner);
    app.tree_rows = rows.iter().map(|(_, r)| r.clone()).collect();
    let lines: Vec<Line<'static>> = rows.into_iter().map(|(line, _)| line).collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_worktree_keeps_the_relay_suffix() {
        assert_eq!(
            short_worktree("/Users/x/app/.relay/wt/t-backend-auth"),
            ".relay/wt/t-backend-auth"
        );
        assert_eq!(short_worktree("/a/b/c/d"), "b/c/d");
    }

    #[test]
    fn glyphs_follow_the_ink_tree() {
        assert_eq!(runtime_glyph(Some(RuntimeState::Working)), "●");
        assert_eq!(runtime_glyph(Some(RuntimeState::Exited)), "✗");
        assert_eq!(runtime_glyph(None), "?");
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    use crate::keys::Key;
    use crate::testkit::*;

    #[test]
    fn tree_lists_every_task_of_live_1_with_its_status_glyph() {
        let mut app = replay_app("live-1");
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(text.contains("MISSION  Add secure login to this"), "{text}");
        let header = tree_lines(&app, 40)[0].to_string();
        assert_eq!(
            header,
            "MISSION  Add secure login to this application.  executing"
        );
        for task in app.ws().state.tasks.keys() {
            let node = app.ws().graph.node(task).expect("task has a node");
            let row = rows
                .iter()
                .find(|r| r.contains(task))
                .unwrap_or_else(|| panic!("{task} missing from the tree:\n{text}"));
            assert!(
                row.contains(runtime_glyph(node.runtime)),
                "{task} lacks its glyph: {row}"
            );
        }
        // The selected agent is marked with › and shows its three states and version.
        let backend = rows
            .iter()
            .find(|r| r.contains("› t-backend-auth"))
            .unwrap();
        assert!(backend.contains("✗ completed · verified"), "{backend}");
        let full: Vec<String> = tree_lines(&app, 40).iter().map(|l| l.to_string()).collect();
        assert!(
            full.iter()
                .any(|l| l == "› t-backend-auth  ✗ completed · verified  v1"),
            "{full:?}"
        );
        assert!(
            text.contains("backend · wt .relay/wt/t-backend-auth"),
            "{text}"
        );
        assert!(text.contains("lint: 0 errors · 0 warnings"), "{text}");
    }

    #[test]
    fn tree_shows_live_7_subtask_and_scrolls_with_the_selection() {
        let mut app = replay_app("live-7");
        let rows = draw_rows(&mut app, 120, 40);
        let text = screen_text(&rows);
        assert!(text.contains("t-token-store"), "{text}");
        assert!(text.contains("t-backend-auth"), "{text}");
        // A short terminal keeps the selected agent visible.
        app.handle_key(Key::char('j'));
        let rows = draw_rows(&mut app, 100, 30);
        assert!(
            rows.iter().any(|r| r.contains("› t-token-store")),
            "{}",
            screen_text(&rows)
        );
    }

    #[test]
    fn tree_details_show_questions_blockers_and_dependencies() {
        let mut app = crate::app::App::new(crate::app::Mode::Replay);
        app.set_graph(demo_graph());
        let lines = tree_lines(&app, 20);
        let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert!(
            text.iter()
                .any(|l| l.contains("t-backend-auth  ○ proposed · needs_clarification  v-")),
            "{text:?}"
        );
        assert!(
            text.iter().any(|l| l.contains("    backend · ? 2")),
            "{text:?}"
        );
        assert!(text.iter().any(|l| l.contains("? 2")), "{text:?}");
        assert!(text.iter().any(|l| l.contains("◐ blocked")), "{text:?}");
    }
}
