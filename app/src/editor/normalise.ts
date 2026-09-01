// Undo the serialiser's cosmetic churn so the file on disk stays close to
// what its author wrote. Applied to every getMarkdown() result.

const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/g

function isDelimiterRow(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t.includes('-') && t.includes('|') && /^[|\-: ]+$/.test(t)
}

function canonicalDelimiter(line: string): string {
  const t = line.trim()
  const inner = t.startsWith('|') ? t.slice(1) : t
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner
  const cells = body.split('|').map((c) => c.trim())
  const out = cells.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return ':-:'
    if (left) return ':--'
    if (right) return '--:'
    return '---'
  })
  return `|${out.join('|')}|`
}

export function normaliseMarkdown(md: string): string {
  let inFence = false
  const lines = md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    let l = line.replace(AUTOLINK, '$1')
    // remark escapes & and _ defensively; neither needs it in running text.
    l = l.replace(/\\&/g, '&')
    if (l.trimStart().startsWith('|')) {
      // Empty cells come back as <br />.
      l = l.replace(/\|\s*<br\s*\/?>\s*(?=\|)/g, '| ')
      if (isDelimiterRow(l)) l = canonicalDelimiter(l)
    }
    return l
  })
  let out = lines.join('\n')
  // One trailing newline, never more.
  out = out.replace(/\n+$/, '\n')
  return out
}
