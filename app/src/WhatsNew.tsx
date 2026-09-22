import { useEffect, type ReactNode } from 'react'
import { compareVersions, RELEASES, releasesBetween } from './releaseNotes'

/** `code` spans only; the notes are written plain. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 1 ? <code key={i}>{part.slice(1, -1)}</code> : part,
  )
}

/** "22 Sep 2026", not the ISO date the file carries. */
function when(date: string | null): string {
  if (!date) return ''
  const d = new Date(`${date}T12:00:00`)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

interface PillProps {
  version: string
  onOpen: () => void
  onDismiss: () => void
}

/** The only sign of an update: a quiet chip in the corner, shown for the
 *  first session on a new version. No backdrop, no focus steal, and it goes
 *  away with the window whether or not it was read. */
export function WhatsNewPill({ version, onOpen, onDismiss }: PillProps) {
  return (
    <div className="notes-pill" role="status">
      <button type="button" className="notes-pill-open" onClick={onOpen} title="Release Notes">
        <span className="notes-pill-dot" aria-hidden />
        Updated to {version}
        <span className="notes-pill-sep" aria-hidden>
          ·
        </span>
        <span className="notes-pill-cta">What’s new</span>
      </button>
      <button type="button" className="notes-pill-x" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

interface SheetProps {
  current: string
  /** The version the update came from. Releases after it are marked new;
   *  null lists the whole history plainly, as Settings opens it. */
  from: string | null
  onClose: () => void
}

export function ReleaseNotes({ current, from, onClose }: SheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fresh = from ? releasesBetween(from, current) : []
  const rest = RELEASES.filter((r) => compareVersions(r.version, current) <= 0 && !fresh.includes(r))

  const release = (r: (typeof RELEASES)[number], isNew: boolean) => (
    <section key={r.version} className={`release ${isNew ? 'is-new' : ''}`}>
      <div className="release-head">
        <span className="release-version">{r.version}</span>
        {r.version === current && <span className="release-tag">Installed</span>}
        <span className="release-date">{when(r.date)}</span>
      </div>
      <ul className="release-notes">
        {r.notes.map((n, i) => (
          <li key={i}>{inline(n)}</li>
        ))}
      </ul>
    </section>
  )

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet notes-sheet" role="dialog" aria-label="Release Notes" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>{fresh.length ? 'What’s New in Sidenote' : 'Release Notes'}</span>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="sheet-body">
          {fresh.map((r) => release(r, true))}
          {fresh.length > 0 && rest.length > 0 && <div className="release-divider">Earlier releases</div>}
          {rest.map((r) => release(r, false))}
        </div>
      </div>
    </div>
  )
}
