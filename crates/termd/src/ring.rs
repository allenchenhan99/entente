//! Bounded FIFO of raw PTY output bytes: the scrollback that late-joining WebSocket clients replay.
//! Port of `ByteRing` in `apps/relayd/src/pty/pane.ts` (256 KiB per pane).

use std::collections::VecDeque;

/// Raw bytes retained per pane for late-joining clients.
pub const RING_CAPACITY: usize = 256 * 1024;

#[derive(Debug)]
pub struct ByteRing {
    buf: VecDeque<u8>,
    capacity: usize,
}

impl ByteRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity.min(64 * 1024)),
            capacity,
        }
    }

    /// Appends `chunk`, dropping the oldest bytes so at most `capacity` remain.
    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.capacity {
            self.buf.clear();
            self.buf.extend(&chunk[chunk.len() - self.capacity..]);
            return;
        }
        self.buf.extend(chunk);
        let excess = self.buf.len().saturating_sub(self.capacity);
        if excess > 0 {
            self.buf.drain(..excess);
        }
    }

    /// The retained bytes, oldest first.
    pub fn bytes(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_under_capacity() {
        let mut ring = ByteRing::new(16);
        ring.push(b"hello");
        ring.push(b" world");
        assert_eq!(ring.bytes(), b"hello world");
        assert_eq!(ring.len(), 11);
    }

    #[test]
    fn drops_the_oldest_bytes_when_full() {
        let mut ring = ByteRing::new(8);
        ring.push(b"abcdef");
        ring.push(b"ghij");
        assert_eq!(ring.bytes(), b"cdefghij");
        ring.push(b"k");
        assert_eq!(ring.bytes(), b"defghijk");
    }

    #[test]
    fn a_chunk_larger_than_capacity_keeps_only_its_tail() {
        let mut ring = ByteRing::new(4);
        ring.push(b"xy");
        ring.push(b"0123456789");
        assert_eq!(ring.bytes(), b"6789");
        assert!(!ring.is_empty());
    }

    #[test]
    fn default_capacity_is_256_kib() {
        let mut ring = ByteRing::new(RING_CAPACITY);
        ring.push(&vec![b'x'; 300_000]);
        assert_eq!(ring.len(), RING_CAPACITY);
    }
}
