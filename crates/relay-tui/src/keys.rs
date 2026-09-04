//! Key model and key map. `Key` abstracts crossterm so `App` and its tests never touch the terminal; the map
//! mirrors `apps/tui/src/keys.ts` (Tab cycles panels, j/k or arrows move, Enter/i inspect, the action's own key
//! runs it, Esc closes, `?` help) plus the Rust-only keys: `q` quit, `i` in the pane grid = type into the
//! focused terminal, `f` focus pane, and the contract aliases `c` (clarify), `y` / `n` (review pass / fail).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCode {
    Char(char),
    Enter,
    Esc,
    Tab,
    BackTab,
    Backspace,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    F(u8),
    Null,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub code: KeyCode,
    pub ctrl: bool,
    pub alt: bool,
}

impl Key {
    pub const fn new(code: KeyCode) -> Self {
        Self {
            code,
            ctrl: false,
            alt: false,
        }
    }
    pub const fn char(c: char) -> Self {
        Self::new(KeyCode::Char(c))
    }
    pub const fn ctrl(c: char) -> Self {
        Self {
            code: KeyCode::Char(c),
            ctrl: true,
            alt: false,
        }
    }
    pub const ENTER: Key = Key::new(KeyCode::Enter);
    pub const ESC: Key = Key::new(KeyCode::Esc);
    pub const TAB: Key = Key::new(KeyCode::Tab);
    pub const UP: Key = Key::new(KeyCode::Up);
    pub const DOWN: Key = Key::new(KeyCode::Down);
    pub const LEFT: Key = Key::new(KeyCode::Left);
    pub const RIGHT: Key = Key::new(KeyCode::Right);
    pub const BACKSPACE: Key = Key::new(KeyCode::Backspace);

    /// The printable character, when this key is one (no ctrl/alt).
    pub fn plain_char(&self) -> Option<char> {
        match self.code {
            KeyCode::Char(c) if !self.ctrl && !self.alt => Some(c),
            _ => None,
        }
    }

    pub fn is_ctrl_c(&self) -> bool {
        self.ctrl && matches!(self.code, KeyCode::Char('c') | KeyCode::Char('C'))
    }

    /// Bytes a terminal would send for this key (xterm conventions), for `PtyClientMessage::Input`.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.alt {
            out.push(0x1b);
        }
        match self.code {
            KeyCode::Char(c) if self.ctrl => {
                let upper = c.to_ascii_uppercase();
                if upper.is_ascii_uppercase() {
                    out.push(upper as u8 - b'@');
                } else if c == ' ' || c == '@' {
                    out.push(0);
                } else if ('[' ..= '_').contains(&c) {
                    out.push(c as u8 - b'@');
                } else {
                    let mut b = [0u8; 4];
                    out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
                }
            }
            KeyCode::Char(c) => {
                let mut b = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            }
            KeyCode::Enter => out.push(b'\r'),
            KeyCode::Esc => out.push(0x1b),
            KeyCode::Tab => out.push(b'\t'),
            KeyCode::BackTab => out.extend_from_slice(b"\x1b[Z"),
            KeyCode::Backspace => out.push(0x7f),
            KeyCode::Delete => out.extend_from_slice(b"\x1b[3~"),
            KeyCode::Up => out.extend_from_slice(b"\x1b[A"),
            KeyCode::Down => out.extend_from_slice(b"\x1b[B"),
            KeyCode::Right => out.extend_from_slice(b"\x1b[C"),
            KeyCode::Left => out.extend_from_slice(b"\x1b[D"),
            KeyCode::Home => out.extend_from_slice(b"\x1b[H"),
            KeyCode::End => out.extend_from_slice(b"\x1b[F"),
            KeyCode::PageUp => out.extend_from_slice(b"\x1b[5~"),
            KeyCode::PageDown => out.extend_from_slice(b"\x1b[6~"),
            KeyCode::Insert => out.extend_from_slice(b"\x1b[2~"),
            KeyCode::F(n) => match n {
                1 => out.extend_from_slice(b"\x1bOP"),
                2 => out.extend_from_slice(b"\x1bOQ"),
                3 => out.extend_from_slice(b"\x1bOR"),
                4 => out.extend_from_slice(b"\x1bOS"),
                5 => out.extend_from_slice(b"\x1b[15~"),
                6 => out.extend_from_slice(b"\x1b[17~"),
                7 => out.extend_from_slice(b"\x1b[18~"),
                8 => out.extend_from_slice(b"\x1b[19~"),
                9 => out.extend_from_slice(b"\x1b[20~"),
                10 => out.extend_from_slice(b"\x1b[21~"),
                11 => out.extend_from_slice(b"\x1b[23~"),
                12 => out.extend_from_slice(b"\x1b[24~"),
                _ => {}
            },
            KeyCode::Null => {}
        }
        out
    }
}

