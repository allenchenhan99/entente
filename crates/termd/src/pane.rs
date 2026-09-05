//! One relay pane: a PTY process (`portable-pty`), a `vt100` screen of the same size, a raw byte ring (the
//! scrollback new WebSocket clients replay) and an asciinema recorder. Every output chunk goes to all of them and
//! to every subscriber (WebSocket clients, wait-output pollers, the prompt deliverer) through a broadcast channel.
//! Port of `apps/relayd/src/pty/pane.ts`.

use crate::metrics::{ms_between, PaneMarks, PaneTimings};
use crate::readiness::{evaluate_readiness, last_non_empty_line, PaneReadiness, ReadinessInput};
use crate::recorder::CastRecorder;
use crate::ring::{ByteRing, RING_CAPACITY};
use crate::screen::{Screen, ScreenQuery, ScreenSnapshot, ScreenSource};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};

pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 40;
/// SIGTERM → SIGKILL grace.
pub const KILL_GRACE_MS: u64 = 3000;
/// Output chunks buffered per subscriber before a slow client starts losing frames.
const OUTPUT_CHANNEL_CAPACITY: usize = 4096;
/// After the process exits, how long the exit is held back for the reader to drain the last bytes, so `exit`
/// never overtakes the last `output` and the final line is scannable.
const EXIT_DRAIN_MS: u64 = 250;
const READ_CHUNK: usize = 8192;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Runtime {
    ClaudeCode,
    Codex,
}

/// `claude` / `claude-code` → claude-code, `codex` → codex, anything else → None.
pub fn runtime_of(argv: &[String]) -> Option<Runtime> {
    let base = argv
        .first()
        .and_then(|a| Path::new(a).file_name())
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    match base.as_str() {
        "claude" | "claude-code" => Some(Runtime::ClaudeCode),
        "codex" => Some(Runtime::Codex),
        _ => None,
    }
}

/// `PaneInfo` as `packages/protocol/src/pty.ts` serialises it (`timings` always present).
#[derive(Serialize, Clone, Debug)]
pub struct PaneInfo {
    pub pane_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Runtime>,
    pub cwd: String,
    pub pid: u32,
    pub alive: bool,
    pub cols: u16,
    pub rows: u16,
    pub cast_path: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub timings: PaneTimings,
}

pub struct PaneOptions {
    pub pane_id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
    /// The complete environment of the child (the host merges process env, request env and the RELAY vars).
    pub env: Vec<(String, String)>,
    pub cast_path: PathBuf,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub quiet_ms: f64,
    /// When the spawn request arrived (origin of `PaneTimings.spawn_ms`).
    pub spawn_requested: Instant,
}

#[derive(Debug)]
pub enum PaneSpawnError {
    EmptyArgv,
    Cast(std::io::Error),
    Pty(String),
}

impl fmt::Display for PaneSpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyArgv => write!(f, "relay host: argv must not be empty"),
            Self::Cast(e) => write!(f, "cast file: {e}"),
            Self::Pty(e) => write!(f, "pty: {e}"),
        }
    }
}

impl std::error::Error for PaneSpawnError {}

/// ISO-8601 with milliseconds, like `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

struct State {
    screen: Screen,
    ring: ByteRing,
    recorder: CastRecorder,
    cols: u16,
    rows: u16,
    last_output_at: Option<Instant>,
    exit: Option<(i32, String)>,
    marks: PaneMarks,
    output_tx: broadcast::Sender<Arc<Vec<u8>>>,
}

/// What a new WebSocket client (or wait-output poller) starts from: taken atomically with the subscription so
/// the replayed scrollback and the live stream neither overlap nor leave a gap.
pub struct Subscription {
    pub info: PaneInfo,
    pub scrollback: Vec<u8>,
    /// `Some` when the pane had already exited at subscription time.
    pub exit_code: Option<i32>,
    pub output: broadcast::Receiver<Arc<Vec<u8>>>,
    pub exit: watch::Receiver<Option<i32>>,
}

