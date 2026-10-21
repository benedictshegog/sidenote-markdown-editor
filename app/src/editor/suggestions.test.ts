// @vitest-environment jsdom
//
// How a suggestion is drawn: the deletions marked in place, the insertions as
// widgets, and the edges that keep two neighbouring suggestions apart.

import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import type { Decoration } from "@milkdown/kit/prose/view";

import { setSuggestionsMeta, suggestionKey, suggestionPlugin, type SuggestionRange } from "./suggestions";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

const SENTENCE_A = "Old first sentence here.";
const SENTENCE_B = "Old second one.";
const TEXT = `${SENTENCE_A} ${SENTENCE_B}`;

function draw(ranges: SuggestionRange[]): Decoration[] {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(TEXT)])]);
  let state = EditorState.create({ doc, plugins: [suggestionPlugin] });
  state = state.apply(setSuggestionsMeta(state.tr, ranges));
  return suggestionKey.getState(state)!.find();
}

const cls = (d: Decoration) => String((d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class ?? "");
const isWidget = (d: Decoration) => d.from === d.to && !(d as unknown as { type: { attrs?: unknown } }).type.attrs;

const dom = (d: Decoration) => (d as unknown as { type: { toDOM: () => HTMLElement } }).type.toDOM();

// Paragraph content starts at 1.
const A_FROM = 1;
const B_FROM = 1 + SENTENCE_A.length + 1;

describe("suggestion drawing", () => {
  it("draws a rewrite as one struck block and the exact new text after it", () => {
    const next = " A wholly new first sentence.";
    const decos = draw([
      {
        id: "s1",
        from: A_FROM,
        segs: [
          { kind: "delete", text: SENTENCE_A },
          { kind: "insert", text: next },
        ],
        selected: false,
      },
    ]);
    const del = decos.filter((d) => cls(d) === "sidenote-sug-del");
    expect(del).toHaveLength(1);
    expect([del[0].from, del[0].to]).toEqual([A_FROM, A_FROM + SENTENCE_A.length]);

    const els = decos.filter(isWidget).map(dom);
    const added = els.filter((e) => e.classList.contains("sidenote-sug-add"));
    expect(added).toHaveLength(1);
    expect(added[0].textContent).toBe(next);
    // It finishes the suggestion, so it carries the end gap itself.
    expect(added[0].classList.contains("sidenote-sug-end")).toBe(true);
    expect(els.filter((e) => e.className === "sidenote-sug-end")).toHaveLength(0);
  });

  it("marks where each of two neighbouring suggestions starts and ends", () => {
    const decos = draw([
      {
        id: "s1",
        from: A_FROM,
        segs: [
          { kind: "equal", text: "Old " },
          { kind: "delete", text: "first " },
          { kind: "insert", text: "1st " },
          { kind: "equal", text: "sentence here." },
        ],
        selected: false,
      },
      {
        id: "s2",
        from: B_FROM,
        segs: [
          { kind: "delete", text: "Old " },
          { kind: "equal", text: "second one." },
        ],
        selected: false,
      },
    ]);
    const at = (c: string) =>
      decos.filter((d) => isWidget(d) && dom(d).className === c).map((d) => d.from);
    const starts = at("sidenote-sug-start");
    const ends = at("sidenote-sug-end");
    expect(starts.sort((a, b) => a - b)).toEqual([A_FROM, B_FROM]);
    expect(ends.sort((a, b) => a - b)).toEqual([A_FROM + SENTENCE_A.length, B_FROM + SENTENCE_B.length]);
  });
});
