//! Markdown to plain text, in the same shape the editor produces when it
//! walks its ProseMirror document: text blocks joined by "\n", inline
//! syntax stripped, code kept as text.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

pub fn plain_text(markdown: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(markdown, opts);

    let mut out = String::new();
    // Tight list items carry text directly; loose ones wrap it in paragraphs.
    // Track whether the current item has emitted a paragraph so the item end
    // does not add a second separator.
    let mut item_depth: Vec<bool> = Vec::new();

    let end_block = |out: &mut String| {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
    };

    for ev in parser {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Item => item_depth.push(false),
                Tag::Paragraph => {
                    if let Some(flag) = item_depth.last_mut() {
                        *flag = true;
                    }
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::HtmlBlock => end_block(&mut out),
                TagEnd::Item => {
                    item_depth.pop();
                    end_block(&mut out);
                }
                _ => {}
            },
            Event::Text(t) => out.push_str(&t),
            Event::Code(t) => out.push_str(&t),
            Event::InlineMath(t) | Event::DisplayMath(t) => out.push_str(&t),
            Event::SoftBreak => out.push('\n'),
            Event::HardBreak => out.push('\n'),
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::FootnoteReference(_) => {}
            Event::TaskListMarker(_) => {}
            Event::Rule => end_block(&mut out),
        }
    }
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inline_syntax() {
        let md = "# Title\n\nThe restore then **deletes** its own hold row in `finally`.\n\n- one\n- two `x`\n";
        assert_eq!(
            plain_text(md),
            "Title\nThe restore then deletes its own hold row in finally.\none\ntwo x"
        );
    }

    #[test]
    fn table_cells_are_blocks() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        assert_eq!(plain_text(md), "a\nb\n1\n2");
    }

    #[test]
    fn code_block_kept() {
        let md = "```sh\necho hi\n```\n\nAfter.";
        assert_eq!(plain_text(md), "echo hi\nAfter.");
    }
}
