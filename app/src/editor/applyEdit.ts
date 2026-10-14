// Landing one CLI edit in the live document: `old` (plain text, exactly once
// in the prose) becomes the markdown `next`, as a single mapped transaction.
//
// It lives apart from `Editor.tsx` so the parse-and-apply decision can be
// tested against a real editor without a React tree. `Editor.tsx` holds the
// Crepe instance and calls in.

import {
  Slice,
  type Node as PMNode,
  type ResolvedPos,
} from "@milkdown/kit/prose/model";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";

import type { ApplyResult } from "../types";
import { DRAFT_ID } from "./commentMark";
import { definedLabels, parseWithFootnotes } from "./footnotes";
import { TextMap } from "./textmap";

/**
 * Where `needle` occurs exactly once in `text`, as `[start, end]`; otherwise
 * the number of hits. A second pass ignores runs of whitespace, because the
 * markdown in the file wraps lines where the editor shows one space.
 */
export function findOnce(
  text: string,
  needle: string,
): [number, number] | number {
  if (!needle) return 0;
  const exact = countHits(text, needle);
  if (exact.length === 1) return [exact[0], exact[0] + needle.length];
  if (exact.length > 1) return exact.length;
  // Collapse whitespace on both sides, keeping a map back to the original.
  const back: number[] = [];
  let squashed = "";
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!space && squashed.length) {
        squashed += " ";
        back.push(i);
      }
      space = true;
    } else {
      squashed += c;
      back.push(i);
      space = false;
    }
  }
  const wanted = needle.trim().replace(/\s+/g, " ");
  if (!wanted) return 0;
  const loose = countHits(squashed, wanted);
  if (loose.length !== 1) return loose.length;
  const a = back[loose[0]];
  const b = back[loose[0] + wanted.length - 1] + 1;
  return [a, b];
}

function countHits(text: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits; // indexOf('') never returns -1
  let i = text.indexOf(needle);
  while (i >= 0) {
    hits.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return hits;
}

/**
 * The inline content of `fragment` when it is one block's worth of prose,
 * however deeply that block is wrapped; otherwise null.
 *
 * `--new` is parsed as a whole markdown document, so a replacement that
 * starts with a block marker — `3. `, `> `, `#` — comes back wrapped in the
 * block that marker names, even when it is replacing a few words inside a
 * paragraph. Wrapped content spliced into an inline range nests: the
 * paragraph is split in two, the wrapper is dropped between the halves, and
 * the file gains a stray empty block and a second list marker. Unwrapping
 * first keeps the edit where the caller aimed it — the words change, the
 * block they sit in does not.
 */
function inlineContent(fragment: PMNode["content"]) {
  let content = fragment;
  // Peel wrappers (list → item → paragraph, blockquote → paragraph) while
  // there is exactly one child and it is not already a textblock. A textblock
  // — paragraph, heading, code block — holds the inline content itself.
  for (let depth = 0; depth < 10; depth++) {
    if (content.childCount !== 1) return null;
    const only = content.child(0);
    if (only.isTextblock) return only.content;
    if (only.isLeaf || only.isInline) return null;
    content = only.content;
  }
  return null;
}

/**
 * Whether the schema lets `parsed`'s blocks stand where the blocks between
 * `$from` and `$to` stand. Asked only of a range that covers whole blocks.
 */
function fits($from: ResolvedPos, $to: ResolvedPos, parsed: PMNode): boolean {
  const depth = $from.depth - 1;
  // Different wrappers at each end: no one parent to ask. Leave those to the
  // block splice, which is what they had before.
  if ($to.depth !== $from.depth || $to.node(depth) !== $from.node(depth))
    return true;
  return $from
    .node(depth)
    .canReplace($from.index(depth), $to.indexAfter(depth), parsed.content);
}

/**
 * Land `next` in place of `old`. Returns the plain text that landed, or why
 * nothing did. Call it inside `editor.action`, with that action's `ctx`.
 */
export function applyEditIn(ctx: Ctx, old: string, next: string): ApplyResult {
  const view = ctx.get(editorViewCtx);
  const map = new TextMap(view.state.doc);
  const hit = findOnce(map.text, old);
  if (typeof hit === "number") return { ok: false, error: "stale", found: hit };
  const from = map.indexToPos(hit[0], "start");
  const to = map.indexToPos(hit[1], "end");
  if (from === null || to === null || to < from)
    return { ok: false, error: "stale", found: 0 };
  const { doc } = view.state;
  const markType = view.state.schema.marks.comment;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  // Comment marks on the passage, to carry onto the new text.
  const carried = new Set<string>();
  doc.nodesBetween(from, to, (node) => {
    for (const m of node.marks) {
      if (m.type === markType && m.attrs.id !== DRAFT_ID)
        carried.add(m.attrs.id as string);
    }
  });
  // Parsed on its own, `[^1]` would lose its definition and be saved
  // as `\[^1]`; see footnotes.ts.
  const parsed = next.trim()
    ? parseWithFootnotes(next, definedLabels(doc), ctx.get(parserCtx))
    : null;
  const tr = view.state.tr;
  // Whole blocks replaced by whole blocks keep their block types (a
  // heading stays a heading). Anything else is an inline splice: the
  // fragment's edges merge into the paragraph around the passage, the
  // way replacing text in the file splits or joins the surrounding
  // paragraph.
  const wholeBlocks =
    $from.parent.isTextblock &&
    $to.parent.isTextblock &&
    $from.parentOffset === 0 &&
    $to.parentOffset === $to.parent.content.size;
  // ...but only where the parsed blocks may stand. A list item holds a
  // paragraph first, so a list or a heading put in a paragraph's place is
  // not replacing it at all: the schema keeps the empty paragraph (saved as
  // `<br />`) and drops the new block in beneath it, nested and numbered
  // twice. Where the blocks do not fit, the words do: see `inlineContent`.
  const structural = wholeBlocks && !!parsed && fits($from, $to, parsed);
  if (!parsed) {
    if (wholeBlocks) {
      // Deleting the only block of a list item (or any wrapper) takes
      // the wrapper with it; an empty item would serialise as `<br />`.
      let d = $from.depth;
      while (
        d > 1 &&
        $from.node(d - 1).childCount === 1 &&
        $from.sameParent($to)
      )
        d--;
      tr.delete($from.before(d), $to.after(d));
    } else {
      tr.delete(from, to);
    }
  } else if (structural) {
    tr.replaceRange($from.before(), $to.after(), new Slice(parsed.content, 0, 0));
  } else {
    // The range takes inline content. One block's worth of prose is unwrapped
    // down to its words; anything with real structure (several blocks, a
    // table) is still spliced in as blocks, which splits the block around it.
    const inline = inlineContent(parsed.content);
    tr.replaceRange(
      from,
      to,
      inline ? new Slice(inline, 0, 0) : new Slice(parsed.content, 1, 1),
    );
  }
  const start = structural ? $from.before() : from;
  const end = tr.mapping.map(structural ? $to.after() : to);
  if (parsed && end > start) {
    for (const id of carried) tr.addMark(start, end, markType.create({ id }));
  }
  tr.setMeta("sidenote-apply", true);
  view.dispatch(tr);
  const landed = parsed && end > start ? tr.doc.textBetween(start, end, "\n") : "";
  return { ok: true, landed };
}
