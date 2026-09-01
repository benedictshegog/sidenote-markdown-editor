// Suggested edits drawn in the prose, the way a word processor shows tracked
// changes: what would go has a line through it, what would arrive sits beside
// it, and the sentence still reads left to right.
//
// Only the deletions are really in the document. `quote` is text the file
// already holds, so the `equal` and `delete` segments are marked in place with
// inline decorations. The insertions exist nowhere yet, so each one is a
// widget the editor draws — which is also why they cannot be typed into or
// selected as text. That asymmetry is the honest one: accepting is what makes
// the inserted words part of the document.
//
// Nothing here writes anything. The plugin is view state rebuilt from
// `suggestions.json`, and dropping it changes no text.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Seg } from '../types'

/** One suggestion, already located in the document. */
export interface SuggestionRange {
  id: string
  /** Start of `quote` in the document. */
  from: number
  segs: Seg[]
  /** Drawn as the one the margin card is on. */
  selected: boolean
}

export const suggestionKey = new PluginKey<DecorationSet>('sidenote-suggestions')

type SetSuggestions = { ranges: SuggestionRange[] }

export function setSuggestionsMeta(tr: Transaction, ranges: SuggestionRange[]): Transaction {
  return tr.setMeta(suggestionKey, { ranges } satisfies SetSuggestions)
}

/** The inserted words, as an element. Rendered by the editor rather than
 *  stored, so it carries no position of its own and cannot be edited. */
function addition(text: string, id: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'sidenote-sug-add' 
  span.setAttribute('data-suggestion-id', id)
  // `textContent`, never innerHTML: this is document text from a file, and it
  // gets nowhere near the HTML parser.
  span.textContent = text
  return span
}

function build(state: EditorState, ranges: SuggestionRange[]): DecorationSet {
  const size = state.doc.content.size
  const decos: Decoration[] = []

  for (const r of ranges) {
    // Walk the segments, advancing through `quote` as we go. `equal` and
    // `delete` are in the document and take up room; `insert` is not and does
    // not. That is the whole placement rule, and it is why the backend
    // guarantees those two rebuild `quote` exactly.
    let pos = r.from
    for (const seg of r.segs) {
      if (seg.kind === 'insert') {
        if (pos >= 0 && pos <= size) {
          decos.push(
            Decoration.widget(pos, () => addition(seg.text, r.id), {
              // Sit after any deletion that ends here, so a replacement reads
              // "old new" rather than "new old".
              side: 1,
              // The widget is not part of the document: keep it out of copied
              // text and out of the markdown the serialiser sees.
              ignoreSelection: true,
              marks: [],
            }),
          )
        }
        continue
      }
      const to = pos + seg.text.length
      if (seg.kind === 'delete' && to > pos && pos >= 0 && to <= size) {
        decos.push(
          Decoration.inline(pos, to, {
            class: 'sidenote-sug-del',
            'data-suggestion-id': r.id,
          }),
        )
      }
      pos = to
    }

    // A band over the whole passage, so a suggestion is one visible object
    // rather than a scatter of marks, and so clicking anywhere in it selects
    // the card.
    const end = pos
    if (end > r.from && r.from >= 0 && end <= size) {
      decos.push(
        Decoration.inline(r.from, end, {
          class: `sidenote-sug${r.selected ? ' is-selected' : ''}`,
          'data-suggestion-id': r.id,
          title: 'Suggested by Claude — accept or reject it in the margin',
        }),
      )
    }
  }
  return DecorationSet.create(state.doc, decos)
}

export const suggestionPlugin = new Plugin<DecorationSet>({
  key: suggestionKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(suggestionKey) as SetSuggestions | undefined
      if (meta) return build(newState, meta.ranges)
      // Typing before a suggestion should carry it along rather than leave it
      // pointing at the wrong words. ProseMirror maps for us; whether the
      // suggestion still applies at all is a separate question, answered by
      // searching for its text again once the typing settles.
      return tr.docChanged ? value.map(tr.mapping, tr.doc) : value
    },
  },
  props: {
    decorations: (state) => suggestionKey.getState(state) ?? DecorationSet.empty,
  },
})

/** The suggestion id at a click, if the click landed in one. */
export function suggestionAt(target: EventTarget | null): string | null {
  const el = target instanceof HTMLElement ? target.closest('[data-suggestion-id]') : null
  return el?.getAttribute('data-suggestion-id') ?? null
}
