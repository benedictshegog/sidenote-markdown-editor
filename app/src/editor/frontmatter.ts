// YAML front matter: the `---` block at byte 0 of a file, as Claude Code
// skills, Jekyll and Hugo pages carry it. CommonMark has no such thing, so
// without this the opening fence parsed as a rule, the keys as a paragraph and
// the closing fence as a setext underline, and the next save wrote back a
// blank line, a long `-----` underline and `\[` escapes inside the YAML.
//
// remark-frontmatter reads the block into an mdast `yaml` node and writes it
// back verbatim. Here it becomes a `frontmatter` node: a code-like textblock
// (plain text, no marks, no markdown) that the serialiser hands back as that
// same `yaml` node. It is shown, and editable, as raw text.
//
// It is not part of the prose. `TextMap` and `getPlainText` leave it out, and
// `core::plain` strips the same block, so comments, `sidenote apply` and
// suggestions cannot land in it.

import remarkFrontmatter from "remark-frontmatter";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";

export const FRONTMATTER = "frontmatter";

export const remarkFrontmatterPlugin = $remark(
  "remarkFrontmatter",
  () => remarkFrontmatter,
  ["yaml"],
);

export const frontmatterSchema = $nodeSchema(FRONTMATTER, () => ({
  content: "text*",
  group: "block",
  marks: "",
  code: true,
  defining: true,
  parseDOM: [
    {
      tag: 'pre[data-type="frontmatter"]',
      preserveWhitespace: "full",
      // Ahead of the code block's plain `pre` rule.
      priority: 60,
    },
  ],
  toDOM: () => [
    "pre",
    {
      "data-type": FRONTMATTER,
      class: "sidenote-frontmatter",
      spellcheck: "false",
    },
    ["code", 0],
  ],
  parseMarkdown: {
    match: ({ type }) => type === "yaml",
    runner: (state, node, type) => {
      state.openNode(type);
      const value = node.value as string | undefined;
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === FRONTMATTER,
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.textContent);
    },
  },
}));

/** Size of the front matter node at the top of `doc`, or 0 when it has none. */
export function frontmatterSize(doc: PMNode): number {
  const first = doc.firstChild;
  return first?.type.name === FRONTMATTER ? first.nodeSize : 0;
}

/**
 * Keep the block where the syntax allows it. Front matter is only front
 * matter at byte 0: anywhere else, `---` fences read back as a rule and a
 * setext heading, the corruption this module exists to stop. So a block that
 * ends up anywhere but first (a paste, a moved block, an edit whose new text
 * began with `---`) becomes a YAML code block, which keeps its text.
 */
function keepAtTop(): Plugin {
  return new Plugin({
    key: new PluginKey("sidenote-frontmatter"),
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.docChanged)) return null;
      const code = state.schema.nodes.code_block;
      if (!code) return null;
      const stray: number[] = [];
      state.doc.descendants((node, pos, parent, index) => {
        if (node.type.name !== FRONTMATTER) return true;
        if (parent !== state.doc || index !== 0) stray.push(pos);
        return false;
      });
      if (!stray.length) return null;
      const tr = state.tr;
      for (const pos of stray)
        tr.setNodeMarkup(pos, code, { language: "yaml" });
      return tr;
    },
    props: {
      handleKeyDown: (view, event) => guardEdges(view, event),
    },
  });
}

/**
 * Backspace at the start of the block under the front matter, or Delete at
 * the end of the front matter, would join the two: the paragraph's words
 * would land inside the YAML. Refuse, the way a code block's edge is a wall
 * in most editors. An empty block under it still goes, as it would anywhere.
 */
function guardEdges(view: EditorView, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key !== "Backspace" && event.key !== "Delete") return false;
  const size = frontmatterSize(view.state.doc);
  if (!size) return false;
  const { $from, empty } = view.state.selection;
  if (!empty) return false;
  if (event.key === "Backspace") {
    // The cursor sits at the start of the top-level textblock right after
    // it. Deeper blocks (a list item, a quote) lift out instead of joining.
    if ($from.depth !== 1 || $from.parentOffset !== 0) return false;
    if ($from.before() !== size) return false;
    return $from.parent.content.size > 0;
  }
  // Delete at the very end of the front matter.
  const inside = $from.depth === 1 && $from.parent.type.name === FRONTMATTER;
  return inside && $from.parentOffset === $from.parent.content.size;
}

export const frontmatterGuard = $prose(() => keepAtTop());

/** Everything the editor needs for front matter, in `.use()` order. */
export const frontmatter = [
  remarkFrontmatterPlugin,
  frontmatterSchema,
  frontmatterGuard,
].flat() as MilkdownPlugin[];

/**
 * Split `md` into its front matter block (fences and the newline after the
 * closing one included) and the rest. Mirrors remark-frontmatter: an opening
 * `---` on the first line, then the first line that is `---` again, either
 * allowing trailing spaces or tabs. Returns an empty head when there is none.
 */
export function splitFrontmatter(md: string): [string, string] {
  const open = /^---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!open) return ["", md];
  const close = /^---[ \t]*(?:\r?\n|$)/m;
  const rest = md.slice(open[0].length);
  const m = close.exec(rest);
  if (!m) return ["", md];
  const end = open[0].length + m.index + m[0].length;
  return [md.slice(0, end), md.slice(end)];
}
