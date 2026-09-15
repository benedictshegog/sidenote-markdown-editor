// Footnotes: GFM `[^label]` references and their `[^label]: text` definitions.
//
// The gfm preset already parses both into nodes and writes them back byte for
// byte; what it lacks is anything to read them by. A reference is a bare
// <sup> with no link, and a definition is a <dl> whose label and text sit on
// separate lines. The look lives in sidenote.css. This plugin adds the part
// CSS cannot: each reference carries its note as a native tooltip, and a click
// on a reference goes to its definition, a click on a definition's number
// comes back to the first reference to it.
//
// It also helps `applyEdit` parse a replacement on its own. remark only reads
// `[^1]` as a reference when a `[^1]:` definition is in the same text, and a
// replacement is parsed without the document around it, so without help the
// reference turns into literal text and is saved as `\[^1]`.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'

const REFERENCE = 'footnote_reference'
const DEFINITION = 'footnote_definition'
const FLASH = 'sidenote-footnote-flash'

/** remark matches labels case-insensitively with whitespace collapsed. */
const norm = (label: string) => label.toLowerCase().replace(/\s+/g, ' ').trim()

/** Labels with a definition in `doc`, normalised. */
export function definedLabels(doc: PMNode): Set<string> {
  const out = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === DEFINITION) out.add(norm(String(node.attrs.label)))
    return node.isBlock
  })
  return out
}

const REF_IN_MARKDOWN = /\[\^([^\]\s]+)\](?!:)/g
const DEF_IN_MARKDOWN = /^ {0,3}\[\^([^\]\s]+)\]:/gm

/**
 * Parse a replacement passage so its footnote references survive. Every
 * reference in `md` whose definition is in the document (and not in `md`
 * itself) gets a stub definition appended for the parse, and the stubs are
 * taken off again. References to labels defined nowhere stay text, exactly as
 * they would when the whole file is read back.
 */
export function parseWithFootnotes(
  md: string,
  defined: Set<string>,
  parse: (md: string) => PMNode,
): PMNode {
  const own = new Set([...md.matchAll(DEF_IN_MARKDOWN)].map((m) => norm(m[1])))
  const stubs: string[] = []
  const seen = new Set<string>()
  for (const m of md.matchAll(REF_IN_MARKDOWN)) {
    const key = norm(m[1])
    if (!defined.has(key) || own.has(key) || seen.has(key)) continue
    seen.add(key)
    stubs.push(m[1])
  }
  if (!stubs.length) return parse(md)
  const doc = parse(`${md.replace(/\n+$/, '')}\n\n${stubs.map((l) => `[^${l}]: stub`).join('\n\n')}\n`)
  // The stubs come last in the source, so they are the last top-level nodes.
  const keep: PMNode[] = []
  doc.content.forEach((n) => keep.push(n))
  let drop = stubs.length
  while (drop > 0 && keep.length && keep[keep.length - 1].type.name === DEFINITION) {
    keep.pop()
    drop--
  }
  return doc.type.create(doc.attrs, Fragment.fromArray(keep))
}

interface Note {
  pos: number
  text: string
}

function collectNotes(doc: PMNode): Map<string, Note> {
  const notes = new Map<string, Note>()
  doc.descendants((node, pos) => {
    if (node.type.name !== DEFINITION) return node.isBlock
    const key = norm(String(node.attrs.label))
    if (!notes.has(key)) {
      notes.set(key, { pos, text: node.textBetween(0, node.content.size, ' ', '').trim() })
    }
    return false
  })
  return notes
}

function build(doc: PMNode): DecorationSet {
  const notes = collectNotes(doc)
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== REFERENCE) return true
    const note = notes.get(norm(String(node.attrs.label)))
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        // A native tooltip, like the presence markers: it follows the system
        // theme and never covers the prose it belongs to.
        title: note ? note.text : 'No definition for this footnote',
        class: note ? 'sidenote-footnote-ref' : 'sidenote-footnote-ref is-missing',
      }),
    )
    return false
  })
  return DecorationSet.create(doc, decos)
}

export const footnoteKey = new PluginKey<DecorationSet>('sidenote-footnotes')

/** Scroll `pos`'s node into view and flash it once. */
function reveal(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return
  dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
  dom.classList.remove(FLASH)
  // Force a reflow so a second click restarts the animation.
  void dom.offsetWidth
  dom.classList.add(FLASH)
  dom.addEventListener('animationend', () => dom.classList.remove(FLASH), { once: true })
}

function firstReference(state: EditorState, key: string): number | null {
  let found: number | null = null
  state.doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.type.name === REFERENCE && norm(String(node.attrs.label)) === key) {
      found = pos
      return false
    }
    return true
  })
  return found
}

export const footnotePlugin = new Plugin<DecorationSet>({
  key: footnoteKey,
  state: {
    init: (_config, state) => build(state.doc),
    apply: (tr, value, _old, next) => (tr.docChanged ? build(next.doc) : value),
  },
  props: {
    decorations: (state) => footnoteKey.getState(state) ?? DecorationSet.empty,
    handleDOMEvents: {
      click: (view, event) => {
        const target = event.target as HTMLElement | null
        if (!target || event.metaKey || event.shiftKey) return false
        const ref = target.closest(`sup[data-type="${REFERENCE}"]`)
        if (ref instanceof HTMLElement) {
          const note = collectNotes(view.state.doc).get(norm(ref.dataset.label ?? ''))
          if (note) reveal(view, note.pos)
          return false
        }
        const label = target.closest(`dl[data-type="${DEFINITION}"] > dt`)
        if (label instanceof HTMLElement) {
          const dl = label.parentElement as HTMLElement
          const pos = firstReference(view.state, norm(dl.dataset.label ?? ''))
          if (pos !== null) reveal(view, pos)
        }
        return false
      },
    },
  },
})
