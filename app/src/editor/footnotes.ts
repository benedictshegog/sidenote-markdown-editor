// Footnotes: GFM `[^label]` references and their `[^label]: text` definitions.
//
// The gfm preset already parses both into nodes and writes them back byte for
// byte; what it lacks is anything to read them by. A reference is a bare
// <sup> with no link, and a definition is a <dl> whose label and text sit on
// separate lines. The look lives in sidenote.css. This plugin adds the part
// CSS cannot: resting the pointer on a reference previews its note in a card,
// a click on a reference goes to its definition, and a click on a
// definition's number comes back to the first reference to it.
//
// It also helps `applyEdit` parse a replacement on its own. remark only reads
// `[^1]` as a reference when a `[^1]:` definition is in the same text, and a
// replacement is parsed without the document around it, so without help the
// reference turns into literal text and is saved as `\[^1]`.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import { DOMSerializer, Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'

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

const OPEN_DELAY_MS = 250
const CLOSE_DELAY_MS = 150

/**
 * The note under a reference, shown while the pointer rests on it, so reading
 * a note never moves you away from the sentence that cites it.
 *
 * The card is rendered from the definition's own nodes, so `code`, emphasis
 * and links look as they do in the notes list. It lives on document.body with
 * fixed positioning: inside the editor it would be clipped by table wrappers
 * and taken for document content. Pointer travel from the reference onto the
 * card keeps it open, so its text can be selected and copied.
 */
class FootnotePreview {
  private card: HTMLDivElement
  private anchor: HTMLElement | null = null
  private openTimer = 0
  private closeTimer = 0
  private view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.card = document.createElement('div')
    this.card.className = 'sidenote-footnote-preview'
    this.card.setAttribute('role', 'tooltip')
    this.card.hidden = true
    this.card.addEventListener('mouseenter', () => window.clearTimeout(this.closeTimer))
    this.card.addEventListener('mouseleave', () => this.scheduleClose())
    document.body.appendChild(this.card)
    view.dom.addEventListener('mouseover', this.onOver)
    view.dom.addEventListener('mouseout', this.onOut)
    window.addEventListener('scroll', this.hide, true)
    window.addEventListener('keydown', this.onKey)
  }

  private onOver = (event: MouseEvent) => {
    const ref = (event.target as HTMLElement | null)?.closest(`sup[data-type="${REFERENCE}"]`)
    if (!(ref instanceof HTMLElement)) return
    window.clearTimeout(this.closeTimer)
    if (ref === this.anchor && !this.card.hidden) return
    window.clearTimeout(this.openTimer)
    this.openTimer = window.setTimeout(() => this.show(ref), OPEN_DELAY_MS)
  }

  private onOut = (event: MouseEvent) => {
    const ref = (event.target as HTMLElement | null)?.closest(`sup[data-type="${REFERENCE}"]`)
    if (!ref || ref.contains(event.relatedTarget as Node | null)) return
    window.clearTimeout(this.openTimer)
    this.scheduleClose()
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.hide()
  }

  private scheduleClose() {
    window.clearTimeout(this.closeTimer)
    this.closeTimer = window.setTimeout(this.hide, CLOSE_DELAY_MS)
  }

  private show(ref: HTMLElement) {
    const label = ref.dataset.label ?? ''
    const note = collectNotes(this.view.state.doc).get(norm(label))
    this.card.replaceChildren()
    const number = document.createElement('span')
    number.className = 'sidenote-footnote-preview-label'
    number.textContent = label
    this.card.appendChild(number)
    const body = document.createElement('div')
    body.className = 'sidenote-footnote-preview-body'
    if (note) {
      const node = this.view.state.doc.nodeAt(note.pos)
      if (node) {
        const serializer = DOMSerializer.fromSchema(this.view.state.schema)
        body.appendChild(serializer.serializeFragment(node.content))
      }
    } else {
      body.textContent = 'No definition for this footnote.'
      this.card.classList.add('is-missing')
    }
    if (note) this.card.classList.remove('is-missing')
    this.card.appendChild(body)
    this.anchor = ref
    this.card.hidden = false
    this.place(ref)
  }

  /** Under the reference, flipped above it when there is no room below. */
  private place(ref: HTMLElement) {
    const r = ref.getBoundingClientRect()
    const gap = 6
    const margin = 12
    const card = this.card.getBoundingClientRect()
    let left = r.left + r.width / 2 - card.width / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - card.width - margin))
    let top = r.bottom + gap
    if (top + card.height > window.innerHeight - margin && r.top - gap - card.height > margin) {
      top = r.top - gap - card.height
    }
    this.card.style.left = `${Math.round(left)}px`
    this.card.style.top = `${Math.round(top)}px`
  }

  hide = () => {
    window.clearTimeout(this.openTimer)
    window.clearTimeout(this.closeTimer)
    this.card.hidden = true
    this.anchor = null
  }

  update(view: EditorView, prev: EditorState) {
    this.view = view
    // An edit can remove the reference or rewrite the note under the card.
    if (!view.state.doc.eq(prev.doc)) this.hide()
  }

  destroy() {
    this.hide()
    this.view.dom.removeEventListener('mouseover', this.onOver)
    this.view.dom.removeEventListener('mouseout', this.onOut)
    window.removeEventListener('scroll', this.hide, true)
    window.removeEventListener('keydown', this.onKey)
    this.card.remove()
  }
}

export const footnotePlugin = new Plugin<DecorationSet>({
  key: footnoteKey,
  view: (view) => new FootnotePreview(view),
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
