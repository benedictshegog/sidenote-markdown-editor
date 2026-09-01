import { shortPath } from './Recents'
import type { DocEntry } from './types'

interface Props {
  docs: DocEntry[]
  currentId: string | null
  onOpen: (doc: DocEntry) => void
  onForget: (doc: DocEntry) => void
}

/** Recent documents in a narrow left column, on ⌘1. Only reachable once a tab
 *  is open — with none, the start screen lists the same documents centred, so
 *  a pane there would just duplicate it. Rows stack title over path because
 *  the column is too narrow for the two to share a line. */
export function Sidebar({ docs, currentId, onOpen, onForget }: Props) {
  return (
    <nav className="sidebar">
      <div className="sidebar-head" data-tauri-drag-region>
        <span className="sidebar-title" data-tauri-drag-region>
          Recent
        </span>
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
