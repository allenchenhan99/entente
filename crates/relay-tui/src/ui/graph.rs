//! The agent network: nodes as discs on a ratatui `Canvas`, edges as lines between their rims, drawn in
//! two layers of agents and the verifier under them — the brains you prompted, the subs they called —
//! so the whole network fits the narrow left column.
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
use crate::ui::network::{name_nodes, Naming};
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
    /// False when no process is running for this node: drawn as a broken rim, not a solid one.
    pub live: bool,
    /// True when the work is over and nothing needs you: drawn grey so live work stands out.
    pub finished: bool,
    /// World units this node owns horizontally.
    pub slot: f64,
    /// Draw this node's label a row lower. Neighbours in a tier are only ~8 columns apart, so
    /// alternating rows is what lets both keep their whole name.
    pub stagger: bool,
}

/// Is this node worth drawing?
///
/// relayd is the verifier — no agent ever fills that role — so the node only means something once a
/// task has produced something to check. Until then its status is `pending` and it is a lifeless dot
/// taking space a 40-column panel does not have.
pub fn is_visible(node: &GraphNode, planner_present: bool) -> bool {
    match node.kind {
        // The network is the agents and what runs between them. The human is not one of them — you are
        // the one reading it — and neither is the verifier: relayd runs the checks itself, so it is
        // machinery, not a party to a handoff. Whether a task passed is on the task's own node.
        GraphNodeKind::Human | GraphNodeKind::Verifier => false,
        // The object model always carries a planner node; whether anyone is doing that job is a
        // different question, and its pane is what answers it.
        GraphNodeKind::Planner => planner_present,
        GraphNodeKind::Agent => true,
    }
}

/// Is this agent's work over, with nothing left for anyone to do?
///
/// Finished work recedes so live work draws the eye. `failed` is not finished — it is an outcome you
/// have to see — and neither is anything waiting on you, whatever its task state says.
pub fn is_finished(node: &GraphNode) -> bool {
    if matches!(
        node.status,
        VisualStatus::Attention | VisualStatus::Blocked | VisualStatus::Failed
    ) {
        return false;
    }
    matches!(
        node.task_state,
        Some(TaskState::Completed) | Some(TaskState::Canceled)
    )
}

/// Is a coding shell actually running for this agent?
///
/// Only agents have one. `human`, `planner` and the verifier are roles, not processes — relayd is the
/// verifier — so they are never drawn as "not running".
///
/// The pane is the truth when there is one — an agent exists as a contract long before anything is
/// spawned for it, and its pane can die while the task stays open. The event-derived runtime state is
/// the fallback for panes this client has not been told about.
pub fn runtime_is_live(node: &GraphNode, pane_alive: Option<bool>) -> bool {
    if node.kind != GraphNodeKind::Agent {
        return true;
    }
    if let Some(alive) = pane_alive {
        return alive;
    }
    matches!(
        node.runtime,
        Some(RuntimeState::Idle) | Some(RuntimeState::Working) | Some(RuntimeState::Blocked)
    )
}

/// Agents relayd is hosting that no contract accounts for.
///
/// The object model builds agents from task contracts, so an agent launched by hand — you opened a
/// terminal and started one — is nowhere in it. It belongs on the network all the same: it is running,
/// it is an agent, and the fact that nothing binds it to anyone is the thing worth seeing. It is drawn
/// standing alone, with no edges, because RelayGraph draws relationships it has evidence for.
///
/// A plain shell is not an agent and does not appear; the pane's runtime is what tells them apart.
pub fn unattached_agents<'a>(
    graph: &Graph,
    panes: impl Iterator<Item = &'a PaneInfo>,
) -> Vec<GraphNode> {
    panes
        .filter(|pane| pane.runtime.is_some())
        .filter(|pane| {
            !graph.nodes.iter().any(|node| {
                node.kind == GraphNodeKind::Agent
                    && (Some(node.id.as_str()) == pane.task_id.as_deref()
                        || node.label == pane.role)
            })
        })
        .map(|pane| GraphNode {
            id: pane.pane_id.clone(),
            kind: GraphNodeKind::Agent,
            label: pane.role.clone(),
            task_id: None,
            runtime: Some(if pane.alive {
                RuntimeState::Working
            } else {
                RuntimeState::Exited
            }),
            task_state: None,
            handoff_state: None,
            column: 1, // the agents tier
            status: if pane.alive {
                VisualStatus::Working
            } else {
                VisualStatus::Done
            },
            // Why it stands alone, said plainly rather than left to be inferred from missing edges.
            badge: Some("no contract".to_string()),
        })
        .collect()
}

