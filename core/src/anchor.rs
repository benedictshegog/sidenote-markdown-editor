//! Locate a text quote selector in a document, and build selectors.
//!
//! All offsets are in Unicode scalar values (chars), not bytes, so the
//! editor (which works in JS string indices) converts at the boundary.
//!
//! Strategy, in order:
//! 1. exact match of `exact`, disambiguated by `prefix`/`suffix` (and the
//!    `start` hint) when the phrase repeats;
//! 2. fuzzy match: the best window of similar length whose character
//!    similarity to `exact` is at least `FUZZY_THRESHOLD`, searched near the
//!    hint first and then over the whole text.

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, get_diff_ratio, Algorithm};

use crate::model::{Selector, CONTEXT_CHARS};

pub const FUZZY_THRESHOLD: f32 = 0.75;
const NEAR_WINDOW: usize = 2000;
const CANDIDATES: usize = 40;
const BOUNDARY_SLACK: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Exact,
    Fuzzy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Range {
    /// Inclusive char offset.
    pub start: usize,
    /// Exclusive char offset.
    pub end: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Anchored {
    pub range: Range,
    pub method: Method,
    pub score: f32,
}

pub fn anchor(text: &str, sel: &Selector) -> Option<Anchored> {
    let chars: Vec<char> = text.chars().collect();
    anchor_chars(&chars, sel)
}

pub fn anchor_chars(chars: &[char], sel: &Selector) -> Option<Anchored> {
    let exact: Vec<char> = sel.exact.chars().collect();
    if exact.is_empty() || exact.len() > chars.len() {
        return None;
    }
    let hits = find_all(chars, &exact);
    if !hits.is_empty() {
        let start = if hits.len() == 1 {
            hits[0]
        } else {
            pick_by_context(chars, &hits, sel, exact.len())
        };
        return Some(Anchored {
            range: Range {
                start,
                end: start + exact.len(),
            },
            method: Method::Exact,
            score: 1.0,
        });
    }
    fuzzy(chars, &exact, sel.start)
}

/// Build a selector for `[start, end)` in `text`.
pub fn make_selector(text: &str, start: usize, end: usize) -> Selector {
    let chars: Vec<char> = text.chars().collect();
    make_selector_chars(&chars, start, end)
}

pub fn make_selector_chars(chars: &[char], start: usize, end: usize) -> Selector {
    let end = end.min(chars.len());
    let start = start.min(end);
    let p0 = start.saturating_sub(CONTEXT_CHARS);
    let s1 = (end + CONTEXT_CHARS).min(chars.len());
    Selector {
        exact: chars[start..end].iter().collect(),
        prefix: chars[p0..start].iter().collect(),
        suffix: chars[end..s1].iter().collect(),
        start: Some(start),
    }
}

fn find_all(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return vec![];
    }
    let mut out = Vec::new();
    let last = hay.len() - needle.len();
    let first = needle[0];
    let mut i = 0;
    while i <= last {
        if hay[i] == first && &hay[i..i + needle.len()] == needle {
            out.push(i);
        }
        i += 1;
    }
    out
}

/// Among several exact hits, prefer the one whose surrounding text agrees
/// most with the stored prefix and suffix; break ties by distance to the hint.
fn pick_by_context(chars: &[char], hits: &[usize], sel: &Selector, len: usize) -> usize {
    let prefix: Vec<char> = sel.prefix.chars().collect();
    let suffix: Vec<char> = sel.suffix.chars().collect();
    let mut best = hits[0];
    let mut best_key = (i64::MIN, i64::MIN);
    for &h in hits {
        let mut score: i64 = 0;
        // prefix: compare backwards from the hit
        for (k, pc) in prefix.iter().rev().enumerate() {
            if k + 1 > h {
                break;
            }
            if chars[h - 1 - k] == *pc {
                score += 1;
            } else {
                break;
            }
        }
        let e = h + len;
        for (k, sc) in suffix.iter().enumerate() {
            if e + k >= chars.len() {
                break;
            }
            if chars[e + k] == *sc {
                score += 1;
            } else {
                break;
            }
        }
        let dist = sel
            .start
            .map(|s| -((s as i64 - h as i64).abs()))
            .unwrap_or(0);
        let key = (score, dist);
        if key > best_key {
            best_key = key;
            best = h;
        }
    }
    best
}

fn ratio(a: &[char], b: &[char]) -> f32 {
    let ops = capture_diff_slices(Algorithm::Myers, a, b);
    get_diff_ratio(&ops, a.len(), b.len())
}

