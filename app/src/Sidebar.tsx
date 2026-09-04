import { shortPath } from './Recents'
import type { DocEntry } from './types'

interface Props {
  docs: DocEntry[]
  currentId: string | null
  onOpen: (doc: DocEntry) => void
  onForget: (doc: DocEntry) => void
  onClose: () => void
}

/** A window with its left pane filled: the sidebar glyph, shared by the button
 *  that opens the pane (in the tab bar) and the one that closes it (in here). */
export function SidebarGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm5.5 2v12H20V6H9.5z"
      />
    </svg>
  )
}

/** Recent documents in a narrow left column, on ⌘1. Only reachable once a tab
 *  is open — with none, the start screen lists the same documents centred, so
 *  a pane there would just duplicate it. Rows stack title over path because
 *  the column is too narrow for the two to share a line. */
export function Sidebar({ docs, currentId, onOpen, onForget, onClose }: Props) {
  return (
    <nav className="sidebar">
      <div className="sidebar-head" data-tauri-drag-region>
        <span className="sidebar-title" data-tauri-drag-region>
          Recent
        </span>
        <button type="button" className="side-toggle" title="Hide Sidebar (⌘1)" onClick={onClose}>
          <SidebarGlyph />
        </button>
      </div>
      <ul className="side-recent">
        {docs.map((d) => (
          <li
            key={d.id}
            className={`side-item ${d.id === currentId ? 'side-current' : ''}`}
            onClick={() => onOpen(d)}
            title={d.path}
          >
            <div className="side-title">{d.title}</div>
            <div className="side-path">{shortPath(d.path, 26)}</div>
            <button
              type="button"
              className="side-forget"
              title="Remove from Recent (keeps the file, deletes its comments)"
              onClick={(e) => {
                e.stopPropagation()
                onForget(d)
              }}
            >
              ×
            </button>
          </li>
        ))}
        {docs.length === 0 && <li className="panel-empty">No documents yet.</li>}
      </ul>
    </nav>
  )
}
