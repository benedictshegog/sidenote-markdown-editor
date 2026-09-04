//! Tauri commands exposed to the UI. Thin wrappers over `sidenote_core::Store`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use sidenote_core::anchor::{anchor, make_selector_chars, Anchored};
use sidenote_core::suggest::{Seg, Suggestion};
use sidenote_core::{DocEntry, Selector, StateFile, Store, Thread, ThreadStatus, ThreadsFile};

use crate::state::AppState;
use crate::{menu, watch, ws};

type S<'a> = State<'a, Arc<AppState>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct StateView {
    pub state: StateFile,
    /// Busy and younger than the stale threshold.
    pub fresh: bool,
    pub held_secs: Option<i64>,
}

#[derive(Serialize)]
pub struct ListenerStatus {
    pub owner: Option<String>,
    pub owner_connected: bool,
    pub any_connected: bool,
    /// Would a comment posted right now reach a Claude Code session? This is
    /// the only question the indicator answers, and the only one worth
    /// answering: an owned document goes to its owner and nobody else, so a
    /// session connected for some other document changes nothing here.
    pub connected: bool,
    pub sessions: Vec<String>,
    pub port_error: Option<String>,
}

#[derive(Deserialize)]
pub struct SelectorUpdate {
    pub thread_id: String,
    /// `None` means the mark vanished from the editor: orphan the thread.
    pub selector: Option<Selector>,
}

#[tauri::command]
pub fn list_docs(state: S) -> Result<Vec<DocEntry>, String> {
    state.store.list().map_err(err)
}

#[tauri::command]
pub fn register_doc(app: AppHandle, state: S, path: String) -> Result<DocEntry, String> {
    let (doc, _) = state.store.register(Path::new(&path), None).map_err(err)?;
    let doc = state.store.touch_opened(&doc.id).map_err(err)?;
    menu::rebuild(&app).ok();
    Ok(doc)
}

#[tauri::command]
pub fn read_doc(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(err)
}

/// Largest image the editor will inline. Big enough for a retina screenshot,
/// small enough that the IPC copy is not felt.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Undo percent-encoding in a markdown URL. `![](my%20shot.png)` names a file
/// called `my shot.png` on disk.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extensions the editor will read.
///
/// This is the check that matters. A document is untrusted text — it may have
/// been written by a model, or sent by someone else — and without a filter an
/// `<img>` could name any file on the machine. Restricting the read to image
/// types means the tag can only ever do what an image tag is for.
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "heic", "tif", "tiff",
];

/// Resolve a markdown image URL to a file on disk, relative to the document
/// that names it.
///
/// Paths are deliberately not confined to the document's own folder. Keeping
/// images in a sibling `assets/` directory is ordinary practice, and a
/// document is as likely to sit on an external volume as under `$HOME`, so a
/// location rule would refuse honest layouts while an untrusted document could
/// walk around it with `../` anyway. The extension is the real boundary.
fn resolve_image(doc: &Path, src: &str) -> Result<PathBuf, String> {
    let cleaned = percent_decode(src.split(['#', '?']).next().unwrap_or(src));
    if cleaned.is_empty() {
        return Err("empty image path".into());
    }

    let raw = PathBuf::from(&cleaned);
    let ext = raw
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(format!("{ext:?} is not an image extension"));
    }

    let joined = if raw.is_absolute() {
        raw
    } else {
        doc.parent().ok_or("document has no folder")?.join(raw)
    };

    // Resolves `..` and any symlink, so the path that is opened is the path
    // that was checked.
    let file = joined.canonicalize().map_err(err)?;
    if !file.is_file() {
        return Err("not a file".into());
    }
    Ok(file)
}

/// Bytes of an image a document references, for preview in the editor.
///
/// The webview resolves a relative URL against the app origin, not against the
/// folder the markdown lives in, so `![](shot.png)` cannot load on its own.
/// The front end asks for the bytes instead and wraps them in a blob URL.
#[tauri::command]
pub fn read_image(doc: String, src: String) -> Result<tauri::ipc::Response, String> {
    let file = resolve_image(Path::new(&doc), &src)?;
    let size = std::fs::metadata(&file).map_err(err)?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!("image is {size} bytes, over the {MAX_IMAGE_BYTES} limit"));
    }
    let bytes = std::fs::read(&file).map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The editor's autosave. Goes through the store, so it takes the same file
/// lock `sidenote apply` does and refuses while a session holds a fresh one.
/// The editor is already read-only when the app can see the busy flag; this
/// covers the moment before it has seen it.
#[tauri::command]
pub fn write_doc(state: S, path: String, content: String) -> Result<(), String> {
    state.store.write_document(Path::new(&path), &content).map_err(err)
}

#[tauri::command]
pub fn read_threads(state: S, id: String) -> Result<ThreadsFile, String> {
    state.store.read_threads(&id).map_err(err)
}

#[tauri::command]
pub fn create_thread(
    state: S,
    id: String,
    selector: Selector,
    body: String,
) -> Result<Thread, String> {
    state.store.create_thread(&id, selector, &body).map_err(err)
}

