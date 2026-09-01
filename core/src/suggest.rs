//! Suggested edits: what `apply` records instead of writing while the
//! document is in suggesting mode.
//!
//! The unit is exactly what `apply` already takes — one `old` passage and its
//! `new` replacement — so a suggestion is an `apply` that has not run yet.
//! Accepting one runs it. That is the whole design: there is one edit path,
//! and the mode decides only when it fires.
//!
//! The markdown file is untouched until the user accepts, which is the same
//! rule comments follow. A document full of pending suggestions is still
//! clean markdown on disk.

use serde::{Deserialize, Serialize};
use similar::{Algorithm, DiffOp, TextDiff};

pub const SUGGESTIONS_VERSION: u32 = 1;

/// `~/.sidenote/docs/<id>/suggestions.json`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuggestionsFile {
    pub version: u32,
    #[serde(default)]
    pub suggestions: Vec<Suggestion>,
    /// The next id to hand out. Held here rather than derived from the
    /// suggestions present, because deciding one removes it: with three
    /// pending and `s3` rejected, the highest left is `s2` and the next
    /// suggestion would be `s3` again. A card the user is looking at, or a
    /// decision already in flight, would then be answered by the wrong
    /// suggestion. Threads can derive theirs — they are never removed.
    #[serde(default)]
    pub next: u32,
}

impl Default for SuggestionsFile {
    fn default() -> Self {
        Self {
            version: SUGGESTIONS_VERSION,
            suggestions: Vec::new(),
            next: 1,
        }
    }
}

impl SuggestionsFile {
    /// Take the next id. Recovers if the counter is behind the ids present —
    /// a file written before it existed, or edited by hand.
    pub fn take_id(&mut self) -> String {
        let highest = self
            .suggestions
            .iter()
            .filter_map(|s| s.id.strip_prefix('s').and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        let n = self.next.max(highest + 1);
        self.next = n + 1;
        format!("s{n}")
    }
}

/// One pending edit. Deciding it removes it from the file: the record of what
/// happened lives in the thread's reply, not here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Suggestion {
    /// `s1`, `s2`, … Unique within the document for its lifetime.
    pub id: String,
    /// The markdown to replace. Must occur exactly once in the file when the
    /// user accepts, exactly as for `apply`.
    pub old: String,
    /// The replacement markdown. Empty is a pure deletion.
    pub new: String,
    /// The thread this edit answers, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /// `CLAUDE_CODE_SESSION_ID` of the session that suggested it.
    pub session: String,
    pub at: String,
}

// ---- rendering ----------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SegKind {
    Equal,
    Delete,
    Insert,
}

/// One run of the word-level diff between the two passages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Seg {
    pub kind: SegKind,
    pub text: String,
}