/// World units a tier gives each of its nodes — the widest a label may be before it runs into the
/// neighbour's.
pub fn slot_width(count: usize) -> f64 {
    WORLD / (count.max(1) as f64 + 1.0)
}

/// Where each node sits. Nodes of a tier are spread evenly across the world's width, in protocol order.
pub fn layout_net(graph: &Graph, unattached: &[GraphNode], planner_present: bool) -> Vec<Disc> {
    // Two layers of agents and the verifier under them: who you prompted, who they called, and what
    // checks the result. The protocol's `column` is not used for agents — an agent's layer is who gave
    // it its contract, not which column the object model happens to put it in.
    let naming = name_nodes(graph, unattached, planner_present);
    let mut tiers: [Vec<(&GraphNode, Option<&Naming>)>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for node in graph
        .nodes
        .iter()
        .chain(unattached.iter())
        .filter(|n| is_visible(n, planner_present))
    {
        let named = naming.get(&node.id);
        // The protocol's fourth column (`done`) has no object behind it yet; fold it into the verifier
        // tier rather than leaving a dead band in a panel this narrow.
        let tier = named
            .map(|n| n.tier)
            .unwrap_or((node.column as usize).min(2));
        tiers[tier.min(2)].push((node, named));
    }
    // A layer nobody is using leaves no gap: with no delegation the verifier moves up under the
    // brains rather than floating below an empty band, which a 40-column panel cannot spare.
    let occupied: Vec<usize> = (0..3).filter(|t| !tiers[*t].is_empty()).collect();
    let row_of = |tier: usize| occupied.iter().position(|t| *t == tier).unwrap_or(tier);

    let mut discs = Vec::new();
    for (tier, nodes) in tiers.iter().enumerate() {
        let count = nodes.len();
        for (index, (node, named)) in nodes.iter().enumerate() {
            let step = WORLD / (count as f64 + 1.0);
            discs.push(Disc {
                id: node.id.clone(),
                // `brain 1` / `sub 1.2`; the role stays on the detail line, which has room for it.
                label: named
                    .map(|n| n.label.clone())
                    .unwrap_or_else(|| node.label.clone()),
                x: step * (index as f64 + 1.0),
                y: TIER_Y[row_of(tier)],
                radius: if node.kind == GraphNodeKind::Agent {
                    R_AGENT
                } else {
                    R_ROLE
                },
                status: node.status,
                is_agent: node.kind == GraphNodeKind::Agent,
                badge: node.badge.clone(),
                // From the events; `render` refines it with the pane, which is the better witness.
                live: runtime_is_live(node, None),
                finished: is_finished(node),
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

/// A broken rim, for a node with no process behind it. Drawn as points rather than a line so it reads
/// as "not running" without depending on colour.
fn dashed_rim(cx: f64, cy: f64, radius: f64) -> Vec<(f64, f64)> {
    (0..48)
        .filter(|i| (i / 3) % 2 == 0)
        .map(|i| {
            let angle = i as f64 / 48.0 * std::f64::consts::TAU;
            (cx + radius * angle.cos(), cy + radius * angle.sin())
        })
        .collect()
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
        // A brain has no incoming edge to carry its contract — nobody called it, you did — so the
        // version and its state come here instead of being lost with the human node.
        if let Some(edge) = app
            .graph
            .edges
            .iter()
            .find(|e| e.kind == GraphEdgeKind::Contract && e.to == node.id)
        {
            spans.push(Span::styled(" · ", Style::new().fg(Color::DarkGray)));
            spans.push(Span::styled(
                edge.label.clone(),
                Style::new().fg(status_color(edge.status)),
            ));
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
    let unattached = app.unattached_agents();
    let mut discs = layout_net(&graph, &unattached, app.planner_present());
    // The pane is the better witness than the event-derived runtime state: an agent's contract exists
    // long before a coding shell is spawned for it, and the shell can die while the task stays open.
    for disc in &mut discs {
        if let Some(node) = graph
            .nodes
            .iter()
            .chain(unattached.iter())
            .find(|n| n.id == disc.id)
        {
            let pane_alive = app
                .pane_states
                .values()
                .find(|p| {
                    p.info.task_id.as_deref() == Some(disc.id.as_str()) || p.info.pane_id == disc.id
                })
                .map(|p| p.alive());
            disc.live = runtime_is_live(node, pane_alive);
        }
    }
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
                // An edge between finished nodes is finished business as well.
                let quiet = [&edge.from, &edge.to]
                    .iter()
                    .all(|id| discs.iter().any(|d| d.id == **id && d.finished));
                let color = if quiet {
                    Color::DarkGray
                } else {
                    status_color(edge.status)
                };
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
                let color = if d.finished {
                    Color::DarkGray
                } else {
                    status_color(d.status)
                };
                if d.live {
                    ctx.draw(&Circle {
                        x: d.x,
                        y: d.y,
                        radius: d.radius,
                        color,
                    });
                } else {
                    // No process behind this node: a broken rim, whatever its task state says.
                    let rim = dashed_rim(d.x, d.y, d.radius);
                    ctx.draw(&Points {
                        coords: &rim,
                        color,
                    });
                }
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
                let color = if d.finished {
                    Color::DarkGray
                } else {
                    status_color(d.status)
                };
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

    /// The fixture with a verifier that has something to do, so it is drawn.
    fn graph_with_verifier(name: &str) -> Graph {
        let mut graph = fixture(name).graph;
        for node in graph.nodes.iter_mut() {
            if node.kind == GraphNodeKind::Verifier {
                node.status = VisualStatus::Working;
            }
        }
        graph
    }

    /// live-1's tasks were both proposed by the human, so they are two brains; give one a caller so
    /// the network has a brain, a sub and an edge between them.
    fn graph_with_a_sub(name: &str) -> Graph {
        let mut graph = graph_with_verifier(name);
        for edge in graph.edges.iter_mut() {
            if edge.kind == GraphEdgeKind::Contract && edge.to == "t-frontend-login" {
                edge.from = "t-backend-auth".to_string();
            }
        }
        graph
    }

    #[test]
    fn brains_sit_above_the_subs_they_called() {
        let discs = layout_net(&graph_with_a_sub("live-1"), &[], true);
        let brain = discs.iter().find(|d| d.id == "t-backend-auth").unwrap();
        let sub = discs.iter().find(|d| d.id == "t-frontend-login").unwrap();

        assert!(
            !discs.iter().any(|d| d.id == "human" || d.id == "verifier"),
            "neither the human nor the verifier is an agent on the network"
        );
        assert!(
            brain.y > sub.y,
            "the agent you prompted is drawn above the one it called"
        );
        assert!(sub.is_agent && brain.is_agent, "both layers are agents");
    }

    #[test]
    fn a_tier_spreads_its_nodes_evenly_and_never_stacks_them() {
        let discs = layout_net(&fixture("live-1").graph, &[], true);
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
        let before = layout_net(&graph, &[], true);
        let after = layout_net(&graph, &[], true);
        assert_eq!(before, after, "layout is fixed, never force-directed");
    }

    #[test]
    fn edges_start_and_end_on_the_rims_not_the_centres() {
        let graph = graph_with_a_sub("live-1");
        let discs = layout_net(&graph, &[], true);
        let edge = graph
            .edges
            .iter()
            .find(|e| disc(&discs, &e.from).is_some() && disc(&discs, &e.to).is_some())
            .expect("an edge between two drawn nodes");
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
        let discs = layout_net(&graph, &[], true);
        let target = discs.iter().find(|d| d.id == "t-backend-auth").unwrap();

        let hit = hit_test(&graph, &discs, (target.x, target.y)).unwrap();
        assert_eq!(hit, GraphObjectRef::node("t-backend-auth"));
    }

    #[test]
    fn clicking_between_two_discs_finds_the_edge_that_runs_there() {
        let graph = graph_with_a_sub("live-1");
        let discs = layout_net(&graph, &[], true);
        let edge = graph
            .edges
            .iter()
            .find(|e| {
                e.kind == GraphEdgeKind::Contract
                    && disc(&discs, &e.from).is_some()
                    && disc(&discs, &e.to).is_some()
            })
            .expect("a contract edge between two drawn nodes");
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
        let discs = layout_net(&graph, &[], true);
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
    fn the_verifier_is_never_on_the_network() {
        // relayd runs the checks itself, so the verifier is machinery rather than a party to a
        // handoff; whether a task passed is on the task's own node.
        let mut graph = fixture("live-1").graph;
        for node in graph.nodes.iter_mut() {
            if node.kind == GraphNodeKind::Verifier {
                node.status = VisualStatus::Working;
            }
        }

        assert!(!layout_net(&graph, &[], true)
            .iter()
            .any(|d| d.id == "verifier"));
    }

    #[test]
    fn an_edge_into_a_hidden_node_is_not_drawn_either() {
        let mut graph = fixture("live-1").graph;
        for node in graph.nodes.iter_mut() {
            if node.kind == GraphNodeKind::Verifier {
                node.status = VisualStatus::Pending;
            }
        }
        let discs = layout_net(&graph, &[], true);
        for edge in graph.edges.iter().filter(|e| e.to == "verifier") {
            assert!(edge_ends(&discs, edge).is_none());
        }
    }

    fn node_in(state: TaskState, status: VisualStatus) -> GraphNode {
        let mut node = fixture("live-1")
            .graph
            .nodes
            .into_iter()
            .find(|n| n.kind == GraphNodeKind::Agent)
            .unwrap();
        node.task_state = Some(state);
        node.status = status;
        node
    }

    #[test]
    fn finished_work_recedes_and_unfinished_work_does_not() {
        assert!(is_finished(&node_in(
            TaskState::Completed,
            VisualStatus::Verified
        )));
        assert!(is_finished(&node_in(
            TaskState::Canceled,
            VisualStatus::Done
        )));

        assert!(
            !is_finished(&node_in(TaskState::Executing, VisualStatus::Working)),
            "still working"
        );
        assert!(
            !is_finished(&node_in(TaskState::Completed, VisualStatus::Attention)),
            "completed, but something still needs you"
        );
        assert!(
            !is_finished(&node_in(TaskState::Repairing, VisualStatus::Blocked)),
            "blocked on you"
        );
    }

    #[test]
    fn a_failed_task_is_never_dimmed_away() {
        assert!(
            !is_finished(&node_in(TaskState::Failed, VisualStatus::Failed)),
            "failing is an outcome you have to see, not finished business"
        );
    }

    /// The style of the cells a label is drawn in, found by its text in the rendered buffer.
    fn label_style(app: &mut App, label: &str) -> Option<ratatui::style::Style> {
        let mut term = terminal(100, 30);
        term.draw(|frame| crate::ui::draw(frame, app)).unwrap();
        let buffer = term.backend().buffer().clone();
        for y in 0..buffer.area.height {
            let row: String = (0..buffer.area.width)
                .map(|x| buffer.cell((x, y)).map(|c| c.symbol()).unwrap_or(" "))
                .collect();
            if let Some(at) = row.find(label) {
                return buffer.cell((at as u16, y)).map(|c| c.style());
            }
        }
        None
    }

    #[test]
    fn a_finished_agent_is_drawn_grey_and_a_working_one_is_not() {
        let mut app = replay_app("live-1");
        let mut graph = graph_with_a_sub("live-1");
        for node in graph.nodes.iter_mut() {
            if node.id == "t-backend-auth" {
                node.task_state = Some(TaskState::Completed);
                node.status = VisualStatus::Verified;
            }
            if node.id == "t-frontend-login" {
                node.task_state = Some(TaskState::Executing);
                node.status = VisualStatus::Working;
            }
        }
        app.set_graph(graph);
        // Selection is drawn in the accent colour and beats dimming, as it should; check a node that
        // is not the selected one.
        app.select(Some(GraphObjectRef::node("t-frontend-login")));

        let finished = label_style(&mut app, "brain 1").expect("the finished agent is drawn");
        let working = label_style(&mut app, "sub 1.1").expect("the working agent is drawn");

        assert_eq!(finished.fg, Some(Color::DarkGray), "finished work recedes");
        assert_ne!(working.fg, Some(Color::DarkGray), "live work does not");
    }

    #[test]
    fn selecting_a_finished_agent_still_shows_it_clearly() {
        let mut app = replay_app("live-1");
        let mut graph = graph_with_a_sub("live-1");
        for node in graph.nodes.iter_mut() {
            if node.id == "t-backend-auth" {
                node.task_state = Some(TaskState::Completed);
                node.status = VisualStatus::Verified;
            }
        }
        app.set_graph(graph);
        app.select(Some(GraphObjectRef::node("t-backend-auth")));

        let style = label_style(&mut app, "brain 1").expect("drawn");

        assert_eq!(
            style.fg,
            Some(Color::Cyan),
            "what you picked is never greyed out from under you"
        );
    }

    #[test]
    fn a_finished_node_keeps_its_label_so_it_can_still_be_identified() {
        let mut graph = graph_with_a_sub("live-1");
        for node in graph.nodes.iter_mut() {
            if node.kind == GraphNodeKind::Agent {
                node.task_state = Some(TaskState::Completed);
                node.status = VisualStatus::Verified;
            }
        }
        let discs = layout_net(&graph, &[], true);

        assert!(discs.iter().filter(|d| d.is_agent).all(|d| d.finished));
        assert!(
            discs.iter().any(|d| d.label.starts_with("brain")),
            "grey, but still nameable: a disc you can select must say what it is"
        );
    }

    #[test]
    fn a_role_is_never_drawn_as_a_dead_process() {
        for id in ["human", "planner", "verifier"] {
            let node = fixture("live-8")
                .graph
                .nodes
                .into_iter()
                .find(|n| n.id == id)
                .unwrap();
            assert!(
                runtime_is_live(&node, None),
                "{id} is a role, not a process — relayd is the verifier"
            );
        }
    }

    #[test]
    fn a_node_with_no_process_is_not_live() {
        let mut node = fixture("live-1")
            .graph
            .nodes
            .into_iter()
            .find(|n| n.kind == GraphNodeKind::Agent)
            .unwrap();

        node.runtime = Some(RuntimeState::Unspawned);
        assert!(
            !runtime_is_live(&node, None),
            "no coding shell has been launched"
        );
        node.runtime = Some(RuntimeState::Exited);
        assert!(!runtime_is_live(&node, None), "its shell is gone");
        node.runtime = Some(RuntimeState::Working);
        assert!(runtime_is_live(&node, None));
        node.runtime = Some(RuntimeState::Blocked);
        assert!(
            runtime_is_live(&node, None),
            "blocked is a running process waiting"
        );
    }

    #[test]
    fn a_pane_outranks_the_event_derived_runtime_state() {
        let mut node = fixture("live-1")
            .graph
            .nodes
            .into_iter()
            .find(|n| n.kind == GraphNodeKind::Agent)
            .unwrap();
        node.runtime = Some(RuntimeState::Working);

        assert!(
            !runtime_is_live(&node, Some(false)),
            "the events say working, but its pane is dead: believe the pane"
        );
        node.runtime = Some(RuntimeState::Unspawned);
        assert!(runtime_is_live(&node, Some(true)));
    }

    #[test]
    fn a_broken_rim_is_drawn_in_pieces_and_a_live_one_is_not() {
        let rim = dashed_rim(50.0, 50.0, 9.0);

        assert!(!rim.is_empty());
        assert!(rim.len() < 48, "gaps, or it would be a solid circle");
        for (x, y) in &rim {
            let r = ((x - 50.0f64).powi(2) + (y - 50.0f64).powi(2)).sqrt();
            assert!((r - 9.0).abs() < 0.001, "every point sits on the rim");
        }
    }

    #[test]
    fn the_panel_draws_the_network_and_its_labels() {
        let mut app = replay_app("live-1");
        app.set_graph(graph_with_verifier("live-1"));
        app.select(Some(GraphObjectRef::node("t-backend-auth")));
        let rows = draw_rows(&mut app, 100, 30);
        let text = screen_text(&rows);

        assert!(text.contains("HANDOFFS"), "{text}");
        assert!(
            text.contains("backend"),
            "the agent's label is drawn:\n{text}"
        );
        assert!(
            !text.contains("verifier"),
            "only agents are on the network:\n{text}"
        );
        assert!(text.contains("run "), "the detail line is drawn:\n{text}");
    }

    #[test]
    fn a_mission_with_nothing_verified_yet_draws_no_verifier() {
        // live-1 was abandoned mid-flight: one task cancelled, nothing checked, so relayd has
        // verified nothing and the node would be a lifeless dot.
        let mut app = replay_app("live-1");
        let text = screen_text(&draw_rows(&mut app, 100, 30));

        assert!(text.contains("HANDOFFS"), "{text}");
        assert!(!text.contains("verifier"), "{text}");
    }
}
