//! Screen-tier readiness (PRD §23, `PaneReadiness.source = 'screen'`): can the pane accept a prompt right now?
//! A byte-for-byte port of `apps/relayd/src/pty/readiness.ts`: same regexes, same tail/chrome logic, same
//! `detail` strings, so relayd's tests keep meaning the same thing against termd.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// No output for this long counts as "quiet".
pub const QUIET_MS: f64 = 400.0;
/// How many trailing non-empty lines are examined for a prompt.
pub const TAIL_LINES: usize = 8;

/// Idle shell prompts and bare composers: `$ `, `❯ `, `> `, `› ` …
static IDLE_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[❯>›$%#]\s*$").unwrap());
/// Claude Code (`> `) and Codex (`› `) composers with placeholder text.
static COMPOSER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(> |› )").unwrap());
/// A question waiting for the human.
static QUESTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\?\s*$").unwrap());
/// The agent is visibly working.
static BUSY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(esc to interrupt|Working|Thinking|Running)").unwrap());
/// Chrome that sits *below* the prompt in agent TUIs and must not be mistaken for the last meaningful line:
/// Claude Code's permission/status bar, Codex's model/cwd footer, box-drawing rules.
static CHROME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(bypass permissions|shift\+tab|^\s*⏵|^\s*gpt-\d|· ~/|/rc\s*$|^[\s─━╭╰│╮╯┃]+$)")
        .unwrap()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadinessSource {
    Declared,
    Hook,
    Screen,
    Unknown,
}

/// `PaneReadiness` as `packages/protocol/src/pty.ts` serialises it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PaneReadiness {
    pub pane_id: String,
    pub ready: bool,
    pub source: ReadinessSource,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub struct ReadinessInput<'a> {
    pub pane_id: &'a str,
    /// Visible rows, top to bottom.
    pub lines: &'a [String],
    /// Epoch ms (or any ms clock shared with `now`) of the last output byte; `None` = no output yet.
    pub last_output_at: Option<f64>,
    pub now: f64,
    pub quiet_ms: Option<f64>,
    pub exited: bool,
    /// ISO clock for `observed_at`; defaults to `now` interpreted as epoch ms.
    pub observed_at: Option<String>,
}

pub fn last_non_empty_line(lines: &[String]) -> Option<&str> {
    lines
        .iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(String::as_str)
}

