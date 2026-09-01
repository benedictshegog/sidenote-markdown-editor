import { invoke } from '@tauri-apps/api/core'
import type {
  Anchored,
  ApplyResult,
  CliStatus,
  DocEntry,
  ListenerStatus,
  Selector,
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
  readDoc: (path: string) => invoke<string>('read_doc', { path }),
  readImage: (doc: string, src: string) => invoke<ArrayBuffer>('read_image', { doc, src }),
  writeDoc: (path: string, content: string) => invoke<void>('write_doc', { path, content }),
  readThreads: (id: string) => invoke<ThreadsFile>('read_threads', { id }),
  createThread: (id: string, selector: Selector, body: string) =>
    invoke<Thread>('create_thread', { id, selector, body }),
  addUserMessage: (id: string, threadId: string, body: string) =>
    invoke<Thread>('add_user_message', { id, threadId, body }),
  setThreadStatus: (id: string, threadId: string, status: ThreadStatus) =>
    invoke<Thread>('set_thread_status', { id, threadId, status }),
  setThreadSelector: (id: string, threadId: string, selector: Selector) =>
    invoke<Thread>('set_thread_selector', { id, threadId, selector }),
  updateSelectors: (id: string, updates: { thread_id: string; selector: Selector | null }[]) =>
    invoke<boolean>('update_selectors', { id, updates }),
  readState: (id: string) => invoke<StateView>('read_state', { id }),
  markThreadRead: (id: string, threadId: string) =>
    invoke<Thread>('mark_thread_read', { id, threadId }),
  unlockDoc: (id: string) => invoke<StateFile>('unlock_doc', { id }),
  readSuggestions: (id: string) => invoke<SuggestionsView>('read_suggestions', { id }),
  setSuggesting: (id: string, on: boolean) => invoke<StateFile>('set_suggesting', { id, on }),
  setMenuChecked: (id: string, checked: boolean) =>
    invoke<void>('set_menu_checked', { id, checked }).catch(() => {}),
  recordSuggestion: (id: string, session: string, old: string, next: string, thread: string | null) =>
    invoke<Suggestion>('record_suggestion', { id, session, old, new: next, thread }),
  acceptSuggestion: (id: string, suggestion: string, landed: string) =>
    invoke<Thread | null>('accept_suggestion', { id, suggestion, landed }),
  rejectSuggestion: (id: string, suggestion: string) =>
    invoke<void>('reject_suggestion', { id, suggestion }),
  anchorThreads: (text: string, selectors: Selector[]) =>
    invoke<(Anchored | null)[]>('anchor_threads', { text, selectors }),
  makeSelectors: (text: string, ranges: [number, number][]) =>
    invoke<Selector[]>('make_selectors', { text, ranges }),
  emitEvent: (id: string, event: 'comment' | 'reply' | 'resolve', thread: string) =>
    invoke<{ delivered: number; to_owner: boolean; marked: boolean }>('emit_event', { id, event, thread }),
  listenerStatus: (id?: string | null) => invoke<ListenerStatus>('listener_status', { id: id ?? null }),
  relinkDoc: (id: string, path: string) => invoke<DocEntry>('relink_doc', { id, path }),
  forgetDoc: (id: string) => invoke<void>('forget_doc', { id }),
  listSnapshots: (id: string) => invoke<SnapshotInfo[]>('list_snapshots', { id }),
  suggestRelink: (id: string) => invoke<string | null>('suggest_relink', { id }),
  watchDoc: (id: string, path: string) => invoke<void>('watch_doc', { id, path }),
  unwatchDoc: (path: string) => invoke<void>('unwatch_doc', { path }),
  windowCount: () => invoke<number>('window_count'),
  newWindow: (path?: string | null) => invoke<string>('new_window', { path: path ?? null }),
  readSnapshot: (id: string, name: string) => invoke<string>('read_snapshot', { id, name }),
  diffSnapshot: (id: string, name: string, other?: string | null) =>
    invoke<string>('diff_snapshot', { id, name, other: other ?? null }),
  restoreSnapshot: (id: string, name: string) => invoke<string>('restore_snapshot', { id, name }),
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
  uiLog: (line: string) => invoke<void>('ui_log', { line }).catch(() => {}),
}
