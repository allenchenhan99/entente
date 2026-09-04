//! asciinema v2 recorder for one pane: `<cast-dir>/<pane>.cast`. Header
//! `{"version":2,"width","height","timestamp","title"}`, then `[t,"o",data]` per output chunk and
//! `[t,"r","<cols>x<rows>"]` on resize. Every event is written to the file immediately (no batching), so a crash
//! loses at most what the OS had not yet flushed. Port of `apps/relayd/src/pty/recorder.ts`.

use serde::Serialize;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Monotonic ms clock for event times.
pub type Clock = Box<dyn FnMut() -> f64 + Send>;

#[derive(Serialize)]
struct Header<'a> {
    version: u32,
    width: u16,
    height: u16,
    timestamp: u64,
    title: &'a str,
}

pub struct CastRecorder {
    path: PathBuf,
    file: Option<File>,
    clock: Clock,
    started_at: f64,
    /// Bytes of an incomplete UTF-8 sequence carried into the next chunk.
    carry: Vec<u8>,
}

impl std::fmt::Debug for CastRecorder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CastRecorder")
            .field("path", &self.path)
            .field("closed", &self.file.is_none())
            .finish()
    }
}

fn monotonic_clock() -> Clock {
    let origin = Instant::now();
    Box::new(move || origin.elapsed().as_secs_f64() * 1000.0)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl CastRecorder {
    pub fn new(path: &Path, cols: u16, rows: u16, title: &str) -> io::Result<Self> {
        Self::with_clock(path, cols, rows, title, monotonic_clock(), unix_now())
    }

    /// `clock` supplies event times in ms; `timestamp` is the header's Unix time in seconds.
    pub fn with_clock(
        path: &Path,
        cols: u16,
        rows: u16,
        title: &str,
        mut clock: Clock,
        timestamp: u64,
    ) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = File::create(path)?;
        let started_at = clock();
        let mut rec = Self {
            path: path.to_path_buf(),
            file: Some(file),
            clock,
            started_at,
            carry: Vec::new(),
        };
        let header = Header {
            version: 2,
            width: cols,
            height: rows,
            timestamp,
            title,
        };
        rec.line(&serde_json::to_string(&header).expect("header serialises"))?;
        Ok(rec)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn elapsed(&mut self) -> f64 {
        let now = (self.clock)();
        (now - self.started_at).round() / 1000.0
    }

    fn line(&mut self, text: &str) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            let mut buf = Vec::with_capacity(text.len() + 1);
            buf.extend_from_slice(text.as_bytes());
            buf.push(b'\n');
            file.write_all(&buf)?;
            file.flush()?;
        }
        Ok(())
    }

    /// Records raw PTY bytes as text; a multibyte character split across chunks is joined with the next chunk.
    pub fn output(&mut self, chunk: &[u8]) -> io::Result<()> {
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend_from_slice(chunk);
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(e) => {
                let valid = e.valid_up_to();
                if e.error_len().is_none() && bytes.len() - valid < 4 {
                    self.carry = bytes[valid..].to_vec();
                    bytes.truncate(valid);
                }
                String::from_utf8_lossy(&bytes).into_owned()
            }
        };
        if text.is_empty() {
            return Ok(());
        }
        let t = self.elapsed();
        self.line(&serde_json::to_string(&(t, "o", text)).expect("event serialises"))
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        let t = self.elapsed();
        self.line(
            &serde_json::to_string(&(t, "r", format!("{cols}x{rows}"))).expect("event serialises"),
        )
    }

    pub fn close(&mut self) {
        if !self.carry.is_empty() {
            let rest = std::mem::take(&mut self.carry);
            let text = String::from_utf8_lossy(&rest).into_owned();
            let t = self.elapsed();
            let _ = self.line(&serde_json::to_string(&(t, "o", text)).expect("event serialises"));
        }
        self.file = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    fn read_events(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .trim_end()
            .split('\n')
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn writes_header_o_and_r_events_flushed_on_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("casts").join("relay:1.cast");
        let t = Arc::new(AtomicU64::new(0));
        let clock_t = t.clone();
        let mut rec = CastRecorder::with_clock(
            &file,
            120,
            40,
            "backend",
            Box::new(move || clock_t.load(Ordering::SeqCst) as f64),
            1_700_000_000,
        )
        .unwrap();
        t.store(250, Ordering::SeqCst);
        rec.output(b"hello\r\n").unwrap();
        t.store(500, Ordering::SeqCst);
        rec.resize(80, 24).unwrap();
        t.store(1000, Ordering::SeqCst);
        rec.output(b"bye").unwrap();
        // Flushed per write: readable before close.
        let events = read_events(&file);
        assert_eq!(
            events[0],
            serde_json::json!({ "version": 2, "width": 120, "height": 40, "timestamp": 1_700_000_000, "title": "backend" })
        );
        assert_eq!(events[1], serde_json::json!([0.25, "o", "hello\r\n"]));
        assert_eq!(events[2], serde_json::json!([0.5, "r", "80x24"]));
        assert_eq!(events[3], serde_json::json!([1.0, "o", "bye"]));
        rec.close();
        assert_eq!(read_events(&file).len(), 4);
        assert_eq!(rec.path(), file.as_path());
    }

    #[test]
    fn joins_a_multibyte_character_split_across_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("p.cast");
        let mut rec = CastRecorder::new(&file, 10, 2, "x").unwrap();
        let text = "❯ ".as_bytes();
        rec.output(&text[..1]).unwrap();
        rec.output(&text[1..]).unwrap();
        rec.close();
        let events = read_events(&file);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1][2], "❯ ");
        assert!(events[1][0].as_f64().unwrap() >= 0.0);
    }

    #[test]
    fn invalid_bytes_are_replaced_and_a_trailing_partial_is_flushed_on_close() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("p.cast");
        let mut rec = CastRecorder::new(&file, 10, 2, "x").unwrap();
        rec.output(b"a\xffb").unwrap();
        rec.output(&"é".as_bytes()[..1]).unwrap();
        rec.close();
        let events = read_events(&file);
        assert_eq!(events[1][2], "a\u{fffd}b");
        assert_eq!(events[2][2], "\u{fffd}");
    }
}