#[tauri::command]
pub fn add_user_message(
    state: S,
    id: String,
    thread_id: String,
    body: String,
) -> Result<Thread, String> {
    state
        .store
        .add_message(&id, &thread_id, sidenote_core::Author::User, &body, None)
        .map_err(err)
}

/// The user opened a thread, so they have had the chance to read it —
/// Claude's replies only render on an expanded card, which is what makes
/// expanding one the honest moment to call it read.
#[tauri::command]
pub fn mark_thread_read(app: AppHandle, state: S, id: String, thread_id: String) -> Result<Thread, String> {
    let t = state.store.mark_read(&id, &thread_id).map_err(err)?;
    refresh_badge(&app, &state);
    Ok(t)
}

/// Unread threads across every registered document.
#[tauri::command]
pub fn unread_counts(state: S) -> Result<Vec<UnreadDoc>, String> {
    Ok(state
        .store
        .unread_counts()
        .map_err(err)?
        .into_iter()
        .map(|(doc, count)| UnreadDoc { id: doc.id, path: doc.path, title: doc.title, count })
        .collect())
}

#[derive(Serialize)]
pub struct UnreadDoc {
    pub id: String,
    pub path: String,
    pub title: String,
    pub count: usize,
}

/// The badge counts only documents open in a tab.
///
/// The earlier rule was every registered document, on the reasoning that a
/// reply on something you are not looking at is exactly what a badge is for.
/// In use it went the other way: documents outlive the work in them, and a
/// finished or deleted one kept the dot lit with no way to clear it — opening
/// a document whose file has gone shows "File not found", not its threads. A
/// badge that cannot be cleared stops being read at all. Closing the tab is
/// now the gesture that says "done with this", and it silences the count.
fn badge_total(counts: &[(DocEntry, usize)], open: &std::collections::HashSet<String>) -> usize {
    counts.iter().filter(|(d, _)| open.contains(&d.path)).map(|(_, n)| n).sum()
}

/// Recount and put the total on the Dock icon. `None` clears it — Tauri maps
/// 0 and None to the same thing, but being explicit keeps the intent legible.
pub fn refresh_badge(app: &AppHandle, state: &AppState) {
    let counts = match state.store.unread_counts() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("badge: cannot count unread threads: {e}");
            return;
        }
    };
    // Every window's tabs, so a document open behind another still counts.
    let open: std::collections::HashSet<String> =
        state.windows.lock().unwrap().values().flatten().cloned().collect();
    let total = badge_total(&counts, &open);
    let count = (total > 0).then_some(total as i64);
    // The badge belongs to the app, but Tauri hangs it off a window; any one
    // of them sets the same Dock icon, so the first is as good as any.
    if let Some(w) = app.webview_windows().values().next() {
        if let Err(e) = w.set_badge_count(count) {
            log::warn!("badge: cannot set count: {e}");
        }
    }
    let _ = app.emit("unread-changed", total);
}

#[tauri::command]
pub fn set_thread_status(
    app: AppHandle,
    state: S,
    id: String,
    thread_id: String,
    status: ThreadStatus,
) -> Result<Thread, String> {
    let t = state.store.set_status(&id, &thread_id, status).map_err(err)?;
    refresh_badge(&app, &state);
    Ok(t)
}

#[tauri::command]
pub fn set_thread_selector(
    state: S,
    id: String,
    thread_id: String,
    selector: Selector,
) -> Result<Thread, String> {
    state.store.set_selector(&id, &thread_id, selector).map_err(err)
}

/// Bulk selector refresh after an autosave. `update_json` skips the write when
/// nothing moved, so an idle editor does not churn `threads.json`.
#[tauri::command]
pub fn update_selectors(
    state: S,
    id: String,
    updates: Vec<SelectorUpdate>,
) -> Result<bool, String> {
    state
        .store
        .update_threads(&id, |t| {
            let live = |th: &Thread| th.status != ThreadStatus::Resolved;
            // A `None` selector means "the mark is gone from the editor", and
            // the answer to that is to orphan the thread. But the marks are
            // also all absent for a moment after `setMarkdown` replaces the
            // content and before `applyThreads` repaints them. An autosave in
            // that gap arrives here asking to orphan the lot.
            //
            // Losing every anchor in a document at once is not an edit anyone
            // makes by hand, and it cannot be undone from the app, so treat it
            // as the repaint race it almost certainly is. One thread going
            // missing is ordinary — the user deleted the paragraph.
            let live_count = t.threads.iter().filter(|th| live(th)).count();
            let orphaning = updates
                .iter()
                .filter(|u| u.selector.is_none())
                .filter(|u| t.threads.iter().any(|th| th.id == u.thread_id && live(th)))
                .count();
            if live_count > 1 && orphaning == live_count {
                log::warn!(
                    "update_selectors: refusing to orphan all {live_count} threads of {id}; \
                     the editor had no marks painted"
                );
                return Ok(false);
            }

            let mut changed = false;
            for u in updates {
                if let Some(th) = t.threads.iter_mut().find(|x| x.id == u.thread_id) {
                    if th.status == ThreadStatus::Resolved {
                        continue;
                    }
                    match u.selector {
                        Some(sel) => {
                            if th.selector != sel || th.status != ThreadStatus::Open {
                                th.selector = sel;
                                th.status = ThreadStatus::Open;
                                changed = true;
                            }
                        }
                        None => {
                            if th.status != ThreadStatus::Orphaned {
                                th.status = ThreadStatus::Orphaned;
                                changed = true;
                            }
                        }
                    }
                }
            }
            Ok(changed)
        })
        .map_err(err)
}

