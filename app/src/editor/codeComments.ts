// Comments on text inside a code block.
//
// Two things stand in the way out of the box. The code block's schema allows
// no marks, so the comment mark never lands on its text; and its node view is
// a CodeMirror editor that draws its own DOM, so a mark that did land would
// not show. This module lifts the first and supplies the second: the mark
// stays the single record of where a comment is, and is mirrored into
// CodeMirror as a decoration carrying the same class and `data-comment-id`
// the prose highlight has, so the margin, the click handler and `scrollTo`
// find it without knowing the difference.
//
// Crepe builds CodeMirror only for blocks near the viewport and shows a plain
// `<pre>` for the rest. That placeholder is painted too: a card needs
// something to sit beside wherever its comment is.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView as CodeMirror, ViewPlugin } from '@codemirror/view'
import type { Ctx } from '@milkdown/kit/ctx'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { DRAFT_ID } from './commentMark'

const CODE_BLOCK = 'code_block'

/** One comment's stretch of a code block, in offsets into the block's text. */
export interface CodeRange {
  from: number
  to: number
  id: string
}

/** Let the comment mark onto code. A marked stretch splits the block's text
 *  into several text nodes, and the stock serialiser writes only the first,
 *  so the whole text is written here instead. */
export function allowCommentsInCode(ctx: Ctx) {
  ctx.update(codeBlockSchema.key, (prev) => (c) => ({
    ...prev(c),
    marks: 'comment',
    toMarkdown: {
      match: (node) => node.type.name === CODE_BLOCK,
      runner: (state, node) => {
        state.addNode('code', undefined, node.textContent, { lang: node.attrs.language })
      },
    },
  }))
}

/** The comment marks on a code block's text, adjacent pieces joined. */
export function codeRanges(block: PMNode): CodeRange[] {
  const out: CodeRange[] = []
  block.forEach((child, offset) => {
    for (const m of child.marks) {
      if (m.type.name !== 'comment') continue
      const id = m.attrs.id as string
      const to = offset + child.nodeSize
      const last = out.findLast((r) => r.id === id)
      if (last && last.to === offset) last.to = to
      else out.push({ from: offset, to, id })
    }
  })
  return out
}

function classFor(id: string, selected: string | null): string {
  let c = 'sidenote-comment'
  if (id === DRAFT_ID) c += ' sidenote-comment-draft'
  if (id === selected) c += ' sidenote-comment-selected'
  return c
}

interface Painted {
  ranges: CodeRange[]
  selected: string | null
}

const paint = StateEffect.define<Painted>()

const highlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(paint)) continue
      const len = tr.newDoc.length
      next = Decoration.set(
        e.value.ranges
          .map((r) => ({ ...r, to: Math.min(r.to, len) }))
          .filter((r) => r.from < r.to)
          .map((r) =>
            Decoration.mark({
              class: classFor(r.id, e.value.selected),
              attributes: { 'data-comment-id': r.id },
            }).range(r.from, r.to),
          ),
        true,
      )
    }
    return next
  },
  provide: (f) => CodeMirror.decorations.from(f),
})

/** The placeholder's text, with each commented stretch in a span. Where two
 *  comments overlap the spans nest, as the marks do in prose. */
function paintPlaceholder(code: HTMLElement, text: string, { ranges, selected }: Painted) {
  if (!ranges.length) {
    if (code.childElementCount) code.textContent = text
    return
  }
  const cuts = [...new Set([0, text.length, ...ranges.flatMap((r) => [r.from, r.to])])]
    .filter((n) => n >= 0 && n <= text.length)
    .sort((a, b) => a - b)
  const parts: Node[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]]
    let node: Node = document.createTextNode(text.slice(a, b))
    for (const r of ranges) {
      if (r.from > a || r.to < b) continue
      const span = document.createElement('span')
      span.className = classFor(r.id, selected)
      span.setAttribute('data-comment-id', r.id)
      span.appendChild(node)
      node = span
    }
    parts.push(node)
  }
  code.replaceChildren(...parts)
}

/** One editor's link between its comment marks and its code blocks. */
export function createCodeComments(): {
  /** For the CodeMirror feature's `extensions`. */
  extension: Extension
  /** For the ProseMirror editor. */
  plugin: Plugin
  /** The comment drawn as selected, or none. */
  setSelected(id: string | null): void
} {
  let pm: EditorView | null = null
  let selected: string | null = null
  /** What each CodeMirror shows now, so an unchanged block is left alone. */
  const drawn = new WeakMap<CodeMirror, string>()

  const sync = () => {
    const view = pm
    if (!view || view.isDestroyed) return
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== CODE_BLOCK) return !node.isTextblock
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return false
      const painted: Painted = { ranges: codeRanges(node), selected }
      const host = dom.querySelector<HTMLElement>('.cm-editor')
      const cm = host && CodeMirror.findFromDOM(host)
      if (cm) {
        const key = JSON.stringify(painted)
        if (drawn.get(cm) === key || cm.state.field(highlights, false) === undefined) return false
        drawn.set(cm, key)
        cm.dispatch({ effects: paint.of(painted) })
        return false
      }
      const code = dom.querySelector<HTMLElement>('.milkdown-code-block-placeholder code')
      if (code) paintPlaceholder(code, node.textContent, painted)
      return false
    })
  }

  // A CodeMirror is built when its block scrolls near and torn down after it
  // leaves, with no change to the document either time. Its DOM is put in
  // place, or the placeholder put back, later in the same task; so look again
  // once that task is over.
  let queued = false
  const later = () => {
    if (queued) return
    queued = true
    setTimeout(() => {
      queued = false
      sync()
    }, 0)
  }
  const lifecycle = ViewPlugin.define(() => {
    later()
    return { destroy: later }
  })

  const plugin = new Plugin({
    view: (view) => {
      pm = view
      later()
      return {
        // Node views are updated before plugin views, so each CodeMirror
        // already holds the new text when the ranges reach it.
        update: (v, prev) => {
          pm = v
          if (v.state.doc !== prev.doc) sync()
        },
        destroy: () => {
          pm = null
        },
      }
    },
  })

  return {
    extension: [highlights, lifecycle],
    plugin,
    setSelected: (id) => {
      if (id === selected) return
      selected = id
      sync()
    },
  }
}
