//! The agent network: nodes as discs on a ratatui `Canvas`, edges as lines between their rims, drawn in
//! three tiers (you / planner · agents · verifier) so the whole graph fits the narrow left column.
//!
//! Layout is in a fixed world box and never force-directed: a disc must not move under the pointer when
//! relayd spawns or reaps a neighbour. The view (pan and zoom) maps that world onto the panel, correcting
//! for the terminal's 2:1 cell aspect so a circle reads as a circle.
//!
//! Interaction lives in `App` (click, drag, wheel, keys); this module owns the geometry both sides share:
//! `layout_net` places the discs, `view_bounds` maps world to canvas, and `hit_test` turns a cell back into
//! the object under it.

use crate::app::{App, GraphView, Region, Viewport};
use crate::model::*;
use crate::ui::tree::{enum_name, status_color};
use crate::ui::{panel_block, region_active, viewport_of};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::symbols::Marker;
use ratatui::text::{Line, Span};
use ratatui::widgets::canvas::{Canvas, Circle, Line as CanvasLine, Points};
use ratatui::widgets::{Borders, Paragraph};
use ratatui::Frame;

/// The world box every layout is expressed in. Panning and zooming move the view over it, not the nodes.
pub const WORLD: f64 = 100.0;
// Braille gives 2×4 dots per cell, so a small circle degenerates into fragments: these radii are the
// smallest that still draw a closed rim in a 40-column panel.
const R_AGENT: f64 = 9.0;
const R_ROLE: f64 = 7.0;
/// Tier centres, top to bottom, in world units (y grows upward), spaced to leave a row for each label.
const TIER_Y: [f64; 3] = [84.0, 50.0, 16.0];
/// Clearance between a disc's rim and its label, in world units.
const LABEL_GAP: f64 = 5.5;

#[derive(Debug, Clone, PartialEq)]
pub struct Disc {
    pub id: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub status: VisualStatus,
    pub is_agent: bool,
    pub badge: Option<String>,
    /// World units this node owns horizontally.
    pub slot: f64,
    /// Draw this node's label a row lower. Neighbours in a tier are only ~8 columns apart, so
    /// alternating rows is what lets both keep their whole name.
    pub stagger: bool,
}

/// World units a tier gives each of its nodes — the widest a label may be before it runs into the
/// neighbour's.
pub fn slot_width(count: usize) -> f64 {
    WORLD / (count.max(1) as f64 + 1.0)
}

/// Where each node sits. Nodes of a tier are spread evenly across the world's width, in protocol order.
pub fn layout_net(graph: &Graph) -> Vec<Disc> {
    let mut tiers: [Vec<&GraphNode>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for node in &graph.nodes {
        // The protocol's fourth column (`done`) has no object behind it yet; fold it into the verifier tier
        // rather than leaving a dead band in a panel this narrow.
        let tier = (node.column as usize).min(2);
        tiers[tier].push(node);
    }
    let mut discs = Vec::new();
    for (tier, nodes) in tiers.iter().enumerate() {
        let count = nodes.len();
        for (index, node) in nodes.iter().enumerate() {
            let step = WORLD / (count as f64 + 1.0);
            discs.push(Disc {
                id: node.id.clone(),
                label: node.label.clone(),
                x: step * (index as f64 + 1.0),
                y: TIER_Y[tier],
                radius: if node.kind == GraphNodeKind::Agent {
                    R_AGENT
                } else {
                    R_ROLE
                },
                status: node.status,
                is_agent: node.kind == GraphNodeKind::Agent,
                badge: node.badge.clone(),
                slot: slot_width(count),
                stagger: index % 2 == 1,
            });
        }
    }
    discs
}

fn disc<'a>(discs: &'a [Disc], id: &str) -> Option<&'a Disc> {
    discs.iter().find(|d| d.id == id)
}

/// Where an edge starts and ends: the rims of its two discs, never their centres.
pub fn edge_ends(discs: &[Disc], edge: &GraphEdge) -> Option<((f64, f64), (f64, f64))> {
    let (from, to) = (disc(discs, &edge.from)?, disc(discs, &edge.to)?);
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let len = (dx * dx + dy * dy).sqrt().max(0.001);
    let (ux, uy) = (dx / len, dy / len);
    Some((
        (from.x + ux * from.radius, from.y + uy * from.radius),
        (to.x - ux * (to.radius + 1.0), to.y - uy * (to.radius + 1.0)),
    ))
}