#[tauri::command]
pub fn read_state(state: S, id: String) -> Result<StateView, String> {
    let st = state.store.read_state(&id).map_err(err)?;
    let fresh = Store::is_fresh_busy(&st);
    let held_secs = st.busy_since.as_deref().and_then(sidenote_core::util::age_secs);
    Ok(StateView {
        state: st,
        fresh,
        held_secs,
    })
}

#[tauri::command]
pub fn unlock_doc(state: S, id: String) -> Result<StateFile, String> {
    state.store.unlock(&id).map_err(err)
}

/// One pending suggestion, ready to draw.
///
/// `old` is already the plain text the app matched in its editor — `apply`
/// reduces the markdown to it before sending — so it needs no conversion here.
/// `new` is markdown, and only its plain form is drawn; accepting is what
/// parses and inserts the real thing.
///
/// Staleness is deliberately not here. Whether a suggestion still fits is a
/// question about the text the editor is showing, and the file on disk trails
/// it by an autosave. The front end asks its own editor.
#[derive(Serialize)]
pub struct SuggestionView {
    pub id: String,
    pub thread: Option<String>,
    /// The session that proposed it. Kept so that restoring one after an undo
    /// does not reattribute it.
    pub session: String,
    pub at: String,
    /// The passage in the document this replaces, in plain text.
    pub quote: String,
    /// The replacement, still markdown. Accepting hands this to the same
    /// `applyEdit` a direct edit takes, so it is parsed and inserted rather
    /// than pasted in as text.
    pub markdown: String,
    /// Word-level diff over the plain forms. The `equal` and `delete`
    /// segments concatenate back to `quote`.
    pub segs: Vec<Seg>,
    pub removed: usize,
    pub added: usize,
}

#[derive(Serialize)]
pub struct SuggestionsView {
    pub suggesting: bool,
    pub suggestions: Vec<SuggestionView>,
}

fn view_of(s: Suggestion) -> SuggestionView {
    let segs = sidenote_core::suggest::segments(&s.old, &sidenote_core::plain_text(&s.new));
    let (removed, added) = sidenote_core::suggest::word_counts(&segs);
    SuggestionView {
        id: s.id,
        thread: s.thread,
        session: s.session,
        at: s.at,
        quote: s.old,
        markdown: s.new,
        segs,
        removed,
        added,
    }
}

#[tauri::command]
pub fn read_suggestions(state: S, id: String) -> Result<SuggestionsView, String> {
    let st = state.store.read_state(&id).map_err(err)?;
    let pending = state.store.read_suggestions(&id).map_err(err)?.suggestions;
    Ok(SuggestionsView {
        suggesting: st.suggesting,
        suggestions: pending.into_iter().map(view_of).collect(),
    })
}

