// Linearise a ProseMirror document into plain text (text blocks joined by
// "\n") and map between JS string indices, char (code point) offsets and
// ProseMirror positions. The char offsets are what `core` anchors against.

import type { Node as PMNode } from '@milkdown/kit/prose/model'

interface Segment {
  pmFrom: number
  pmTo: number
  jsFrom: number
  jsTo: number
}

export class TextMap {
  readonly text: string
  private segments: Segment[]
  private cpToJs: number[] | null = null
  private jsToCp: Map<number, number> | null = null
  /** True when no character in the text is outside the BMP, which makes code
   *  point offsets and JS string indices the same number. */
  private bmpOnly: boolean | null = null

  constructor(doc: PMNode) {
    const segs: Segment[] = []
    let text = ''
    let first = true
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      if (!first) text += '\n'
      first = false
      node.forEach((child, offset) => {
        const from = pos + 1 + offset
        if (child.isText) {
          const t = child.text ?? ''
          segs.push({ pmFrom: from, pmTo: from + t.length, jsFrom: text.length, jsTo: text.length + t.length })
          text += t
        } else if (child.type.name === 'hardbreak' || child.type.name === 'hard_break') {
          segs.push({ pmFrom: from, pmTo: from + 1, jsFrom: text.length, jsTo: text.length + 1 })
          text += '\n'
        }
        // other inline leaves (images, math) contribute no text
      })
      return false
    })
    this.text = text
    this.segments = segs
  }

  /** Whether any character needs a surrogate pair. One linear scan of code
   *  units, and for almost every document the answer is no. */
  private isBmpOnly(): boolean {
    if (this.bmpOnly === null) {
      let plain = true
      for (let i = 0; i < this.text.length; i++) {
        const c = this.text.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdfff) {
          plain = false
          break
        }
      }
      this.bmpOnly = plain
    }
    return this.bmpOnly
  }

  /** Build the offset tables. Only reached for text holding astral characters
   *  — an emoji, say — because otherwise the two offsets are identical.
   *
   *  These tables cost one array entry and one Map entry per character of the
   *  document, rebuilt for every TextMap, and a TextMap is built on each
   *  autosave and each presence redraw. On a long document that was tens of
   *  thousands of Map entries allocated to answer a handful of lookups. */
  private buildCp() {
    if (this.cpToJs) return
    const cp: number[] = []
    const js = new Map<number, number>()
    let i = 0
    let n = 0
    for (const ch of this.text) {
      cp.push(i)
      js.set(i, n)
      i += ch.length
      n++
    }
    cp.push(i)
    js.set(i, n)
    this.cpToJs = cp
    this.jsToCp = js
  }

  /** Char (code point) offset to JS string index. */
  cpToIndex(cp: number): number {
    if (this.isBmpOnly()) return Math.min(cp, this.text.length)
    this.buildCp()
    const arr = this.cpToJs!
    return arr[Math.min(cp, arr.length - 1)]
  }

  /** JS string index to char (code point) offset. */
  indexToCp(i: number): number {
    if (this.isBmpOnly()) return Math.min(i, this.text.length)
    this.buildCp()
    const v = this.jsToCp!.get(i)
    if (v !== undefined) return v
    // inside a surrogate pair: walk back
    let k = i
    while (k > 0 && !this.jsToCp!.has(k)) k--
    return this.jsToCp!.get(k) ?? 0
  }

  /** JS index to ProseMirror position. `bias` decides how separators resolve. */
  indexToPos(i: number, bias: 'start' | 'end'): number | null {
    const segs = this.segments
    if (segs.length === 0) return null
    let lo = 0
    let hi = segs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = segs[mid]
      if (i < s.jsFrom) hi = mid - 1
      else if (i > s.jsTo) lo = mid + 1
      else {
        if (i === s.jsTo && bias === 'start' && mid + 1 < segs.length && segs[mid + 1].jsFrom === i) {
          return segs[mid + 1].pmFrom
        }
        return s.pmFrom + (i - s.jsFrom)
      }
    }
    // In a separator gap.
    if (bias === 'start') {
      const next = segs[lo]
      return next ? next.pmFrom : null
    }
    const prev = segs[hi]
    return prev ? prev.pmTo : null
  }

  /** ProseMirror position to JS index (null when outside any text segment). */
  posToIndex(pos: number): number | null {
    const segs = this.segments
    let lo = 0
    let hi = segs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = segs[mid]
      if (pos < s.pmFrom) hi = mid - 1
      else if (pos > s.pmTo) lo = mid + 1
      else return s.jsFrom + (pos - s.pmFrom)
    }
    return null
  }

  /**
   * The PM ranges covering [jsFrom, jsTo): one per text block, so a
   * selection that crosses blocks becomes one mark per block.
   */
  rangesFor(jsFrom: number, jsTo: number): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = []
    for (const s of this.segments) {
      if (s.jsTo <= jsFrom || s.jsFrom >= jsTo) continue
      const a = Math.max(s.jsFrom, jsFrom)
      const b = Math.min(s.jsTo, jsTo)
      if (b <= a) continue
      const from = s.pmFrom + (a - s.jsFrom)
      const to = s.pmFrom + (b - s.jsFrom)
      const last = out[out.length - 1]
      if (last && last.to === from) last.to = to
      else out.push({ from, to })
    }
    return out
  }
}
