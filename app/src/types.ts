// Mirrors sidenote_core::model.

export type ThreadStatus = 'open' | 'resolved' | 'orphaned'
export type Author = 'user' | 'claude'

export interface Selector {
  exact: string
  prefix: string
  suffix: string
  start?: number
}

export interface Message {
  author: Author
  at: string
  body: string
}

export interface Thread {
  id: string
  status: ThreadStatus
  selector: Selector
  created_at: string
  messages: Message[]
  done?: boolean
  /** A session has picked the thread up and not replied yet. */
  working?: boolean
  /** When `working` was last set; the newest is the passage Claude is on. */
  working_since?: string | null
  /** How many messages the thread held when the user last opened it. A count
   *  rather than a time: these timestamps are whole seconds. */
  read_count?: number | null
}

/** A thread is unread when Claude has written in it since the user last
 *  opened it. Mirrors `Thread::unread` in the core. */
export function isUnread(t: Thread): boolean {
  if (t.status === 'resolved') return false
  const last = t.messages[t.messages.length - 1]
  if (!last || last.author !== 'claude') return false
  return t.messages.length > (t.read_count ?? 0)
}

export interface ThreadsFile {
  version: number
  threads: Thread[]
}

export interface DocEntry {
  id: string
  path: string
  title: string
  registered_at: string
  last_opened: string
  owner_session?: string | null
}

export interface Focus {
  exact: string
  session: string
  at: string
  thread?: string | null
}

export interface StateFile {
  busy: boolean
  busy_since?: string | null
  busy_by?: string | null
  unlocked_at?: string | null
  unlocked_session?: string | null
  /** Where the session last wrote. Advisory: it locks nothing. */
  focus?: Focus | null
  /** Suggesting mode: Claude's edits wait in the margin instead of landing. */
  suggesting?: boolean
}

export type SegKind = 'equal' | 'delete' | 'insert'

/** One run of the word-level diff between a suggestion's two passages. */
export interface Seg {
  kind: SegKind
  text: string
}

/** A pending suggestion, as the backend hands it over: everything needed to
 *  draw it, in the plain text the editor shows rather than in markdown. */
export interface Suggestion {
  id: string
  thread?: string | null
  /** The session that proposed it. */
  session: string
  at: string
  /** The passage in the document this replaces, in plain text. */
  quote: string
  /** The replacement, still markdown: accepting parses and inserts it through
   *  the same path a direct edit takes. */
  markdown: string
  /** `equal` and `delete` segments concatenate back to `quote`. */
  segs: Seg[]
  removed: number
  added: number
}

export interface SuggestionsView {
  suggesting: boolean
  suggestions: Suggestion[]
}

export interface StateView {
  state: StateFile
  fresh: boolean
  held_secs?: number | null
}

export interface ListenerStatus {
  owner?: string | null
  owner_connected: boolean
  any_connected: boolean
  /** Would a comment posted now reach a session? The only thing the dot shows. */
  connected: boolean
  sessions: string[]
  port_error?: string | null
}

export interface Anchored {
  range: { start: number; end: number }
  method: 'exact' | 'fuzzy'
  score: number
}

export interface CliStatus {
  installed: boolean
  link: string
  target?: string | null
  bundled?: string | null
}

export interface SnapshotInfo {
  name: string
  path: string
  mtime?: number | null
  size: number
}

// A release check. `latest` is null until a check has ever succeeded, and the
// last known answer is kept when one fails, so `error` can be set alongside it.
export interface UpdateStatus {
  current: string
  latest?: string | null
  newer: boolean
  notes?: string | null
  url?: string | null
  /** Homebrew installed this copy, so the app can run the upgrade itself. */
  managed: boolean
  checked_at?: number | null
  error?: string | null
}

/** What the editor reports back for a CLI `apply` routed through the app. */
export type ApplyResult =
  | { ok: true; landed: string }
  /** Suggesting mode: nothing was edited, the edit is waiting for the user. */
  | { ok: true; suggested: string }
  | { ok: false; error: 'stale'; found: number }
  | { ok: false; error: 'not_ready' }

/** Which build this is. A dev build beside the installed app says so. */
export interface AppInfo {
  name: string
  version: string
  dev: boolean
  /** The WebSocket port the CLI must dial to reach this app. */
  port: number
}

/** A document served over the local network (dev builds only). */
export interface ShareInfo {
  /** The URL to hand out: the machine's LAN address. */
  url: string
  /** Every URL the page answers on: LAN address, then `<host>.local`. */
  urls: string[]
  token: string
  port: number
}

/** A share another Sidenote advertises over Bonjour (dev builds only). */
export interface NetworkShare {
  fullname: string
  title: string
  host: string
  port: number
  token: string
  url: string
}
