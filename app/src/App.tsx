import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ask, message, open, save } from '@tauri-apps/plugin-dialog'

import { DocumentView, type DocumentActions } from './DocumentView'
import { DraftView, UNTITLED, type DraftActions } from './DraftView'
import { ipc } from './ipc'
import { applyContents, applyTypeface, loadPreferences, Settings } from './Settings'
import { Welcome } from './Welcome'
import { Asterisk, Recents } from './Recents'
import { Sidebar, SidebarGlyph } from './Sidebar'
import { dismiss, dismissed, UpdateBar } from './Update'
import { ReleaseNotes, WhatsNewPill } from './WhatsNew'
import { takeUpdatedFrom } from './releaseNotes'
import type { AppInfo, DocEntry, Pane, ToastAction, UpdateStatus } from './types'

const TABS_KEY = 'sidenote.tabs'
/** The splits among the saved tabs, as pairs of paths. */
const PAIRS_KEY = 'sidenote.pairs'
/** Where the divider sits, as a share of the window: one for every split. */
const SPLIT_KEY = 'sidenote.split'

/** A document with no file yet: New Document, before Save. It lives in this
 *  window alone — nothing in `~/.sidenote` knows it — so it is not restored
 *  next launch, and closing it asks. */
interface DraftTab {
  id: string
  draft: true
  title: string
  /** There is text to save. An empty draft closes without a word. */
  dirty: boolean
}

type Tab = DocEntry | DraftTab

function isDraft(t: Tab): t is DraftTab {
  return 'draft' in t
}

/** One entry in the tab bar: a tab alone, or two shown side by side. */
type Group = Tab[]

/** Two tabs that share a place in the bar, left then right. */
type Pair = [left: string, right: string]

/** The bar's entries. A pair holds only while its two tabs sit next to each
 *  other in that order, so opening, closing or moving a tab cannot leave a
 *  pane joined to the wrong neighbour; a stale pair is just ignored. */
function groupsOf(tabs: Tab[], pairs: Pair[]): Group[] {
  const leftOf = new Map(pairs.map(([l, r]) => [r, l]))
  const out: Group[] = []
  for (const t of tabs) {
    const last = out[out.length - 1]
    if (last?.length === 1 && leftOf.get(t.id) === last[0].id) last.push(t)
    else out.push([t])
  }
  return out
}

/** A window in two columns: marks a split's entry in the tab bar. */
function SplitGlyph() {
  return (
    <svg className="tab-glyph" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h7V6H4zm9 0v12h7V6h-7z"
      />
    </svg>
  )
}

/** A tab lifting off a window: Move to New Tab, on a pane's head. */
function TabGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 8h3V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm5-2v4H4v8h16v-8h-5V6H9z"
      />
    </svg>
  )
}

/** A file name from a title: nothing a path would read as structure. */
function fileStem(title: string): string {
  const s = title.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80)
  return s || UNTITLED
}

const SAVE_LABEL = 'Save…'
const DISCARD_LABEL = 'Don’t Save'