/// Canvas bounds for a view over the world, corrected for the terminal's 2:1 cell aspect: a row is about
/// twice as tall as a column is wide, so the vertical span must be twice as large per cell to keep circles round.
pub fn view_bounds(view: &GraphView, viewport: Viewport) -> ([f64; 2], [f64; 2]) {
    let (w, h) = (viewport.width.max(1) as f64, viewport.height.max(1) as f64);
    let fit_x = WORLD.max(WORLD * w / (2.0 * h));
    let span_x = fit_x / view.zoom;
    let span_y = 2.0 * h * span_x / w;
    let (cx, cy) = (WORLD / 2.0 + view.pan_x, WORLD / 2.0 + view.pan_y);
    (
        [cx - span_x / 2.0, cx + span_x / 2.0],
        [cy - span_y / 2.0, cy + span_y / 2.0],
    )
}

/// World coordinates of a terminal cell inside the graph viewport.
pub fn cell_to_world(view: &GraphView, viewport: Viewport, col: u16, row: u16) -> (f64, f64) {
    let (x_bounds, y_bounds) = view_bounds(view, viewport);
    let fx = (col.saturating_sub(viewport.x)) as f64 / viewport.width.max(1) as f64;
    let fy = (row.saturating_sub(viewport.y)) as f64 / viewport.height.max(1) as f64;
    (
        x_bounds[0] + fx * (x_bounds[1] - x_bounds[0]),
        // rows run down the screen, the canvas runs up
        y_bounds[1] - fy * (y_bounds[1] - y_bounds[0]),
    )
}

fn distance_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= f64::EPSILON {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (a.0 + t * dx, a.1 + t * dy);
    ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt()
}

/// The object under a world point: a disc first (they sit above the wiring), then an edge within reach of it.
pub fn hit_test(graph: &Graph, discs: &[Disc], point: (f64, f64)) -> Option<GraphObjectRef> {
    let mut best: Option<(f64, &Disc)> = None;
    for d in discs {
        let distance = ((point.0 - d.x).powi(2) + (point.1 - d.y).powi(2)).sqrt();
        if distance <= d.radius * 1.35 && best.as_ref().is_none_or(|(b, _)| distance < *b) {
            best = Some((distance, d));
        }
    }
    if let Some((_, d)) = best {
        return Some(GraphObjectRef::node(&d.id));
    }
    let mut closest: Option<(f64, &GraphEdge)> = None;
    for edge in &graph.edges {
        let Some((a, b)) = edge_ends(discs, edge) else {
            continue;
        };
        let distance = distance_to_segment(point, a, b);
        if distance <= 2.5 && closest.as_ref().is_none_or(|(c, _)| distance < *c) {
            closest = Some((distance, edge));
        }
    }
    closest.map(|(_, e)| GraphObjectRef::edge(&e.id))
}

fn glyph(status: VisualStatus) -> &'static str {
    match status {
        VisualStatus::Pending => "·",
        VisualStatus::Working => "●",
        VisualStatus::Attention => "!",
        VisualStatus::Blocked => "◐",
        VisualStatus::Done | VisualStatus::Verified => "✓",
        VisualStatus::Failed => "✗",
    }
}

fn selected_is(selected: Option<&GraphObjectRef>, kind: RefKind, id: &str) -> bool {
    selected.is_some_and(|r| r.kind == kind && r.id == id)
}

