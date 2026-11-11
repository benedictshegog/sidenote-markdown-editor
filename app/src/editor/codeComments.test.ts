// @vitest-environment jsdom
//
// A comment on text inside a code block, in the same Crepe the app builds:
// the mark lands, the highlight is drawn, and the file a save writes is
// unchanged.

import { afterEach, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";

import { allowCommentsInCode, codeRanges, createCodeComments } from "./codeComments";
import { commentMark } from "./commentMark";
import { frontmatter } from "./frontmatter";
import { normaliseMarkdown, stringifyOptions } from "./normalise";
import { TextMap } from "./textmap";

// jsdom has no IntersectionObserver; Crepe's code block view asks for one.
// This one is driven by hand, to bring a block "on screen".
const observers: { cb: IntersectionObserverCallback }[] & IntersectionObserver[] = [];
globalThis.IntersectionObserver = class {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push(this as never);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

const live: Crepe[] = [];

afterEach(async () => {
  while (live.length) await live.pop()!.destroy();
});

const MD = "Before.\n\n```sh\nmake build\nmake test\n```\n\nAfter.\n";

async function load(md: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const code = createCodeComments();
  const crepe = new Crepe({
    root,
    defaultValue: md,
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.AI]: false,
    },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: { extensions: [code.extension] },
    },
  });
  crepe.editor
    .config((ctx) => {
      ctx.set(remarkStringifyOptionsCtx, { ...stringifyOptions });
      allowCommentsInCode(ctx);
    })
    .use(frontmatter)
    .use(commentMark)
    .use($prose(() => code.plugin));
  await crepe.create();
  live.push(crepe);
  return { crepe, root, code };
}

/** Mark `words` (found in the linearised text) as comment `id`. */
function comment(crepe: Crepe, words: string, id: string) {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const map = new TextMap(view.state.doc);
    const at = map.text.indexOf(words);
    expect(at).toBeGreaterThanOrEqual(0);
    const type = view.state.schema.marks.comment;
    const tr = view.state.tr;
    for (const r of map.rangesFor(at, at + words.length))
      tr.addMark(r.from, r.to, type.create({ id }));
    view.dispatch(tr);
  });
}

function codeBlock(crepe: Crepe) {
  let found: ReturnType<typeof codeRanges> = [];
  crepe.editor.action((ctx) => {
    ctx.get(editorViewCtx).state.doc.descendants((node) => {
      if (node.type.name === "code_block") found = codeRanges(node);
    });
  });
  return found;
}

describe("a comment inside a code block", () => {
  it("is highlighted in CodeMirror once the block is on screen", async () => {
    const { crepe, root } = await load(MD);
    comment(crepe, "make test", "c4");
    // Scroll the block into view, as the observer would report it.
    const block = root.querySelector(".milkdown-code-block")!;
    for (const o of observers) o.cb([{ target: block, isIntersecting: true } as IntersectionObserverEntry], o);
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelector(".cm-editor")).not.toBeNull();
    expect(root.querySelector('.cm-content [data-comment-id="c4"]')?.textContent).toBe("make test");
    // And a comment made while it is live.
    comment(crepe, "build", "c5");
    expect(root.querySelector('.cm-content [data-comment-id="c5"]')?.textContent).toBe("build");
    expect(normaliseMarkdown(crepe.getMarkdown())).toBe(MD);
  });

  it("lands on the code and leaves the saved markdown alone", async () => {
    const { crepe } = await load(MD);
    comment(crepe, "build", "c1");
    expect(codeBlock(crepe)).toEqual([{ from: 5, to: 10, id: "c1" }]);
    expect(normaliseMarkdown(crepe.getMarkdown())).toBe(MD);
  });

  it("is highlighted in the block's placeholder", async () => {
    const { crepe, root } = await load(MD);
    comment(crepe, "make test", "c2");
    const el = root.querySelector('pre [data-comment-id="c2"]');
    expect(el?.textContent).toBe("make test");
    expect(root.querySelector("pre code")?.textContent).toBe("make build\nmake test");
  });

  it("draws the selected comment as selected, and overlaps nested", async () => {
    const { crepe, root, code } = await load(MD);
    comment(crepe, "make build", "c1");
    comment(crepe, "build\nmake", "c2");
    code.setSelected("c2");
    const both = root.querySelector('[data-comment-id="c1"] [data-comment-id="c2"], [data-comment-id="c2"] [data-comment-id="c1"]');
    expect(both?.textContent).toBe("build");
    expect(root.querySelector('[data-comment-id="c2"]')?.className).toContain("sidenote-comment-selected");
    expect(root.querySelector('[data-comment-id="c1"]')?.className).not.toContain("sidenote-comment-selected");
    expect(normaliseMarkdown(crepe.getMarkdown())).toBe(MD);
  });

  it("covers prose and code in one comment", async () => {
    const { crepe, root } = await load(MD);
    comment(crepe, "Before.\nmake", "c3");
    const parts = [...root.querySelectorAll('[data-comment-id="c3"]')].map((e) => e.textContent);
    expect(parts).toEqual(["Before.", "make"]);
  });
});
