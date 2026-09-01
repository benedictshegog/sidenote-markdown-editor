//! Small helpers: ids, timestamps, titles, process liveness.

use std::path::Path;

use chrono::{DateTime, Utc};
use rand::Rng;

const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// Random 8-character document id.
pub fn new_doc_id() -> String {
    let mut rng = rand::rng();
    (0..8)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Next thread id: `c<n>` where n is one above the highest existing number.
pub fn next_thread_id(existing: impl Iterator<Item = impl AsRef<str>>) -> String {
    let max = existing
        .filter_map(|id| id.as_ref().strip_prefix('c').and_then(|n| n.parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    format!("c{}", max + 1)
}

pub fn now() -> String {
    format_time(Utc::now())
}

pub fn format_time(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Seconds elapsed since an RFC 3339 timestamp. `None` if unparsable.
pub fn age_secs(s: &str) -> Option<i64> {
    parse_time(s).map(|t| (Utc::now() - t).num_seconds())
}

/// Title of a markdown document: the first ATX heading, else the file stem.
pub fn title_of(markdown: &str, path: &Path) -> String {
    for line in markdown.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix('#') {
            let rest = rest.trim_start_matches('#').trim();
            if !rest.is_empty() {
                return unescape_markdown(rest);
            }
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".to_string())
}

/// Remove backslash escapes (`C\&I` -> `C&I`) for display.
pub fn unescape_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&n) = chars.peek() {
                if n.is_ascii_punctuation() {
                    out.push(n);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Session id of the calling Claude Code session, if any.
pub fn current_session() -> Option<String> {
    std::env::var("CLAUDE_CODE_SESSION_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_ids_increase() {
        assert_eq!(next_thread_id(std::iter::empty::<&str>()), "c1");
        assert_eq!(next_thread_id(["c3", "c12", "c7"].iter()), "c13");
    }

    #[test]
    fn title_from_heading() {
        let p = Path::new("/x/restore.md");
        assert_eq!(title_of("intro\n\n## Plan B\n", p), "Plan B");
        assert_eq!(title_of("no heading", p), "restore");
    }
}
