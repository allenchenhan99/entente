//! Layout and the top-level `draw()`. Left column (35 %) = tree over graph; right column (65 %) = the pane grid;
//! bottom strip (5 rows) = inbox; last row = status line. Popups: inspector and help. Below 100×30 the layout
//! degrades: the pane grid goes first (narrow), then the inbox strip (short).

pub mod graph;
pub mod inbox;
pub mod inspector;
pub mod panes;
pub mod status;
pub mod tree;

use crate::app::{App, Region};
use crate::keys::help_lines;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

pub const MIN_WIDTH: u16 = 100;
pub const MIN_HEIGHT: u16 = 30;
pub const INBOX_ROWS: u16 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Areas {
    pub tree: Rect,
    pub graph: Rect,
    /// Zero-sized when the terminal is too narrow for the pane grid.
    pub panes: Rect,
    /// Zero-sized when the terminal is too short for the inbox strip.
    pub inbox: Rect,
    pub status: Rect,
}

pub fn layout(area: Rect) -> Areas {
    let show_inbox = area.height >= 20;
    let [main, inbox, status] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(if show_inbox { INBOX_ROWS } else { 0 }),
        Constraint::Length(1),
    ])
    .areas(area);
    let show_panes = area.width >= 80;
    let left_width = if show_panes {
        ((main.width as u32 * 35 / 100) as u16).max(40)
    } else {
        main.width
    };
    let [left, panes] =
        Layout::horizontal([Constraint::Length(left_width), Constraint::Min(0)]).areas(main);
    let [tree, graph] =
        Layout::vertical([Constraint::Percentage(40), Constraint::Min(0)]).areas(left);
    Areas {
        tree,
        graph,
        panes: if show_panes { panes } else { Rect::default() },
        inbox,
        status,
    }
}

/// The Ink panel header: `▶ TITLE` in cyan when the region has focus, gray otherwise.
pub fn panel_block(title: &str, active: bool, borders: Borders) -> Block<'static> {
    let style = if active {
        Style::new().fg(Color::Cyan).bold()
    } else {
        Style::new().fg(Color::DarkGray)
    };
    let marker = if active { "▶ " } else { "  " };
    Block::new()
        .borders(borders)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(Line::styled(format!("{marker}{title} "), style))
}

pub fn popup(area: Rect, percent_x: u16, percent_y: u16) -> Rect {
    let width = (area.width as u32 * percent_x as u32 / 100) as u16;
    let height = (area.height as u32 * percent_y as u32 / 100) as u16;
    let width = width.clamp(area.width.min(20), area.width);
    let height = height.clamp(area.height.min(5), area.height);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width < 40 || area.height < 8 {
        frame.render_widget(
            Paragraph::new(format!(
                "relay-tui needs at least 40×8 (best at {MIN_WIDTH}×{MIN_HEIGHT}); this is {}×{}",
                area.width, area.height
            )),
            area,
        );
        return;
    }
    let areas = layout(area);
    tree::render(frame, areas.tree, app);
    graph::render(frame, areas.graph, app);
    if areas.panes.width > 0 {
        panes::render(frame, areas.panes, app);
    } else {
        app.pane_areas.clear();
    }
    if areas.inbox.height > 0 {
        inbox::render(frame, areas.inbox, app);
    }
    status::render(frame, areas.status, app);

    if app.inspector_open {
        let rect = popup(area, 80, 80);
        frame.render_widget(Clear, rect);
        inspector::render(frame, rect, app);
    }
    if app.help_open {
        let lines = help_lines();
        let height = (lines.len() as u16 + 2).min(area.height);
        let width = (lines.iter().map(|l| l.chars().count()).max().unwrap_or(20) as u16 + 4)
            .min(area.width);
        let rect = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, rect);
        let block = Block::bordered()
            .title(" keys ")
            .border_style(Style::new().fg(Color::Cyan));
        let text: Vec<Line> = lines.into_iter().map(Line::from).collect();
        frame.render_widget(Paragraph::new(text).block(block), rect);
    }
}

pub fn region_active(app: &App, region: Region) -> bool {
    app.region == region && !app.inspector_open
}
