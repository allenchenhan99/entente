//! termd — the Relay Terminal PTY host (R1 of PRD §23): a drop-in replacement for relayd's TypeScript PTY host.
//! Same HTTP/WebSocket protocol as `packages/protocol/src/pty.ts`, same readiness heuristics and prompt-delivery
//! rules as `apps/relayd/src/pty/{readiness,host,pane}.ts`, same asciinema casts, plus efficiency metrics.
#![deny(warnings)]

pub mod keys;
pub mod metrics;
pub mod readiness;
pub mod recorder;
pub mod ring;
pub mod screen;
