//! The explainable graph: four columns (human / planner · agents · verifier · done) of nodes with their status
//! glyph and badge, then one row per edge drawn with box characters and its label, attention edges highlighted.
//! Port of `apps/tui/src/graph/{layout,edges,canvas,Graph}.ts` onto a ratatui buffer.

use crate::app::{App, Region};
use crate::model::*;
use crate::ui::tree::status_color;
use crate::ui::{panel_block, region_active};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Borders, Paragraph};
use ratatui::Frame;

/// A character grid with a style per cell (the Ink `Canvas`).
pub struct Canvas {
    pub width: usize,
    pub height: usize,
    cells: Vec<Vec<(char, Style)>>,
}

impl Canvas {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            cells: vec![vec![(' ', Style::new()); width]; height],
        }
    }

    pub fn text(&mut self, x: usize, y: usize, value: &str, style: Style) {
        if y >= self.height {
            return;
        }
        for (offset, ch) in value.chars().enumerate() {
            let cx = x + offset;
            if cx >= self.width {
                break;
            }
            self.cells[y][cx] = (ch, style);
        }
    }

    pub fn render(&self) -> Vec<Line<'static>> {
        self.cells
            .iter()
            .map(|row| {
                let mut spans: Vec<Span<'static>> = Vec::new();
                let mut current: Option<(String, Style)> = None;
                for (ch, style) in row {
                    match &mut current {
                        Some((text, s)) if s == style => text.push(*ch),
                        _ => {
                            if let Some((text, s)) = current.take() {
                                spans.push(Span::styled(text, s));
                            }
                            current = Some((ch.to_string(), *style));
                        }
                    }
                }
                if let Some((text, s)) = current.take() {
                    spans.push(Span::styled(text, s));
                }
                Line::from(spans)
            })
            .collect()
    }
}

pub struct StatusVisual {
    pub color: Color,
    pub bold: bool,
    pub dim: bool,
    pub glyph: &'static str,
    pub line: &'static str,
}

/// Port of `statusVisual` (`edges.ts`): glyph, line pattern and colour per status, animated by `tick`.
pub fn status_visual(status: VisualStatus, tick: u64) -> StatusVisual {
    let color = status_color(status);
    match status {
        VisualStatus::Pending => StatusVisual {
            color,
            bold: false,
            dim: tick % 8 < 4,
            glyph: "·",
            line: if tick.is_multiple_of(2) {
                "╌ ╌"
            } else {
                " ╌ "
            },
        },
        VisualStatus::Attention => StatusVisual {
            color,
            bold: tick % 4 < 2,
            dim: false,
            glyph: "!",
            line: "?──",
        },
        VisualStatus::Blocked => StatusVisual {
            color,
            bold: true,
            dim: false,
            glyph: "◐",
            line: "◐──",
        },
        VisualStatus::Working => StatusVisual {
            color,
            bold: false,
            dim: false,
            glyph: "●",
            line: if tick.is_multiple_of(2) {
                "╌─╌"
            } else {
                "─╌─"
            },
        },
        VisualStatus::Done | VisualStatus::Verified => StatusVisual {
            color,
            bold: status == VisualStatus::Verified,
            dim: false,
            glyph: "✓",
            line: "───",
        },
        VisualStatus::Failed => StatusVisual {
            color,
            bold: true,
            dim: false,
            glyph: "✗",
            line: "─✗─",
        },
    }
}

fn status_style(status: VisualStatus, tick: u64, selected: bool) -> Style {
    let visual = status_visual(status, tick);
    let mut style = Style::new().fg(visual.color);
    if selected || visual.bold {
        style = style.bold();
    }
    if visual.dim {
        style = style.dim();
    }
    if selected {
        style = style.reversed();
    }
    style
}

pub const HEADINGS: [&str; 4] = ["HUMAN / PLANNER", "AGENTS", "VERIFIER", "DONE"];

/// Column x positions for a canvas of `width` cells.
pub fn columns(width: usize) -> [usize; 4] {
    let w = width.max(40);
    [0, w * 30 / 100, w * 62 / 100, w.saturating_sub(10)]
}

/// One line per edge: `from ──label──▶ to`, prefixed by the status glyph (`!` for attention).
pub fn edge_text(edge: &GraphEdge, tick: u64) -> String {
    let visual = status_visual(edge.status, tick);
    let marker = if edge.attention { "!" } else { visual.glyph };
    format!(
        "{marker} {} {}{}{} ▶ {}",
        edge.from, visual.line, edge.label, visual.line, edge.to
    )
}

/// Below this width the four columns overlap; nodes are then listed under their column heading instead.
pub const COLUMN_LAYOUT_MIN_WIDTH: usize = 70;

/// Logical rows of the graph: `(row, column, node index)` per node; edge rows start after the deepest column.
struct Rows {
    node_rows: Vec<usize>,
    heading_rows: [usize; 4],
    first_edge_row: usize,
    columns: bool,
}