pub struct Pane {
    pub id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub runtime: Option<Runtime>,
    pub cwd: String,
    pub cast_path: PathBuf,
    pub started_at: String,
    pub pid: u32,
    quiet_ms: f64,
    origin: Instant,
    state: Mutex<State>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    exit_tx: watch::Sender<Option<i32>>,
    first_output_tx: watch::Sender<bool>,
}

impl fmt::Debug for Pane {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pane")
            .field("id", &self.id)
            .field("pid", &self.pid)
            .field("alive", &self.alive())
            .finish()
    }
}

type Done = Arc<(Mutex<bool>, Condvar)>;

impl Pane {
    /// Starts the process and the reader / writer / exit threads.
    pub fn spawn(opts: PaneOptions) -> Result<Arc<Pane>, PaneSpawnError> {
        let (file, args) = opts.argv.split_first().ok_or(PaneSpawnError::EmptyArgv)?;
        if file.is_empty() {
            return Err(PaneSpawnError::EmptyArgv);
        }
        let cols = opts.cols.unwrap_or(DEFAULT_COLS);
        let rows = opts.rows.unwrap_or(DEFAULT_ROWS);
        let started_at = now_iso();
        let recorder = CastRecorder::new(&opts.cast_path, cols, rows, &opts.role)
            .map_err(PaneSpawnError::Cast)?;
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PaneSpawnError::Pty(e.to_string()))?;
        let mut cmd = CommandBuilder::new(file);
        cmd.args(args);
        cmd.env_clear();
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        cmd.cwd(&opts.cwd);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PaneSpawnError::Pty(e.to_string()))?;
        let process_started = Instant::now();
        // Close our copy of the slave so the master sees EOF once the child (and its children) let go of it.
        drop(pair.slave);
        let pid = child.process_id().unwrap_or(0);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PaneSpawnError::Pty(e.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| PaneSpawnError::Pty(e.to_string()))?;

        let (output_tx, _) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, _) = watch::channel(None);
        let (first_output_tx, _) = watch::channel(false);
        let mut marks = PaneMarks::new(opts.spawn_requested);
        marks.process_started = Some(process_started);
        let pane = Arc::new(Pane {
            id: opts.pane_id,
            role: opts.role,
            task_id: opts.task_id,
            runtime: runtime_of(&opts.argv),
            cwd: opts.cwd,
            cast_path: opts.cast_path,
            started_at,
            pid,
            quiet_ms: opts.quiet_ms,
            origin: opts.spawn_requested,
            state: Mutex::new(State {
                screen: Screen::new(cols, rows),
                ring: ByteRing::new(RING_CAPACITY),
                recorder,
                cols,
                rows,
                last_output_at: None,
                exit: None,
                marks,
                output_tx,
            }),
            master: Mutex::new(pair.master),
            writer_tx,
            exit_tx,
            first_output_tx,
        });

        std::thread::Builder::new()
            .name(format!("{}-writer", pane.id))
            .spawn(move || {
                for bytes in writer_rx {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
            })
            .map_err(PaneSpawnError::Cast)?;

        let reader_done: Done = Arc::new((Mutex::new(false), Condvar::new()));
        let done = reader_done.clone();
        let reader_pane = pane.clone();
        std::thread::Builder::new()
            .name(format!("{}-reader", pane.id))
            .spawn(move || {
                let mut buf = [0u8; READ_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => reader_pane.handle_output(&buf[..n]),
                    }
                }
                let (flag, cv) = &*done;
                *flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
                cv.notify_all();
            })
            .map_err(PaneSpawnError::Cast)?;

        let exit_pane = pane.clone();
        std::thread::Builder::new()
            .name(format!("{}-exit", pane.id))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => 1,
                };
                // Give the reader a moment to apply the final chunk; a grandchild may hold the pty open forever.
                let (flag, cv) = &*reader_done;
                let guard = flag.lock().unwrap_or_else(|e| e.into_inner());
                let _ =
                    cv.wait_timeout_while(guard, Duration::from_millis(EXIT_DRAIN_MS), |done| {
                        !*done
                    });
                exit_pane.publish_exit(code);
            })
            .map_err(PaneSpawnError::Cast)?;

        Ok(pane)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn handle_output(&self, chunk: &[u8]) {
        let received = Instant::now();
        let mut st = self.lock();
        st.screen.process(chunk);
        let render_ms = received.elapsed().as_secs_f64() * 1000.0;
        st.ring.push(chunk);
        let _ = st.recorder.output(chunk);
        st.marks.record_chunk(chunk.len(), render_ms);
        if st.marks.first_output.is_none() {
            st.marks.first_output = Some(received);
        }
        st.last_output_at = Some(received);
        let _ = st.output_tx.send(Arc::new(chunk.to_vec()));
        drop(st);
        self.first_output_tx.send_replace(true);
    }

    fn publish_exit(&self, code: i32) {
        let mut st = self.lock();
        if st.exit.is_some() {
            return;
        }
        st.exit = Some((code, now_iso()));
        st.recorder.close();
        drop(st);
        self.exit_tx.send_replace(Some(code));
    }

    pub fn alive(&self) -> bool {
        self.lock().exit.is_none()
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.lock().exit.as_ref().map(|(c, _)| *c)
    }

    fn info_locked(&self, st: &State) -> PaneInfo {
        PaneInfo {
            pane_id: self.id.clone(),
            task_id: self.task_id.clone(),
            role: self.role.clone(),
            runtime: self.runtime,
            cwd: self.cwd.clone(),
            pid: self.pid,
            alive: st.exit.is_none(),
            cols: st.cols,
            rows: st.rows,
            cast_path: self.cast_path.to_string_lossy().into_owned(),
            started_at: self.started_at.clone(),
            exited_at: st.exit.as_ref().map(|(_, at)| at.clone()),
            exit_code: st.exit.as_ref().map(|(c, _)| *c),
            timings: st.marks.timings(),
        }
    }

    pub fn info(&self) -> PaneInfo {
        let st = self.lock();
        self.info_locked(&st)
    }

    pub fn timings(&self) -> PaneTimings {
        self.lock().marks.timings()
    }

    /// Read or update the timing marks (prompt delivery records its steps here).
    pub fn with_marks<R>(&self, f: impl FnOnce(&mut PaneMarks) -> R) -> R {
        f(&mut self.lock().marks)
    }

    /// Raw bytes retained for late clients (≤ 256 KiB).
    pub fn scrollback(&self) -> Vec<u8> {
        self.lock().ring.bytes()
    }

    pub fn snapshot(&self, query: ScreenQuery) -> ScreenSnapshot {
        self.lock().screen.snapshot(&self.id, query)
    }

    /// The visible rows, top to bottom (trailing whitespace trimmed).
    pub fn visible_lines(&self) -> Vec<String> {
        self.lock().screen.visible_lines()
    }

    /// The last non-empty visible line (what prompt delivery watches).
    pub fn last_line(&self) -> Option<String> {
        let lines = self.visible_lines();
        last_non_empty_line(&lines).map(str::to_string)
    }

    pub fn readiness(&self) -> PaneReadiness {
        let now = Instant::now();
        let mut st = self.lock();
        let lines = st.screen.visible_lines();
        let readiness = evaluate_readiness(ReadinessInput {
            pane_id: &self.id,
            lines: &lines,
            last_output_at: st.last_output_at.map(|t| ms_between(self.origin, t)),
            now: ms_between(self.origin, now),
            quiet_ms: Some(self.quiet_ms),
            exited: st.exit.is_some(),
            observed_at: Some(now_iso()),
        });
        if readiness.ready && st.marks.ready.is_none() {
            st.marks.ready = Some(now);
        }
        readiness
    }

    pub fn bracketed_paste(&self) -> bool {
        self.lock().screen.bracketed_paste()
    }

    pub fn alternate_screen(&self) -> bool {
        self.lock().screen.alternate_screen()
    }

    /// ms since the last output byte (infinity before the first).
    /// Output chunks seen so far (the prompt deliverer uses it to detect a repaint racing its verdict).
    pub fn output_chunks(&self) -> u64 {
        self.with_marks(|m| m.output_chunks)
    }

    pub fn quiet_for(&self) -> f64 {
        match self.lock().last_output_at {
            None => f64::INFINITY,
            Some(t) => t.elapsed().as_secs_f64() * 1000.0,
        }
    }

    pub fn write(&self, bytes: &[u8]) {
        if !self.alive() || bytes.is_empty() {
            return;
        }
        let _ = self.writer_tx.send(bytes.to_vec());
    }

    /// Types `text` the way a paste would: wrapped in bracketed-paste markers when the program asked for them.
    pub fn paste(&self, text: &str) {
        if self.bracketed_paste() {
            self.write(format!("\x1b[200~{text}\x1b[201~").as_bytes());
        } else {
            self.write(text.as_bytes());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let mut st = self.lock();
        st.cols = cols;
        st.rows = rows;
        if st.exit.is_none() {
            let master = self.master.lock().unwrap_or_else(|e| e.into_inner());
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        st.screen.resize(cols, rows);
        let _ = st.recorder.resize(cols, rows);
    }

    pub fn subscribe(&self) -> Subscription {
        let st = self.lock();
        Subscription {
            info: self.info_locked(&st),
            scrollback: st.ring.bytes(),
            exit_code: st.exit.as_ref().map(|(c, _)| *c),
            output: st.output_tx.subscribe(),
            exit: self.exit_tx.subscribe(),
        }
    }

    pub fn exit_watch(&self) -> watch::Receiver<Option<i32>> {
        self.exit_tx.subscribe()
    }

    /// Resolves with the exit code once the process has ended.
    pub async fn wait_exit(&self) -> i32 {
        let mut rx = self.exit_tx.subscribe();
        let code = rx.wait_for(|v| v.is_some()).await.ok().and_then(|v| *v);
        code.or_else(|| self.exit_code()).unwrap_or(1)
    }

    /// Resolves on the first output byte.
    pub async fn wait_first_output(&self) {
        let mut rx = self.first_output_tx.subscribe();
        let _ = rx.wait_for(|v| *v).await;
    }

    /// SIGTERM, then SIGKILL after `grace`; resolves once the process has exited.
    pub async fn kill(&self, grace: Duration) {
        if !self.alive() || self.pid == 0 {
            return;
        }
        // SAFETY: plain signal delivery to the child's pid; no memory is touched.
        unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGTERM) };
        if tokio::time::timeout(grace, self.wait_exit()).await.is_err() && self.alive() {
            // SAFETY: as above.
            unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGKILL) };
            self.wait_exit().await;
        }
    }
}