/// The line under the network: the three independent state layers of the selected agent, spelled out — an
/// idle runtime says nothing about the task. For an edge it is the edge's own label instead.
pub fn detail_line(app: &App) -> Line<'static> {
    let Some(reference) = app.selected.as_ref() else {
        return Line::styled(
            "nothing selected · click a node, or j/k",
            Style::new().fg(Color::DarkGray),
        );
    };
    if reference.kind == RefKind::Edge {
        if let Some(edge) = app.graph.edges.iter().find(|e| e.id == reference.id) {
            let mut spans = vec![
                Span::styled(edge.id.clone(), Style::new().fg(Color::Gray)),
                Span::raw("  "),
                Span::styled(
                    edge.label.clone(),
                    Style::new().fg(status_color(edge.status)),
                ),
            ];
            if edge.attention {
                spans.push(Span::styled(
                    "  needs you",
                    Style::new()
                        .fg(Color::Yellow)
                        .add_modifier(ratatui::style::Modifier::BOLD),
                ));
            }
            return Line::from(spans);
        }
    }
    let Some(node) = app.graph.nodes.iter().find(|n| n.id == reference.id) else {
        return Line::raw("");
    };
    let mut spans = vec![Span::styled(
        node.label.clone(),
        Style::new()
            .fg(status_color(node.status))
            .add_modifier(ratatui::style::Modifier::BOLD),
    )];
    if node.kind == GraphNodeKind::Agent {
        for (name, value) in [
            ("run", enum_name(&node.runtime)),
            ("task", enum_name(&node.task_state)),
            ("handoff", enum_name(&node.handoff_state)),
        ] {
            spans.push(Span::styled(
                format!(" · {name} "),
                Style::new().fg(Color::DarkGray),
            ));
            spans.push(Span::raw(value));
        }
    } else if let Some(badge) = node.badge.clone() {
        spans.push(Span::styled(
            format!(" · {badge}"),
            Style::new().fg(Color::DarkGray),
        ));
    }
    Line::from(spans)
}

