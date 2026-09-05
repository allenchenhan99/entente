//! Wall-clock arithmetic for the inbox, without pulling in a date crate.
//!
//! The inbox answers "what needs you"; how long it has needed you is the other half, and it is the
//! half that says what to do first. The server stamps `since` as RFC 3339, so all this has to do is
//! turn two of those into a difference and a word — a full calendar library would be a dependency
//! bought for one subtraction.

/// Seconds since the Unix epoch for an RFC 3339 timestamp (`2026-09-05T10:05:00+08:00`, `…Z`).
///
/// Returns `None` on anything it does not fully understand rather than guessing, because a wrong
/// age is worse than no age: it would rank the queue.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, min, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut epoch = days_from_civil(year, month, day) * 86_400 + hour * 3600 + min * 60 + sec;

    // The offset is whatever follows the seconds and any fractional part.
    let rest = &s[19..];
    let rest = rest.strip_prefix('.').map_or(rest, |frac| {
        let digits = frac.len() - frac.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        &frac[digits..]
    });
    match rest.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => {}
        Some(sign @ (b'+' | b'-')) => {
            let oh = rest.get(1..3)?.parse::<i64>().ok()?;
            let om = rest.get(4..6)?.parse::<i64>().ok()?;
            let offset = oh * 3600 + om * 60;
            epoch += if *sign == b'+' { -offset } else { offset };
        }
        Some(_) => return None,
    }
    Some(epoch)
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// How long something has been waiting, in five columns at most: `now`, `9m`, `41m`, `2h`, `3d`.
///
/// A clock that has run backwards (a clock skew between relayd and this terminal) reads `now`
/// rather than a negative age — it is the honest reading of "no measurable wait".
pub fn age_label(seconds: i64) -> String {
    match seconds {
        i64::MIN..=59 => "now".to_string(),
        60..=3599 => format!("{}m", seconds / 60),
        3600..=86_399 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

/// What an age means for the person reading it. The thresholds are about human attention, not about
/// the agents: five minutes is roughly how long you can be away without losing the thread, and
/// twenty is long enough that whatever you were doing instead has become the real task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Fresh,
    Waiting,
    Stalled,
}

pub fn urgency(seconds: i64) -> Urgency {
    match seconds {
        i64::MIN..=299 => Urgency::Fresh,
        300..=1199 => Urgency::Waiting,
        _ => Urgency::Stalled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_offsets_and_z_to_the_same_instant() {
        let z = parse_rfc3339("2026-09-05T02:05:00Z").unwrap();
        let plus8 = parse_rfc3339("2026-09-05T10:05:00+08:00").unwrap();
        assert_eq!(z, plus8);
        let minus5 = parse_rfc3339("2026-09-04T21:05:00-05:00").unwrap();
        assert_eq!(z, minus5);
        assert_eq!(parse_rfc3339("2026-09-05T02:05:00.123Z"), Some(z));
    }

    #[test]
    fn the_epoch_is_where_it_should_be() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-09-05T02:05:00Z"), Some(1_788_573_900));
    }

    #[test]
    fn nonsense_is_no_age_rather_than_a_wrong_one() {
        assert_eq!(parse_rfc3339(""), None);
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-13-05T02:05:00Z"), None);
        assert_eq!(parse_rfc3339("2026-09-05T02:05:00 PST"), None);
    }

    #[test]
    fn ages_stay_within_five_columns() {
        assert_eq!(age_label(-30), "now");
        assert_eq!(age_label(0), "now");
        assert_eq!(age_label(59), "now");
        assert_eq!(age_label(60), "1m");
        assert_eq!(age_label(2_460), "41m");
        assert_eq!(age_label(7_200), "2h");
        assert_eq!(age_label(300_000), "3d");
    }

    #[test]
    fn urgency_ramps_at_human_thresholds() {
        assert_eq!(urgency(60), Urgency::Fresh);
        assert_eq!(urgency(299), Urgency::Fresh);
        assert_eq!(urgency(300), Urgency::Waiting);
        assert_eq!(urgency(1_199), Urgency::Waiting);
        assert_eq!(urgency(1_200), Urgency::Stalled);
    }
}
