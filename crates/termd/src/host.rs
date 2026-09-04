//! The pane host: one `Pane` per spawn, ids `relay:<n>`, casts under `<cast-dir>/<pane>.cast`, prompt delivery
//! driven by the screen model, host-level metrics. Port of `apps/relayd/src/pty/host.ts` (`RelayHost`).

use crate::keys::{keys_to_bytes, UnknownKey};
use crate::metrics::{ms_between, HostMetrics, HostMetricsPane, HOST_KIND};
use crate::pane::{now_iso, Pane, PaneInfo, PaneOptions, PaneSpawnError, KILL_GRACE_MS};
use crate::readiness::QUIET_MS;
use crate::screen::{ScreenQuery, ScreenSource};
use regex::Regex;
use serde::Serialize;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct PromptTimings {
    /// No output for this long = quiet (also the readiness window).
    pub quiet_ms: f64,
    /// Press Enter again if the composer still holds the paste this long after the last Enter.
    pub retry_ms: u64,
    /// Give up (pane left open) after this long from spawn.
    pub timeout_ms: u64,
}

impl Default for PromptTimings {
    fn default() -> Self {
        Self {
            quiet_ms: QUIET_MS,
            retry_ms: 5000,
            timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub cast_dir: PathBuf,
    /// First pane number to hand out.
    pub first_pane: u64,
    pub timings: PromptTimings,
}

#[derive(Debug, Clone, Default)]
pub struct SpawnRequest {
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub prompt: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug)]
pub enum SpawnError {
    EmptyArgv,
    Spawn(String),
    /// The pane is open; the prompt was not accepted.
    Prompt {
        pane_id: String,
        message: String,
    },
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyArgv => write!(f, "relay host: argv must not be empty"),
            Self::Spawn(e) => write!(f, "spawn failed: {e}"),
            Self::Prompt { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SpawnError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneNotFound(pub String);

impl fmt::Display for PaneNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pane {} not found", self.0)
    }
}

impl std::error::Error for PaneNotFound {}

#[derive(Debug, Clone)]
pub struct WaitOutputOptions {
    pub matches: Option<String>,
    pub regex: Option<Regex>,
    pub timeout_ms: u64,
    pub source: ScreenSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum WaitOutputResult {
    Matched { line: String, at: String },
    Timeout,
    Exited { code: i32 },
}

/// Rows of scrollback a `recent` wait-output scan looks at (the `ReadScreenQuery.lines` default).
const WAIT_RECENT_LINES: usize = 200;
const POLL_MS: u64 = 25;
/// Codex shows a paste placeholder while the text is still in its composer.
static PASTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[Pasted Content").unwrap());
static COMPOSER_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[❯›>] ").unwrap());

pub struct Host {
    cfg: HostConfig,
    started: Instant,
    panes: Mutex<Vec<Arc<Pane>>>,
    next: Mutex<u64>,
    focused: Mutex<Option<String>>,
    prompt_failures: AtomicU64,
}

impl Host {
    pub fn new(cfg: HostConfig) -> Self {
        Self {
            next: Mutex::new(cfg.first_pane),
            cfg,
            started: Instant::now(),
            panes: Mutex::new(Vec::new()),
            focused: Mutex::new(None),
            prompt_failures: AtomicU64::new(0),
        }
    }

    pub fn timings(&self) -> PromptTimings {
        self.cfg.timings
    }

    pub fn get(&self, pane_id: &str) -> Option<Arc<Pane>> {
        self.panes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|p| p.id == pane_id)
            .cloned()
    }

    pub fn require(&self, pane_id: &str) -> Result<Arc<Pane>, PaneNotFound> {
        self.get(pane_id)
            .ok_or_else(|| PaneNotFound(pane_id.to_string()))
    }

    pub fn panes(&self) -> Vec<Arc<Pane>> {
        self.panes.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn list(&self) -> Vec<PaneInfo> {
        self.panes().iter().map(|p| p.info()).collect()
    }

    pub fn focused_pane(&self) -> Option<String> {
        self.focused
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn focus(&self, pane_id: &str) -> Result<(), PaneNotFound> {
        self.require(pane_id)?;
        *self.focused.lock().unwrap_or_else(|e| e.into_inner()) = Some(pane_id.to_string());
        Ok(())
    }

    /// Env = process env + request env + `TERM`, `COLORTERM`, `RELAY_PANE_ID`.
    fn child_env(pane_id: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        let mut set = |k: &str, v: &str| {
            if let Some(slot) = env.iter_mut().find(|(key, _)| key == k) {
                slot.1 = v.to_string();
            } else {
                env.push((k.to_string(), v.to_string()));
            }
        };
        for (k, v) in extra {
            set(k, v);
        }
        set("TERM", "xterm-256color");
        set("COLORTERM", "truecolor");
        set("RELAY_PANE_ID", pane_id);
        env
    }

    /// Spawns a pane; when `prompt` is set, resolves only once the prompt was delivered (or failed).
    pub async fn spawn(&self, req: SpawnRequest) -> Result<String, SpawnError> {
        let spawn_requested = Instant::now();
        if req.argv.is_empty() {
            return Err(SpawnError::EmptyArgv);
        }
        let pane = {
            // Hold the counter while spawning so a failed spawn does not consume a number.
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let pane_id = format!("relay:{}", *next);
            let pane = Pane::spawn(PaneOptions {
                pane_id: pane_id.clone(),
                role: req.name.clone(),
                task_id: req.task_id.clone(),
                argv: req.argv.clone(),
                cwd: req.cwd.clone(),
                env: Self::child_env(&pane_id, &req.env),
                cast_path: self.cfg.cast_dir.join(format!("{pane_id}.cast")),
                cols: req.cols,
                rows: req.rows,
                quiet_ms: self.cfg.timings.quiet_ms,
                spawn_requested,
            })
            .map_err(|e| match e {
                PaneSpawnError::EmptyArgv => SpawnError::EmptyArgv,
                other => SpawnError::Spawn(other.to_string()),
            })?;
            *next += 1;
            self.panes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(pane.clone());
            pane
        };
        if let Some(prompt) = req.prompt.as_deref() {
            if let Err(why) = self.deliver_prompt(&pane, prompt).await {
                self.prompt_failures.fetch_add(1, Ordering::SeqCst);
                return Err(SpawnError::Prompt {
                    pane_id: pane.id.clone(),
                    message: format!(
                        "agent prompt failed: {why}; pane {} left open for diagnosis",
                        pane.id
                    ),
                });
            }
        }
        Ok(pane.id.clone())
    }

    /// SIGTERM, SIGKILL after `grace`; resolves once the process is gone.
    pub async fn kill(&self, pane_id: &str, grace: Duration) -> Result<(), PaneNotFound> {
        self.require(pane_id)?.kill(grace).await;
        Ok(())
    }

    pub async fn kill_all(&self, grace: Duration) {
        let panes = self.panes();
        futures_util::future::join_all(panes.iter().map(|p| p.kill(grace))).await;
    }

    pub fn default_grace() -> Duration {
        Duration::from_millis(KILL_GRACE_MS)
    }

    /// `text` typed as-is (bracketed paste when enabled), then `keys`; an unknown key writes nothing.
    pub fn input(
        &self,
        pane: &Pane,
        text: Option<&str>,
        keys: &[String],
    ) -> Result<(), UnknownKey> {
        let key_bytes = keys_to_bytes(keys)?;
        if let Some(text) = text.filter(|t| !t.is_empty()) {
            pane.paste(text);
        }
        if !key_bytes.is_empty() {
            pane.write(&key_bytes);
        }
        Ok(())
    }

    pub async fn wait_output(&self, pane: Arc<Pane>, opts: WaitOutputOptions) -> WaitOutputResult {
        let matches = |line: &str| {
            opts.matches.as_deref().is_some_and(|m| line.contains(m))
                || opts.regex.as_ref().is_some_and(|r| r.is_match(line))
        };
        let scan = || {
            let snap = pane.snapshot(ScreenQuery {
                source: opts.source,
                lines: WAIT_RECENT_LINES,
            });
            snap.lines
                .into_iter()
                .find(|l| matches(l))
                .map(|line| WaitOutputResult::Matched {
                    line,
                    at: now_iso(),
                })
        };
        if let Some(hit) = scan() {
            return hit;
        }
        let sub = pane.subscribe();
        if let Some(code) = sub.exit_code {
            return WaitOutputResult::Exited { code };
        }
        let mut output = sub.output;
        let mut exit = sub.exit;
        let deadline = tokio::time::sleep(Duration::from_millis(opts.timeout_ms));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return WaitOutputResult::Timeout,
                received = output.recv() => match received {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(hit) = scan() {
                            return hit;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return scan().unwrap_or(WaitOutputResult::Exited { code: pane.exit_code().unwrap_or(1) });
                    }
                },
                changed = exit.wait_for(|v| v.is_some()) => {
                    let code = changed.map(|v| v.unwrap_or(1)).unwrap_or_else(|_| pane.exit_code().unwrap_or(1));
                    return scan().unwrap_or(WaitOutputResult::Exited { code });
                }
            }
        }
    }

    // ---------- prompt delivery (host.ts `deliverPrompt`, step by step) ----------

    async fn deliver_prompt(&self, pane: &Arc<Pane>, prompt: &str) -> Result<(), String> {
        let PromptTimings {
            quiet_ms,
            retry_ms,
            timeout_ms,
        } = self.cfg.timings;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let poll = Duration::from_millis(POLL_MS);
        let exited_why = || {
            let code = pane
                .exit_code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "undefined".into());
            format!("process exited with code {code} before taking the prompt")
        };
        let last_line_json =
            || serde_json::to_string(&pane.last_line().unwrap_or_default()).unwrap_or_default();

        tokio::select! {
            _ = pane.wait_first_output() => {},
            _ = pane.wait_exit() => {},
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {},
        }
        // Ready = quiet for `quiet_ms` and the screen shows a prompt / composer line.
        loop {
            if !pane.alive() {
                return Err(exited_why());
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "no prompt on screen within {timeout_ms} ms (last line: {})",
                    last_line_json()
                ));
            }
            if pane.quiet_for() >= quiet_ms && pane.readiness().ready {
                break;
            }
            tokio::time::sleep(poll).await;
        }
        let before = pane.last_line();
        pane.paste(prompt);
        pane.write(b"\r");
        pane.with_marks(|m| {
            m.prompt_written = Some(Instant::now());
            m.prompt_retries = Some(0);
        });
        let mut last_enter_at = Instant::now();
        let mut retries: u32 = 0;
        let prefix: String = prompt.chars().take(24).collect();
        // The prompt is still sitting in the agent's composer when the screen shows a paste placeholder
        // (Codex: `› [Pasted Content 2981 chars]`) or a composer line that still starts with our text.
        let still_in_composer = || {
            pane.visible_lines().iter().any(|l| {
                let trimmed = l.trim();
                PASTED.is_match(l)
                    || ((COMPOSER_LINE.is_match(trimmed) || trimmed == "›") && l.contains(&prefix))
            })
        };
        // Accepted = the agent is visibly busy, or the screen moved on and the composer is clear.
        let accepted = || {
            let r = pane.readiness();
            if !r.ready && r.detail.as_deref().is_some_and(|d| d.starts_with("busy")) {
                return true;
            }
            !still_in_composer() && pane.last_line() != before
        };
        while !accepted() {
            if !pane.alive() {
                return Err(exited_why());
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "prompt not accepted within {timeout_ms} ms (last line: {})",
                    last_line_json()
                ));
            }
            if still_in_composer()
                && retries < 3
                && last_enter_at.elapsed() >= Duration::from_millis(retry_ms)
            {
                pane.write(b"\r");
                last_enter_at = Instant::now();
                retries += 1;
                pane.with_marks(|m| m.prompt_retries = Some(retries));
            }
            tokio::time::sleep(poll).await;
        }
        pane.with_marks(|m| {
            m.prompt_accepted = Some(Instant::now());
            m.prompt_retries = Some(retries);
        });
        Ok(())
    }

    // ---------- metrics ----------

    pub fn metrics(&self) -> HostMetrics {
        let panes = self.panes();
        HostMetrics {
            host: HOST_KIND,
            uptime_ms: ms_between(self.started, Instant::now()),
            panes_spawned: panes.len() as u64,
            panes_alive: panes.iter().filter(|p| p.alive()).count() as u64,
            prompt_failures: self.prompt_failures.load(Ordering::SeqCst),
            panes: panes
                .iter()
                .map(|p| HostMetricsPane {
                    pane_id: p.id.clone(),
                    role: p.role.clone(),
                    task_id: p.task_id.clone(),
                    timings: p.timings(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_overlays_request_env_and_forces_the_relay_vars() {
        std::env::set_var("TERMD_TEST_KEEP", "keep");
        let env = Host::child_env(
            "relay:3",
            &[
                ("EXTRA".into(), "yes".into()),
                ("TERM".into(), "dumb".into()),
            ],
        );
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("TERMD_TEST_KEEP"), Some("keep"));
        assert_eq!(get("EXTRA"), Some("yes"));
        assert_eq!(get("TERM"), Some("xterm-256color"));
        assert_eq!(get("COLORTERM"), Some("truecolor"));
        assert_eq!(get("RELAY_PANE_ID"), Some("relay:3"));
        assert_eq!(env.iter().filter(|(k, _)| k == "TERM").count(), 1);
    }

    #[test]
    fn wait_output_result_serialises_as_a_discriminated_union() {
        let m = WaitOutputResult::Matched {
            line: "got tada".into(),
            at: "t".into(),
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::json!({ "status": "matched", "line": "got tada", "at": "t" })
        );
        assert_eq!(
            serde_json::to_value(WaitOutputResult::Timeout).unwrap(),
            serde_json::json!({ "status": "timeout" })
        );
        assert_eq!(
            serde_json::to_value(WaitOutputResult::Exited { code: 4 }).unwrap(),
            serde_json::json!({ "status": "exited", "code": 4 })
        );
    }
}
