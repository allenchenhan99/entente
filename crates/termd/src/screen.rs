//! Server-side screen model: a `vt100` parser per pane (rows × cols, 5000 rows of scrollback) and the
//! `ScreenSnapshot` read from it (`ReadScreenQuery`): `visible` = the viewport; `recent` = up to `lines`
//! scrollback rows followed by the viewport. Port of `apps/relayd/src/pty/screen.ts`.

use serde::{Deserialize, Serialize};

/// Rows the parser keeps above the viewport (`recent` reads at most `ReadScreenQuery.lines` ≤ 5000).
pub const SCREEN_SCROLLBACK: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSource {
    Visible,
    Recent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenQuery {
    pub source: ScreenSource,
    pub lines: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreenSnapshot {
    pub pane_id: String,
    pub cols: u16,
    pub rows: u16,
    /// Visible rows, top to bottom, trailing whitespace trimmed.
    pub lines: Vec<String>,
    pub cursor: Cursor,
    /// True while the process uses the alternate screen (full-screen TUIs).
    pub alternate: bool,
    /// Scrollback lines available above the visible rows.
    pub scrollback_lines: usize,
}

pub struct Screen {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
}

impl std::fmt::Debug for Screen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Screen")
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .finish()
    }
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, SCREEN_SCROLLBACK),
            cols,
            rows,
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.parser.screen_mut().set_size(rows, cols);
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }

    fn view_rows(&self) -> Vec<String> {
        self.parser
            .screen()
            .rows(0, self.cols)
            .map(|r| r.trim_end().to_string())
            .collect()
    }

    /// How many rows the active buffer holds above the viewport (0 on the alternate screen).
    pub fn scrollback_lines(&mut self) -> usize {
        let screen = self.parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let total = screen.scrollback();
        screen.set_scrollback(0);
        total
    }

    /// The visible rows, top to bottom (trailing whitespace trimmed).
    pub fn visible_lines(&self) -> Vec<String> {
        self.view_rows()
    }

    pub fn snapshot(&mut self, pane_id: &str, query: ScreenQuery) -> ScreenSnapshot {
        let total = self.scrollback_lines();
        let mut lines = Vec::new();
        if query.source == ScreenSource::Recent {
            // Walk the scrollback from `total - want` down to the viewport, one view (≤ rows) at a time.
            let want = query.lines.min(total);
            let mut remaining = want;
            while remaining > 0 {
                self.parser.screen_mut().set_scrollback(remaining);
                let take = remaining.min(self.rows as usize);
                lines.extend(self.view_rows().into_iter().take(take));
                remaining -= take;
            }
            self.parser.screen_mut().set_scrollback(0);
        }
        lines.extend(self.view_rows());
        let (row, col) = self.parser.screen().cursor_position();
        ScreenSnapshot {
            pane_id: pane_id.to_string(),
            cols: self.cols,
            rows: self.rows,
            lines,
            cursor: Cursor { x: col, y: row },
            alternate: self.alternate_screen(),
            scrollback_lines: total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(screen: &mut Screen, source: ScreenSource, lines: usize) -> ScreenSnapshot {
        screen.snapshot("relay:1", ScreenQuery { source, lines })
    }

    #[test]
    fn visible_snapshot_shows_printed_lines_and_cursor() {
        let mut s = Screen::new(120, 40);
        s.process(b"a\r\nb\r\nc\r\n");
        let snap = snap(&mut s, ScreenSource::Visible, 200);
        assert_eq!(snap.pane_id, "relay:1");
        assert_eq!(&snap.lines[..3], ["a", "b", "c"]);
        assert_eq!(snap.lines.len(), 40);
        assert_eq!((snap.cols, snap.rows), (120, 40));
        assert_eq!(snap.cursor, Cursor { x: 0, y: 3 });
        assert!(!snap.alternate);
        assert_eq!(snap.scrollback_lines, 0);
        assert_eq!(s.visible_lines()[0], "a");
    }

    #[test]
    fn alternate_screen_and_bracketed_paste_modes() {
        let mut s = Screen::new(20, 5);
        s.process(b"main\r\n");
        assert!(!s.bracketed_paste());
        s.process(b"\x1b[?2004h");
        assert!(s.bracketed_paste());
        s.process(b"\x1b[?1049h");
        s.process(b"alt");
        let snap = snap(&mut s, ScreenSource::Visible, 200);
        assert!(snap.alternate);
        assert!(!snap.lines.iter().any(|l| l == "main"));
        assert!(snap.lines.iter().any(|l| l == "alt"));
        assert_eq!(snap.scrollback_lines, 0);
        s.process(b"\x1b[?1049l");
        assert!(!s.alternate_screen());
        assert_eq!(s.visible_lines()[0], "main");
    }

    #[test]
    fn recent_prepends_scrollback_rows() {
        let mut s = Screen::new(120, 10);
        for i in 1..=50 {
            s.process(format!("line{i}\r\n").as_bytes());
        }
        let visible = snap(&mut s, ScreenSource::Visible, 200);
        assert_eq!(visible.lines.len(), 10);
        assert_eq!(visible.lines[0], "line42");
        assert_eq!(visible.scrollback_lines, 41);
        let recent = snap(&mut s, ScreenSource::Recent, 5);
        assert_eq!(recent.lines.len(), 15);
        assert_eq!(recent.lines[0], "line37");
        assert_eq!(recent.lines[4], "line41");
        assert_eq!(recent.lines[5], "line42");
        let all = snap(&mut s, ScreenSource::Recent, 200);
        assert_eq!(all.lines.len(), 51);
        assert_eq!(all.lines[0], "line1");
        assert_eq!(all.lines[40], "line41");
        assert_eq!(all.lines[41], "line42");
        assert_eq!(all.lines[49], "line50");
        assert_eq!(all.lines[50], "");
        // Multi-view walk when the request spans more than one screen height of scrollback.
        let twenty = snap(&mut s, ScreenSource::Recent, 25);
        assert_eq!(twenty.lines.len(), 35);
        let expect: Vec<String> = (17..=50).map(|i| format!("line{i}")).collect();
        assert_eq!(&twenty.lines[..34], expect.as_slice());
        // The walk leaves the viewport in place.
        assert_eq!(s.visible_lines()[0], "line42");
    }

    #[test]
    fn resize_changes_the_grid() {
        let mut s = Screen::new(120, 40);
        s.process(b"hello\r\n");
        s.resize(80, 24);
        let snap = snap(&mut s, ScreenSource::Visible, 1);
        assert_eq!((snap.cols, snap.rows), (80, 24));
        assert_eq!(snap.lines.len(), 24);
        assert_eq!(snap.lines[0], "hello");
        assert_eq!((s.cols(), s.rows()), (80, 24));
    }

    #[test]
    fn scrollback_is_capped_at_5000_rows() {
        let mut s = Screen::new(10, 2);
        for i in 0..6000 {
            s.process(format!("{i}\r\n").as_bytes());
        }
        assert_eq!(s.scrollback_lines(), SCREEN_SCROLLBACK);
    }
}
