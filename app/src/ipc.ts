import { invoke } from '@tauri-apps/api/core'

/** Ids of documents opened from another Sidenote (dev builds). A call that
 *  names one of them, by id or by its `sidenote://` path, is not run here:
 *  it goes to `remote_call`, which posts it to the Mac that shares the
 *  document and returns that side's answer. Everything else is unchanged. */
const remoteIds = new Set<string>()
export function markRemote(id: string) {
  remoteIds.add(id)
}
export function isRemotePath(p: string | null | undefined): boolean {
  return typeof p === 'string' && p.startsWith('sidenote://')
}
function isRemote(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false
  if (isRemotePath(args.path as string) || isRemotePath(args.doc as string)) return true
  return typeof args.id === 'string' && remoteIds.has(args.id)
}
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isRemote(args) ? invoke<T>('remote_call', { cmd, args }) : invoke<T>(cmd, args)
}
import type {
  Anchored,
  AppInfo,
  ApplyResult,
  CliStatus,
  DocEntry,
  ListenerStatus,
  NetworkShare,
  Selector,
  ShareInfo,
  SnapshotInfo,
  StateFile,
  StateView,
  Thread,
  ThreadStatus,
  ThreadsFile,
  UpdateStatus,
  Suggestion,
  SuggestionsView,
} from './types'

export const ipc = {
  listDocs: () => invoke<DocEntry[]>('list_docs'),
  registerDoc: (path: string) => invoke<DocEntry>('register_doc', { path }),
  readDoc: (path: string) => call<string>('read_doc', { path }),
  readImage: (doc: string, src: string) => call<ArrayBuffer>('read_image', { doc, src }),
  writeDoc: (path: string, content: string) => call<void>('write_doc', { path, content }),
  readThreads: (id: string) => call<ThreadsFile>('read_threads', { id }),
  createThread: (id: string, selector: Selector, body: string) =>
    call<Thread>('create_thread', { id, selector, body }),
  addUserMessage: (id: string, threadId: string, body: string) =>
    call<Thread>('add_user_message', { id, threadId, body }),
  setThreadStatus: (id: string, threadId: string, status: ThreadStatus) =>
    call<Thread>('set_thread_status', { id, threadId, status }),
  setThreadSelector: (id: string, threadId: string, selector: Selector) =>
    call<Thread>('set_thread_selector', { id, threadId, selector }),
  updateSelectors: (id: string, updates: { thread_id: string; selector: Selector | null }[]) =>
    call<boolean>('update_selectors', { id, updates }),
  readState: (id: string) => call<StateView>('read_state', { id }),
  markThreadRead: (id: string, threadId: string) =>
    call<Thread>('mark_thread_read', { id, threadId }),
  unlockDoc: (id: string) => call<StateFile>('unlock_doc', { id }),
  readSuggestions: (id: string) => call<SuggestionsView>('read_suggestions', { id }),
  setSuggesting: (id: string, on: boolean) => call<StateFile>('set_suggesting', { id, on }),
  setMenuChecked: (id: string, checked: boolean) =>
    invoke<void>('set_menu_checked', { id, checked }).catch(() => {}),
  recordSuggestion: (id: string, session: string, old: string, next: string, thread: string | null) =>
    call<Suggestion>('record_suggestion', { id, session, old, new: next, thread }),
  acceptSuggestion: (id: string, suggestion: string, landed: string) =>
    call<Thread | null>('accept_suggestion', { id, suggestion, landed }),
  rejectSuggestion: (id: string, suggestion: string) =>
    call<void>('reject_suggestion', { id, suggestion }),
  anchorThreads: (text: string, selectors: Selector[]) =>
    invoke<(Anchored | null)[]>('anchor_threads', { text, selectors }),
  makeSelectors: (text: string, ranges: [number, number][]) =>
    invoke<Selector[]>('make_selectors', { text, ranges }),
  emitEvent: (id: string, event: 'comment' | 'reply' | 'resolve', thread: string) =>
    call<{ delivered: number; to_owner: boolean; marked: boolean }>('emit_event', { id, event, thread }),
  listenerStatus: (id?: string | null) => call<ListenerStatus>('listener_status', { id: id ?? null }),
  relinkDoc: (id: string, path: string) => invoke<DocEntry>('relink_doc', { id, path }),
  forgetDoc: (id: string) => invoke<void>('forget_doc', { id }),
  listSnapshots: (id: string) => call<SnapshotInfo[]>('list_snapshots', { id }),
  suggestRelink: (id: string) => invoke<string | null>('suggest_relink', { id }),
  watchDoc: (id: string, path: string) => call<void>('watch_doc', { id, path }),
  unwatchDoc: (path: string) => call<void>('unwatch_doc', { path }),
  windowCount: () => invoke<number>('window_count'),
  newWindow: (path?: string | null) => invoke<string>('new_window', { path: path ?? null }),
  appInfo: () => invoke<AppInfo>('app_info'),
  /** This window has settled its drafts and written its documents; quit may go on. */
  quitReady: () => invoke<void>('quit_ready'),
  /** The user kept an unsaved draft; the quit is off. */
  quitCancel: () => invoke<void>('quit_cancel'),
  readSnapshot: (id: string, name: string) => call<string>('read_snapshot', { id, name }),
  diffSnapshot: (id: string, name: string, other?: string | null) =>
    call<string>('diff_snapshot', { id, name, other: other ?? null }),
  restoreSnapshot: (id: string, name: string) => call<string>('restore_snapshot', { id, name }),
  takePendingOpens: () => invoke<string[]>('take_pending_opens'),
  sidenoteHome: () => invoke<string>('sidenote_home'),
  cliStatus: () => invoke<CliStatus>('cli_status'),
  installCli: () => invoke<string>('install_cli'),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  openLink: (url: string) => invoke<void>('open_link', { url }),
  skillStatus: () => invoke<{ path: string; installed: boolean; current: boolean }>('skill_status'),
  installSkill: (force = false) => invoke<string>('install_skill', { force }),
  defaultMdHandler: () => invoke<{ bundle_id: string; is_default: boolean; current?: string | null }>('default_md_handler'),
  setDefaultMdHandler: () => invoke<string[]>('set_default_md_handler'),
  updateCheck: (force = false) => invoke<UpdateStatus>('update_check', { force }),
  updateRun: () => invoke<string>('update_run'),
  applyResult: (rid: number, result: ApplyResult) => invoke<void>('apply_result', { rid, result }),
  /** Dev builds only: serve the document to devices on the local network. */
  shareDoc: (path: string) => invoke<ShareInfo>('share_doc', { path }),
  unshareDoc: (path: string) => invoke<void>('unshare_doc', { path }),
  shareStatus: (path: string) => call<ShareInfo | null>('share_status', { path }),
  /** Dev builds only: open a document another Sidenote shares. */
  connectRemote: (url: string) => invoke<DocEntry>('connect_remote', { url }),
  networkShares: () => invoke<NetworkShare[]>('network_shares'),
  uiLog: (line: string) => invoke<void>('ui_log', { line }).catch(() => {}),
}
