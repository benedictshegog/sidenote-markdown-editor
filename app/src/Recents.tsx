import type { DocEntry } from './types'

interface Props {
  docs: DocEntry[]
  onOpen: (doc: DocEntry) => void
  onForget: (doc: DocEntry) => void
}

/** The folder the file sits in, with $HOME collapsed to ~ and a long head
 *  dropped, so the meaningful tail survives. Truncating here rather than with
 *  `direction: rtl` avoids bidi reordering the hyphens in paths like a UUID.
 *  Shared with the sidebar, which lists the same documents more narrowly. */
export function shortPath(p: string, max = 34): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0]
  const s = home ? p.replace(home, '~') : p
  const parts = s.split('/')
  parts.pop()
  const dir = parts.join('/')
  return dir.length > max ? `…${dir.slice(dir.length - max)}` : dir
}

/** Recently reviewed documents, centred under the Open button on the start
 *  screen. Once a tab is open the sidebar (⌘1) carries the same list. */
/** Sidenote's asterisk. Drawn rather than typed: as a character its ink sits
 *  in the top third of the em box, so it cannot be centred without guessing at
 *  the metrics of whichever typeface is selected. */
export function Asterisk({ size = 56 }: { size?: number }) {
  return (
    <svg
      className="asterisk"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3.6v16.8M4.7 7.8l14.6 8.4M4.7 16.2l14.6-8.4" />
    </svg>
  )
}

export function Recents({ docs, onOpen, onForget }: Props) {
  if (docs.length === 0) return null
  return (
    <section className="recents">
      <h2 className="recents-label">Recent</h2>
      <ul className="recent">
        {docs.map((d) => (
          <li key={d.id} className="recent-item">
            <button type="button" className="recent-open" title={d.path} onClick={() => onOpen(d)}>
              <span className="recent-title">{d.title}</span>
              <span className="recent-path">{shortPath(d.path)}</span>
            </button>
            <button
              type="button"
              className="recent-forget"
              title="Remove from Recent (keeps the file, deletes its comments)"
              onClick={() => onForget(d)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