fn fuzzy(chars: &[char], exact: &[char], hint: Option<usize>) -> Option<Anchored> {
    let n = chars.len();
    let len = exact.len();
    if len == 0 || n < len.saturating_sub(BOUNDARY_SLACK).max(1) {
        return None;
    }
    // Search region: near the hint first, then the whole text.
    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut near: Option<(usize, usize)> = None;
    if let Some(h) = hint {
        let lo = h.saturating_sub(NEAR_WINDOW);
        let hi = (h + NEAR_WINDOW + len).min(n);
        if lo < hi {
            regions.push((lo, hi));
            near = Some((lo, hi));
        }
    }
    // Only widen when the near window left something out. A document shorter
    // than two NEAR_WINDOWs is covered entirely by the first pass, and most
    // are, so this skips a second full scan of text just searched.
    if near != Some((0, n)) {
        regions.push((0, n));
    }

    for (lo, hi) in regions {
        if let Some(a) = fuzzy_in(chars, exact, lo, hi, hint) {
            return Some(a);
        }
    }
    None
}

fn fuzzy_in(
    chars: &[char],
    exact: &[char],
    lo: usize,
    hi: usize,
    hint: Option<usize>,
) -> Option<Anchored> {
    let len = exact.len();
    let region = &chars[lo..hi];
    if region.len() < len.saturating_sub(BOUNDARY_SLACK).max(1) {
        return None;
    }
    let win = len.min(region.len());

    // Cheap pre-filter: a sliding character histogram overlap.
    let mut need: std::collections::HashMap<char, i32> = std::collections::HashMap::new();
    for &c in exact {
        *need.entry(c).or_insert(0) += 1;
    }
    let mut have: std::collections::HashMap<char, i32> = std::collections::HashMap::new();
    let mut overlap: i32 = 0;
    let mut scored: Vec<(i32, usize)> = Vec::new();
    for i in 0..region.len() {
        let c = region[i];
        let h = have.entry(c).or_insert(0);
        *h += 1;
        if let Some(&nd) = need.get(&c) {
            if *h <= nd {
                overlap += 1;
            }
        }
        if i + 1 > win {
            let gone = region[i + 1 - win - 1];
            let h = have.get_mut(&gone).unwrap();
            if let Some(&nd) = need.get(&gone) {
                if *h <= nd {
                    overlap -= 1;
                }
            }
            *h -= 1;
        }
        if i + 1 >= win {
            scored.push((overlap, i + 1 - win));
        }
    }
    if scored.is_empty() {
        return None;
    }
    // Keep the best candidates by overlap, prefer those close to the hint.
    let order = |a: &(i32, usize), b: &(i32, usize)| {
        b.0.cmp(&a.0).then_with(|| match hint {
            Some(h) => {
                let da = (lo + a.1) as i64 - h as i64;
                let db = (lo + b.1) as i64 - h as i64;
                da.abs().cmp(&db.abs())
            }
            None => a.1.cmp(&b.1),
        })
    };
    // `scored` holds one entry per window position, so it is the length of the
    // document. Sorting all of it to read the first forty was the single
    // largest cost here. Partition off a generous shortlist first, then sort
    // only that: O(n) plus O(k log k) rather than O(n log n).
    const SHORTLIST: usize = CANDIDATES * 8;
    if scored.len() > SHORTLIST {
        scored.select_nth_unstable_by(SHORTLIST, order);
        scored.truncate(SHORTLIST);
    }
    scored.sort_by(order);
    // Collapse near-duplicate starts so the candidate set spans the text.
    let mut cands: Vec<usize> = Vec::new();
    for (_, s) in scored {
        if cands.iter().all(|c| (*c as i64 - s as i64).abs() > (len as i64 / 2).max(1)) {
            cands.push(s);
        }
        if cands.len() >= CANDIDATES {
            break;
        }
    }

    // A candidate this good will not be beaten by enough to matter, and the
    // candidates are already ordered best-first, so stop rather than refine
    // the rest of the shortlist.
    const GOOD_ENOUGH: f32 = 0.97;
    let mut best: Option<(f32, usize, usize)> = None;
    for s in cands {
        let e = (s + win).min(region.len());
        let r = ratio(&region[s..e], exact);
        if r < FUZZY_THRESHOLD * 0.8 {
            continue;
        }
        // Refine boundaries within a small slack.
        let (rs, re, rr) = refine(region, exact, s, e);
        if best.map(|b| rr > b.0).unwrap_or(true) {
            best = Some((rr, rs, re));
        }
        if rr >= GOOD_ENOUGH {
            break;
        }
    }
    let (score, s, e) = best?;
    if score < FUZZY_THRESHOLD {
        return None;
    }
    Some(Anchored {
        range: Range {
            start: lo + s,
            end: lo + e,
        },
        method: Method::Fuzzy,
        score,
    })
}