/// Record an edit the editor has decided not to make. Called from the
/// `apply-request` handler, which has already checked that the passage occurs
/// exactly once in the text it is showing.
#[tauri::command]
pub fn record_suggestion(
    state: S,
    id: String,
    session: String,
    old: String,
    new: String,
    thread: Option<String>,
) -> Result<Suggestion, String> {
    state
        .store
        .record_suggestion(&id, &session, &old, &new, thread.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn set_suggesting(state: S, id: String, on: bool) -> Result<StateFile, String> {
    state.store.set_suggesting(&id, on).map_err(err)
}

/// Keep the Document menu's tick honest across tabs and windows.
#[tauri::command]
pub fn set_menu_checked(app: AppHandle, id: String, checked: bool) {
    menu::set_checked(&app, &id, checked);
}

/// Finish an accept the editor has already applied. `landed` is the plain text
/// it inserted, which is what the thread re-anchors to.
#[tauri::command]
pub fn accept_suggestion(
    state: S,
    id: String,
    suggestion: String,
    landed: String,
) -> Result<Option<Thread>, String> {
    let r = state
        .store
        .accept_suggestion_applied(&id, &suggestion, &landed)
        .map_err(err)?;
    Ok(r.thread)
}

#[tauri::command]
pub fn reject_suggestion(state: S, id: String, suggestion: String) -> Result<(), String> {
    state.store.reject_suggestion(&id, &suggestion).map_err(err)?;
    Ok(())
}

/// Locate selectors in plain text. Offsets are char offsets.
#[tauri::command]
pub fn anchor_threads(text: String, selectors: Vec<Selector>) -> Vec<Option<Anchored>> {
    let chars: Vec<char> = text.chars().collect();
    selectors
        .iter()
        .map(|s| sidenote_core::anchor::anchor_chars(&chars, s))
        .collect()
}

#[tauri::command]
pub fn make_selectors(text: String, ranges: Vec<(usize, usize)>) -> Vec<Selector> {
    let chars: Vec<char> = text.chars().collect();
    ranges
        .into_iter()
        .map(|(s, e)| make_selector_chars(&chars, s, e))
        .collect()
}

#[tauri::command]
pub fn anchor_one(text: String, selector: Selector) -> Option<Anchored> {
    anchor(&text, &selector)
}

#[derive(Serialize)]
pub struct EmitResult {
    pub delivered: usize,
    pub to_owner: bool,
    /// The thread was marked as in a session's hands (👀), because a session
    /// took the frame.
    pub marked: bool,
}

/// Send a frame to the owning Claude session (or broadcast).
#[tauri::command]
pub fn emit_event(
    state: S,
    id: String,
    event: String,
    thread: String,
) -> Result<EmitResult, String> {
    let doc = state.store.doc_by_id(&id).map_err(err)?;
    let frame = serde_json::json!({
        "event": event,
        "doc": doc.path,
        "thread": thread,
    })
    .to_string();
    let owner = doc.owner_session.as_deref();
    let owner_connected = {
        let hub = state.hub.lock().unwrap();
        owner
            .map(|o| hub.clients.values().any(|c| c.session.as_deref() == Some(o)))
            .unwrap_or(false)
    };
    let delivered = ws::route(&state, owner, &frame);

    // 👀 means a Claude Code session has the comment, and the socket taking
    // the frame is that moment — waiting for the session to run `sidenote ack`
    // would wait on a model turn, which can be seconds or, if it is busy,
    // much longer. A frame nobody took marks nothing, so the eye never
    // promises a reader that does not exist.
    let marked = delivered > 0
        && matches!(event.as_str(), "comment" | "reply")
        && state
            .store
            .ack(Path::new(&doc.path), std::slice::from_ref(&thread))
            .map_err(|e| log::warn!("emit_event: cannot mark {thread}: {e}"))
            .is_ok_and(|n| n > 0);

    Ok(EmitResult {
        delivered,
        to_owner: owner_connected,
        marked,
    })
}

/// The UI's answer to an `apply-request` event: `{ok, landed}` or
/// `{ok:false, error, found}`. Completes the request the socket is waiting on.
#[tauri::command]
pub fn apply_result(state: S, rid: u64, result: serde_json::Value) -> Result<(), String> {
    let tx = state.hub.lock().unwrap().pending.remove(&rid);
    match tx {
        Some(tx) => tx.send(result).map_err(|_| "request already answered".to_string()),
        None => Err(format!("no pending request {rid}")),
    }
}

#[tauri::command]
pub fn listener_status(state: S, id: Option<String>) -> Result<ListenerStatus, String> {
    let owner = match id {
        Some(id) => state.store.doc_by_id(&id).map_err(err)?.owner_session,
        None => None,
    };
    let hub = state.hub.lock().unwrap();
    let sessions = hub.sessions();
    let owner_connected = owner
        .as_deref()
        .map(|o| sessions.iter().any(|s| s == o))
        .unwrap_or(false);
    let any_connected = !hub.clients.is_empty();
    // Mirrors `ws::route`: an owned document reaches its owner alone, an
    // unowned one reaches anybody who is listening.
    let connected = if owner.is_some() { owner_connected } else { any_connected };
    Ok(ListenerStatus {
        owner,
        owner_connected,
        any_connected,
        connected,
        sessions,
        port_error: hub.port_error.clone(),
    })
}

#[tauri::command]
pub fn relink_doc(app: AppHandle, state: S, id: String, path: String) -> Result<DocEntry, String> {
    let d = state.store.relink(&id, Path::new(&path)).map_err(err)?;
    menu::rebuild(&app).ok();
    // The file is readable again, so its unread threads count once more.
    refresh_badge(&app, &state);
    Ok(d)
}

#[tauri::command]
pub fn forget_doc(app: AppHandle, state: S, id: String) -> Result<(), String> {
    state.store.forget(&id).map_err(err)?;
    menu::rebuild(&app).ok();
    refresh_badge(&app, &state);
    Ok(())
}

#[derive(Serialize)]
pub struct SnapshotInfo {
    pub name: String,
    pub path: String,
    pub mtime: Option<u64>,
    pub size: u64,
}

#[tauri::command]
pub fn list_snapshots(state: S, id: String) -> Result<Vec<SnapshotInfo>, String> {
    Ok(state
        .store
        .snapshots(&id)
        .map_err(err)?
        .into_iter()
        .map(|s| SnapshotInfo {
            name: s.name(),
            path: s.path.to_string_lossy().into_owned(),
            mtime: s.mtime(),
            size: s.size(),
        })
        .collect())
}

#[tauri::command]
pub fn read_snapshot(state: S, id: String, name: String) -> Result<String, String> {
    state.store.read_snapshot(&id, &name).map_err(err)
}

#[tauri::command]
pub fn diff_snapshot(state: S, id: String, name: String, other: Option<String>) -> Result<String, String> {
    state.store.diff_snapshot(&id, &name, other.as_deref()).map_err(err)
}

#[tauri::command]
pub fn restore_snapshot(state: S, id: String, name: String) -> Result<String, String> {
    state.store.restore_snapshot(&id, &name).map(|s| s.name()).map_err(err)
}

/// Suggest a relink candidate for a missing file: the latest snapshot's
/// content hash is matched against `.md` files in the old directory tree.
#[tauri::command]
pub fn suggest_relink(state: S, id: String) -> Result<Option<String>, String> {
    let doc = state.store.doc_by_id(&id).map_err(err)?;
    let Some(latest) = sidenote_core::snapshots::latest(&state.store.doc_dir(&id)).map_err(err)? else {
        return Ok(None);
    };
    let want = std::fs::read_to_string(&latest.path).map_err(err)?;
    let old = PathBuf::from(&doc.path);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    // Walk up to three levels and scan two levels down; cheap and local.
    // `seen` matters as much as the depth limit: each level up covers the
    // subtree the level below just walked, so without it the ancestor scans
    // re-read every file two and three times over.
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut dir = old.parent().map(|p| p.to_path_buf());
    for _ in 0..3 {
        let Some(d) = dir.clone() else { break };
        // Never scan the home directory or an ancestor of it. A scan of `~`
        // descends into Music, Pictures and iCloud Drive, and macOS raises a
        // TCC consent prompt for each one — a missing Desktop file must not
        // cost the user three permission dialogs.
        if home.as_deref().is_some_and(|h| h.starts_with(&d)) {
            break;
        }
        if let Some(hit) = scan_for(&d, &want, 2, &mut seen) {
            return Ok(Some(hit.to_string_lossy().into_owned()));
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    Ok(None)
}

fn scan_for(dir: &Path, want: &str, depth: usize, seen: &mut HashSet<PathBuf>) -> Option<PathBuf> {
    if !seen.insert(dir.to_path_buf()) {
        return None;
    }
    let rd = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !name.starts_with('.') && name != "node_modules" && name != "target" {
                subdirs.push(p);
            }
        } else if p.extension().map(|x| x == "md").unwrap_or(false) {
            // Size first. Reading every markdown file in a project tree to
            // compare it against one snapshot is most of the cost here, and
            // the length rules almost all of them out for free.
            let same_size = e
                .metadata()
                .map(|m| m.len() == want.len() as u64)
                .unwrap_or(false);
            if same_size {
                if let Ok(c) = std::fs::read_to_string(&p) {
                    if c == want {
                        return Some(p);
                    }
                }
            }
        }
    }
    if depth > 0 {
        for s in subdirs {
            if let Some(h) = scan_for(&s, want, depth - 1, seen) {
                return Some(h);
            }
        }
    }
    None
}

/// Register a document open in a window (one per tab) and watch its directories.
#[tauri::command]
pub fn watch_doc(app: AppHandle, window: tauri::Window, state: S, id: String, path: String) -> Result<(), String> {
    let label = window.label().to_string();
    {
        let mut wins = state.windows.lock().unwrap();
        let list = wins.entry(label.clone()).or_default();
        if !list.contains(&path) {
            list.push(path.clone());
        }
    }
    let dirs = watch::dirs_for(&state.store.doc_dir(&id), Path::new(&path));
    let r = watch::add_doc(&app, &label, &path, dirs);
    // Opening a tab can bring unread threads into the count.
    refresh_badge(&app, &state);
    r
}

/// A tab closed in a window.
#[tauri::command]
pub fn unwatch_doc(app: AppHandle, window: tauri::Window, state: S, path: String) -> Result<(), String> {
    let label = window.label().to_string();
    if let Some(list) = state.windows.lock().unwrap().get_mut(&label) {
        list.retain(|p| p != &path);
    }
    watch::remove_doc(&app, &label, &path);
    // Closing a tab is how the user says they are done with a document.
    refresh_badge(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
}

/// What this build is, for the badge that tells a dev app from the installed one.
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub dev: bool,
    pub port: u16,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let info = app.package_info();
    AppInfo {
        name: info.name.clone(),
        version: info.version.to_string(),
        dev: cfg!(debug_assertions),
        port: sidenote_core::app_port(),
    }
}

// ---- quitting -----------------------------------------------------------------

/// Quit, once every window has had its say.
///
/// The predefined Quit item sends `terminate:` straight to NSApp, which ends
/// the process without a word to the UI: a draft typed a moment ago is gone,
/// and an autosave still on its timer never lands. So Cmd+Q is an ordinary
/// menu item and quitting is a round trip. Every window is asked; each one
/// settles its unsaved drafts (Save, Don't Save, or Cancel), flushes its
/// documents, and reports ready; the app exits when the last of them has. One
/// Cancel calls the whole thing off.
///
/// A second Cmd+Q while one is pending exits at once. That is the way out
/// when a webview is not answering, and nothing else: while a dialog is up
/// the menu's key equivalents are disabled, so it cannot fire by accident
/// over a question that is still open.
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let labels: HashSet<String> = app.webview_windows().keys().cloned().collect();
    let mut pending = state.quit_pending.lock().unwrap();
    if pending.is_some() || labels.is_empty() {
        app.exit(0);
        return;
    }
    *pending = Some(labels);
    drop(pending);
    let _ = app.emit("confirm-quit", ());
}

/// A window has nothing left to save, or is gone. Exit when it was the last
/// one a pending quit was waiting for.
pub fn window_settled(app: &AppHandle, state: &AppState, label: &str) {
    let done = {
        let mut pending = state.quit_pending.lock().unwrap();
        match pending.as_mut() {
            Some(set) => {
                set.remove(label);
                set.is_empty()
            }
            None => false,
        }
    };
    if done {
        app.exit(0);
    }
}

#[tauri::command]
pub fn quit_ready(app: AppHandle, window: tauri::Window, state: S) {
    window_settled(&app, &state, window.label());
}

#[tauri::command]
pub fn quit_cancel(state: S) {
    *state.quit_pending.lock().unwrap() = None;
}

#[tauri::command]
pub fn new_window(app: AppHandle, path: Option<String>) -> Result<String, String> {
    crate::create_window(&app, path.as_deref().map(Path::new))
        .map(|w| w.label().to_string())
        .map_err(err)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Escape a value for an AppleScript double-quoted string literal.
///
/// Backslash first, or the escapes added for `"` are escaped in turn.
fn applescript_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Files the OS asked us to open before the UI mounted.
#[tauri::command]
pub fn take_pending_opens(state: S) -> Vec<String> {
    *state.ui_ready.lock().unwrap() = true;
    let mut p = state.pending_opens.lock().unwrap();
    p.drain(..).map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
pub fn sidenote_home(state: S) -> String {
    state.store.home().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn plain_text(markdown: String) -> String {
    sidenote_core::plain_text(&markdown)
}

// ---- CLI install -----------------------------------------------------------

const CLI_LINK: &str = "/usr/local/bin/sidenote";

fn bundled_cli(app: &AppHandle) -> Option<PathBuf> {
    // Sidecar binaries live next to the main executable inside the bundle.
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let p = dir.join("sidenote");
    if p.is_file() {
        return Some(p);
    }
    // Dev: the workspace target directory.
    let dev = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|_| std::env::var("CARGO_MANIFEST_DIR").ok())
        .map(|m| PathBuf::from(m).join("../../target/debug/sidenote"));
    dev.filter(|p| p.is_file())
}

#[derive(Serialize)]
pub struct CliStatus {
    pub installed: bool,
    pub link: String,
    pub target: Option<String>,
    pub bundled: Option<String>,
}

const CLI_LINKS: [&str; 2] = ["/opt/homebrew/bin/sidenote", CLI_LINK];

#[tauri::command]
pub fn cli_status(app: AppHandle) -> CliStatus {
    let bundled = bundled_cli(&app);
    // Installed when any known link resolves to an existing binary.
    let found = CLI_LINKS
        .iter()
        .map(PathBuf::from)
        .find(|l| std::fs::symlink_metadata(l).is_ok() && l.exists());
    let target = found
        .as_ref()
        .and_then(|l| std::fs::read_link(l).ok())
        .map(|p| p.to_string_lossy().into_owned());
    CliStatus {
        installed: found.is_some(),
        link: found
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| CLI_LINK.to_string()),
        target,
        bundled: bundled.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// What a debug build must not do to the machine it runs on: link its own
/// debug binary over the installed `sidenote`, or register its `.dev` bundle
/// as the handler for every markdown file. Both are one click in the welcome
/// sheet, and a dev build with a fresh webview store shows that sheet.
const DEV_REFUSAL: &str = "not from a dev build: it would replace the installed Sidenote's integration";

#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Err(DEV_REFUSAL.into());
    }
    let src = bundled_cli(&app).ok_or("the sidenote binary is not bundled with this build")?;
    let link = PathBuf::from(CLI_LINK);
    // Already pointing at this binary: nothing to do.
    if std::fs::read_link(&link).ok().as_deref() == Some(src.as_path()) {
        return Ok(format!("{CLI_LINK} -> {}", src.display()));
    }
    if let Some(parent) = link.parent() {
        if !parent.exists() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let direct = (|| -> std::io::Result<()> {
        if std::fs::symlink_metadata(&link).is_ok() {
            std::fs::remove_file(&link)?;
        }
        std::os::unix::fs::symlink(&src, &link)
    })();
    match direct {
        Ok(()) => return Ok(format!("{CLI_LINK} -> {}", src.display())),
        Err(e) if matches!(
            e.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::AlreadyExists
        ) => {}
        Err(e) => return Err(format!("cannot create {CLI_LINK}: {e}")),
    }
    // /usr/local/bin is root-owned on this Mac: ask for admin rights through
    // the native authorisation dialog.
    //
    // Two levels of quoting, and both matter, because this runs as root. The
    // inner shell command is single-quoted; the whole thing is then an
    // AppleScript string literal, where a `"` or `\` in the bundle path used
    // to end the literal early and let the rest of the path run as AppleScript
    // with administrator privileges. The path is the app's own location, so
    // that needs a bundle sitting in a folder someone else named — remote, but
    // root is not a thing to leave to luck.
    let shell = format!(
        "mkdir -p /usr/local/bin && ln -sf {} {}",
        shell_quote(&src.display().to_string()),
        shell_quote(CLI_LINK)
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        applescript_string(&shell)
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(err)?;
    if out.status.success() {
        Ok(format!("{CLI_LINK} -> {}", src.display()))
    } else {
        let msg = String::from_utf8_lossy(&out.stderr);
        if msg.contains("-128") {
            Err("cancelled".into())
        } else {
            Err(format!(
                "cannot create {CLI_LINK}: {}. Run: sudo ln -sf '{}' {CLI_LINK}",
                msg.trim(),
                src.display()
            ))
        }
    }
}

/// Reveal a file in Finder.
/// Open a link from a document in the user's browser.
///
/// A document is written by an agent, so its links are untrusted. This reuses
/// the window navigation guard rather than keeping a second copy of the rules:
/// web links open, and anything that could reach the local machine is refused.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|_| format!("not a url: {url}"))?;
    if crate::link_opens_externally(&parsed) {
        crate::open_external(parsed.as_str());
        Ok(())
    } else {
        Err(format!("refused: {url}"))
    }
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(err)
}

/// Largest `ui.log` before it is rolled over to `ui.log.1`.
const UI_LOG_MAX: u64 = 1024 * 1024;

/// Append a line to `~/.sidenote/ui.log` (JS errors and diagnostics).
///
/// Rolled at a megabyte, keeping one previous file. A JS error inside a render
/// loop writes a line per frame, and this grew without limit.
#[tauri::command]
pub fn ui_log(state: S, line: String) {
    use std::io::Write;
    let p = state.store.home().join("ui.log");
    if std::fs::metadata(&p).map(|m| m.len() > UI_LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&p, p.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} {}", sidenote_core::util::now(), line);
    }
}

#[derive(Serialize)]
pub struct SkillStatus {
    pub path: String,
    pub installed: bool,
    pub current: bool,
}

#[tauri::command]
pub fn skill_status() -> SkillStatus {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path = home
        .join(".claude")
        .join("skills")
        .join(sidenote_core::SKILL_NAME)
        .join("SKILL.md");
    let existing = std::fs::read_to_string(&path).ok();
    SkillStatus {
        path: path.to_string_lossy().into_owned(),
        installed: existing.is_some(),
        current: existing.as_deref() == Some(sidenote_core::SKILL_MD),
    }
}

#[tauri::command]
pub fn install_skill(force: bool) -> Result<String, String> {
    let (path, outcome) = sidenote_core::install_skill(force).map_err(err)?;
    Ok(format!("{:?} {}", outcome, path.display()).to_lowercase())
}

// ---- default handler for .md (Launch Services) ----------------------------

#[cfg(target_os = "macos")]
mod launch_services {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler_bundle_id: CFStringRef,
        ) -> i32;
        fn LSCopyDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32) -> CFStringRef;
        fn UTTypeCreatePreferredIdentifierForTag(
            tag_class: CFStringRef,
            tag: CFStringRef,
            conforming_to: CFStringRef,
        ) -> CFStringRef;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    /// UTIs that `.md` and `.markdown` currently resolve to, plus the
    /// conventional one, deduplicated.
    pub fn markdown_utis() -> Vec<String> {
        let mut out = vec!["net.daringfireball.markdown".to_string()];
        for ext in ["md", "markdown"] {
            let tag_class = CFString::new("public.filename-extension");
            let tag = CFString::new(ext);
            unsafe {
                let r = UTTypeCreatePreferredIdentifierForTag(
                    tag_class.as_concrete_TypeRef(),
                    tag.as_concrete_TypeRef(),
                    std::ptr::null(),
                );
                if !r.is_null() {
                    let s: CFString = CFString::wrap_under_create_rule(r);
                    let v = s.to_string();
                    if !out.contains(&v) {
                        out.push(v);
                    }
                }
            }
        }
        out
    }

    pub fn current_handler(uti: &str) -> Option<String> {
        let t = CFString::new(uti);
        unsafe {
            let r = LSCopyDefaultRoleHandlerForContentType(t.as_concrete_TypeRef(), K_LS_ROLES_ALL);
            if r.is_null() {
                return None;
            }
            let s: CFString = CFString::wrap_under_create_rule(r);
            Some(s.to_string())
        }
    }

    pub fn set_handler(uti: &str, bundle_id: &str) -> Result<(), i32> {
        let t = CFString::new(uti);
        let b = CFString::new(bundle_id);
        let rc = unsafe {
            LSSetDefaultRoleHandlerForContentType(t.as_concrete_TypeRef(), K_LS_ROLES_ALL, b.as_concrete_TypeRef())
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(rc)
        }
    }
}

