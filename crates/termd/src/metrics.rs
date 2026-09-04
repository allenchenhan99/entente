//! Efficiency instrumentation (`PaneTimings`, `HostMetrics` in `packages/protocol/src/pty.ts`): the marks every
//! terminal host records per pane and the derivations `GET /metrics` serves. Durations use `std::time::Instant`.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::Instant;

/// Rolling window of render-latency samples (per chunk: bytes read from the PTY → `vt100` parser finished).
pub const RENDER_SAMPLES: usize = 512;

/// Fixed-size sample window with nearest-rank percentiles.
#[derive(Debug, Clone)]
pub struct Percentiles {
    samples: VecDeque<f64>,
    capacity: usize,
}

impl Default for Percentiles {
    fn default() -> Self {
        Self::new(RENDER_SAMPLES)
    }
}

impl Percentiles {
    pub fn new(capacity: usize) -> Self {
        Self {
            samples: VecDeque::with_capacity(capacity.min(RENDER_SAMPLES)),
            capacity,
        }
    }

    pub fn push(&mut self, sample: f64) {
        if self.capacity == 0 {
            return;
        }
        if self.samples.len() == self.capacity {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Nearest-rank percentile: the ⌈p/100 · n⌉-th smallest sample (`None` without samples).
    pub fn percentile(&self, p: f64) -> Option<f64> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = sorted.len();
        let rank = ((p / 100.0) * n as f64).ceil() as usize;
        Some(sorted[rank.clamp(1, n) - 1])
    }

    pub fn p50(&self) -> Option<f64> {
        self.percentile(50.0)
    }

    pub fn p95(&self) -> Option<f64> {
        self.percentile(95.0)
    }
}

/// `PaneTimings` as the zod schema serialises it (undefined = key absent).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PaneTimings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_output_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_write_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_accept_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_retries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_p50_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_p95_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_chunks: Option<u64>,
}

pub fn ms_between(from: Instant, to: Instant) -> f64 {
    to.saturating_duration_since(from).as_secs_f64() * 1000.0
}

/// The raw marks a pane records; `timings()` derives `PaneTimings` from them.
#[derive(Debug, Clone)]
pub struct PaneMarks {
    /// The spawn request arrived (the `Instant` origin of every derived duration).
    pub spawn_requested: Instant,
    /// PTY process started.
    pub process_started: Option<Instant>,
    /// First output byte.
    pub first_output: Option<Instant>,
    /// Readiness detector first said "ready" (prompt visible & quiet).
    pub ready: Option<Instant>,
    /// Prompt bytes written (paste + Enter).
    pub prompt_written: Option<Instant>,
    /// Prompt accepted (agent visibly busy / composer clear).
    pub prompt_accepted: Option<Instant>,
    /// Extra Enter presses needed (set once prompt delivery ran).
    pub prompt_retries: Option<u32>,
    pub render: Percentiles,
    pub output_bytes: u64,
    pub output_chunks: u64,
}

impl PaneMarks {
    pub fn new(spawn_requested: Instant) -> Self {
        Self {
            spawn_requested,
            process_started: None,
            first_output: None,
            ready: None,
            prompt_written: None,
            prompt_accepted: None,
            prompt_retries: None,
            render: Percentiles::default(),
            output_bytes: 0,
            output_chunks: 0,
        }
    }

    /// Records one output chunk: its size and how long the screen model took to apply it.
    pub fn record_chunk(&mut self, bytes: usize, render_ms: f64) {
        self.output_bytes += bytes as u64;
        self.output_chunks += 1;
        self.render.push(render_ms);
    }

