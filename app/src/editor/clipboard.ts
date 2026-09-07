// What leaves the editor as rich text. Both routes go through here: a plain
// Cmd+C on a selection (ProseMirror's `clipboardSerializer` prop) and
// "Copy as Rich Text" (`getHtml`).
//
// The bare `<p>` HTML ProseMirror produces has no margins, so every mail
// client that pastes it applies its own paragraph spacing: Word-engine Outlook
// gives each paragraph "Normal (Web)" space before and after, and the web
// editor in new Outlook keeps the browser's 1em on each side. Either way the
// paste does not match text typed in the message, and the fix on the receiving
// end is a manual "remove space before/after paragraph".
//
// So the HTML says what it wants. Every block carries `margin:0`, which both
// engines honour, and the gap between two top-level blocks is an empty
// paragraph, which is exactly how Outlook itself writes a blank line. A heading
// is followed directly by its text, as it would be in a typed message.

import { schemaCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  DOMSerializer,
  Fragment,
  type DOMOutputSpec,
  type Node as PMNode,
  type Schema,
} from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";

const BLOCK_MARGIN = "margin:0";

/** Marks the separator paragraphs so a paste back into the editor can drop them. */
const GAP_ATTR = "data-sidenote-gap";

type Spec = (node: PMNode) => DOMOutputSpec;

function isAttrs(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Node)
  );
}

/** Add `margin:0` to the element a block node's spec produces. */
function withMargin(spec: DOMOutputSpec): DOMOutputSpec {
  if (Array.isArray(spec)) {
    const [tag, second, ...rest] = spec as unknown[];
    if (isAttrs(second)) {
      const style = second.style ? `${second.style};${BLOCK_MARGIN}` : BLOCK_MARGIN;
      return [tag, { ...second, style }, ...rest] as DOMOutputSpec;
    }
    const tail = second === undefined ? rest : [second, ...rest];
    return [tag, { style: BLOCK_MARGIN }, ...tail] as unknown as DOMOutputSpec;
  }
  if (spec instanceof HTMLElement) {
    spec.style.margin = "0";
  } else if (
    typeof spec === "object" &&
    spec !== null &&
    "dom" in spec &&
    spec.dom instanceof HTMLElement
  ) {
    spec.dom.style.margin = "0";
  }
  return spec;
}

/** Comment highlights are Sidenote's, not the document's. Unwrap them. */
function unwrapComments(root: ParentNode): void {
  root.querySelectorAll("[data-comment-id]").forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE",
  "TABLE", "HR", "DIV", "DL", "FIGURE",
]);

function isBlock(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName);
}

/** A blank line between top-level blocks, the way Outlook writes one. A
 *  selection inside one paragraph serialises as inline nodes, which get no
 *  separators. */
function separateBlocks(root: ParentNode): void {
  const doc = root.ownerDocument ?? document;
  const blocks = Array.from(root.children);
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    if (!isBlock(prev) || !isBlock(blocks[i]) || isHeading(prev)) continue;
    const gap = doc.createElement("p");
    gap.setAttribute("style", BLOCK_MARGIN);
    gap.setAttribute(GAP_ATTR, "");
    gap.innerHTML = "&nbsp;";
    root.insertBefore(gap, blocks[i]);
  }
}

export class ClipboardSerializer extends DOMSerializer {
  static forSchema(schema: Schema): ClipboardSerializer {
    const base = DOMSerializer.fromSchema(schema);
    const nodes: Record<string, Spec> = {};
    for (const [name, spec] of Object.entries(base.nodes)) {
      nodes[name] = schema.nodes[name]?.isBlock
        ? (node) => withMargin(spec(node))
        : spec;
    }
    return new ClipboardSerializer(nodes, base.marks);
  }

  override serializeFragment(
    fragment: Fragment,
    options?: { document?: Document },
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const out = super.serializeFragment(fragment, options, target);
    unwrapComments(out);
    separateBlocks(out);
    return out;
  }
}

/** Drop the separator paragraphs when the editor's own output comes back in. */
export function stripGaps(html: string): string {
  if (!html.includes(GAP_ATTR)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll(`p[${GAP_ATTR}]`).forEach((el) => el.remove());
  return template.innerHTML;
}

export const clipboardKey = new PluginKey("sidenote-clipboard");

export function clipboardPlugin(ctx: Ctx): Plugin {
  const serializer = ClipboardSerializer.forSchema(ctx.get(schemaCtx));
  return new Plugin({
    key: clipboardKey,
    props: {
      clipboardSerializer: serializer,
      transformPastedHTML: stripGaps,
    },
  });
}
