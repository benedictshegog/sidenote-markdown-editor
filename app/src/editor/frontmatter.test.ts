// @vitest-environment jsdom
//
// Round trips through the editor's own markdown pipeline: Crepe with the
// options and plugins `Editor.tsx` gives it, then `normaliseMarkdown`, which
// is what a save writes to disk.

import { afterEach, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import type { EditorView } from "@milkdown/kit/prose/view";

import { frontmatter, FRONTMATTER, splitFrontmatter } from "./frontmatter";
import { normaliseMarkdown, stringifyOptions } from "./normalise";
import { TextMap } from "./textmap";

// jsdom has no IntersectionObserver; Crepe's code block view asks for one.
globalThis.IntersectionObserver ??= class {
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

async function load(md: string): Promise<Crepe> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: md,
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.AI]: false,
    },
  });
  crepe.editor
    .config((ctx) => {
      ctx.set(remarkStringifyOptionsCtx, { ...stringifyOptions });
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
    })
    .use(frontmatter);
  await crepe.create();
  live.push(crepe);
  return crepe;
}

const save = (crepe: Crepe) => normaliseMarkdown(crepe.getMarkdown());

function view(crepe: Crepe): EditorView {
  let v: EditorView | null = null;
  crepe.editor.action((ctx) => {
    v = ctx.get(editorViewCtx);
  });
  return v!;
}

async function roundTrip(md: string): Promise<string> {
  const crepe = await load(md);
  const once = save(crepe);
  // A second pass: what the editor holds after reading its own output.
  const again = save(await load(once));
  expect(again).toBe(once);
  return once;
}

const SKILL = `---
name: push
description: Some text. Use when ...
argument-hint: "[PR number or URL] [instructions]"
---

# Heading
`;

describe("front matter round trip", () => {
  it("keeps a skill header byte for byte", async () => {
    expect(await roundTrip(SKILL)).toBe(SKILL);
  });

  it("does not escape or reflow markdown characters inside the YAML", async () => {
    const md = `---
description: "Use when: the user says \\"ship it\\", or 'push'."
title: a [link](x) and [x] ~strike~ ~~gone~~ *star* **bold** _under_ __dunder__
path: ~/Documents/Code/*.md
list:
  - one_two_three
  - "#hash & <tag> | pipe"
long: ${"word ".repeat(40).trim()}
---

Body text.
`;
    expect(await roundTrip(md)).toBe(md);
  });

  it("keeps an empty block and blank lines inside it", async () => {
    expect(await roundTrip("---\n---\n\nBody.\n")).toBe("---\n---\n\nBody.\n");
    const md = "---\na: 1\n\n# not a heading\n\nb: 2\n---\n\nBody.\n";
    expect(await roundTrip(md)).toBe(md);
  });

  it("keeps a file that is only front matter", async () => {
    const md = "---\nname: x\n---\n";
    expect(await roundTrip(md)).toBe(md);
  });

  it("reads the block as one front matter node, not prose", async () => {
    const crepe = await load(SKILL);
    const doc = view(crepe).state.doc;
    expect(doc.firstChild?.type.name).toBe(FRONTMATTER);
    expect(doc.firstChild?.textContent).toBe(
      'name: push\ndescription: Some text. Use when ...\nargument-hint: "[PR number or URL] [instructions]"',
    );
    expect(doc.child(1).type.name).toBe("heading");
    expect(view(crepe).dom.querySelector("pre.sidenote-frontmatter")).not.toBeNull();
  });
});

describe("documents without front matter", () => {
  it("round trip as before", async () => {
    const md = `# Title

Some _emphasis_, **strong** and \`code\`.

- one
- two

| a | b |
|---|---|
| 1 | 2 |
`;
    expect(await roundTrip(md)).toBe(md);
  });

  it("keep a rule that is not at byte 0 as a rule", async () => {
    const md = "Intro.\n\n---\n\nname: push\n\n---\n\nAfter.\n";
    const crepe = await load(md);
    const doc = view(crepe).state.doc;
    const names: string[] = [];
    doc.forEach((n) => names.push(n.type.name));
    expect(names).not.toContain(FRONTMATTER);
    expect(names.filter((n) => n === "hr")).toHaveLength(2);
    expect(save(crepe)).toBe(md);
  });

  it("keep a setext heading under text as a heading", async () => {
    const crepe = await load("Intro.\n\n---\nname: push\n---\n");
    const names: string[] = [];
    view(crepe).state.doc.forEach((n) => names.push(n.type.name));
    expect(names).toEqual(["paragraph", "hr", "heading"]);
  });
});

describe("front matter stays out of the prose", () => {
  it("is not in the text comments and edits are matched against", async () => {
    const crepe = await load(SKILL);
    const map = new TextMap(view(crepe).state.doc);
    expect(map.text).toBe("Heading");
  });

  it("takes no comment mark", async () => {
    const crepe = await load(SKILL);
    const v = view(crepe);
    const mark = v.state.schema.marks.comment;
    // Not registered in this harness; the schema rule is what matters.
    const fm = v.state.schema.nodes[FRONTMATTER];
    expect(fm.spec.marks).toBe("");
    if (mark) expect(fm.allowsMarkType(mark)).toBe(false);
  });

  it("turns a block moved below the top into a YAML code block", async () => {
    const crepe = await load(SKILL);
    const v = view(crepe);
    const fm = v.state.doc.firstChild!;
    const end = v.state.doc.content.size;
    v.dispatch(v.state.tr.insert(end, fm.copy(fm.content)));
    const names: string[] = [];
    v.state.doc.forEach((n) => names.push(n.type.name));
    // Crepe's trailing plugin keeps an empty paragraph last.
    expect(names).toEqual([FRONTMATTER, "heading", "code_block", "paragraph"]);
    const moved = v.state.doc.child(2);
    expect(moved.attrs.language).toBe("yaml");
    expect(moved.textContent).toBe(fm.textContent);
    expect(save(crepe)).toBe(
      SKILL + "\n```yaml\n" + fm.textContent + "\n```\n",
    );
  });
});

describe("normaliseMarkdown", () => {
  it("leaves the YAML alone", () => {
    const md =
      "---\nurl: <https://example.com>\nx: a \\& b\n|<br />|\n---\n\n<https://example.com> a \\& b\n";
    expect(normaliseMarkdown(md)).toBe(
      "---\nurl: <https://example.com>\nx: a \\& b\n|<br />|\n---\n\nhttps://example.com a & b\n",
    );
  });

  it("splits only at byte 0", () => {
    expect(splitFrontmatter("---\na: 1\n---\n\nB\n")).toEqual([
      "---\na: 1\n---\n",
      "\nB\n",
    ]);
    expect(splitFrontmatter("x\n---\na\n---\n")[0]).toBe("");
    expect(splitFrontmatter("---\nno close\n")[0]).toBe("");
  });
});