fn plan_rows(graph: &Graph, width: usize) -> Rows {
    let columns = width >= COLUMN_LAYOUT_MIN_WIDTH;
    let mut node_rows = vec![0; graph.nodes.len()];
    let mut heading_rows = [0; 4];
    let first_edge_row = if columns {
        // Ink layout: headings on row 0, nodes stacked per column from row 1.
        let mut counts = [0usize; 4];
        for (index, node) in graph.nodes.iter().enumerate() {
            let column = (node.column as usize).min(3);
            counts[column] += 1;
            node_rows[index] = counts[column];
        }
        counts.iter().copied().max().unwrap_or(0) + 2
    } else {
        // Narrow: one group per column (heading row, then its nodes), columns without nodes are skipped.
        let mut row = 0;
        for (column, heading_row) in heading_rows.iter_mut().enumerate() {
            let members: Vec<usize> = graph
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| (n.column as usize).min(3) == column)
                .map(|(i, _)| i)
                .collect();
            if members.is_empty() {
                continue;
            }
            *heading_row = row;
            row += 1;
            for index in members {
                node_rows[index] = row;
                row += 1;
            }
        }
        row + 1
    };
    Rows {
        node_rows,
        heading_rows,
        first_edge_row,
        columns,
    }
}

/// The graph as styled lines (port of `renderGraph`): headings, nodes by column, then the edge rows.
/// The rows scroll so the selected object is visible.
pub fn graph_lines(
    graph: &Graph,
    width: usize,
    height: usize,
    tick: u64,
    selected: Option<&GraphObjectRef>,
) -> Vec<Line<'static>> {
    let mut canvas = Canvas::new(width, height);
    if graph.nodes.is_empty() && graph.edges.is_empty() {
        canvas.text(
            0,
            0,
            "<empty graph>",
            Style::new().fg(Color::DarkGray).dim(),
        );
        return canvas.render();
    }
    let rows = plan_rows(graph, width);
    let cols = columns(width);
    let edge_row = |index: usize| rows.first_edge_row + index;

    let selected_row = selected.and_then(|r| match r.kind {
        RefKind::Node => graph
            .nodes
            .iter()
            .position(|n| n.id == r.id)
            .map(|i| rows.node_rows[i]),
        RefKind::Edge => graph.edges.iter().position(|e| e.id == r.id).map(edge_row),
        RefKind::Inbox => None,
    });
    let content_height = height.saturating_sub(1);
    let offset = match selected_row {
        Some(row) if row > content_height && content_height > 0 => row - content_height,
        _ => 0,
    };
    // Row 0 (the column headings) stays; scrolled-away rows are dropped.
    let visible = |row: usize| {
        if row == 0 {
            Some(0)
        } else {
            row.checked_sub(offset).filter(|r| *r > 0)
        }
    };

    let heading_style = Style::new().fg(Color::DarkGray).bold();
    if rows.columns {
        for (column, heading) in HEADINGS.iter().enumerate() {
            canvas.text(cols[column], 0, heading, heading_style);
        }
    } else {
        for (column, heading) in HEADINGS.iter().enumerate() {
            let used = graph
                .nodes
                .iter()
                .any(|n| (n.column as usize).min(3) == column);
            if !used {
                continue;
            }
            let row = rows.heading_rows[column];
            let y = if row == 0 { Some(0) } else { visible(row) };
            if let Some(y) = y {
                canvas.text(0, y, heading, heading_style);
            }
        }
    }
    for (index, node) in graph.nodes.iter().enumerate() {
        let row = rows.node_rows[index];
        let Some(y) = visible(row) else { continue };
        let is_selected = matches!(selected, Some(r) if r.kind == RefKind::Node && r.id == node.id);
        let visual = status_visual(node.status, tick);
        let identity = if node.label == node.id {
            node.id.clone()
        } else {
            format!("{} ({})", node.id, node.label)
        };
        let badge = node
            .badge
            .as_ref()
            .map(|b| format!(" {b}"))
            .unwrap_or_default();
        let x = if rows.columns {
            cols[(node.column as usize).min(3)]
        } else {
            2
        };
        canvas.text(
            x,
            y,
            &format!("{} {identity}{badge}", visual.glyph),
            status_style(node.status, tick, is_selected),
        );
    }
    for (index, edge) in graph.edges.iter().enumerate() {
        let Some(y) = visible(edge_row(index)) else {
            continue;
        };
        let is_selected = matches!(selected, Some(r) if r.kind == RefKind::Edge && r.id == edge.id);
        let mut style = status_style(edge.status, tick, is_selected);
        if edge.attention {
            style = style.fg(Color::Yellow).bold();
        }
        canvas.text(0, y, &edge_text(edge, tick), style);
    }
    canvas.render()
}

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(
        Region::Graph.title(),
        region_active(app, Region::Graph),
        Borders::TOP,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = graph_lines(
        &app.graph,
        inner.width as usize,
        inner.height as usize,
        app.tick,
        app.selected.as_ref(),
    );
    frame.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_merges_equal_styles_into_spans() {
        let mut c = Canvas::new(6, 1);
        c.text(0, 0, "ab", Style::new().fg(Color::Red));
        c.text(2, 0, "cd", Style::new().fg(Color::Red));
        c.text(4, 0, "ef", Style::new());
        let line = &c.render()[0];
        assert_eq!(line.spans.len(), 2);
        assert_eq!(line.to_string(), "abcdef");
    }

    #[test]
    fn attention_edges_get_the_bang_and_the_question_line() {
        let edge = GraphEdge {
            id: "contract:t".into(),
            kind: GraphEdgeKind::Contract,
            from: "planner".into(),
            to: "t".into(),
            task_id: None,
            label: "v1 ? 2".into(),
            status: VisualStatus::Attention,
            attention: true,
            version: Some(1),
        };
        assert_eq!(edge_text(&edge, 0), "! planner ?──v1 ? 2?── ▶ t");
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    use crate::keys::Key;
    use crate::testkit::*;

    fn plain(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.to_string().trim_end().to_string())
            .collect()
    }

    #[test]
    fn graph_draws_columns_nodes_and_labelled_contract_edges_for_live_1() {
        let g = fixture("live-1").graph;
        let rows = plain(&graph_lines(
            &g,
            100,
            12,
            0,
            Some(&GraphObjectRef::node("t-backend-auth")),
        ));
        assert!(
            rows[0].contains("HUMAN / PLANNER")
                && rows[0].contains("AGENTS")
                && rows[0].contains("VERIFIER"),
            "{rows:?}"
        );
        let text = rows.join("\n");
        assert!(text.contains("✓ t-backend-auth (backend) a2"), "{text}");
        assert!(text.contains("✗ t-frontend-login (frontend)"), "{text}");
        assert!(text.contains("human ───v1 ✓─── ▶ t-backend-auth"), "{text}");
        assert!(text.contains("t-backend-auth ───✓─── ▶ verifier"), "{text}");
        // Nodes sit in their columns: human/planner at x=0, agents at 30 %, verifier at 62 %.
        let cols = columns(100);
        let agent_row = rows
            .iter()
            .find(|r| r.contains("t-backend-auth (backend)"))
            .unwrap();
        assert_eq!(
            agent_row.chars().position(|c| c == '✓'),
            Some(cols[1]),
            "{agent_row}"
        );
    }

    #[test]
    fn graph_shows_the_delegation_edge_of_live_7() {
        let g = fixture("live-7").graph;
        let text = plain(&graph_lines(&g, 100, 14, 0, None)).join("\n");
        assert!(
            text.contains("t-backend-auth ───sub ✓ merged─── ▶ t-token-store"),
            "{text}"
        );
        assert!(text.contains("human ───↩ 1─── ▶ t-backend-auth"), "{text}");
    }

    #[test]
    fn graph_highlights_attention_edges_and_the_selection() {
        let g = demo_graph();
        let lines = graph_lines(
            &g,
            100,
            16,
            0,
            Some(&GraphObjectRef::edge("contract:t-backend-auth")),
        );
        let attention = lines
            .iter()
            .find(|l| l.to_string().contains("?──v1 ? 2?──"))
            .expect("attention edge row");
        let span = attention
            .spans
            .iter()
            .find(|s| s.content.contains("planner"))
            .unwrap();
        assert_eq!(span.style.fg, Some(Color::Yellow));
        assert!(span
            .style
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD));
        assert!(
            span.style
                .add_modifier
                .contains(ratatui::style::Modifier::REVERSED),
            "selected edge is inverse"
        );
        assert!(
            attention.to_string().starts_with("! planner"),
            "{attention}"
        );
        let done = lines
            .iter()
            .find(|l| l.to_string().contains("───v2 ✓───"))
            .unwrap();
        let span = done
            .spans
            .iter()
            .find(|s| s.content.contains("planner"))
            .unwrap();
        assert_eq!(span.style.fg, Some(Color::Green));
    }

    #[test]
    fn graph_groups_nodes_under_their_heading_when_narrow() {
        let g = fixture("live-1").graph;
        let rows = plain(&graph_lines(&g, 40, 14, 0, None));
        assert_eq!(rows[0], "HUMAN / PLANNER");
        assert_eq!(rows[1], "  · human");
        assert_eq!(rows[2], "  ✓ planner");
        assert_eq!(rows[3], "AGENTS");
        assert_eq!(rows[4], "  ✓ t-backend-auth (backend) a2");
        assert_eq!(rows[6], "VERIFIER");
        assert_eq!(rows[7], "  · verifier");
        assert_eq!(rows[9], "✓ human ───v1 ✓─── ▶ t-backend-auth");
    }

    #[test]
    fn graph_renders_inside_the_layout_and_scrolls_to_the_selected_edge() {
        let mut app = replay_app("live-7");
        app.handle_key(Key::TAB); // graph region
        for _ in 0..9 {
            app.handle_key(Key::char('j'));
        }
        assert_eq!(
            app.selected,
            Some(GraphObjectRef::edge("reply:t-backend-auth"))
        );
        let rows = draw_rows(&mut app, 100, 30);
        let text = screen_text(&rows);
        assert!(text.contains("▶ HANDOFFS"), "{text}");
        assert!(
            text.contains("↩ 1"),
            "the selected edge is scrolled into view:\n{text}"
        );
    }
}
