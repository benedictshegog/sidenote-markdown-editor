// @vitest-environment jsdom
//
// What the editor puts on the clipboard as rich text. Both copy routes use
// this serializer: Cmd+C on a selection (ProseMirror's `clipboardSerializer`)
// and Copy Document As > Rich Text (`getHtml`).

import { afterEach, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import type { EditorView } from "@milkdown/kit/prose/view";

import { ClipboardSerializer } from "./clipboard";
import { stringifyOptions } from "./normalise";

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

async function copy(md: string): Promise<string> {
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
  crepe.editor.config((ctx) => {
    ctx.set(remarkStringifyOptionsCtx, { ...stringifyOptions });
    ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
  });
  await crepe.create();
  live.push(crepe);
  let html = "";
  crepe.editor.action((ctx) => {
    const view: EditorView = ctx.get(editorViewCtx);
    const holder = document.createElement("div");
    ClipboardSerializer.forSchema(view.state.schema).serializeFragment(
      view.state.doc.content,
      undefined,
      holder,
    );
    html = holder.innerHTML;
  });
  return html;
}

const DOC = `# Heading

Some **bold**, _italic_, \`code\` and a [link](https://example.com).

1. First item
2. Second item

- A bullet

> A quote

\`\`\`js
const a = 1;
\`\`\`
`;

describe("copied rich text", () => {
  it("carries no colour of its own", async () => {
    const html = await copy(DOC);
    // WebKit annotates the top-level elements with the copy context's
    // computed style on the way to the pasteboard. In dark mode that is white
    // text, which is invisible in Gmail's compose window. Saying the colour
    // ourselves is what keeps it out: nothing here may name a colour, and
    // every block has to say `inherit` so the annotation has no last word.
    const tight = html.replace(/\s*:\s*/g, ":").toLowerCase();
    expect(tight).not.toMatch(/[a-z-]*color:(?!inherit|auto)/);
    expect(html).not.toMatch(/rgb\(/i);
    for (const tag of ["h1", "p", "ol", "li", "ul", "blockquote", "pre"]) {
      const el = document.createElement("div");
      el.innerHTML = html;
      for (const node of el.querySelectorAll(tag)) {
        expect(
          (node as HTMLElement).style.color,
          `<${tag}> must say color: inherit`,
        ).toBe("inherit");
      }
    }
  });

  it("keeps the formatting worth keeping", async () => {
    const html = await copy(DOC);
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("<code>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<h1");
    expect(html).toContain("<ol");
    expect(html).toContain("<ul");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;");
  });

  it("still says margin:0 on every block, for mail clients", async () => {
    const html = await copy(DOC);
    const el = document.createElement("div");
    el.innerHTML = html;
    for (const node of el.querySelectorAll("h1, p, ol, ul, blockquote, pre")) {
      expect((node as HTMLElement).style.margin).toBe("0px");
    }
  });
});
