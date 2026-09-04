//! Native menu bar. Menu events are forwarded to the UI as a `menu` event
//! carrying the item id; Open Recent items carry `recent:<path>`.

use std::sync::Arc;

use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// A menu item the UI has to act on.
///
/// `window` names the window that had focus when the item was chosen; a
/// window that is not the named one ignores the event. `None` means nothing
/// had focus, and then whichever window is listening may take it.
#[derive(Clone, Serialize)]
pub struct MenuEvent {
    pub id: String,
    pub window: Option<String>,
}

use crate::state::AppState;

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<Arc<AppState>>();
    let recent = state.store.list().unwrap_or_default();

    let app_menu = Submenu::with_items(
        app,
        "Sidenote",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About Sidenote"),
                Some(AboutMetadata {
                    name: Some("Sidenote".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    comments: Some("Review documents written by Claude Code.".into()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "install_cli", "Install Claude Code Integration…", true, None::<&str>)?,
            &MenuItem::with_id(app, "reveal_home", "Reveal ~/.sidenote in Finder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Ours, not `PredefinedMenuItem::quit`: that one terminates the
            // process from inside AppKit, before the UI can ask about an
            // unsaved draft. `commands::request_quit` has the round trip.
            &MenuItem::with_id(
                app,
                "quit",
                format!("Quit {}", app.package_info().name),
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;

    let recent_menu = Submenu::new(app, "Open Recent", true)?;
    for d in recent.iter().take(15) {
        let item = MenuItem::with_id(
            app,
            format!("recent:{}", d.path),
            &d.title,
            true,
            None::<&str>,
        )?;
        recent_menu.append(&item)?;
    }
    if !recent.is_empty() {
        recent_menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    recent_menu.append(&MenuItem::with_id(
        app,
        "clear_recent",
        "Clear Menu",
        !recent.is_empty(),
        None::<&str>,
    )?)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new_doc", "New Document", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "new_window", "New Window", true, Some("CmdOrCtrl+Shift+N"))?,
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &recent_menu,
            &PredefinedMenuItem::separator(app)?,
            // Names the file for a new document; an opened one autosaves, so
            // there it only writes whatever is still on the timer.
            &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "close_doc", "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, "reopen_tab", "Reopen Closed Tab", true, Some("CmdOrCtrl+Shift+T"))?,
            &MenuItem::with_id(app, "relink", "Relink…", true, None::<&str>)?,
            &MenuItem::with_id(app, "reveal_doc", "Reveal in Finder", true, Some("CmdOrCtrl+Shift+R"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            // Ours, not `PredefinedMenuItem::undo`.
            //
            // The predefined item sends `undo:` down the responder chain, which
            // in a WKWebView means WebKit's own editing undo. The document is a
            // ProseMirror editor with its own history, and WebKit's undo knows
            // nothing about it — so Cmd+Z did nothing useful. Worse, the menu
            // item owns the key equivalent, so macOS swallowed Cmd+Z before it
            // could reach the editor's keymap: ProseMirror never saw the key at
            // all. Routing it as a normal menu id lets the UI decide, which is
            // the only place that knows whether the focus is in the document or
            // in a comment box.
            &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find…", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(app, "find_next", "Find Next", true, Some("CmdOrCtrl+G"))?,
            &MenuItem::with_id(app, "find_prev", "Find Previous", true, Some("CmdOrCtrl+Shift+G"))?,
            &PredefinedMenuItem::separator(app)?,
            &Submenu::with_items(
                app,
                "Copy Document As",
                true,
                &[
                    &MenuItem::with_id(app, "copy_as:markdown", "Markdown", true, None::<&str>)?,
                    &MenuItem::with_id(app, "copy_as:html", "Rich Text", true, None::<&str>)?,
                    &MenuItem::with_id(app, "copy_as:text", "Plain Text", true, None::<&str>)?,
                ],
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "comment", "Comment on Selection", true, Some("CmdOrCtrl+Shift+M"))?,
        ],
    )?;

    // Keep these ids in step with TYPEFACES in app/src/Settings.tsx — the two
    // lists are separate and drift silently if only one is edited.
    let typeface_menu = Submenu::with_items(
        app,
        "Typeface",
        true,
        &[
            &MenuItem::with_id(app, "font:sf", "SF Pro", true, None::<&str>)?,
            &MenuItem::with_id(app, "font:inter", "Inter", true, None::<&str>)?,
            &MenuItem::with_id(app, "font:avenir", "Avenir Next", true, None::<&str>)?,
            &MenuItem::with_id(app, "font:helvetica", "Helvetica Neue", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "font:newyork", "New York", true, None::<&str>)?,
            &MenuItem::with_id(app, "font:charter", "Charter", true, None::<&str>)?,
            &MenuItem::with_id(app, "font:iowan", "Iowan Old Style", true, None::<&str>)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "next_tab", "Next Tab", true, Some("CmdOrCtrl+Shift+]"))?,
            &MenuItem::with_id(app, "prev_tab", "Previous Tab", true, Some("CmdOrCtrl+Shift+["))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle_sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "toggle_threads", "Toggle Comments", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(app, "toggle_versions", "Versions", true, Some("CmdOrCtrl+3"))?,
            &CheckMenuItem::with_id(app, "toggle_resolved", "Show Resolved Comments", true, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &typeface_menu,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "show_source", "Show Source", true, false, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let doc_menu = Submenu::with_items(
        app,
        "Document",
        true,
        &[
            &MenuItem::with_id(app, "copy_connect", "Copy Connect Prompt for Claude Code", true, Some("CmdOrCtrl+Shift+K"))?,
            &PredefinedMenuItem::separator(app)?,
            // A check item rather than two commands: the mode is one piece of
            // state, and the menu is where it can say which way it is set.
            // The app corrects the tick per document once the window reports
            // which one is in front.
            &CheckMenuItem::with_id(app, "toggle_suggesting", "Suggesting", true, false, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "accept_all", "Accept All Suggestions", true, None::<&str>)?,
            &MenuItem::with_id(app, "reject_all", "Reject All Suggestions", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "unlock", "Unlock", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "Reload from Disk", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "copy_path", "Copy Path", true, Some("CmdOrCtrl+Shift+C"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &doc_menu, &window_menu],
    )
}

/// Set the tick on a check item.
///
/// macOS toggles a `CheckMenuItem` itself when it is clicked, which is right
/// for a preference and wrong for anything that belongs to a document: switch
/// tabs and the tick still shows the last document's answer. The UI calls this
/// whenever the active document changes, so the menu says what is true of the
/// document in front rather than what was last clicked.
pub fn set_checked(app: &AppHandle, id: &str, checked: bool) {
    let Some(menu) = app.menu() else { return };
    let Some(item) = menu.get(id) else { return };
    if let Some(check) = item.as_check_menuitem() {
        let _ = check.set_checked(checked);
    }
}

pub fn rebuild(app: &AppHandle) -> tauri::Result<()> {
    let menu = build(app)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn install_handler(app: &AppHandle) {
    app.on_menu_event(|app, event| {
        let id = event.id().0.clone();
        match id.as_str() {
            "quit" => crate::commands::request_quit(app),
            "reveal_home" => {
                let state = app.state::<Arc<AppState>>();
                let _ = std::process::Command::new("open")
                    .arg(state.store.home())
                    .spawn();
            }
            _ => {
                // Menu actions apply to the focused window only.
                //
                // It has to be `emit_to` with an explicit target. `Emitter` is
                // implemented on a window, but its `emit` forwards to
                // `manager().emit`, which broadcasts to every webview exactly
                // as `AppHandle::emit` does — the receiver being a window says
                // nothing about where the event goes. So this looked targeted
                // and was not: every window ran every menu action, and Cmd+N
                // opened one window per open window, Cmd+W closed a tab in
                // each of them, Cmd+2 toggled every comment panel.
                //
                // It stayed hidden while `capabilities/default.json` listed
                // `main` alone, because the other windows could not receive
                // events at all. Allowing `doc-*` there is what made it show.
                // Focused window, else `main`, else any. Falling back to
                // "no window named" makes every window act on the item, which
                // is only reachable through automation — a person has to focus
                // the app to reach its menu — but one window acting is right
                // in every case, so there is no reason to leave it open.
                let windows = app.webview_windows();
                let target = windows
                    .values()
                    .find(|w| w.is_focused().unwrap_or(false))
                    .or_else(|| windows.get("main"))
                    .or_else(|| windows.values().next());
                // The window is named in the payload and each one checks it,
                // rather than relying on the emit to be delivered narrowly.
                // Neither `WebviewWindow::emit` nor `emit_to` gave one-window
                // delivery here — the first forwards to `manager().emit`,
                // which broadcasts, and the second still reached other
                // windows in testing. An explicit label is not at the mercy of
                // that, and it reads as what it is.
                let _ = app.emit(
                    "menu",
                    MenuEvent {
                        id,
                        window: target.map(|w| w.label().to_string()),
                    },
                );
            }
        }
    });
}