/// Nudge the two boundaries, within `BOUNDARY_SLACK`, to whatever scores best.
///
/// Coordinate descent: sweep every offset of one edge, keep the best, then do
/// the same for the other, then repeat once so the start can react to an end
/// the first pass moved. That is at most four sweeps of seventeen, against the
/// 289 of the full (17 x 17) grid this replaces — and the grid ran for each of
/// up to forty candidates, for every thread, on every `turn end`.
///
/// Each edge is swept in full rather than walked until a step stops helping.
/// A hill climb is cheaper again, but similarity plateaus (several offsets
/// scoring the same) are common in prose, and stopping on one loses a match
/// that lies just beyond it: `reanchor_fuzzy_and_orphan` catches exactly that.
fn refine(region: &[char], exact: &[char], s: usize, e: usize) -> (usize, usize, f32) {
    let n = region.len() as i64;
    let slack = BOUNDARY_SLACK as i64;
    let (s0, e0) = (s as i64, e as i64);
    let (mut bs, mut be) = (s0, e0);
    let mut best = ratio(&region[s..e], exact);

    for _ in 0..2 {
        for d in -slack..=slack {
            let ns = s0 + d;
            if ns < 0 || ns >= be || ns == bs {
                continue;
            }
            let r = ratio(&region[ns as usize..be as usize], exact);
            if r > best {
                bs = ns;
                best = r;
            }
        }
        for d in -slack..=slack {
            let ne = e0 + d;
            if ne > n || ne <= bs || ne == be {
                continue;
            }
            let r = ratio(&region[bs as usize..ne as usize], exact);
            if r > best {
                be = ne;
                best = r;
            }
        }
    }
    (bs as usize, be as usize, best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(exact: &str, prefix: &str, suffix: &str) -> Selector {
        Selector {
            exact: exact.into(),
            prefix: prefix.into(),
            suffix: suffix.into(),
            start: None,
        }
    }

    #[test]
    fn exact_unique() {
        let t = "The restore then deletes its own hold row in finally.";
        let a = anchor(t, &sel("deletes its own hold row", "", "")).unwrap();
        assert_eq!(a.method, Method::Exact);
        assert_eq!(&t[a.range.start..a.range.end], "deletes its own hold row");
    }

    #[test]
    fn repeated_phrase_uses_context() {
        let t = "Run the job. Then run the job again. Finally run the job once more.";
        let a = anchor(t, &sel("run the job", "Finally ", " once")).unwrap();
        assert_eq!(a.range.start, t.find("run the job once").unwrap());
        let b = anchor(t, &sel("run the job", "Then ", " again")).unwrap();
        assert_eq!(b.range.start, t.find("run the job again").unwrap());
    }

    #[test]
    fn fuzzy_after_small_edit() {
        let t = "The restore then removes its own hold row inside finally, for safety.";
        let a = anchor(t, &sel("deletes its own hold row in finally", "then ", ", for")).unwrap();
        assert_eq!(a.method, Method::Fuzzy);
        let got: String = t.chars().skip(a.range.start).take(a.range.end - a.range.start).collect();
        assert!(got.contains("its own hold row"), "got {got:?}");
    }

    #[test]
    fn rewritten_sentence_orphans() {
        let t = "Completely different prose about cabbages and kings.";
        assert!(anchor(t, &sel("deletes its own hold row in finally", "", "")).is_none());
    }

    #[test]
    fn selector_round_trip() {
        let t = "aaaa bbbb cccc dddd";
        let s = make_selector(t, 5, 9);
        assert_eq!(s.exact, "bbbb");
        assert_eq!(s.prefix, "aaaa ");
        assert_eq!(s.suffix, " cccc dddd");
        assert_eq!(s.start, Some(5));
        let a = anchor(t, &s).unwrap();
        assert_eq!((a.range.start, a.range.end), (5, 9));
    }

    #[test]
    fn unicode_offsets_are_chars() {
        let t = "héllo wörld again";
        let s = make_selector(t, 6, 11);
        assert_eq!(s.exact, "wörld");
        let a = anchor(t, &s).unwrap();
        assert_eq!((a.range.start, a.range.end), (6, 11));
    }
}
