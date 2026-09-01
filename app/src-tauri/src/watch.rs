//! File watcher: each window registers the directories it needs (its
//! document's directory and its `docs/<id>/`). The union is watched; a
//! directory is released when no window needs it. Emits `fs-changed` with
//! the changed path; the UI filters and debounces.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub fn ensure_watcher(app: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    let mut guard = state.watcher.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let app2 = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            use notify::EventKind::*;
            if matches!(ev.kind, Create(_) | Modify(_) | Remove(_)) {
                for p in ev.paths {
                    let _ = app2.emit("fs-changed", p.to_string_lossy().to_string());
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}

/// Register the directories one document (tab) in a window needs.
pub fn add_doc(app: &AppHandle, label: &str, path: &str, dirs: Vec<PathBuf>) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>().inner().clone();
    ensure_watcher(app, &state)?;
    state
        .watched
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_default()
        .insert(path.to_string(), dirs);
    reconcile(&state)
}

/// A tab closed.
pub fn remove_doc(app: &AppHandle, label: &str, path: &str) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    if let Some(m) = state.watched.lock().unwrap().get_mut(label) {
        m.remove(path);
    }
    let _ = reconcile(&state);
}

pub fn forget_window(app: &AppHandle, label: &str) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    state.watched.lock().unwrap().remove(label);
    let _ = reconcile(&state);
}

fn reconcile(state: &Arc<AppState>) -> Result<(), String> {
    let wanted: Vec<PathBuf> = {
        let watched = state.watched.lock().unwrap();
        let mut v: Vec<PathBuf> = watched.values().flat_map(|m| m.values()).flatten().cloned().collect();
        v.sort();
        v.dedup();
        v
    };
    let mut active = state.active_dirs.lock().unwrap();
    let mut guard = state.watcher.lock().unwrap();
    let Some(w) = guard.as_mut() else { return Ok(()) };
    for d in active.iter() {
        if !wanted.contains(d) {
            let _ = w.unwatch(d);
        }
    }
    for d in wanted.iter() {
        if !active.contains(d) && d.is_dir() {
            w.watch(d, RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
    }
    *active = wanted;
    Ok(())
}

/// How long to gather `threads.json` changes before recounting the badge.
///
/// A recount reads every registered document — `unread_counts` walks the whole
/// index, and the open-tab filter is applied after — so its cost grows with
/// everything the user has ever opened. The events arrive in bursts: one turn
/// writes `threads.json` for each ack, reply and re-anchor, and the app writes
/// it after an autosave too. Undebounced, that was a full re-scan of the whole
/// history several times a second while someone typed.
const BADGE_DEBOUNCE: Duration = Duration::from_millis(300);

/// Watch every document's review data so the Dock badge recounts when a reply
/// lands. Separate from the per-tab watcher above, which follows the
/// directories an open document needs rather than the review data. Every
/// document is watched, not just the open ones: `refresh_badge` decides what
/// counts. Recursive, because each document has its own directory under
/// `docs/`.
pub fn watch_all_threads(app: &AppHandle, state: &Arc<AppState>) {
    let dir = state.store.home().join("docs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let app2 = app.clone();
    let pending = Arc::new(AtomicBool::new(false));
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(ev) = res else { return };
        use notify::EventKind::*;
        if !matches!(ev.kind, Create(_) | Modify(_) | Remove(_)) {
            return;
        }
        if !ev.paths.iter().any(|p| p.ends_with("threads.json")) {
            return;
        }
        // First event in this window arms the recount; the rest ride on it.
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let app3 = app2.clone();
        let pending = pending.clone();
        std::thread::spawn(move || {
            std::thread::sleep(BADGE_DEBOUNCE);
            pending.store(false, Ordering::SeqCst);
            let state = app3.state::<Arc<AppState>>().inner().clone();
            crate::commands::refresh_badge(&app3, &state);
        });
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&dir, RecursiveMode::Recursive).is_err() {
        return;
    }
    *state.badge_watcher.lock().unwrap() = Some(watcher);
}

pub fn dirs_for(doc_dir: &Path, file: &Path) -> Vec<PathBuf> {
    let mut v = vec![doc_dir.to_path_buf()];
    if let Some(p) = file.parent() {
        v.push(p.to_path_buf());
    }
    v
}