/// JavaScript's `String.prototype.slice(0, n)` on a trimmed line (by chars, which is what matters for the prompts we see).
fn head(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_epoch_ms(ms: f64) -> String {
    use chrono::{SecondsFormat, TimeZone, Utc};
    let millis = ms.floor() as i64;
    match Utc.timestamp_millis_opt(millis) {
        chrono::LocalResult::Single(dt) => dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        _ => String::from("1970-01-01T00:00:00.000Z"),
    }
}

pub fn evaluate_readiness(input: ReadinessInput<'_>) -> PaneReadiness {
    let observed_at = input
        .observed_at
        .unwrap_or_else(|| iso_from_epoch_ms(input.now));
    let quiet_ms = input.quiet_ms.unwrap_or(QUIET_MS);
    let make = |ready: bool, source: ReadinessSource, detail: String| PaneReadiness {
        pane_id: input.pane_id.to_string(),
        ready,
        source,
        observed_at: observed_at.clone(),
        detail: Some(detail),
    };
    if input.exited {
        return make(false, ReadinessSource::Unknown, "pane exited".into());
    }
    let since_output = match input.last_output_at {
        None => f64::INFINITY,
        Some(at) => input.now - at,
    };
    if since_output < quiet_ms {
        return make(
            false,
            ReadinessSource::Screen,
            format!("output flowing ({} ms ago)", since_output.round() as i64),
        );
    }
    let non_empty: Vec<&String> = input
        .lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let tail: Vec<&String> = non_empty[non_empty.len().saturating_sub(TAIL_LINES)..].to_vec();
    if tail.is_empty() {
        return make(false, ReadinessSource::Screen, "screen is empty".into());
    }
    let meaningful: Vec<&String> = tail.into_iter().filter(|l| !CHROME.is_match(l)).collect();
    if let Some(busy) = meaningful.iter().find(|l| BUSY.is_match(l)) {
        return make(
            false,
            ReadinessSource::Screen,
            format!("busy: {}", head(busy, 80)),
        );
    }
    // Prefer the lowest prompt-like line: the composer sits above the footer chrome.
    for line in meaningful.iter().rev() {
        if IDLE_PROMPT.is_match(line) || COMPOSER.is_match(line) || QUESTION.is_match(line) {
            return make(
                true,
                ReadinessSource::Screen,
                format!("prompt: {}", head(line, 80)),
            );
        }
    }
    let last = last_non_empty_line(input.lines).unwrap_or("");
    make(
        false,
        ReadinessSource::Screen,
        format!("no prompt: {}", head(last, 80)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 10_000.0;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn eval(lines_: &[String], last_output_at: Option<f64>, exited: bool) -> PaneReadiness {
        evaluate_readiness(ReadinessInput {
            pane_id: "relay:1",
            lines: lines_,
            last_output_at,
            now: NOW,
            quiet_ms: Some(QUIET_MS),
            exited,
            observed_at: None,
        })
    }

    #[test]
    fn ready_when_the_last_non_empty_line_is_an_idle_shell_prompt() {
        for prompt in ["$ ", "$", "% ", "# ", "❯ ", "> ", "› "] {
            let r = eval(&lines(&["a", "b", prompt, ""]), Some(NOW - 1000.0), false);
            assert!(r.ready, "{prompt:?}");
            assert_eq!(r.source, ReadinessSource::Screen);
            assert_eq!(
                r.detail.as_deref(),
                Some(format!("prompt: {}", prompt.trim()).as_str())
            );
        }
    }

    #[test]
    fn ready_on_claude_codex_composer_lines_and_on_a_trailing_question() {
        assert!(
            eval(
                &lines(&["> Try \"fix the bug\"", ""]),
                Some(NOW - 1000.0),
                false
            )
            .ready
        );
        assert!(eval(&lines(&["› Ask Codex", ""]), Some(NOW - 1000.0), false).ready);
        assert!(
            eval(
                &lines(&["Do you want to proceed?", ""]),
                Some(NOW - 1000.0),
                false
            )
            .ready
        );
    }

    #[test]
    fn not_ready_while_output_is_still_flowing() {
        let r = eval(&lines(&["$ "]), Some(NOW - 100.0), false);
        assert!(!r.ready);
        assert_eq!(r.detail.as_deref(), Some("output flowing (100 ms ago)"));
        assert_eq!(r.source, ReadinessSource::Screen);
    }

    #[test]
    fn not_ready_while_the_last_line_says_the_agent_is_working() {
        for line in [
            "esc to interrupt",
            "Working…",
            "Thinking (3s)",
            "Running tests",
        ] {
            let r = eval(&lines(&[line]), Some(NOW - 1000.0), false);
            assert!(!r.ready, "{line}");
            assert_eq!(r.detail.as_deref(), Some(format!("busy: {line}").as_str()));
        }
    }

    #[test]
    fn not_ready_on_an_ordinary_line_and_unknown_after_exit() {
        let r = eval(&lines(&["compiling"]), Some(NOW - 1000.0), false);
        assert!(!r.ready);
        assert_eq!(r.detail.as_deref(), Some("no prompt: compiling"));
        let gone = eval(&lines(&["$ "]), Some(NOW - 1000.0), true);
        assert!(!gone.ready);
        assert_eq!(gone.source, ReadinessSource::Unknown);
        assert_eq!(gone.detail.as_deref(), Some("pane exited"));
        let empty = eval(&lines(&[]), Some(NOW - 1000.0), false);
        assert!(!empty.ready);
        assert_eq!(empty.detail.as_deref(), Some("screen is empty"));
    }

    #[test]
    fn no_output_yet_counts_as_quiet() {
        let r = eval(&lines(&["$ "]), None, false);
        assert!(r.ready);
    }

    #[test]
    fn observed_at_defaults_to_now_as_iso() {
        let r = eval(&lines(&["$ "]), Some(NOW - 1000.0), false);
        assert_eq!(r.observed_at, "1970-01-01T00:00:10.000Z");
        assert_eq!(r.pane_id, "relay:1");
    }

    #[test]
    fn serialises_like_the_zod_schema() {
        let r = eval(&lines(&["$ "]), Some(NOW - 1000.0), false);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "pane_id": "relay:1", "ready": true, "source": "screen",
                "observed_at": "1970-01-01T00:00:10.000Z", "detail": "prompt: $"
            })
        );
    }

    // ---- real agent screens ----

    fn real(pane_id: &str, lines_: &[String]) -> PaneReadiness {
        evaluate_readiness(ReadinessInput {
            pane_id,
            lines: lines_,
            last_output_at: Some(NOW - QUIET_MS - 1.0),
            now: NOW,
            quiet_ms: None,
            exited: false,
            observed_at: None,
        })
    }

    #[test]
    fn claude_code_idle_the_composer_sits_above_the_permissions_status_bar() {
        let screen = lines(&[
            " ▐▛███▛█   Claude Code v2.1.260",
            "▝▜██████▀  Fable 5.1 with high effort · Claude Max",
            "  ▝▝ ▝▝    ~/entente-demo/app/.relay/wt/t-backend-auth",
            "⚠ 1 MCP server needs authentication · run /mcp",
            "────────────────────────────────────────────────────────────",
            "❯",
            "────────────────────────────────────────────────────────────",
            "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents                                   /rc",
        ]);
        let r = real("relay:1", &screen);
        assert!(r.ready);
        assert!(r.detail.as_deref().unwrap().contains('❯'));
    }

    #[test]
    fn codex_idle_the_composer_sits_above_the_model_cwd_footer() {
        let screen = lines(&[
            "│ >_ OpenAI Codex (v0.153.2)                               │",
            "╰──────────────────────────────────────────────────────────╯",
            "• You have 2 usage limit resets available. Run /usage to use one.",
            "› Ask Codex to do anything",
            "  gpt-5.6-sol default · ~/entente-demo/app/.relay/wt/t-frontend-login",
        ]);
        assert!(real("relay:2", &screen).ready);
    }

    #[test]
    fn claude_code_working_the_busy_line_wins_even_when_a_composer_is_drawn() {
        let screen = lines(&[
            "⏺ Calling relay, running 1 shell command…",
            "✶ Discombobulating… (2m 14s · ↓ 11.3k tokens)",
            "     interrupting Claude's current work — esc to interrupt",
            "❯",
            "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ]);
        let r = real("relay:1", &screen);
        assert!(!r.ready);
        assert!(r.detail.as_deref().unwrap().starts_with("busy:"));
    }

    #[test]
    fn only_the_last_eight_non_empty_lines_are_examined() {
        // A prompt nine non-empty lines up is out of the tail; only the trailing eight count.
        let mut screen = lines(&["$ "]);
        for i in 0..8 {
            screen.push(format!("line {i}"));
        }
        let r = real("relay:1", &screen);
        assert!(!r.ready);
        assert_eq!(r.detail.as_deref(), Some("no prompt: line 7"));
        // Eight lines: the prompt is inside the tail and a busy line further down still wins.
        let mut screen = lines(&["$ "]);
        for i in 0..7 {
            screen.push(format!("line {i}"));
        }
        assert!(real("relay:1", &screen).ready);
        screen.push("Running tests".into());
        assert!(!real("relay:1", &screen).ready);
    }

    #[test]
    fn chrome_footer_lines_are_ignored_and_detail_is_capped_at_80_chars() {
        let footer = lines(&[
            "compiling",
            "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ]);
        let r = real("relay:1", &footer);
        assert!(!r.ready);
        // `no prompt:` reports the last non-empty *visible* line (chrome included), as the TS host does.
        assert_eq!(
            r.detail.as_deref(),
            Some("no prompt: ⏵⏵ bypass permissions on (shift+tab to cycle)")
        );
        let long = format!("{}?", "x".repeat(100));
        let r = real("relay:1", &lines(&[long.as_str()]));
        assert!(r.ready);
        assert_eq!(r.detail.as_deref().unwrap().len(), "prompt: ".len() + 80);
    }
}