    pub fn timings(&self) -> PaneTimings {
        let span = |from: Option<Instant>, to: Option<Instant>| match (from, to) {
            (Some(a), Some(b)) => Some(ms_between(a, b)),
            _ => None,
        };
        PaneTimings {
            spawn_ms: span(Some(self.spawn_requested), self.process_started),
            first_output_ms: span(self.process_started, self.first_output),
            readiness_ms: span(self.first_output, self.ready),
            prompt_write_ms: span(self.ready, self.prompt_written),
            prompt_accept_ms: span(self.prompt_written, self.prompt_accepted),
            prompt_retries: self.prompt_retries,
            render_p50_ms: self.render.p50(),
            render_p95_ms: self.render.p95(),
            output_bytes: if self.output_chunks > 0 {
                Some(self.output_bytes)
            } else {
                None
            },
            output_chunks: if self.output_chunks > 0 {
                Some(self.output_chunks)
            } else {
                None
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostMetricsPane {
    pub pane_id: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub timings: PaneTimings,
}

/// `GET /metrics`.
#[derive(Debug, Clone, Serialize)]
pub struct HostMetrics {
    pub host: &'static str,
    pub uptime_ms: f64,
    pub panes_spawned: u64,
    pub panes_alive: u64,
    pub prompt_failures: u64,
    pub panes: Vec<HostMetricsPane>,
}

pub const HOST_KIND: &str = "relayterm";

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn nearest_rank_percentiles() {
        let mut p = Percentiles::new(512);
        assert_eq!(p.p50(), None);
        for v in [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0] {
            p.push(v);
        }
        assert_eq!(p.p50(), Some(50.0));
        assert_eq!(p.p95(), Some(100.0));
        assert_eq!(p.percentile(100.0), Some(100.0));
        assert_eq!(p.percentile(0.0), Some(10.0));
        let mut one = Percentiles::new(4);
        one.push(7.0);
        assert_eq!(one.p50(), Some(7.0));
        assert_eq!(one.p95(), Some(7.0));
    }

    #[test]
    fn the_window_keeps_the_newest_512_samples() {
        let mut p = Percentiles::default();
        for v in 0..1000 {
            p.push(v as f64);
        }
        assert_eq!(p.len(), 512);
        assert!(!p.is_empty());
        // Samples 488..1000 remain: the median is the 256th of them.
        assert_eq!(p.p50(), Some(488.0 + 255.0));
        assert_eq!(p.percentile(0.0), Some(488.0));
    }

    #[test]
    fn timings_are_derived_from_marks_and_serialise_without_undefined_fields() {
        let t0 = Instant::now();
        let mut marks = PaneMarks::new(t0);
        assert_eq!(
            serde_json::to_value(marks.timings()).unwrap(),
            serde_json::json!({})
        );
        marks.process_started = Some(t0 + Duration::from_millis(5));
        marks.first_output = Some(t0 + Duration::from_millis(105));
        marks.ready = Some(t0 + Duration::from_millis(605));
        marks.prompt_written = Some(t0 + Duration::from_millis(610));
        marks.prompt_accepted = Some(t0 + Duration::from_millis(5610));
        marks.prompt_retries = Some(1);
        marks.record_chunk(100, 0.5);
        marks.record_chunk(200, 1.5);
        let t = marks.timings();
        assert_eq!(t.spawn_ms, Some(5.0));
        assert_eq!(t.first_output_ms, Some(100.0));
        assert_eq!(t.readiness_ms, Some(500.0));
        assert_eq!(t.prompt_write_ms, Some(5.0));
        assert_eq!(t.prompt_accept_ms, Some(5000.0));
        assert_eq!(t.prompt_retries, Some(1));
        assert_eq!(t.render_p50_ms, Some(0.5));
        assert_eq!(t.render_p95_ms, Some(1.5));
        assert_eq!(t.output_bytes, Some(300));
        assert_eq!(t.output_chunks, Some(2));
        let json = serde_json::to_value(&t).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = [
            "spawn_ms",
            "first_output_ms",
            "readiness_ms",
            "prompt_write_ms",
            "prompt_accept_ms",
            "prompt_retries",
            "render_p50_ms",
            "render_p95_ms",
            "output_bytes",
            "output_chunks",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
    }

    #[test]
    fn host_metrics_serialise_with_the_zod_field_names() {
        let m = HostMetrics {
            host: HOST_KIND,
            uptime_ms: 12.5,
            panes_spawned: 2,
            panes_alive: 1,
            prompt_failures: 0,
            panes: vec![HostMetricsPane {
                pane_id: "relay:1".into(),
                role: "backend".into(),
                task_id: None,
                timings: PaneTimings::default(),
            }],
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["host"], "relayterm");
        assert_eq!(
            json["panes"][0],
            serde_json::json!({ "pane_id": "relay:1", "role": "backend", "timings": {} })
        );
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "host",
                "panes",
                "panes_alive",
                "panes_spawned",
                "prompt_failures",
                "uptime_ms"
            ]
        );
    }
}
