//! Logical key names accepted by `POST /panes/:id/input` (`PaneInputBody.keys`) → terminal bytes.
//! Port of `apps/relayd/src/pty/keys.ts`.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownKey(pub String);

impl fmt::Display for UnknownKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Same text as the TypeScript host: `unknown key: "<json string>"`.
        write!(
            f,
            "unknown key: {}",
            serde_json::to_string(&self.0).unwrap_or_default()
        )
    }
}

impl std::error::Error for UnknownKey {}

pub fn key_to_bytes(key: &str) -> Result<Vec<u8>, UnknownKey> {
    let named: Option<&[u8]> = match key.to_ascii_lowercase().as_str() {
        "enter" => Some(b"\r"),
        "esc" | "escape" => Some(b"\x1b"),
        "tab" => Some(b"\t"),
        "backspace" => Some(b"\x7f"),
        "up" => Some(b"\x1b[A"),
        "down" => Some(b"\x1b[B"),
        "right" => Some(b"\x1b[C"),
        "left" => Some(b"\x1b[D"),
        _ => None,
    };
    if let Some(bytes) = named {
        return Ok(bytes.to_vec());
    }
    let lower = key.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("ctrl+") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_lowercase() {
                return Ok(vec![c.to_ascii_uppercase() as u8 - 64]);
            }
        }
    }
    Err(UnknownKey(key.to_string()))
}

/// Maps every key up front so an unknown key writes nothing to the pane.
pub fn keys_to_bytes(keys: &[String]) -> Result<Vec<u8>, UnknownKey> {
    let mut out = Vec::new();
    for key in keys {
        out.extend(key_to_bytes(key)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_documented_logical_keys_to_terminal_bytes() {
        assert_eq!(key_to_bytes("enter").unwrap(), b"\r");
        assert_eq!(key_to_bytes("esc").unwrap(), b"\x1b");
        assert_eq!(key_to_bytes("escape").unwrap(), b"\x1b");
        assert_eq!(key_to_bytes("tab").unwrap(), b"\t");
        assert_eq!(key_to_bytes("backspace").unwrap(), b"\x7f");
        assert_eq!(key_to_bytes("up").unwrap(), b"\x1b[A");
        assert_eq!(key_to_bytes("down").unwrap(), b"\x1b[B");
        assert_eq!(key_to_bytes("right").unwrap(), b"\x1b[C");
        assert_eq!(key_to_bytes("left").unwrap(), b"\x1b[D");
        assert_eq!(key_to_bytes("ctrl+c").unwrap(), b"\x03");
        assert_eq!(key_to_bytes("ctrl+d").unwrap(), b"\x04");
        assert_eq!(key_to_bytes("ctrl+Z").unwrap(), b"\x1a");
        assert_eq!(key_to_bytes("ENTER").unwrap(), b"\r");
    }

    #[test]
    fn rejects_unknown_keys() {
        assert_eq!(key_to_bytes("meta+x"), Err(UnknownKey("meta+x".into())));
        assert_eq!(key_to_bytes("ctrl+1"), Err(UnknownKey("ctrl+1".into())));
        assert_eq!(key_to_bytes("ctrl+"), Err(UnknownKey("ctrl+".into())));
        assert_eq!(key_to_bytes(""), Err(UnknownKey(String::new())));
        assert_eq!(
            UnknownKey("hyper+x".into()).to_string(),
            "unknown key: \"hyper+x\""
        );
    }

    #[test]
    fn keys_to_bytes_maps_all_or_nothing() {
        let ok = keys_to_bytes(&["enter".into(), "ctrl+c".into(), "up".into()]).unwrap();
        assert_eq!(ok, b"\r\x03\x1b[A");
        assert!(keys_to_bytes(&["enter".into(), "hyper+x".into()]).is_err());
        assert_eq!(keys_to_bytes(&[]).unwrap(), b"");
    }
}
