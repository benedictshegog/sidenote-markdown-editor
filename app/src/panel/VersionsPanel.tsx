import { useEffect, useState } from 'react'
import { ask } from '@tauri-apps/plugin-dialog'
import { ipc } from '../ipc'
import type { SnapshotInfo } from '../types'
import { relativeTime } from './CommentMargin'

interface Props {
  docId: string
  onRestored: (name: string) => void
  onClose: () => void
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

export function VersionsPanel({ docId, onRestored, onClose }: Props) {
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const list = await ipc.listSnapshots(docId)
    list.reverse()
    setSnaps(list)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  useEffect(() => {
    if (!selected) {
      setDiff('')
      return
    }
    let cancelled = false
    void ipc.diffSnapshot(docId, selected).then((d) => {
      if (!cancelled) setDiff(d)
    })
    return () => {
      cancelled = true
    }
  }, [docId, selected])

  const restore = async (name: string) => {
    const ok = await ask(`Replace the document with snapshot ${name}? The current text is kept as a new snapshot first.`, {
      title: 'Restore version',
      kind: 'warning',
      okLabel: 'Restore',
    })
    if (!ok) return
    setBusy(true)
    try {
      const created = await ipc.restoreSnapshot(docId, name)
      await load()
      setSelected(null)
      onRestored(created)
    } finally {
      setBusy(false)
    }
  }

  // Drop the file header; keep hunks. Each line becomes (kind, text).
  const rows = diff
    ? diff
        .split('\n')
        .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ '))
        .map((l) => {
          if (l.startsWith('@@')) return { kind: 'hunk' as const, text: l.replace(/@@ .* @@/, '⋯') }
          if (l.startsWith('+')) return { kind: 'add' as const, text: l.slice(1) }
          if (l.startsWith('-')) return { kind: 'del' as const, text: l.slice(1) }
          return { kind: 'ctx' as const, text: l.slice(1) }
        })
        .filter((r, i, arr) => !(r.kind === 'ctx' && r.text === '' && i === arr.length - 1))
    : []
  const selectedIsLatest = selected !== null && snaps[0]?.name === selected

  return (
    <aside className="panel versions">
      <div className="panel-head" data-tauri-drag-region>
        <span data-tauri-drag-region>Versions</span>
        <button type="button" className="panel-resolved" onClick={onClose}>
          Comments
        </button>
      </div>
      <div className="panel-body">
        <ul className="versions-list">
          {snaps.map((s, i) => (
            <li
              key={s.name}
              className={`version ${selected === s.name ? 'version-selected' : ''}`}
              onClick={() => setSelected(selected === s.name ? null : s.name)}
            >
              <span className="version-name">{s.name}</span>
              <span className="version-meta">
                {i === 0 ? 'latest · ' : ''}
                {s.mtime ? relativeTime(new Date(s.mtime * 1000).toISOString()) : ''} · {kb(s.size)}
              </span>
            </li>
          ))}
          {snaps.length === 0 && <li className="panel-empty">No snapshots yet.</li>}
        </ul>
        {selected && (
          <div className="version-diff">
            <div className="version-diff-head">
              <span>
                {diff ? `${selected} → current` : `${selected} matches the current text`}
              </span>
              {!selectedIsLatest && (
                <button type="button" className="btn-link" disabled={busy} onClick={() => void restore(selected)}>
                  Restore {selected}
                </button>
              )}
            </div>
            {diff && (
              <div className="diff">
                {rows.map((r, i) => (
                  <div key={i} className={`diff-row diff-${r.kind}`}>
                    <span className="diff-gutter">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
                    <span className="diff-text">{r.text || ' '}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
