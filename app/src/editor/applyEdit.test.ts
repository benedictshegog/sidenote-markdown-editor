// @vitest-environment jsdom
//
// `sidenote apply --old ... --new ...` landing in a live editor: the same
// Crepe the app builds, the same markdown pipeline, and `normaliseMarkdown`
// on the way out, which is what a save writes to disk.

import { afterEach, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";

import { applyEditIn } from "./applyEdit";
import { commentMark } from "./commentMark";
import { frontmatter } from "./frontmatter";
import { normaliseMarkdown, stringifyOptions } from "./normalise";

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
    .use(frontmatter)
    .use(commentMark);
  await crepe.create();
  live.push(crepe);
  return crepe;
}

/** Apply one edit and give back the markdown a save would write. */
async function apply(md: string, old: string, next: string): Promise<string> {
  const crepe = await load(md);
  let result: ReturnType<typeof applyEditIn> | null = null;
  crepe.editor.action((ctx) => {
    result = applyEditIn(ctx, old, next);
  });
  expect(result).toMatchObject({ ok: true });
  return normaliseMarkdown(crepe.getMarkdown());
}

const LIST = `1. **One.** First sentence. Second sentence.
2. **Two.** First sentence. Second sentence.
3. **Three.** First sentence. Second sentence.
`;

describe("block markdown in an inline range", () => {
  it("replaces the words without nesting a second list", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence.",
      "**Two, rewritten.** A new sentence.",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two, rewritten.** A new sentence. Second sentence.
3. **Three.** First sentence. Second sentence.
`);
  });

  it("drops a list marker the replacement repeats", async () => {
    // What `sidenote apply` is given in practice: the caller copies the item
    // back, marker and all. The item it lands in already has a marker.
    const out = await apply(
      LIST,
      "Two. First sentence.",
      "2. **Two, rewritten.** A new sentence.",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two, rewritten.** A new sentence. Second sentence.
3. **Three.** First sentence. Second sentence.
`);
  });

  it("drops a list marker when the range spans two items", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence. Second sentence.\nThree.",
      "2. **Two and three.**",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two and three.** First sentence. Second sentence.
`);
  });

  it("does not quote a paragraph when the replacement starts with >", async () => {
    const out = await apply(
      "Before. Middle. After.\n",
      "Middle.",
      "> Quoted middle.",
    );
    expect(out).toBe("Before. Quoted middle. After.\n");
  });

  it("does not make a heading of words inside a paragraph", async () => {
    const out = await apply(
      "Before. Middle. After.\n",
      "Middle.",
      "## Middle again.",
    );
    expect(out).toBe("Before. Middle again. After.\n");
  });
});

describe("block markdown replacing a whole list item", () => {
  it("keeps one item, not an item with a list inside it", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence. Second sentence.",
      "2. **Two, rewritten.** Only sentence.",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two, rewritten.** Only sentence.
3. **Three.** First sentence. Second sentence.
`);
  });

  it("takes several items in place of one, and renumbers", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence. Second sentence.",
      "2. **Two.**\n3. **Two and a half.**",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two.**
3. **Two and a half.**
4. **Three.** First sentence. Second sentence.
`);
  });

  it("does not leave an empty block when the replacement is a quote", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence. Second sentence.",
      "> Quoted.",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. Quoted.
3. **Three.** First sentence. Second sentence.
`);
  });
});

describe("whole blocks keep their structure", () => {
  it("replaces a whole item with a whole item", async () => {
    const out = await apply(
      LIST,
      "Two. First sentence. Second sentence.",
      "**Two, rewritten.** Only sentence.",
    );
    expect(out).toBe(`1. **One.** First sentence. Second sentence.
2. **Two, rewritten.** Only sentence.
3. **Three.** First sentence. Second sentence.
`);
  });

  it("turns a whole paragraph into a heading when asked", async () => {
    const out = await apply(
      "Before.\n\nMiddle.\n\nAfter.\n",
      "Middle.",
      "## Middle.",
    );
    expect(out).toBe("Before.\n\n## Middle.\n\nAfter.\n");
  });

  it("turns a whole paragraph into a list when asked", async () => {
    const out = await apply(
      "Before.\n\nMiddle.\n\nAfter.\n",
      "Middle.",
      "- one\n- two\n",
    );
    expect(out).toBe("Before.\n\n- one\n- two\n\nAfter.\n");
  });

  it("still splices several paragraphs into an inline range", async () => {
    const out = await apply(
      "Before. Middle. After.\n",
      "Middle.",
      "One.\n\nTwo.",
    );
    expect(out).toBe("Before. One.\n\nTwo. After.\n");
  });
});