export default function App() {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Starts closed; opens only when there is nothing to show, after startup.
  const [toast, setToast] = useState<{ text: string; action?: ToastAction } | null>(null)
  const toastTimer = useRef<number | null>(null)
  const [dropping, setDropping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Full screen hides the traffic lights, so the tab bar drops their inset.
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const win = getCurrentWindow()
    const check = () => void win.isFullscreen().then(setFullscreen).catch(() => {})
    check()
    const un = win.onResized(check)
    return () => void un.then((f) => f())
  }, [])
  const [welcome, setWelcome] = useState<{ needsCli: boolean; needsSkill: boolean; needsMd: boolean; intro: boolean } | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  /** Set on the first launch after an update: the version it came from. */
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  /** Release Notes is open; `from` marks which releases are new. */
  const [notes, setNotes] = useState<{ from: string | null } | null>(null)
  /** The document whose editor takes the cursor when it comes up: the one a
   *  draft just became, so the typing carries on across the save. */
  const [focusId, setFocusId] = useState<string | null>(null)

  const [pairs, setPairs] = useState<Pair[]>([])
  const [split, setSplit] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY))
    return v >= 0.25 && v <= 0.75 ? v : 0.5
  })

  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const pairsRef = useRef<Pair[]>([])
  pairsRef.current = pairs
  // Last session's layout, read before the first render's effects write the
  // empty one over it. Reading at startup came too late, so no tab was ever
  // restored.
  const savedTabs = useRef(localStorage.getItem(TABS_KEY))
  const savedPairs = useRef(localStorage.getItem(PAIRS_KEY))
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  const actions = useRef(new Map<string, DocumentActions>())
  const drafts = useRef(new Map<string, DraftActions>())
  const nextDraft = useRef(1)

  /** Whatever the tab is, this is what answers a menu item for it. */
  const tabActions = (id: string | null) =>
    id ? (actions.current.get(id) ?? drafts.current.get(id) ?? null) : null

  const showToast = useCallback((text: string, action?: ToastAction) => {
    setToast({ text, action })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    // One with a button has to stay long enough to be read and clicked.
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 8000 : 2600)
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

  // Persist the open tabs (paths) and restore them next launch. Drafts have
  // no path and are not kept: closing the window asks about them instead.
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs.flatMap((t) => (isDraft(t) ? [] : [t.path]))))
    const saved = groupsOf(tabs, pairs).flatMap(([l, r]) => (r && !isDraft(l) && !isDraft(r) ? [[l.path, r.path]] : []))
    localStorage.setItem(PAIRS_KEY, JSON.stringify(saved))
  }, [tabs, pairs])

  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(split))
  }, [split])

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

  const groupsNow = () => groupsOf(tabsRef.current, pairsRef.current)

  /** Lay the bar out as these groups. The refs move at once, so a second
   *  change in the same event sees the first. */
  const commitGroups = useCallback((gs: Group[]) => {
    const ts = gs.flat()
    const ps = gs.flatMap((g): Pair[] => (g.length === 2 ? [[g[0].id, g[1].id]] : []))
    tabsRef.current = ts
    pairsRef.current = ps
    setTabs(ts)
    setPairs(ps)
  }, [])

  /** The pane each split had the focus in last, by its left tab, so coming
   *  back to a split puts the cursor where it was. */
  const lastPane = useRef(new Map<string, string>())
  useEffect(() => {
    const g = groupsOf(tabsRef.current, pairsRef.current).find((x) => x.some((t) => t.id === activeId))
    if (g && activeId) lastPane.current.set(g[0].id, activeId)
  }, [activeId, tabs, pairs])

  /** The tab that had the focus before the one that has it now. */
  const prevActive = useRef<string | null>(null)
  const seenActive = useRef<string | null>(null)
  useEffect(() => {
    if (activeId === seenActive.current) return
    prevActive.current = seenActive.current
    seenActive.current = activeId
  }, [activeId])

  /** The tab to show when a group is picked from the bar. */
  const paneOf = (g: Group) => g.find((t) => t.id === lastPane.current.get(g[0].id)) ?? g[0]

  /** Put `tab` into the split on screen (or the entry holding `besideId`), on
   *  `side`. Next to a lone tab that makes a split; in a split it takes that
   *  pane, and the tab it pushes out gets its own place in the bar, right
   *  after. `tab` leaves wherever it was. Two columns at most, as a page of
   *  text barely fits in less. */
  const putBeside = useCallback(
    (tab: Tab, side: Pane, besideId: string | null = activeRef.current) => {
      const gs = groupsOf(tabsRef.current, pairsRef.current)
        .map((g) => g.filter((t) => t.id !== tab.id))
        .filter((g) => g.length)
      const i = gs.findIndex((g) => g.some((t) => t.id === besideId))
      if (i < 0) return
      const shown = gs[i]
      if (shown.length === 1) gs[i] = side === 'left' ? [tab, shown[0]] : [shown[0], tab]
      else {
        const at = side === 'left' ? 0 : 1
        const pair = [...shown]
        pair[at] = tab
        gs.splice(i, 1, pair, [shown[at]])
      }
      commitGroups(gs)
      setActiveId(tab.id)
    },
    [commitGroups],
  )

  /** Give `id` its own place in the bar, right after the split it was in.
   *  The other pane keeps the window. */
  const separate = useCallback(
    (id: string) => {
      const gs = groupsOf(tabsRef.current, pairsRef.current)
      const i = gs.findIndex((g) => g.length === 2 && g.some((t) => t.id === id))
      if (i < 0) return
      const out = gs[i].find((t) => t.id === id)!
      const stay = gs[i].find((t) => t.id !== id)!
      gs.splice(i, 1, [stay], [out])
      commitGroups(gs)
      setActiveId(stay.id)
    },
    [commitGroups],
  )

  /** The other pane of the split on screen, if there is a split. */
  const otherPane = () => {
    const g = groupsOf(tabsRef.current, pairsRef.current).find((x) => x.some((t) => t.id === activeRef.current))
    return g?.length === 2 ? g.find((t) => t.id !== activeRef.current)! : null
  }

  /** Move the focus to the pane on `side`, cursor and all. */
  const focusPane = useCallback((side: Pane) => {
    const g = groupsOf(tabsRef.current, pairsRef.current).find((x) => x.some((t) => t.id === activeRef.current))
    if (g?.length !== 2) return
    const t = g[side === 'left' ? 0 : 1]
    setActiveId(t.id)
    ;(actions.current.get(t.id) ?? drafts.current.get(t.id))?.focus()
  }, [])

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

  // ---- drafts -------------------------------------------------------------

  /** New Document: an empty page to write on, saved when you say where. */
  const newDraft = useCallback(() => {
    const id = `draft-${nextDraft.current++}`
    setTabs((ts) => [...ts, { id, draft: true, title: UNTITLED, dirty: false }])
    setActiveId(id)
    setSidebarOpen(false)
  }, [])

  /** New Document Beside: an empty page next to the one in front. In a split
   *  it takes the other pane, whose tab moves to a place of its own. */
  const newBeside = useCallback(() => {
    if (!activeRef.current) {
      newDraft()
      return
    }
    const id = `draft-${nextDraft.current++}`
    const other = otherPane()
    const side: Pane = other && groupsNow().some((g) => g[0].id === other.id) ? 'left' : 'right'
    putBeside({ id, draft: true, title: UNTITLED, dirty: false }, side)
    setSidebarOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDraft, putBeside])

  const onDraftState = useCallback((id: string, s: { title: string; dirty: boolean }) => {
    setTabs((ts) => ts.map((t) => (t.id === id && isDraft(t) ? { ...t, ...s } : t)))
  }, [])

  /** Ask where the draft goes, write it there, and register it. Null when
   *  the user backed out of the dialog or the write failed. */
  const writeDraft = useCallback(async (tab: DraftTab): Promise<DocEntry | null> => {
    const h = drafts.current.get(tab.id)
    if (!h) return null
    const picked = await save({
      title: 'Save Document',
      defaultPath: `${fileStem(tab.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    if (!picked) return null
    const path = /\.(md|markdown)$/i.test(picked) ? picked : `${picked}.md`
    try {
      await ipc.writeDoc(path, h.getMarkdown())
      return await ipc.registerDoc(path)
    } catch (e) {
      await message(`${e}`, { title: 'Cannot save document', kind: 'error' })
      return null
    }
  }, [])

  /** Save (⌘S) on a draft: the tab becomes the document it was saved as. */
  const saveDraft = useCallback(
    async (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab || !isDraft(tab)) return
      const doc = await writeDraft(tab)
      if (!doc) return
      drafts.current.delete(id)
      setFocusId(doc.id)
      // Saved over a file that is open already: that tab shows it (the
      // watcher reloads it) and the draft goes. Otherwise the document takes
      // the draft's place, in its pane if it had one.
      const open = tabsRef.current.some((t) => t.id === doc.id)
      commitGroups(
        groupsNow()
          .map((g) => (open ? g.filter((t) => t.id !== id) : g).map((t) => (t.id === id || t.id === doc.id ? doc : t)))
          .filter((g) => g.length),
      )
      setActiveId(doc.id)
      await refreshDocs()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitGroups, refreshDocs, writeDraft],
  )

  /** Save, Don't Save, or Cancel. Three buttons, because two cannot offer
   *  both keeping and discarding beside not closing at all; it is the
   *  question macOS asks when a window with unsaved changes closes. */
  const confirmDraft = useCallback(async (tab: DraftTab): Promise<'save' | 'discard' | 'cancel'> => {
    const r = await message(
      `Do you want to save the changes made to “${tab.title}”? Your changes will be lost if you don’t save them.`,
      {
        title: 'Unsaved document',
        kind: 'warning',
        buttons: { yes: SAVE_LABEL, no: DISCARD_LABEL, cancel: 'Cancel' },
      },
    )
    if (r === SAVE_LABEL || r === 'Yes') return 'save'
    if (r === DISCARD_LABEL || r === 'No') return 'discard'
    return 'cancel'
  }, [])

  /** Close a tab. False when it stayed: a draft with text in it asks first,
   *  and Cancel keeps it. */
  const closeTab = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return true
      let reopenPath: string | null = null
      if (isDraft(tab)) {
        if (tab.dirty) {
          const choice = await confirmDraft(tab)
          if (choice === 'cancel') return false
          if (choice === 'save') {
            const doc = await writeDraft(tab)
            if (!doc) return false
            // Reopen Closed Tab brings it back as the file it became.
            reopenPath = doc.path
            void refreshDocs()
          }
        }
        drafts.current.delete(id)
      } else {
        await actions.current.get(id)?.flush()
        actions.current.delete(id)
        await ipc.unwatchDoc(tab.path).catch(() => {})
        reopenPath = tab.path
      }
      // After the waits: the list may have moved while a dialog was up.
      const idx = tabsRef.current.findIndex((t) => t.id === id)
      const gs = groupsNow()
      const gi = gs.findIndex((g) => g.some((t) => t.id === id))
      const partner = gs[gi]?.find((t) => t.id !== id) ?? null
      const next = gs.map((g) => g.filter((t) => t.id !== id)).filter((g) => g.length)
      if (reopenPath) closedTabs.current.push({ path: reopenPath, index: idx })
      commitGroups(next)
      if (activeRef.current === id) {
        // Out of a split, the other pane takes the window.
        const neighbour = partner ?? next[Math.min(gi, next.length - 1)]?.[0] ?? null
        setActiveId(neighbour?.id ?? null)
      }
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitGroups, confirmDraft, refreshDocs, writeDraft],
  )

  /** Settle every unsaved draft in this window — Save, Don't Save or Cancel
   *  for each — then write every open document. False when the user
   *  cancelled, and then whatever asked (a close, a quit, an update) stops. */
  const settleWindow = useCallback(async (): Promise<boolean> => {
    for (const t of [...tabsRef.current]) {
      if (isDraft(t) && t.dirty && !(await closeTab(t.id))) return false
    }
    for (const t of tabsRef.current) await actions.current.get(t.id)?.flush()
    return true
  }, [closeTab])

  /** Save every open document before Homebrew replaces the app under us. */
  const runUpdate = useCallback(async () => {
    if (!(await settleWindow())) return
    await ipc.updateRun()
  }, [settleWindow])

  const reopenClosedTab = useCallback(async () => {
    // Skip entries that are open again already (reopened by other means).
    let entry = closedTabs.current.pop()
    while (entry && tabsRef.current.some((t) => !isDraft(t) && t.path === entry!.path)) entry = closedTabs.current.pop()
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

  // A split is one stop: cycling and ⌘-numbers go by the bar's entries.
  const cycleTab = useCallback((dir: 1 | -1) => {
    const list = groupsOf(tabsRef.current, pairsRef.current)
    if (list.length < 2) return
    const i = list.findIndex((g) => g.some((t) => t.id === activeRef.current))
    const n = (i + dir + list.length) % list.length
    setActiveId(paneOf(list[n]).id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs, ⌘1–⌘8 pick one by position and ⌘9
  // is the last (browser conventions). `code`, not `key`: the digit keys are
  // where they are whatever the keyboard layout prints on them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
        return
      }
      const digit = /^Digit([1-9])$/.exec(e.code)
      // ⇧⌘1 and ⇧⌘2 are menu items, but macOS matches a menu key after Shift
      // has turned 1 into ! and the item never fires. They are handled here.
      const panel = digit && { '1': 'toggle_sidebar', '2': 'toggle_threads' }[digit[1]]
      if (panel && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void runMenu.current(panel)
        return
      }
      if (digit && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        const list = groupsOf(tabsRef.current, pairsRef.current)
        const n = Number(digit[1])
        const g = n === 9 ? list[list.length - 1] : list[n - 1]
        if (g) setActiveId(paneOf(g).id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycleTab])

  // Holding ⌘ puts each tab's ⌘-number in its close button's slot. The slot is
  // always laid out, so no tab changes width. A short wait keeps quick
  // shortcuts (⌘S, ⌘C) from flashing the numbers; any other key cancels it.
  const [showTabKeys, setShowTabKeys] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const hide = () => {
      window.clearTimeout(timer)
      setShowTabKeys(false)
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== 'Meta') hide()
      else if (!e.repeat) {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => setShowTabKeys(true), 60)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') hide()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    // ⌘Tab to another app: the key comes up where this window cannot see it.
    window.addEventListener('blur', hide)
    return () => {
      hide()
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  /** The number ⌘-digit uses for the tab at `i`: 1–8 by position, 9 for the last. */
  const tabKey = (i: number, count: number) => (i < 8 ? i + 1 : i === count - 1 ? 9 : null)

  // ---- dragging tabs -------------------------------------------------------

  // Pointer events rather than HTML drag and drop: the window's file drop
  // handler sits on the native drag, and a tab should move within the bar, not
  // leave it. The order changes live as the tab passes a neighbour's midpoint;
  // between those the dragged tab follows the pointer on a transform. A split
  // moves as one entry. Pulled down into the document, a lone tab lifts out of
  // the bar and drops beside the document on screen, as a pane.
  const workspaceRef = useRef<HTMLDivElement>(null)
  const tabbarRef = useRef<HTMLDivElement>(null)
  const tabEls = useRef(new Map<string, HTMLDivElement>())
  const drag = useRef<{
    /** The group's key: its first tab's id. */
    id: string
    pointerId: number
    startX: number
    grab: number
    grabY: number
    startY: number
    x: number
    moving: boolean
  } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** The pane a drop would land in, while a tab or a pane head is over it. */
  const [paneDrop, setPaneDrop] = useState<Pane | null>(null)
  const paneDropRef = useRef<Pane | null>(null)
  paneDropRef.current = paneDrop
  /** A pane head is over the bar: let go and it becomes a tab. */
  const [barDrop, setBarDrop] = useState(false)
  const barDropRef = useRef(false)
  barDropRef.current = barDrop

  /** The pane under the pointer: by the divider in a split, by the middle
   *  next to a lone document. Null above the document area. */
  const paneAt = (x: number, y: number): Pane | null => {
    const ws = workspaceRef.current?.getBoundingClientRect()
    const bar = tabbarRef.current?.getBoundingClientRect()
    if (!ws || !bar || y < bar.bottom + 8) return null
    const g = groupsOf(tabsRef.current, pairsRef.current).find((x) => x.some((t) => t.id === activeRef.current))
    const cut = g?.length === 2 ? split : 0.5
    return x - ws.left < ws.width * cut ? 'left' : 'right'
  }

  /** The tab a dragged entry would land beside, if it can become a pane: the
   *  document on screen, or, when the dragged tab is that document, the lone
   *  tab that was in front before it, else its nearest lone neighbour. */
  const besideFor = (gs: Group[], from: number): string | null => {
    const g = gs[from]
    if (g?.length !== 1) return null
    const active = activeRef.current
    if (g[0].id !== active) return active
    const lone = (x: Group | undefined) => (x?.length === 1 && x !== g ? x[0].id : null)
    const before = lone(gs.find((x) => x.some((t) => t.id === prevActive.current)))
    if (before) return before
    for (let n = 1; n < gs.length; n++) {
      const near = lone(gs[from + n]) ?? lone(gs[from - n])
      if (near) return near
    }
    return null
  }

  /** Put the dragged tab under the pointer, measured from its slot. */
  const placeDragged = useCallback(() => {
    const d = drag.current
    const el = d && tabEls.current.get(d.id)
    if (!d || !el || !d.moving || paneDropRef.current) return
    // offsetLeft counts from the offset parent, so the pointer has to as well.
    const origin = (el.offsetParent as HTMLElement).getBoundingClientRect().left
    const gs = groupsOf(tabsRef.current, pairsRef.current)
    const first = tabEls.current.get(gs[0][0].id)!
    const last = tabEls.current.get(gs[gs.length - 1][0].id)!
    // Kept within the run of tabs, so it cannot be pulled over the controls.
    const left = Math.min(
      Math.max(d.x - origin - d.grab, first.offsetLeft),
      last.offsetLeft + last.offsetWidth - el.offsetWidth,
    )
    el.style.transform = `translateX(${left - el.offsetLeft}px)`
  }, [])

  // A reorder moves the slot under the tab; keep the tab where the pointer is.
  useLayoutEffect(placeDragged, [tabs, pairs, placeDragged])

  const onTabPointerDown = (e: PointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return
    const r = e.currentTarget.getBoundingClientRect()
    drag.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      grab: e.clientX - r.left,
      grabY: e.clientY - r.top,
      startY: e.clientY,
      x: e.clientX,
      moving: false,
    }
  }

  const onTabPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    d.x = e.clientX
    const el = e.currentTarget
    if (!d.moving) {
      // A few pixels of slack, so a click that wobbles is still a click. In
      // any direction: the pointer is not captured yet, so a pull straight
      // down has to start the drag before it leaves the tab, or the tab
      // never hears of it again.
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return
      d.moving = true
      el.setPointerCapture(e.pointerId)
      setDraggingId(d.id)
    }
    const gs = groupsOf(tabsRef.current, pairsRef.current)
    const from = gs.findIndex((g) => g[0].id === d.id)
    // Only a lone tab can become a pane, and it needs a document to go beside.
    const pane = besideFor(gs, from) ? paneAt(e.clientX, e.clientY) : null
    setPaneDrop(pane)
    paneDropRef.current = pane
    if (pane) {
      // Off the bar: the tab follows the pointer freely, over the document.
      const origin = (el.offsetParent as HTMLElement).getBoundingClientRect()
      const dx = e.clientX - origin.left - d.grab - el.offsetLeft
      const dy = e.clientY - origin.top - d.grabY - el.offsetTop
      el.style.transform = `translate(${dx}px, ${dy}px)`
      return
    }
    const centre = e.clientX - d.grab + el.offsetWidth / 2
    const others = gs.filter((_, i) => i !== from)
    let to = 0
    for (const g of others) {
      const r = tabEls.current.get(g[0].id)!.getBoundingClientRect()
      if (centre > r.left + r.width / 2) to++
    }
    if (to !== from) {
      const next = [...others]
      next.splice(to, 0, gs[from])
      commitGroups(next)
    } else {
      placeDragged()
    }
  }

  const endTabDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    if (!d.moving) return
    e.currentTarget.style.transform = ''
    setDraggingId(null)
    const pane = paneDropRef.current
    setPaneDrop(null)
    const gs = groupsNow()
    const at = gs.findIndex((x) => x[0].id === d.id)
    if (at < 0) return
    const g = gs[at]
    if (pane && e.type === 'pointerup') {
      const beside = besideFor(gs, at)
      if (beside) putBeside(g[0], pane, beside)
    } else if (!pane) setActiveId(paneOf(g).id)
  }

  // ---- dragging pane heads ---------------------------------------------------

  // A pane's head is its handle, as in Rex: up into the bar and the pane
  // becomes a tab of its own; across onto the other pane and the two swap.
  const headDrag = useRef<{ id: string; pointerId: number; startX: number; startY: number; moving: boolean } | null>(null)

  const onHeadPointerDown = (e: PointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    setActiveId(id)
    headDrag.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moving: false }
  }

  const onHeadPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = headDrag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return
      d.moving = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const bar = tabbarRef.current?.getBoundingClientRect()
    const onBar = !!bar && e.clientY < bar.bottom
    const g = groupsOf(tabsRef.current, pairsRef.current).find((x) => x.some((t) => t.id === d.id))
    const own: Pane = g?.[0].id === d.id ? 'left' : 'right'
    const pane = onBar ? null : paneAt(e.clientX, e.clientY)
    setBarDrop(onBar)
    setPaneDrop(pane && pane !== own ? pane : null)
  }

  const endHeadDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = headDrag.current
    if (!d || d.pointerId !== e.pointerId) return
    headDrag.current = null
    const swap = paneDropRef.current
    const toBar = barDropRef.current
    setPaneDrop(null)
    setBarDrop(false)
    if (!d.moving || e.type !== 'pointerup') return
    if (toBar) {
      separate(d.id)
      setActiveId(d.id)
    } else if (swap) {
      commitGroups(groupsNow().map((g) => (g.length === 2 && g.some((t) => t.id === d.id) ? [g[1], g[0]] : g)))
    }
  }

  // ---- the divider -----------------------------------------------------------

  const dividerDrag = useRef<number | null>(null)

  const onDividerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dividerDrag.current !== e.pointerId) return
    const ws = workspaceRef.current?.getBoundingClientRect()
    if (!ws) return
    // Neither page gets narrower than a quarter of the window.
    setSplit(Math.min(0.75, Math.max(0.25, (e.clientX - ws.left) / ws.width)))
  }

  // ---- closing and quitting ----------------------------------------------

  // The red button and Close Window. Once a listener is on this event the
  // window closes only when the handler lets it, so a draft with text gets
  // its question and Cancel keeps the window.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await settleWindow())) e.preventDefault()
    })
    return () => {
      void un.then((f) => f())
    }
  }, [settleWindow])

  // Cmd+Q. The backend asks every window and exits when the last has
  // reported ready; one Cancel anywhere calls it off. See `request_quit`.
  useEffect(() => {
    const un = listen('confirm-quit', async () => {
      if (await settleWindow()) await ipc.quitReady()
      else await ipc.quitCancel()
    })
    return () => {
      void un.then((f) => f())
    }
  }, [settleWindow])

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

  /** Runs a menu item by id; set by the effect below. Keys the menu cannot
   *  catch come here too. */
  const runMenu = useRef<(id: string) => Promise<void>>(async () => {})

  useEffect(() => {
    const run = async (id: string) => {
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
        const act = tabActions(activeRef.current)
        if (act) await act.menu(id)
        return
      }
      switch (id) {
        case 'new_doc':
          newDraft()
          return
        case 'new_beside':
          newBeside()
          return
        case 'join_next': {
          // The next entry in the bar comes into the split, in the other
          // pane's place if there is a split already.
          const gs = groupsNow()
          const i = gs.findIndex((g) => g.some((t) => t.id === activeRef.current))
          const next = i < 0 ? undefined : gs[(i + 1) % gs.length]
          if (!next || next === gs[i]) {
            showToast('Open another tab to show beside this one.')
            return
          }
          if (next.length === 2) {
            showToast('The next tab is a split already.')
            return
          }
          const other = otherPane()
          putBeside(next[0], other && other.id === gs[i][0].id ? 'left' : 'right')
          return
        }
        case 'separate_panes': {
          // The pane in front keeps the window.
          const other = otherPane()
          if (other) separate(other.id)
          return
        }
        case 'focus_pane_left':
          focusPane('left')
          return
        case 'focus_pane_right':
          focusPane('right')
          return
        case 'open':
          await openFileDialog()
          return
        case 'save': {
          const cur = activeRef.current
          const tab = tabsRef.current.find((t) => t.id === cur)
          if (!cur || !tab) return
          if (isDraft(tab)) {
            await saveDraft(cur)
            return
          }
          // An opened document autosaves; this only writes what is still on
          // the timer, and says so, because a ⌘S that does nothing visible
          // reads as a ⌘S that did nothing.
          await actions.current.get(cur)?.flush()
          showToast('Saved.')
          return
        }
        case 'toggle_sidebar':
          // With no tabs the start screen already lists the documents, so a
          // pane there would only duplicate it.
          if (tabsRef.current.length) setSidebarOpen((v) => !v)
          return
        case 'toggle_toc':
          applyContents(document.documentElement.dataset.toc === 'off')
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
          if (info?.dev) {
            showToast('Not from a dev build: use the installed Sidenote to set up the integration.')
            return
          }
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
      const act = tabActions(activeRef.current)
      if (act) await act.menu(id)
    }
    runMenu.current = run
    const un = listen<{ id: string; window?: string | null }>('menu', async (e) => {
      // The backend names the window that had focus. Every window receives the
      // event regardless of how it is emitted, so the check has to be here:
      // without it one Cmd+N opened a window per open window, and Cmd+W closed
      // a tab in each of them.
      const target = e.payload.window
      if (target && target !== getCurrentWindow().label) return
      await run(e.payload.id)
    })
    return () => {
      void un.then((f) => f())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkUpdate, closeTab, cycleTab, docs, focusPane, info, newBeside, newDraft, openFileDialog, openPath, putBeside, refreshDocs, reopenClosedTab, saveDraft, separate, showToast])

  // ---- startup ------------------------------------------------------------

  useEffect(() => {
    loadPreferences()
    void (async () => {
      const inf = await ipc.appInfo().catch(() => null)
      setInfo(inf)
      // One window notices the update; a second window would say it twice.
      if (inf && getCurrentWindow().label === 'main') setUpdatedFrom(takeUpdatedFrom(inf.version))
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
          saved = JSON.parse(savedTabs.current ?? '[]')
        } catch {
          saved = []
        }
        for (const p of saved) await openPath(p, true)
        // And the splits among them. A pair whose file is gone is dropped
        // by `groupsOf`, since its two tabs are no longer neighbours.
        let saidPairs: [string, string][] = []
        try {
          saidPairs = JSON.parse(savedPairs.current ?? '[]')
        } catch {
          saidPairs = []
        }
        // The last open has rendered, so the ref holds every restored tab.
        await new Promise((r) => setTimeout(r, 0))
        const byPath = new Map(tabsRef.current.flatMap((t) => (isDraft(t) ? [] : [[t.path, t.id] as const])))
        const restored = saidPairs.flatMap(([l, r]): Pair[] => {
          const a = byPath.get(l)
          const b = byPath.get(r)
          return a && b ? [[a, b]] : []
        })
        if (restored.length) commitGroups(groupsOf(tabsRef.current, restored))
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
      // Never in a dev build. Its webview store starts empty, so the sheet
      // would show on every fresh identity, and what it offers — linking the
      // debug binary, registering the dev bundle for .md — the backend refuses
      // anyway.
      if (!inf?.dev && (needsCli || needsSkill || needsMd) && !localStorage.getItem('sidenote.welcomeShown')) {
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

  const sideOpen = sidebarOpen && tabs.length > 0
  const groups = groupsOf(tabs, pairs)
  /** The bar entry on screen: one tab, or the two of a split. */
  const shown = groups.find((g) => g.some((t) => t.id === activeId)) ?? null
  const paneSide = (id: string): Pane | undefined =>
    shown?.length === 2 ? (shown[0].id === id ? 'left' : shown[1].id === id ? 'right' : undefined) : undefined

  /** Close every tab in a bar entry; a Cancel on a draft stops there. */
  const closeGroup = async (g: Group) => {
    for (const t of g) if (!(await closeTab(t.id))) return
  }

  return (
    <div className={`app ${sideOpen ? 'sidebar-open' : ''} ${info?.dev ? 'is-dev' : ''} ${fullscreen ? 'is-fullscreen' : ''}`}>
      <div className="sidebar-cell" aria-hidden={!sideOpen}>
        <Sidebar
          docs={docs}
          currentId={activeId}
          onOpen={(d) => void openDoc(d)}
          onForget={(d) => void forgetDoc(d)}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      <div
        ref={workspaceRef}
        className={`workspace ${shown?.length === 2 ? 'is-split' : ''}`}
        style={{ '--split': `${split * 100}%` } as CSSProperties}
      >
        <div ref={tabbarRef} className={`tabbar ${sideOpen ? '' : 'tabbar-inset'} ${barDrop ? 'tabbar-drop' : ''}`} data-tauri-drag-region>
          {/* ⇧⌘1 is the shortcut; this is the same toggle with a face. It moves
              into the sidebar head while the pane is open. */}
          {tabs.length > 0 && !sideOpen && (
            <button type="button" className="side-toggle" title="Show Sidebar (⇧⌘1)" onClick={() => setSidebarOpen(true)}>
              <SidebarGlyph />
            </button>
          )}
          {groups.map((g, i) => {
            const key = g[0].id
            const dirty = g.some((t) => isDraft(t) && t.dirty)
            return (
              <div
                key={key}
                ref={(el) => {
                  if (el) tabEls.current.set(key, el)
                  else tabEls.current.delete(key)
                }}
                className={`tab ${g === shown ? 'tab-active' : ''} ${g.length === 2 ? 'tab-split' : ''} ${dirty ? 'tab-dirty' : ''} ${key === draggingId ? 'tab-dragging' : ''} ${key === draggingId && paneDrop ? 'tab-lifted' : ''} ${showTabKeys && tabKey(i, groups.length) ? 'tab-keyed' : ''}`}
                title={g.map((t) => (isDraft(t) ? 'Not saved yet (⌘S)' : t.path)).join('\n')}
                onClick={() => setActiveId(paneOf(g).id)}
                onPointerDown={(e) => onTabPointerDown(e, key)}
                onPointerMove={onTabPointerMove}
                onPointerUp={endTabDrag}
                onPointerCancel={endTabDrag}
                onAuxClick={(e) => {
                  if (e.button === 1) void closeGroup(g)
                }}
              >
                {g.length === 2 && <SplitGlyph />}
                {g.map((t, j) => (
                  <span key={t.id} className={`tab-title ${j ? 'tab-title-right' : ''}`}>
                    {t.title}
                  </span>
                ))}
                <button
                  type="button"
                  className="tab-close"
                  title={g.length === 2 ? 'Close both panes' : 'Close tab (⌘W)'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeGroup(g)
                  }}
                >
                  <span className="tab-x">×</span>
                  <span className="tab-dot">•</span>
                  <span className="tab-key">{tabKey(i, groups.length)}</span>
                </button>
              </div>
            )
          })}
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
                <p className="muted">Open a markdown file to review it, or start a new one.</p>
                <div className="start-actions">
                  <button type="button" className="btn-quiet" onClick={newDraft}>
                    New Document (⌘N)
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => void openFileDialog()}>
                    Open… (⌘O)
                  </button>
                </div>
              </div>
              <Recents docs={docs} onOpen={(d) => void openDoc(d)} onForget={(d) => void forgetDoc(d)} />
            </div>
          </main>
        )}

        {tabs.map((t) => {
          const pane = paneSide(t.id)
          return (
            // A click anywhere in a pane gives it the focus, and with it the
            // menu. `contents`, so the view still sits in the workspace.
            <div key={t.id} className="pane-slot" onPointerDownCapture={() => pane && setActiveId(t.id)}>
              {isDraft(t) ? (
                <DraftView
                  ref={(h) => {
                    if (h) drafts.current.set(t.id, h)
                    else drafts.current.delete(t.id)
                  }}
                  visible={!!shown?.includes(t)}
                  pane={pane}
                  onState={(s) => onDraftState(t.id, s)}
                  onSave={() => void saveDraft(t.id)}
                  onToast={showToast}
                />
              ) : (
                <DocumentView
                  ref={(h) => {
                    if (h) actions.current.set(t.id, h)
                    else actions.current.delete(t.id)
                  }}
                  doc={t}
                  active={t.id === activeId}
                  visible={!!shown?.includes(t)}
                  pane={pane}
                  focusOnLoad={t.id === focusId}
                  onToast={showToast}
                  onDocChanged={(d) => {
                    setTabs((ts) => ts.map((x) => (x.id === d.id ? d : x)))
                    void refreshDocs()
                  }}
                />
              )}
            </div>
          )
        })}

        {shown?.length === 2 && (
          <>
            {shown.map((t, j) => (
              <div
                key={t.id}
                className={`pane-head pane-${j ? 'right' : 'left'} ${t.id === activeId ? 'pane-head-active' : ''}`}
                title={isDraft(t) ? 'Not saved yet (⌘S)' : t.path}
                onPointerDown={(e) => onHeadPointerDown(e, t.id)}
                onPointerMove={onHeadPointerMove}
                onPointerUp={endHeadDrag}
                onPointerCancel={endHeadDrag}
              >
                <span className="pane-head-title">{t.title}</span>
                <button type="button" className="pane-head-btn" title="Move to New Tab" onClick={() => separate(t.id)}>
                  <TabGlyph />
                </button>
                <button type="button" className="pane-head-btn" title="Close (⌘W)" onClick={() => void closeTab(t.id)}>
                  ×
                </button>
              </div>
            ))}
            <div
              className="pane-divider"
              title="Drag to resize; double-click to even up"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                dividerDrag.current = e.pointerId
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={onDividerMove}
              onPointerUp={() => (dividerDrag.current = null)}
              onPointerCancel={() => (dividerDrag.current = null)}
              onDoubleClick={() => setSplit(0.5)}
            />
          </>
        )}

        {paneDrop && <div className={`pane-drop pane-drop-${paneDrop} ${shown?.length === 2 ? 'pane-drop-split' : ''}`} />}

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

        {updatedFrom && info && !update && (
          <WhatsNewPill
            version={info.version}
            onOpen={() => {
              setNotes({ from: updatedFrom })
              setUpdatedFrom(null)
            }}
            onDismiss={() => setUpdatedFrom(null)}
          />
        )}

        {toast && (
          <div className="toast">
            <span>{toast.text}</span>
            {toast.action && (
              <button type="button" className="toast-action" onClick={toast.action.run}>
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>

      {dropping && (
        <div className="drop-veil">
          <div className="drop-note">Drop markdown to review</div>
        </div>
      )}

      {info?.dev && (
        <div className="dev-chip" title={`Development build · ${info.name} ${info.version} · port ${info.port}`}>
          Dev
        </div>
      )}

      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onToast={showToast}
          onCheckUpdates={() => void checkUpdate(true)}
          onReleaseNotes={() => setNotes({ from: null })}
        />
      )}
      {notes && info && <ReleaseNotes current={info.version} from={notes.from} onClose={() => setNotes(null)} />}
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
    </div>
  )
}
