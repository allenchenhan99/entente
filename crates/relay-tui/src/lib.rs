//! relay-tui: a Ratatui client for relayd (Relay Terminal R2). It talks only HTTP/SSE/WS to relayd and
//! never runs the reducer: the graph, descriptions, stories and actions come from `/graph*`, the panes
//! from `/panes` and `/pty/:id`.

pub mod model;