/// Split into chunks of one word plus the whitespace that follows it.
///
/// The unit of comparison has to be the word *with* its trailing space, not
/// the word and the space as two units. `similar`'s own word splitter makes
/// them two, and then the diff happily matches the space after "every"
/// against the space after "nightly" and calls it common text — so a rewritten
/// phrase came out interleaved, `every` and `hour` left standing between the
/// words that were meant to replace them.
///
/// Concatenating the chunks rebuilds the input exactly, which is what keeps
/// the placement invariant below true.
fn word_chunks(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_ws = false;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() {
            in_ws = true;
        } else if in_ws {
            out.push(&s[start..i]);
            start = i;
            in_ws = false;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Word-level diff of `old` against `new`, for drawing the suggestion inside
/// the document.
///
/// The invariant the app depends on: the `Equal` and `Delete` segments, in
/// order, concatenate back to `old` exactly. `old` is text the app has already
/// located in the document, so walking the segments and advancing an offset by
/// the length of each `Equal` and `Delete` places every one of them without a
/// second search. `Insert` segments are the only text that is not in the
/// document, and they are the only ones the editor has to draw itself.
///
/// Split on words rather than characters because this is prose. A character
/// diff of "every hour" against "nightly" finds the shared "h" and produces
/// confetti; a word diff says one phrase became another, which is what the
/// reader needs to see.
///
/// Words are compared trimmed, so a line that was rewrapped is not reported as
/// a change. The text emitted is the untrimmed chunk, so the `old` side still
/// rebuilds exactly; only the `new` side can come back with the whitespace the
/// old side had, and nothing reads it for anything but display.
pub fn segments(old: &str, new: &str) -> Vec<Seg> {
    let old_chunks = word_chunks(old);
    let new_chunks = word_chunks(new);
    let old_keys: Vec<&str> = old_chunks.iter().map(|c| c.trim()).collect();
    let new_keys: Vec<&str> = new_chunks.iter().map(|c| c.trim()).collect();

    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_slices(&old_keys, &new_keys);

    let mut out: Vec<Seg> = Vec::new();
    for op in diff.ops() {
        match *op {
            DiffOp::Equal { old_index, len, .. } => {
                push(&mut out, SegKind::Equal, &old_chunks[old_index..old_index + len])
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => push(&mut out, SegKind::Delete, &old_chunks[old_index..old_index + old_len]),
            DiffOp::Insert {
                new_index, new_len, ..
            } => push(&mut out, SegKind::Insert, &new_chunks[new_index..new_index + new_len]),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                push(&mut out, SegKind::Delete, &old_chunks[old_index..old_index + old_len]);
                push(&mut out, SegKind::Insert, &new_chunks[new_index..new_index + new_len]);
            }
        }
    }
    space_insertions(&mut out);
    out
}

/// Append to the last run when it is the same kind, so a rewritten sentence is
/// one segment rather than one per word. The card counts words, and the editor
/// draws one element per segment; neither wants them per word.
fn push(out: &mut Vec<Seg>, kind: SegKind, chunks: &[&str]) {
    if chunks.is_empty() {
        return;
    }
    let joined = chunks.concat();
    match out.last_mut() {
        Some(last) if last.kind == kind => last.text.push_str(&joined),
        _ => out.push(Seg { kind, text: joined }),
    }
}

/// Give an insertion the space it needs to sit beside the words around it.
///
/// A chunk carries the whitespace that followed it, so an insertion normally
/// arrives spaced already. The exception is an insertion that follows text
/// which ended the old passage — "…then production." gaining a sentence — where
/// the space belongs to the new side only and would otherwise be dropped,
/// running the two together.
fn space_insertions(segs: &mut [Seg]) {
    for i in 1..segs.len() {
        if segs[i].kind != SegKind::Insert {
            continue;
        }
        let needs = segs[i - 1]
            .text
            .chars()
            .last()
            .is_some_and(|c| !c.is_whitespace())
            && segs[i].text.starts_with(|c: char| !c.is_whitespace());
        if needs {
            segs[i].text.insert(0, ' ');
        }
    }
}

/// How many words the suggestion removes and adds. What the card shows
/// instead of the raw segment count.
pub fn word_counts(segs: &[Seg]) -> (usize, usize) {
    let count = |s: &Seg| s.text.split_whitespace().count();
    (
        segs.iter().filter(|s| s.kind == SegKind::Delete).map(count).sum(),
        segs.iter().filter(|s| s.kind == SegKind::Insert).map(count).sum(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rebuilt(segs: &[Seg]) -> (String, String) {
        let mut old = String::new();
        let mut new = String::new();
        for s in segs {
            match s.kind {
                SegKind::Equal => {
                    old.push_str(&s.text);
                    new.push_str(&s.text);
                }
                SegKind::Delete => old.push_str(&s.text),
                SegKind::Insert => new.push_str(&s.text),
            }
        }
        (old, new)
    }

    /// The placement invariant: the old side must come back byte for byte,
    /// because the app steps through the document by these lengths.
    #[test]
    fn segments_rebuild_the_old_side_exactly() {
        let a = "The pipeline runs every hour and retries twice.";
        let b = "The pipeline runs nightly at 02:00 and retries twice.";
        let segs = segments(a, b);
        let (old, new) = rebuilt(&segs);
        assert_eq!(old, a);
        // The new side comes back word for word; only whitespace may differ,
        // and nothing but the drawing reads it.
        assert_eq!(new.split_whitespace().collect::<Vec<_>>(), b.split_whitespace().collect::<Vec<_>>());
    }

    /// The bug this tokenizer exists for. Splitting words and spaces
    /// separately let the diff match the space after "every" against the space
    /// after "nightly", and the rewritten phrase came out interleaved with the
    /// words it was replacing.
    #[test]
    fn a_rewritten_phrase_is_one_run_not_confetti() {
        let segs = segments(
            "runs every hour and retries twice on failure",
            "runs nightly at 02:00 UTC and retries three times on failure",
        );
        let kinds: Vec<SegKind> = segs.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SegKind::Equal,
                SegKind::Delete,
                SegKind::Insert,
                SegKind::Equal,
                SegKind::Delete,
                SegKind::Insert,
                SegKind::Equal,
            ],
            "{segs:#?}"
        );
        assert_eq!(segs[1].text.trim(), "every hour");
        assert_eq!(segs[2].text.trim(), "nightly at 02:00 UTC");
        assert_eq!(segs[3].text.trim(), "and retries");
        assert_eq!(segs[4].text.trim(), "twice");
        assert_eq!(segs[5].text.trim(), "three times");
    }

    /// Rewrapping is not an edit. The editor's serialiser moves line breaks
    /// around on its own, and reporting that as a change would bury the real
    /// ones.
    #[test]
    fn a_rewrapped_line_is_not_a_change() {
        let segs = segments("There is no backfill\npath yet, so it waits.", "There is no backfill path yet, so it waits.");
        assert!(segs.iter().all(|s| s.kind == SegKind::Equal), "{segs:#?}");
    }

    /// A sentence added to the end of a passage must not run into the one
    /// before it: that space lives on the new side only.
    #[test]
    fn an_appended_sentence_keeps_its_space() {
        let segs = segments("Ship to staging first.", "Ship to staging first. Then production.");
        let ins = segs.iter().find(|s| s.kind == SegKind::Insert).expect("an insertion");
        assert!(ins.text.starts_with(' '), "{:?}", ins.text);
        assert_eq!(rebuilt(&segs).0, "Ship to staging first.");
    }

    #[test]
    fn shared_words_stay_equal() {
        let segs = segments("runs every hour", "runs nightly");
        assert_eq!(segs[0].kind, SegKind::Equal);
        assert!(segs[0].text.starts_with("runs"));
        assert!(segs.iter().any(|s| s.kind == SegKind::Delete));
        assert!(segs.iter().any(|s| s.kind == SegKind::Insert));
    }

    #[test]
    fn pure_insertion_and_pure_deletion() {
        let ins = segments("", "brand new line");
        assert_eq!(ins.len(), 1);
        assert_eq!(ins[0].kind, SegKind::Insert);

        let del = segments("gone for good", "");
        assert_eq!(del.len(), 1);
        assert_eq!(del[0].kind, SegKind::Delete);
    }

    #[test]
    fn identical_text_is_all_equal() {
        let segs = segments("no change here", "no change here");
        assert!(segs.iter().all(|s| s.kind == SegKind::Equal));
    }

    #[test]
    fn counts_words_not_segments() {
        let segs = segments("runs every hour", "runs nightly at 02:00");
        let (removed, added) = word_counts(&segs);
        assert_eq!(removed, 2);
        assert_eq!(added, 3);
    }

    #[test]
    fn ids_are_never_handed_out_twice() {
        let mut f = SuggestionsFile::default();
        assert_eq!(f.take_id(), "s1");
        assert_eq!(f.take_id(), "s2");
        // Removing one must not free its id, or a card in front of the user
        // could be answered by whatever takes it next.
        assert_eq!(f.take_id(), "s3");

        // A file written before the counter existed reads back as 0; the ids
        // present are enough to carry on from.
        let mut old = SuggestionsFile {
            version: SUGGESTIONS_VERSION,
            suggestions: vec![Suggestion {
                id: "s7".into(),
                old: "a".into(),
                new: "b".into(),
                thread: None,
                session: "sid".into(),
                at: "now".into(),
            }],
            next: 0,
        };
        assert_eq!(old.take_id(), "s8");
    }
}