impl From<crossterm::event::KeyEvent> for Key {
    fn from(event: crossterm::event::KeyEvent) -> Self {
        use crossterm::event::{KeyCode as C, KeyModifiers as M};
        let code = match event.code {
            C::Char(c) => KeyCode::Char(c),
            C::Enter => KeyCode::Enter,
            C::Esc => KeyCode::Esc,
            C::Tab => KeyCode::Tab,
            C::BackTab => KeyCode::BackTab,
            C::Backspace => KeyCode::Backspace,
            C::Delete => KeyCode::Delete,
            C::Up => KeyCode::Up,
            C::Down => KeyCode::Down,
            C::Left => KeyCode::Left,
            C::Right => KeyCode::Right,
            C::Home => KeyCode::Home,
            C::End => KeyCode::End,
            C::PageUp => KeyCode::PageUp,
            C::PageDown => KeyCode::PageDown,
            C::Insert => KeyCode::Insert,
            C::F(n) => KeyCode::F(n),
            _ => KeyCode::Null,
        };
        Key {
            code,
            ctrl: event.modifiers.contains(M::CONTROL),
            alt: event.modifiers.contains(M::ALT),
        }
    }
}

/// One line of the help overlay per binding: (key, meaning). The order is the Ink TUI's help line.
pub const KEY_HELP: &[(&str, &str)] = &[
    ("j/k ↑/↓", "move selection"),
    ("Tab", "cycle panels (tree → graph → panes → inbox)"),
    ("Enter", "inspect the selected object (describe · story · actions)"),
    ("i", "inspect · in the pane grid: type into the focused terminal (Esc leaves)"),
    ("a / c", "answer the selected question (clarify)"),
    ("r", "reply to a blocked agent"),
    ("p / y", "mark the pending human_review criterion passed"),
    ("f / n", "mark it failed (asks for the observed failure); f otherwise focuses the pane"),
    ("x", "cancel the task (asks y/N)"),
    ("Esc", "close the inspector / help / input"),
    ("?", "toggle this help"),
    ("q / Ctrl-C", "quit"),
];

/// The help overlay text.
pub fn help_lines() -> Vec<String> {
    KEY_HELP
        .iter()
        .map(|(key, meaning)| format!("{key:<10} {meaning}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_xterm_sequences() {
        assert_eq!(Key::char('x').encode(), b"x");
        assert_eq!(Key::ENTER.encode(), b"\r");
        assert_eq!(Key::ctrl('c').encode(), vec![3]);
        assert_eq!(Key::ctrl('[').encode(), vec![0x1b]);
        assert_eq!(Key::UP.encode(), b"\x1b[A");
        assert_eq!(Key::BACKSPACE.encode(), vec![0x7f]);
        assert_eq!(Key::char('é').encode(), "é".as_bytes());
        assert_eq!(Key::new(KeyCode::F(5)).encode(), b"\x1b[15~");
        let alt_x = Key {
            code: KeyCode::Char('x'),
            ctrl: false,
            alt: true,
        };
        assert_eq!(alt_x.encode(), b"\x1bx");
    }

    #[test]
    fn converts_crossterm_events() {
        use crossterm::event::{KeyCode as C, KeyEvent, KeyModifiers as M};
        let key: Key = KeyEvent::new(C::Char('c'), M::CONTROL).into();
        assert!(key.is_ctrl_c());
        let key: Key = KeyEvent::new(C::Char('j'), M::NONE).into();
        assert_eq!(key.plain_char(), Some('j'));
        let key: Key = KeyEvent::new(C::Enter, M::NONE).into();
        assert_eq!(key, Key::ENTER);
    }
}
