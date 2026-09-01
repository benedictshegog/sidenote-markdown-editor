// Where Claude is working, shown on the comment highlights that are already
// there rather than in furniture of its own. A thread Claude has in hand gets
// its own highlight brightened; the passage an edit lands on flashes once and
// settles. No second colour system, and nothing to read in the gutter.
//
// These are inline decorations, so they sit outside the comment mark in the
// DOM. Both tints are translucent, so the decoration's colour and the mark's
// colour stack — which is what makes "brighter" fall out for free, and what
// lets the flash show on a passage that carries no comment at all.
//
// Nothing here locks anything. The decorations are view state, rebuilt from
// `threads.json` and `state.json`, and dropped the moment the owning session
// disconnects.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

/** One text range Claude has in hand, already located in the document. */
export interface PresenceRange {
  from: number
  to: number
  /** `changed` is where its last edit landed; `working` is a comment it holds. */
  tier: 'working' | 'changed'
}

export const presenceKey = new PluginKey<DecorationSet>('sidenote-presence')

/** Meta payload: the ranges to show, replacing whatever is shown now. */
type SetPresence = { ranges: PresenceRange[] }

export function setPresenceMeta(tr: Transaction, ranges: PresenceRange[]): Transaction {
  return tr.setMeta(presenceKey, { ranges } satisfies SetPresence)
}

function build(state: EditorState, ranges: PresenceRange[]): DecorationSet {
  const size = state.doc.content.size
  const decos = ranges
    .filter((r) => r.from >= 0 && r.to <= size && r.to > r.from)
    .map((r) =>
      Decoration.inline(r.from, r.to, {
        class: r.tier === 'changed' ? 'sidenote-changed' : 'sidenote-working',
        // A native tooltip rather than a floating label: a label drawn in the
        // text column would collide with the prose it is pointing at.
        title: r.tier === 'changed' ? 'Claude just changed this' : 'Claude has this comment in hand',
      }),
    )
  return DecorationSet.create(state.doc, decos)
}

export const presencePlugin = new Plugin<DecorationSet>({
  key: presenceKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(presenceKey) as SetPresence | undefined
      if (meta) return build(newState, meta.ranges)
      // Typing inside a marked range should move the marker with the text,
      // not drop it; ProseMirror maps the decorations for us.
      return tr.docChanged ? value.map(tr.mapping, tr.doc) : value
    },
  },
  props: {
    decorations: (state) => presenceKey.getState(state) ?? DecorationSet.empty,
  },
})