impl ScreenSource {
    pub const fn default_wait() -> Self {
        ScreenSource::Recent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_from_argv_basename() {
        let argv = |s: &str| vec![s.to_string()];
        assert_eq!(
            runtime_of(&argv("/usr/local/bin/claude")),
            Some(Runtime::ClaudeCode)
        );
        assert_eq!(runtime_of(&argv("claude-code")), Some(Runtime::ClaudeCode));
        assert_eq!(runtime_of(&argv("codex")), Some(Runtime::Codex));
        assert_eq!(runtime_of(&argv("sh")), None);
        assert_eq!(runtime_of(&[]), None);
        assert_eq!(
            serde_json::to_value(Runtime::ClaudeCode).unwrap(),
            "claude-code"
        );
    }

    #[test]
    fn empty_argv_is_rejected_before_anything_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let err = Pane::spawn(PaneOptions {
            pane_id: "relay:1".into(),
            role: "x".into(),
            task_id: None,
            argv: vec![],
            cwd: dir.path().to_string_lossy().into_owned(),
            env: vec![],
            cast_path: dir.path().join("p.cast"),
            cols: None,
            rows: None,
            quiet_ms: 400.0,
            spawn_requested: Instant::now(),
        })
        .err()
        .unwrap();
        assert!(matches!(err, PaneSpawnError::EmptyArgv));
        assert!(!dir.path().join("p.cast").exists());
    }
}