#[derive(Serialize)]
pub struct DefaultHandler {
    pub bundle_id: String,
    pub is_default: bool,
    pub current: Option<String>,
}

#[tauri::command]
pub fn default_md_handler(app: AppHandle) -> DefaultHandler {
    // A dev build answers for the installed app: `tauri.dev.conf.json` adds
    // `.dev` to the identifier, and the question is whether markdown opens in
    // Sidenote, not in this binary.
    let me = app
        .config()
        .identifier
        .trim_end_matches(".dev")
        .to_string();
    #[cfg(target_os = "macos")]
    {
        let utis = launch_services::markdown_utis();
        let current = utis.first().and_then(|u| launch_services::current_handler(u));
        let is_default = utis
            .iter()
            .all(|u| launch_services::current_handler(u).map(|h| h.eq_ignore_ascii_case(&me)).unwrap_or(false));
        return DefaultHandler {
            bundle_id: me,
            is_default,
            current,
        };
    }
    #[allow(unreachable_code)]
    DefaultHandler {
        bundle_id: me,
        is_default: false,
        current: None,
    }
}

#[tauri::command]
pub fn set_default_md_handler(app: AppHandle) -> Result<Vec<String>, String> {
    if cfg!(debug_assertions) {
        return Err(DEV_REFUSAL.into());
    }
    let me = app.config().identifier.clone();
    #[cfg(target_os = "macos")]
    {
        let utis = launch_services::markdown_utis();
        for u in &utis {
            launch_services::set_handler(u, &me).map_err(|rc| format!("Launch Services refused ({rc}) for {u}"))?;
        }
        return Ok(utis);
    }
    #[allow(unreachable_code)]
    Err("only supported on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::{badge_total, percent_decode, resolve_image};

    #[test]
    fn percent_decoding_undoes_markdown_escapes() {
        assert_eq!(percent_decode("my%20shot.png"), "my shot.png");
        assert_eq!(percent_decode("caf%C3%A9.png"), "café.png");
        // A stray percent is left alone rather than swallowed.
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(percent_decode("%zz.png"), "%zz.png");
    }

    /// A temp tree: a document in `docs/`, an image beside it, and one in a
    /// sibling `assets/` folder.
    fn tree(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("sidenote-img-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("docs")).unwrap();
        std::fs::create_dir_all(base.join("assets")).unwrap();
        std::fs::write(base.join("docs/plan.md"), "").unwrap();
        std::fs::write(base.join("docs/my shot.png"), b"x").unwrap();
        std::fs::write(base.join("assets/cover.png"), b"x").unwrap();
        std::fs::write(base.join("assets/notes.txt"), b"x").unwrap();
        base
    }

    #[test]
    fn resolves_paths_a_document_can_name() {
        let base = tree("ok");
        let doc = base.join("docs/plan.md");
        let ok = |src: &str| resolve_image(&doc, src).is_ok();

        // Beside the document, including a name markdown had to escape.
        assert!(ok("my%20shot.png"));
        assert!(ok("./my shot.png"));
        // A sibling folder: the layout most documents with images actually use.
        assert!(ok("../assets/cover.png"));
        // An absolute path to the same file.
        assert!(ok(base.join("assets/cover.png").to_str().unwrap()));
        // A fragment or query is not part of the filename.
        assert!(ok("my%20shot.png#top"));
        // Extensions are matched without regard to case.
        std::fs::write(base.join("docs/SHOT.PNG"), b"x").unwrap();
        assert!(ok("SHOT.PNG"));

        // Nothing there.
        assert!(!ok("missing.png"));
        assert!(!ok(""));
        // A folder is not an image.
        assert!(!ok("."));
    }

    /// The extension is the boundary that keeps an `<img>` from reading a file
    /// that is not an image, wherever on disk it sits.
    #[test]
    fn refuses_what_is_not_an_image() {
        let base = tree("ext");
        let doc = base.join("docs/plan.md");
        // Each of these exists and is reachable; the extension is the refusal.
        assert!(resolve_image(&doc, "../assets/notes.txt").is_err());
        assert!(resolve_image(&doc, "plan.md").is_err());
        assert!(resolve_image(&doc, "noextension").is_err());
        if std::path::Path::new("/etc/hosts").exists() {
            assert!(resolve_image(&doc, "/etc/hosts").is_err());
            assert!(resolve_image(&doc, "../../../../../../etc/hosts").is_err());
        }
    }

    fn doc(path: &str) -> sidenote_core::DocEntry {
        sidenote_core::DocEntry {
            id: path.into(),
            path: path.into(),
            title: path.into(),
            registered_at: String::new(),
            last_opened: String::new(),
            owner_session: None,
        }
    }

    /// The badge speaks for the tabs that are open, and nothing else. A
    /// document with unread replies that nobody has open must not light it:
    /// that is the count the user had no gesture to clear.
    #[test]
    fn the_badge_counts_open_tabs_only() {
        let counts = vec![(doc("/a.md"), 2), (doc("/b.md"), 1), (doc("/gone.md"), 5)];

        let none = std::collections::HashSet::new();
        assert_eq!(badge_total(&counts, &none), 0);

        let one: std::collections::HashSet<String> = ["/a.md".to_string()].into();
        assert_eq!(badge_total(&counts, &one), 2);

        // Two tabs open across any number of windows add up.
        let two: std::collections::HashSet<String> =
            ["/a.md".to_string(), "/b.md".to_string()].into();
        assert_eq!(badge_total(&counts, &two), 3);

        // A tab open on a document with nothing unread adds nothing.
        let other: std::collections::HashSet<String> = ["/quiet.md".to_string()].into();
        assert_eq!(badge_total(&counts, &other), 0);
    }
}
