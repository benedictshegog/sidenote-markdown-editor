//! Unified diff that ignores whitespace differences (`diff -w`), printed
//! with the original lines so indentation stays visible.

use similar::{Algorithm, DiffOp, TextDiff};

/// Collapse whitespace runs. Table delimiter rows (`|---|:---:|`) also have
/// their dash runs collapsed, because the editor's serialiser pads them to
/// the column width and that is not a content change.
fn normalise(line: &str) -> String {
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if is_table_delimiter(&collapsed) {
        let mut out = String::new();
        let mut prev_dash = false;
        for c in collapsed.chars() {
            if c == '-' {
                if !prev_dash {
                    out.push('-');
                }
                prev_dash = true;
            } else {
                out.push(c);
                prev_dash = false;
            }
        }
        return out;
    }
    collapsed
}

fn is_table_delimiter(line: &str) -> bool {
    let t = line.trim();
    if !t.contains('-') || !t.contains('|') {
        return false;
    }
    t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// Unified diff of `old` against `new`, ignoring whitespace and blank lines
/// when comparing. Line numbers in hunk headers count non-blank lines.
/// Empty string when the two are equal modulo whitespace.
pub fn unified_ignore_ws(old: &str, new: &str, old_name: &str, new_name: &str) -> String {
    // Blank lines are dropped before comparing (`diff -B`): the editor's
    // serialiser adds or removes them around lists and at the end of file.
    let old_lines: Vec<&str> = old.lines().filter(|l| !l.trim().is_empty()).collect();
    let new_lines: Vec<&str> = new.lines().filter(|l| !l.trim().is_empty()).collect();
    let old_norm: Vec<String> = old_lines.iter().map(|l| normalise(l)).collect();
    let new_norm: Vec<String> = new_lines.iter().map(|l| normalise(l)).collect();
    let old_ref: Vec<&str> = old_norm.iter().map(|s| s.as_str()).collect();
    let new_ref: Vec<&str> = new_norm.iter().map(|s| s.as_str()).collect();

    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_slices(&old_ref, &new_ref);

    let groups = diff.grouped_ops(3);
    if groups.is_empty() || groups.iter().all(|g| g.iter().all(|op| matches!(op, DiffOp::Equal { .. }))) {
        return String::new();
    }

    let mut out = String::new();
    out.push_str(&format!("--- {old_name}\n+++ {new_name}\n"));
    for group in groups {
        let first = group.first().unwrap();
        let last = group.last().unwrap();
        let os = first.old_range().start;
        let oe = last.old_range().end;
        let ns = first.new_range().start;
        let ne = last.new_range().end;
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            os + 1,
            oe - os,
            ns + 1,
            ne - ns
        ));
        for op in group {
            match op {
                DiffOp::Equal {
                    old_index, len, ..
                } => {
                    for l in &old_lines[old_index..old_index + len] {
                        out.push(' ');
                        out.push_str(l);
                        out.push('\n');
                    }
                }
                DiffOp::Delete {
                    old_index, old_len, ..
                } => {
                    for l in &old_lines[old_index..old_index + old_len] {
                        out.push('-');
                        out.push_str(l);
                        out.push('\n');
                    }
                }
                DiffOp::Insert {
                    new_index, new_len, ..
                } => {
                    for l in &new_lines[new_index..new_index + new_len] {
                        out.push('+');
                        out.push_str(l);
                        out.push('\n');
                    }
                }
                DiffOp::Replace {
                    old_index,
                    old_len,
                    new_index,
                    new_len,
                } => {
                    for l in &old_lines[old_index..old_index + old_len] {
                        out.push('-');
                        out.push_str(l);
                        out.push('\n');
                    }
                    for l in &new_lines[new_index..new_index + new_len] {
                        out.push('+');
                        out.push_str(l);
                        out.push('\n');
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_only_changes_are_ignored() {
        let a = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let b = "| a   | b   |\n|-----|-----|\n| 1   | 2   |\n";
        assert_eq!(unified_ignore_ws(a, b, "old", "new"), "");
    }

    #[test]
    fn real_changes_show_original_lines() {
        let a = "one\n  two\nthree\n";
        let b = "one\n  two changed\nthree\n";
        let d = unified_ignore_ws(a, b, "old", "new");
        assert!(d.contains("-  two\n"), "{d}");
        assert!(d.contains("+  two changed\n"), "{d}");
        assert!(d.starts_with("--- old\n+++ new\n@@ -1,3 +1,3 @@\n"), "{d}");
    }
}
