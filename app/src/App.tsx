import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ask, message, open } from '@tauri-apps/plugin-dialog'

import { DocumentView, type DocumentActions } from './DocumentView'
import { ipc } from './ipc'
import { applyTypeface, loadPreferences, Settings } from './Settings'
import { Welcome } from './Welcome'
import { Asterisk, Recents } from './Recents'
import { Sidebar, SidebarGlyph } from './Sidebar'
import { dismiss, dismissed, UpdateBar } from './Update'
import type { DocEntry, UpdateStatus } from './types'

const TABS_KEY = 'sidenote.tabs'

export default function App() {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [tabs, setTabs] = useState<DocEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Starts closed; opens only when there is nothing to show, after startup.
  const [toast, setToast] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [welcome, setWelcome] = useState<{ needsCli: boolean; needsSkill: boolean; needsMd: boolean; intro: boolean } | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  const tabsRef = useRef<DocEntry[]>([])
  tabsRef.current = tabs
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  const actions = useRef(new Map<string, DocumentActions>())

  const showToast = useCallback((t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  const refreshDocs = useCallback(async () => {
    setDocs(await ipc.listDocs())
  }, [])

  // ---- updates ------------------------------------------------------------

  /** Look for a newer release. `force` skips the once-a-day cache and reports
   *  the answer either way, which is what Check for Updates… should do. */
  const checkUpdate = useCallback(
    async (force: boolean) => {
      const st = await ipc.updateCheck(force).catch(() => null)
      if (!st) return
      if (st.newer && st.latest && (force || !dismissed(st.latest))) {
        setUpdate(st)
      } else if (force) {
        showToast(
          st.error
            ? `Cannot check for updates: ${st.error}`
            : `Sidenote ${st.current} is the latest version.`,
        )
      }
    },
    [showToast],
  )

  /** Save every open document before Homebrew replaces the app under us. */
  const runUpdate = useCallback(async () => {
    for (const t of tabsRef.current) await actions.current.get(t.id)?.flush()
    await ipc.updateRun()
  }, [])

  // Persist the open tabs (paths) and restore them next launch.
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => t.path)))
  }, [tabs])

  // The window title is never set from here. titleBarStyle is Overlay with
  // hiddenTitle so it is not drawn anyway, and setTitle relayouts the macOS
  // titlebar, which throws away the traffic light inset applied at window
  // creation — tauri 2.11 offers no way to put it back. One call is enough to
  // lose it, so there is no call. The title comes from tauri.conf.json; the
  // cost is that Mission Control names every window "Sidenote".

  // ---- tabs ---------------------------------------------------------------

  /** Tabs closed in this window, most recent last, with where each sat so
   *  Reopen Closed Tab puts it back rather than at the end. */
  const closedTabs = useRef<{ path: string; index: number }[]>([])

  const openDoc = useCallback(
    async (doc: DocEntry, at?: number) => {
      setTabs((ts) => {
        if (ts.some((t) => t.id === doc.id)) return ts.map((t) => (t.id === doc.id ? doc : t))
        const next = [...ts]
        next.splice(at === undefined ? ts.length : Math.min(at, ts.length), 0, doc)
        return next
      })
      setActiveId(doc.id)
      setSidebarOpen(false)
      await refreshDocs()
    },
    [refreshDocs],
  )

  const openPath = useCallback(
    async (path: string, quiet = false, at?: number) => {
      try {
        const doc = await ipc.registerDoc(path)
        await openDoc(doc, at)
        return true
      } catch (e) {
        if (!quiet) await message(`${e}`, { title: 'Cannot open document', kind: 'error' })
        return false
      }
    },
    [openDoc],
  )

  const openFileDialog = useCallback(async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    const list = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : []
    for (const p of list) await openPath(p)
  }, [openPath])

  const closeTab = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab) return
    await actions.current.get(id)?.flush()
    actions.current.delete(id)
    await ipc.unwatchDoc(tab.path).catch(() => {})
    const idx = tabsRef.current.findIndex((t) => t.id === id)
    const next = tabsRef.current.filter((t) => t.id !== id)
    closedTabs.current.push({ path: tab.path, index: idx })
    setTabs(next)
    if (activeRef.current === id) {
      const neighbour = next[Math.min(idx, next.length - 1)] ?? null
      setActiveId(neighbour?.id ?? null)
    }
  }, [])

  const reopenClosedTab = useCallback(async () => {
    // Skip entries that are open again already (reopened by other means).
    let entry = closedTabs.current.pop()
    while (entry && tabsRef.current.some((t) => t.path === entry!.path)) entry = closedTabs.current.pop()
    if (!entry) return
    const ok = await openPath(entry.path, true, entry.index)
    if (!ok) showToast('The file is gone; nothing to reopen.')
  }, [openPath, showToast])

  const forgetDoc = useCallback(
    async (d: DocEntry) => {
      const ok = await ask(`Remove “${d.title}” from Recent? Its comments and snapshots are deleted; the file stays.`, {
        title: 'Remove document',
        kind: 'warning',
        okLabel: 'Remove',
      })
      if (!ok) return
      if (tabsRef.current.some((t) => t.id === d.id)) await closeTab(d.id)
      await ipc.forgetDoc(d.id)
      await refreshDocs()
    },
    [closeTab, refreshDocs],
  )

  const cycleTab = useCallback((dir: 1 | -1) => {
    const list = tabsRef.current
    if (list.length < 2) return
    const i = list.findIndex((t) => t.id === activeRef.current)
    const n = (i + dir + list.length) % list.length
    setActiveId(list[n].id)
  }, [])

  // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (browser convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycleTab])

  // ---- events from the backend -------------------------------------------

  // No drag starts inside the app. `dragDropEnabled` is on so that Tauri
  // reports real paths for dropped files, and wry then claims every drag
  // before WebKit sees it: a drag begun in here is captured by the file-drop
  // layer, which raises the veil over a text drag and then drops nothing.
  // Refusing at the source is honest. Nothing in the app is draggable by
  // design — the editor's block handle is the only thing that tries, and it
  // mounts outside the ProseMirror DOM, which is why this is on the document
  // rather than on the editor alone.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => e.preventDefault()
    document.addEventListener('dragstart', onDragStart, true)
    return () => document.removeEventListener('dragstart', onDragStart, true)
  }, [])

  // Files dropped on the window. Only Tauri's native handler reports real
  // paths — a webview drop event cannot — so `dragDropEnabled` is on. The
  // cost is that wry claims every drag before WebKit sees it, which is why
  // dragging inside the editor is turned off rather than merely broken; see
  // `editor/Editor.tsx`.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') {
        setDropping(true)
        return
      }
      setDropping(false)
      if (p.type !== 'drop') return
      const md = p.paths.filter((f) => /\.(md|markdown)$/i.test(f))
      if (!md.length) {
        showToast(p.paths.length === 1 ? 'That is not a markdown file.' : 'No markdown files in that drop.')
        return
      }
      const skipped = p.paths.length - md.length
      for (const f of md) await openPath(f)
      if (skipped) showToast(`Opened ${md.length}; skipped ${skipped} non-markdown ${skipped === 1 ? 'file' : 'files'}.`)
    })
    return () => {
      void un.then((f) => f())
    }
  }, [openPath, showToast])

  useEffect(() => {
    const un1 = listen<string>('open-file', (e) => void openPath(e.payload))
    const un2 = listen<string>('fs-changed', (e) => {
      if (e.payload.endsWith('/index.json')) void refreshDocs()
    })
    return () => {
      void un1.then((f) => f())
      void un2.then((f) => f())
    }
  }, [openPath, refreshDocs])

  // ---- menu ---------------------------------------------------------------

  useEffect(() => {
    const un = listen<{ id: string; window?: string | null }>('menu', async (e) => {
      // The backend names the window that had focus. Every window receives the
      // event regardless of how it is emitted, so the check has to be here:
      // without it one Cmd+N opened a window per open window, and Cmd+W closed
      // a tab in each of them.
      const target = e.payload.window
      if (target && target !== getCurrentWindow().label) return
      const id = e.payload.id
      if (id.startsWith('recent:')) {
        await openPath(id.slice('recent:'.length))
        return
      }
      if (id.startsWith('font:')) {
        applyTypeface(id.slice('font:'.length))
        return
      }
      // Undo and redo before anything document-scoped, because a comment box
      // or a settings field can have the focus while a document is open, and
      // then the edit to undo is the one in that box. Only when the focus is
      // in neither does the document's own history apply.
      if (id === 'undo' || id === 'redo') {
        const el = document.activeElement
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          // Deprecated, and the only way to reach a field's own undo stack.
          document.execCommand(id)
          return
        }
        const act = activeRef.current ? actions.current.get(activeRef.current) : null
        if (act) await act.menu(id)
        return
      }
      switch (id) {
        case 'open':
          await openFileDialog()
          return
        case 'toggle_sidebar':
          // With no tabs the start screen already lists the documents, so a
          // pane there would only duplicate it.
          if (tabsRef.current.length) setSidebarOpen((v) => !v)
          return
        case 'close_doc':
          if (activeRef.current) await closeTab(activeRef.current)
          return
        case 'reopen_tab':
          await reopenClosedTab()
          return
        case 'next_tab':
          cycleTab(1)
          return
        case 'prev_tab':
          cycleTab(-1)
          return
        case 'new_window':
          await ipc.newWindow(null)
          return
        case 'settings':
          setSettingsOpen(true)
          return
        case 'check_updates':
          await checkUpdate(true)
          return
        case 'clear_recent': {
          const ok = await ask('Remove every document from Recent? Their comments and snapshots are deleted; the markdown files stay.', {
            title: 'Clear Recent',
            kind: 'warning',
            okLabel: 'Clear',
          })
          if (ok) {
            for (const d of docs) await ipc.forgetDoc(d.id)
            await refreshDocs()
          }
          return
        }
        case 'install_cli': {
          const st = await ipc.cliStatus().catch(() => null)
          const sk = await ipc.skillStatus().catch(() => null)
          const md = await ipc.defaultMdHandler().catch(() => null)
          const needsCli = !!(st && !st.installed)
          const needsSkill = !!(sk && !sk.current)
          const needsMd = !!(md && !md.is_default)
          if (!needsCli && !needsSkill && !needsMd) {
            showToast('Everything is installed: command line tool, skill, default app for .md.')
            return
          }
          setWelcome({ needsCli, needsSkill, needsMd, intro: false })
          return
        }
      }
      // Document-scoped: the active tab handles it.
      const act = activeRef.current ? actions.current.get(activeRef.current) : null
      if (act) await act.menu(id)
    })
    return () => {
      void un.then((f) => f())
    }
  }, [checkUpdate, closeTab, cycleTab, docs, openFileDialog, openPath, refreshDocs, reopenClosedTab, showToast])

  // ---- startup ------------------------------------------------------------

  useEffect(() => {
    loadPreferences()
    void (async () => {
      await refreshDocs()
      const hashDoc = new URLSearchParams(location.hash.replace(/^#/, '')).get('doc')
      const pending = hashDoc ? [] : await ipc.takePendingOpens()
      if (hashDoc) {
        history.replaceState(null, '', location.pathname)
        await openPath(hashDoc)
      } else if (pending.length) {
        for (const p of pending) await openPath(p)
      } else if (getCurrentWindow().label === 'main') {
        // Restore last session's tabs, skipping files that are gone.
        let saved: string[] = []
        try {
          saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]')
        } catch {
          saved = []
        }
        for (const p of saved) await openPath(p, true)
      }
      // First paint is decided: show the window.
      const win = getCurrentWindow()
      await win.show().catch(() => {})
      await win.setFocus().catch(() => {})
      const st = await ipc.cliStatus().catch(() => null)
      const sk = await ipc.skillStatus().catch(() => null)
      if (sk?.installed && !sk.current) {
        const r = await ipc.installSkill(false).catch(() => '')
        if (r.startsWith('updated')) showToast('Claude Code skill updated.')
      }
      const md = await ipc.defaultMdHandler().catch(() => null)
      const needsCli = !!(st && !st.installed && st.bundled)
      const needsSkill = !!(sk && !sk.installed)
      const needsMd = !!(md && !md.is_default)
      if ((needsCli || needsSkill || needsMd) && !localStorage.getItem('sidenote.welcomeShown')) {
        localStorage.setItem('sidenote.welcomeShown', '1')
        setWelcome({ needsCli, needsSkill, needsMd, intro: true })
      }
      // One window asks, or every window opens its own banner. The backend
      // answers from a day-old cache, so this is rarely a network call.
      if (getCurrentWindow().label === 'main') await checkUpdate(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- render -------------------------------------------------------------

  const active = tabs.find((t) => t.id === activeId) ?? null
  const sideOpen = sidebarOpen && tabs.length > 0

  return (
    <div className={`app ${sideOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-cell" aria-hidden={!sideOpen}>
        <Sidebar
          docs={docs}
          currentId={activeId}
          onOpen={(d) => void openDoc(d)}
          onForget={(d) => void forgetDoc(d)}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      <div className="workspace">
        <div className={`tabbar ${sideOpen ? '' : 'tabbar-inset'}`} data-tauri-drag-region>
          {/* ⌘1 is the shortcut; this is the same toggle with a face. It moves
              into the sidebar head while the pane is open. */}
          {tabs.length > 0 && !sideOpen && (
            <button type="button" className="side-toggle" title="Show Sidebar (⌘1)" onClick={() => setSidebarOpen(true)}>
              <SidebarGlyph />
            </button>
          )}
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeId ? 'tab-active' : ''}`}
              title={t.path}
              onClick={() => setActiveId(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTab(t.id)
              }}
            >
              <span className="tab-title">{t.title}</span>
              <button
                type="button"
                className="tab-close"
                title="Close tab (⌘W)"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(t.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {/* The start screen has its own Open button, so this would be a duplicate. */}
          {tabs.length > 0 && (
            <button type="button" className="tab-add" title="Open… (⌘O)" onClick={() => void openFileDialog()}>
              +
            </button>
          )}
          <div className="tabbar-space" data-tauri-drag-region />
        </div>

        {tabs.length === 0 && (
          <main className="main">
            <div className="start">
              <div className="start-head">
                <div className="start-glyph">
                  <Asterisk />
                </div>
                <p className="muted">Open a markdown file to review it.</p>
                <button type="button" className="btn-quiet" onClick={() => void openFileDialog()}>
                  Open… (⌘O)
                </button>
              </div>
              <Recents docs={docs} onOpen={(d) => void openDoc(d)} onForget={(d) => void forgetDoc(d)} />
            </div>
          </main>
        )}

        {tabs.map((t) => (
          <DocumentView
            key={t.id}
            ref={(h) => {
              if (h) actions.current.set(t.id, h)
              else actions.current.delete(t.id)
            }}
            doc={t}
            active={t.id === activeId}
            onToast={showToast}
            onDocChanged={(d) => {
              setTabs((ts) => ts.map((x) => (x.id === d.id ? d : x)))
              void refreshDocs()
            }}
          />
        ))}

        {update && update.latest && (
          <UpdateBar
            status={update}
            onDismiss={() => {
              if (update.latest) dismiss(update.latest)
              setUpdate(null)
            }}
            onUpdate={runUpdate}
          />
        )}

        {toast && <div className="toast">{toast}</div>}
      </div>

      {dropping && (
        <div className="drop-veil">
          <div className="drop-note">Drop markdown to review</div>
        </div>
      )}

      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onToast={showToast}
          onCheckUpdates={() => void checkUpdate(true)}
        />
      )}
      {welcome && (
        <Welcome
          needsCli={welcome.needsCli}
          needsSkill={welcome.needsSkill}
          needsMd={welcome.needsMd}
          intro={welcome.intro}
          onDone={() => setWelcome(null)}
          onToast={showToast}
        />
      )}
      {active && null}
    </div>
  )
}
