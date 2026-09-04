//! Frame-time instrumentation: how long `draw()` takes, as p50 / p95 over a rolling window, so the TUI's own
//! render latency sits next to the host's `render_p95_ms` in the status line and in `--metrics-json`.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::Duration;

const WINDOW: usize = 512;

#[derive(Debug, Default, Clone)]
pub struct FrameStats {
    samples: VecDeque<f64>,
    frames: u64,
    last_ms: f64,
}

/// Nearest-rank percentile (the same rule termd uses for its render percentiles).
pub fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct FrameSummary {
    pub frames: u64,
    pub draw_p50_ms: f64,
    pub draw_p95_ms: f64,
    pub draw_last_ms: f64,
}

impl FrameStats {
    pub fn record(&mut self, elapsed: Duration) {
        let ms = elapsed.as_secs_f64() * 1000.0;
        self.frames += 1;
        self.last_ms = ms;
        if self.samples.len() == WINDOW {
            self.samples.pop_front();
        }
        self.samples.push_back(ms);
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    fn sorted(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self.samples.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v
    }

    pub fn p50_ms(&self) -> Option<f64> {
        percentile(&self.sorted(), 50.0)
    }

    pub fn p95_ms(&self) -> Option<f64> {
        percentile(&self.sorted(), 95.0)
    }

    pub fn summary(&self) -> FrameSummary {
        FrameSummary {
            frames: self.frames,
            draw_p50_ms: self.p50_ms().unwrap_or(0.0),
            draw_p95_ms: self.p95_ms().unwrap_or(0.0),
            draw_last_ms: self.last_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_percentiles() {
        let v: Vec<f64> = (1..=100).map(|n| n as f64).collect();
        assert_eq!(percentile(&v, 50.0), Some(50.0));
        assert_eq!(percentile(&v, 95.0), Some(95.0));
        assert_eq!(percentile(&[7.0], 95.0), Some(7.0));
        assert_eq!(percentile(&[], 95.0), None);
    }

    #[test]
    fn frame_stats_window_and_summary() {
        let mut s = FrameStats::default();
        for n in 0..600 {
            s.record(Duration::from_micros(n));
        }
        assert_eq!(s.frames(), 600);
        // Only the newest 512 samples count: 88..600 µs.
        let summary = s.summary();
        assert!(summary.draw_p50_ms > 0.3 && summary.draw_p50_ms < 0.36, "{summary:?}");
        assert!(summary.draw_p95_ms > 0.56 && summary.draw_p95_ms <= 0.6, "{summary:?}");
    }
}