/// Draw the network. Records the canvas area on `app` so a click can be turned back into an object.
pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    let active = region_active(app, Region::Graph);
    let block = panel_block(Region::Graph.title(), active, Borders::TOP);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 || inner.width == 0 {
        app.graph_viewport = Viewport::EMPTY;
        return;
    }

    let [canvas_area, detail] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(inner);
    app.graph_viewport = viewport_of(canvas_area);

    let graph = app.graph.clone();
    let discs = layout_net(&graph);
    let selected = app.selected.clone();
    let (x_bounds, y_bounds) = view_bounds(&app.graph_view, app.graph_viewport);
    // World units per printed character and per row, so labels can be centred and staggered.
    let x_span = x_bounds[1] - x_bounds[0];
    let per_char = x_span / canvas_area.width.max(1) as f64;
    let per_row = (y_bounds[1] - y_bounds[0]) / canvas_area.height.max(1) as f64;

    let widget = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds(x_bounds)
        .y_bounds(y_bounds)
        .paint(move |ctx| {
            for edge in &graph.edges {
                let Some((a, b)) = edge_ends(&discs, edge) else {
                    continue;
                };
                let color = status_color(edge.status);
                match edge.kind {
                    // Evidence and replies are dotted, so an edge's kind survives losing its colour.
                    GraphEdgeKind::Evidence | GraphEdgeKind::Reply => {
                        let steps = 24;
                        let coords: Vec<(f64, f64)> = (0..=steps)
                            .filter(|i| i % 2 == 0)
                            .map(|i| {
                                let t = i as f64 / steps as f64;
                                (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
                            })
                            .collect();
                        ctx.draw(&Points {
                            coords: &coords,
                            color,
                        });
                    }
                    _ => ctx.draw(&CanvasLine {
                        x1: a.0,
                        y1: a.1,
                        x2: b.0,
                        y2: b.1,
                        color,
                    }),
                }
            }
            ctx.layer();

            for d in &discs {
                let color = status_color(d.status);
                ctx.draw(&Circle {
                    x: d.x,
                    y: d.y,
                    radius: d.radius,
                    color,
                });
                // Attention doubles the rim, so colour is never the only signal.
                if matches!(d.status, VisualStatus::Attention | VisualStatus::Blocked) {
                    ctx.draw(&Circle {
                        x: d.x,
                        y: d.y,
                        radius: d.radius - 1.2,
                        color,
                    });
                }
                if selected_is(selected.as_ref(), RefKind::Node, &d.id) {
                    ctx.draw(&Circle {
                        x: d.x,
                        y: d.y,
                        radius: d.radius + 2.5,
                        color: Color::Cyan,
                    });
                }
            }
            ctx.layer();

            for edge in &graph.edges {
                if !edge.attention {
                    continue;
                }
                if let Some((a, b)) = edge_ends(&discs, edge) {
                    ctx.print(
                        (a.0 + b.0) / 2.0,
                        (a.1 + b.1) / 2.0,
                        Line::styled(
                            "!",
                            Style::new()
                                .fg(Color::Yellow)
                                .add_modifier(ratatui::style::Modifier::BOLD),
                        ),
                    );
                }
            }
            for d in &discs {
                let color = status_color(d.status);
                ctx.print(
                    d.x - per_char / 2.0,
                    d.y,
                    Line::styled(
                        glyph(d.status).to_string(),
                        Style::new()
                            .fg(color)
                            .add_modifier(ratatui::style::Modifier::BOLD),
                    ),
                );
                // A label may only use its own slot: at 40-odd columns two neighbours would otherwise
                // print over each other (`humplanner`).
                // Only the panel itself is a limit now that neighbours are on different rows.
                let room = ((x_span / per_char) as usize).saturating_sub(2).max(3);
                let label = if d.label.chars().count() > room {
                    d.label
                        .chars()
                        .take(room.saturating_sub(1))
                        .collect::<String>()
                        + "…"
                } else {
                    d.label.clone()
                };
                ctx.print(
                    d.x - label.chars().count() as f64 * per_char / 2.0,
                    d.y - d.radius - LABEL_GAP - if d.stagger { per_row } else { 0.0 },
                    Line::styled(
                        label,
                        if selected_is(selected.as_ref(), RefKind::Node, &d.id) {
                            Style::new()
                                .fg(Color::Cyan)
                                .add_modifier(ratatui::style::Modifier::BOLD)
                        } else {
                            Style::new().fg(color)
                        },
                    ),
                );
            }
        });
    frame.render_widget(widget, canvas_area);
    frame.render_widget(Paragraph::new(detail_line(app)), detail);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;

    fn area(width: u16, height: u16) -> Viewport {
        Viewport {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    #[test]
    fn nodes_sit_in_three_tiers_with_agents_between_the_human_and_the_verifier() {
        let discs = layout_net(&fixture("live-1").graph);
        let human = discs.iter().find(|d| d.id == "human").unwrap();
        let agent = discs.iter().find(|d| d.id == "t-backend-auth").unwrap();
        let verifier = discs.iter().find(|d| d.id == "verifier").unwrap();

        assert!(
            human.y > agent.y,
            "the human tier is drawn above the agents"
        );
        assert!(
            agent.y > verifier.y,
            "the verifier tier is below the agents"
        );
        assert!(agent.radius > verifier.radius, "agents are the big discs");
    }

    #[test]
    fn a_tier_spreads_its_nodes_evenly_and_never_stacks_them() {
        let discs = layout_net(&fixture("live-1").graph);
        let agents: Vec<&Disc> = discs.iter().filter(|d| d.is_agent).collect();
        assert!(agents.len() >= 2, "fixture has two agents");
        for pair in agents.windows(2) {
            assert!(
                (pair[0].x - pair[1].x).abs() > pair[0].radius,
                "agents do not overlap: {:?}",
                agents.iter().map(|d| d.x).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn placement_does_not_move_when_the_view_does() {
        let graph = fixture("live-1").graph;
        let before = layout_net(&graph);
        let after = layout_net(&graph);
        assert_eq!(before, after, "layout is fixed, never force-directed");
    }

    #[test]
    fn edges_start_and_end_on_the_rims_not_the_centres() {
        let graph = fixture("live-1").graph;
        let discs = layout_net(&graph);
        let edge = graph.edges.first().unwrap();
        let (a, b) = edge_ends(&discs, edge).unwrap();
        let from = disc(&discs, &edge.from).unwrap();

        let gap = ((a.0 - from.x).powi(2) + (a.1 - from.y).powi(2)).sqrt();
        assert!(
            (gap - from.radius).abs() < 0.001,
            "the line leaves the rim, {gap} vs {}",
            from.radius
        );
        assert!(a != b);
    }

    #[test]
    fn the_vertical_span_keeps_circles_round_on_2_to_1_cells() {
        let view = GraphView::default();
        let (x, y) = view_bounds(&view, area(60, 20));
        let (span_x, span_y) = (x[1] - x[0], y[1] - y[0]);
        // A disc must cover twice as many columns as rows to look round.
        let columns = 2.0 * R_AGENT / span_x * 60.0;
        let rows = 2.0 * R_AGENT / span_y * 20.0;
        assert!(
            (columns / rows - 2.0).abs() < 0.01,
            "{columns} columns vs {rows} rows"
        );
    }

    #[test]
    fn zooming_in_shows_less_of_the_world() {
        let wide = view_bounds(&GraphView::default(), area(60, 20));
        let close = view_bounds(
            &GraphView {
                zoom: 2.0,
                ..GraphView::default()
            },
            area(60, 20),
        );
        assert!((close.0[1] - close.0[0]) < (wide.0[1] - wide.0[0]));
    }

    #[test]
    fn clicking_a_disc_finds_its_node() {
        let graph = fixture("live-1").graph;
        let discs = layout_net(&graph);
        let target = discs.iter().find(|d| d.id == "t-backend-auth").unwrap();

        let hit = hit_test(&graph, &discs, (target.x, target.y)).unwrap();
        assert_eq!(hit, GraphObjectRef::node("t-backend-auth"));
    }

    #[test]
    fn clicking_between_two_discs_finds_the_edge_that_runs_there() {
        let graph = fixture("live-1").graph;
        let discs = layout_net(&graph);
        let edge = graph
            .edges
            .iter()
            .find(|e| e.kind == GraphEdgeKind::Contract)
            .unwrap();
        let (a, b) = edge_ends(&discs, edge).unwrap();
        let middle = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);

        assert_eq!(
            hit_test(&graph, &discs, middle),
            Some(GraphObjectRef::edge(&edge.id))
        );
    }

    #[test]
    fn clicking_empty_space_selects_nothing() {
        let graph = fixture("live-1").graph;
        let discs = layout_net(&graph);
        assert_eq!(hit_test(&graph, &discs, (-40.0, -40.0)), None);
    }

    #[test]
    fn a_cell_maps_to_the_world_point_under_it() {
        let view = GraphView::default();
        let rect = area(60, 20);
        let (x_bounds, y_bounds) = view_bounds(&view, rect);
        let centre = cell_to_world(&view, rect, 30, 10);

        assert!((centre.0 - (x_bounds[0] + x_bounds[1]) / 2.0).abs() < 1.0);
        assert!((centre.1 - (y_bounds[0] + y_bounds[1]) / 2.0).abs() < 2.0);
        // The top row is the top of the canvas, not the bottom.
        assert!(cell_to_world(&view, rect, 30, 0).1 > centre.1);
    }

    #[test]
    fn the_detail_line_spells_out_the_three_layers_of_the_selected_agent() {
        let mut app = replay_app("live-1");
        app.select(Some(GraphObjectRef::node("t-backend-auth")));
        let text = detail_line(&app).to_string();

        assert!(text.contains("run "), "{text}");
        assert!(text.contains("task "), "{text}");
        assert!(text.contains("handoff "), "{text}");
    }

    #[test]
    fn the_detail_line_describes_a_selected_edge_instead() {
        let mut app = replay_app("live-1");
        let edge = app.graph.edges.first().unwrap().clone();
        app.select(Some(GraphObjectRef::edge(&edge.id)));
        let text = detail_line(&app).to_string();

        assert!(text.contains(&edge.id), "{text}");
        assert!(text.contains(&edge.label), "{text}");
    }

    #[test]
    fn the_panel_draws_the_network_and_its_labels() {
        let mut app = replay_app("live-1");
        app.select(Some(GraphObjectRef::node("t-backend-auth")));
        let rows = draw_rows(&mut app, 100, 30);
        let text = screen_text(&rows);

        assert!(text.contains("HANDOFFS"), "{text}");
        assert!(
            text.contains("backend"),
            "the agent's label is drawn:\n{text}"
        );
        assert!(text.contains("verifier"), "{text}");
        assert!(text.contains("run "), "the detail line is drawn:\n{text}");
    }
}
