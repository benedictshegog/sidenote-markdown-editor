// Cmd+F. Matches are inline decorations, like presence: they live in view
// state, never touch the document or the comment marks, and are rebuilt from
// the current doc on every change while a query is set. A match is found
// inside one text node only; text that crosses a mark boundary (a comment
// highlight or bold text mid-word) is not matched. Case-insensitive.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

export interface FindState {
  query: string;
  /** Index into `matches` of the highlighted one, or -1 when there are none. */
  current: number;
  matches: { from: number; to: number }[];
  decos: DecorationSet;
}

export const findKey = new PluginKey<FindState>("sidenote-find");

/** Meta payload. `step` moves `current` by that many, wrapping. */
type FindMeta = { query?: string; step?: number; clear?: boolean };

export function setFindMeta(tr: Transaction, meta: FindMeta): Transaction {
  return tr.setMeta(findKey, meta);
}

const EMPTY: FindState = {
  query: "",
  current: -1,
  matches: [],
  decos: DecorationSet.empty,
};

function locate(
  state: EditorState,
  query: string,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!query) return out;
  const needle = query.toLowerCase();
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const hay = node.text.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push({ from: pos + i, to: pos + i + needle.length });
      i = hay.indexOf(needle, i + needle.length);
    }
    return true;
  });
  return out;
}

function build(state: EditorState, query: string, current: number): FindState {
  const matches = locate(state, query);
  if (!matches.length)
    return { query, current: -1, matches, decos: DecorationSet.empty };
  const cur = ((current % matches.length) + matches.length) % matches.length;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class:
        i === cur ? "sidenote-find sidenote-find-current" : "sidenote-find",
    }),
  );
  return {
    query,
    current: cur,
    matches,
    decos: DecorationSet.create(state.doc, decos),
  };
}

export const findPlugin = new Plugin<FindState>({
  key: findKey,
  state: {
    init: () => EMPTY,
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(findKey) as FindMeta | undefined;
      if (meta?.clear) return EMPTY;
      if (meta?.query !== undefined) {
        // A new query starts from the first match at or after the selection,
        // so Cmd+F then typing lands near where the reader is.
        const at = newState.selection.from;
        const matches = locate(newState, meta.query);
        let first = matches.findIndex((m) => m.from >= at);
        if (first === -1) first = 0;
        return build(newState, meta.query, first);
      }
      if (meta?.step)
        return build(newState, value.query, value.current + meta.step);
      if (tr.docChanged && value.query)
        return build(newState, value.query, value.current);
      return value;
    },
  },
  props: {
    decorations: (state) =>
      findKey.getState(state)?.decos ?? DecorationSet.empty,
  },
});
