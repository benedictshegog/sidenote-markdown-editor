//! # The content security policy
//!
//! `app.security.csp` in `tauri.conf.json` is the other half of
//! [`classify`]. That function decides where a link may take the window; the
//! policy decides what the page may fetch on its own, which is the larger
//! surface: a document is written by an agent, out of sources the agent did
//! not control, and it renders in a webview that can invoke every command in
//! `commands.rs`.
//!
//! `img-src` is the directive that earns its place today. An image URL in a
//! markdown file is a beacon: opening the document fetches it, which tells
//! whoever wrote the URL that the file was read, from what address, and when.
//! Local images are read by the Rust side and handed back as `blob:` URLs, so
//! nothing legitimate needs the network here. Refusing remote ones is a
//! decision rather than an oversight, and it is written down in
//! `docs/decisions/2026-08-23-remote-images.md` — including why the way back
//! is not a looser directive. `connect-src` keeps `ws:` for the listener on
//! 127.0.0.1. `style-src` needs `'unsafe-inline'` because Crepe, ProseMirror
//! and CodeMirror all set element styles directly.
//!
//! The rest is containment rather than a fix for anything live. Milkdown
//! renders raw HTML as text and sanitises link schemes, so there is no way in
//! at present; without a policy, the day that stops being true, a markdown
//! file reaches `write_doc`.
//!
//! `devCsp` exists beside `csp` because `csp` alone covers the bundled front
//! end and not the Vite dev server, which means `pnpm tauri dev` would run
//! with no policy at all and a change that breaks one would not show up until
//! release. It is the same policy, widened only where Vite needs it:
//! `'unsafe-inline'` and `'unsafe-eval'` for hot reload, and localhost in
//! `connect-src` for its socket. `img-src` is identical in both, so the
//! directive that matters can be tested in dev.

mod commands;
mod menu;
mod remote;
mod share;
mod state;
mod update;
mod watch;
mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, RunEvent};
use sidenote_core::Store;

use state::AppState;

/// Build a document window. `path` (when given) is handed to the UI through
/// the URL hash so the window opens straight on the document.
///
/// The label is `doc-N`, and `capabilities/default.json` must keep matching
/// it. Capability windows are globs against this label, so while that file
/// listed `main` alone every window built here resolved to no permissions at
/// all: no `event` meant no menu routing, no `fs-changed` reload and a
/// connection dot that never moved; no `dialog` meant Unlock and the error
/// alerts never appeared. Nothing announced it — the front end catches those
/// rejections — so a second window looked fine and quietly did nothing.
pub fn create_window(app: &AppHandle, path: Option<&Path>) -> tauri::Result<tauri::WebviewWindow> {
    use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
    let state = app.state::<Arc<AppState>>();
    let n = {
        let mut c = state.next_window.lock().unwrap();
        *c += 1;
        *c
    };
    let label = format!("doc-{n}");
    let mut url = WebviewUrl::default();
    if let Some(p) = path {
        let enc: String = url_encode(&p.to_string_lossy());
        url = match url {
            WebviewUrl::App(pb) => WebviewUrl::App(PathBuf::from(format!("{}#doc={enc}", pb.display()))),
            other => other,
        };
    }
    // Cascade from the focused (or any) window so new windows do not stack.
    let origin = app
        .webview_windows()
        .values()
        .filter(|w| w.is_visible().unwrap_or(false))
        .max_by_key(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| {
            let pos = w.outer_position().ok()?;
            let scale = w.scale_factor().ok()?;
            Some(pos.to_logical::<f64>(scale))
        });
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        // The product name, so a dev build's windows say so in Mission Control.
        .title(app.package_info().name.clone())
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 480.0)
        // No native drag-drop handler. tauri-runtime-wry's handler claims every
        // drag, files or not, and never forwards it to WebKit, which kills
        // drag and drop inside the editor (moving text, the block handle). The
        // price is that dropped files report no path, so the front end cancels
        // file drops outright; without that WKWebView would navigate the window
        // to the file:// URL, which on_navigation does not gate.
        .disable_drag_drop_handler()
        .on_navigation(allow_navigation)
        .visible(false);
    if let Some(p) = origin {
        builder = builder.position(p.x + 28.0, p.y + 28.0);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            // Matches trafficLightPosition in tauri.conf.json. Set at creation
            // because it cannot be set later: tauri 2.11 exposes no runtime
            // setter, and setTheme discards it (see applyAppearance).
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0))
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true);
    }
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
    }
    state.windows.lock().unwrap().insert(label, Vec::new());
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

/// What a document window may do with a navigation attempt.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Nav {
    /// The app's own front end: load it in the webview.
    InPlace,
    /// A link out to the web: hand it to the user's default browser.
    External,
    /// Neither: do nothing.
    Refuse,
}

/// Classify a navigation target. Only the app's own front end loads in place;
/// a link in a document belongs to the user's browser, not to this webview.
pub(crate) fn classify(url: &tauri::Url) -> Nav {
    match url.scheme() {
        // The bundled front end and its assets.
        "tauri" | "asset" | "blob" | "data" | "about" => Nav::InPlace,
        "http" | "https" => {
            // The Vite dev server behind `pnpm tauri dev`.
            match url.host_str().unwrap_or("") {
                "localhost" | "127.0.0.1" | "tauri.localhost" => Nav::InPlace,
                _ => Nav::External,
            }
        }
        "mailto" | "tel" => Nav::External,
        // Refuse the rest. A document is written by an agent, so a link in one
        // must not be able to reach `file:` or launch a local application.
        _ => Nav::Refuse,
    }
}

/// Whether an explicit request to open a link should hand it to the browser.
///
/// Wider than [`classify`] on purpose: that keeps localhost in the webview
/// because it is the dev server, but a link the user alt-clicked belongs in a
/// browser either way. Everything [`classify`] refuses stays refused.
pub(crate) fn link_opens_externally(url: &tauri::Url) -> bool {
    match classify(url) {
        Nav::External => true,
        Nav::InPlace => matches!(url.scheme(), "http" | "https"),
        Nav::Refuse => false,
    }
}

fn allow_navigation(url: &tauri::Url) -> bool {
    match classify(url) {
        Nav::InPlace => true,
        Nav::External => {
            open_external(url.as_str());
            false
        }
        Nav::Refuse => {
            log::warn!("sidenote: refused navigation to {url}");
            false
        }
    }
}

/// Hand a URL to whatever the user has set as the default handler.
pub(crate) fn open_external(url: &str) {
    if let Err(e) = std::process::Command::new("open").arg(url).spawn() {
        log::warn!("sidenote: could not open {url} externally: {e}");
    }
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Route a file-open request (Finder, `open -a`, argv, Open Recent from
/// another window): focus the window that already shows it, reuse an empty
/// window, or open a new one.
fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| p.extension().map(|e| e == "md" || e == "markdown").unwrap_or(false))
        .collect();
    if paths.is_empty() {
        return;
    }
    let state = app.state::<Arc<AppState>>();
    let ready = *state.ui_ready.lock().unwrap();
    if !ready {
        state.pending_opens.lock().unwrap().extend(paths);
        return;
    }
    for p in paths {
        let ps = p.to_string_lossy().into_owned();
        // The window that already has the document as a tab wins; else the
        // focused window (or main) opens it as a new tab.
        let showing = {
            let wins = state.windows.lock().unwrap();
            wins.iter().find(|(_, v)| v.iter().any(|x| x == &ps)).map(|(k, _)| k.clone())
        };
        let target = showing
            .and_then(|l| app.get_webview_window(&l))
            .or_else(|| {
                app.webview_windows()
                    .into_iter()
                    .find(|(_, w)| w.is_focused().unwrap_or(false))
                    .map(|(_, w)| w)
            })
            .or_else(|| app.get_webview_window("main"))
            .or_else(|| app.webview_windows().into_values().next());
        match target {
            Some(w) => {
                let _ = w.emit("open-file", ps.clone());
                let _ = w.show();
                let _ = w.set_focus();
            }
            None => {
                let _ = create_window(app, Some(&p));
            }
        }
    }
}

fn argv_paths(args: impl Iterator<Item = String>, cwd: Option<&str>) -> Vec<PathBuf> {
    args.skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() {
                p
            } else {
                match cwd {
                    Some(c) => PathBuf::from(c).join(p),
                    None => std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p),
                }
            }
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Store::open().expect("cannot create ~/.sidenote");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_paths(app, argv_paths(argv.into_iter(), Some(&cwd)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::new(store)))
        .invoke_handler(tauri::generate_handler![
            commands::list_docs,
            commands::register_doc,
            commands::read_doc,
            commands::read_image,
            commands::write_doc,
            commands::read_threads,
            commands::create_thread,
            commands::add_user_message,
            commands::set_thread_status,
            commands::mark_thread_read,
            commands::unread_counts,
            commands::set_thread_selector,
            commands::update_selectors,
            commands::read_state,
            commands::unlock_doc,
            commands::read_suggestions,
            commands::record_suggestion,
            commands::set_suggesting,
            commands::set_menu_checked,
            commands::accept_suggestion,
            commands::reject_suggestion,
            commands::anchor_threads,
            commands::anchor_one,
            commands::make_selectors,
            commands::emit_event,
            commands::listener_status,
            commands::relink_doc,
            commands::forget_doc,
            commands::list_snapshots,
            commands::suggest_relink,
            commands::watch_doc,
            commands::unwatch_doc,
            commands::window_count,
            commands::new_window,
            commands::app_info,
            commands::quit_ready,
            commands::quit_cancel,
            commands::read_snapshot,
            commands::diff_snapshot,
            commands::restore_snapshot,
            commands::take_pending_opens,
            commands::sidenote_home,
            commands::plain_text,
            commands::cli_status,
            commands::install_cli,
            commands::reveal_path,
            commands::open_link,
            commands::ui_log,
            commands::apply_result,
            commands::skill_status,
            commands::install_skill,
            commands::default_md_handler,
            commands::set_default_md_handler,
            commands::share_doc,
            commands::unshare_doc,
            commands::share_status,
            commands::connect_remote,
            commands::remote_call,
            commands::network_shares,
            update::update_check,
            update::update_run,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let handle = app.handle().clone();
            menu::rebuild(&handle)?;
            menu::install_handler(&handle);

            let window = app.get_webview_window("main").expect("main window");
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
            }
            app.state::<Arc<AppState>>().windows.lock().unwrap().insert("main".into(), Vec::new());
            // The UI shows the window once it knows what to display (a
            // document from Finder, restored tabs, or the Recent list), so
            // the Recent list never flashes. Fallback after 3 s.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let _ = w.show();
            });

            ws::start(handle.clone());
            remote::start_browse(&handle.state::<Arc<AppState>>().inner().clone());

            // The badge counts every document, so it needs a watcher of its
            // own and a count at startup — replies can land while the app is
            // closed, and the user should see them on the icon at launch.
            {
                let state = handle.state::<Arc<AppState>>().inner().clone();
                watch::watch_all_threads(&handle, &state);
                commands::refresh_badge(&handle, &state);
            }

            // Files passed on the command line at first launch.
            open_paths(&handle, argv_paths(std::env::args(), None));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths: Vec<PathBuf> = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .collect();
            open_paths(app, paths);
        }
        RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            let state = app.state::<Arc<AppState>>();
            state.windows.lock().unwrap().remove(&label);
            watch::forget_window(app, &label);
            // Its tabs went with it, and the badge counts open tabs.
            commands::refresh_badge(app, &state);
            // A quit waiting on this window need not wait any longer.
            commands::window_settled(app, &state, &label);
        }
        RunEvent::Exit => {
            let state = app.state::<Arc<AppState>>();
            let _ = state.store.clear_listeners();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{classify, link_opens_externally, Nav};

    fn nav(s: &str) -> Nav {
        classify(&s.parse().unwrap())
    }

    #[test]
    fn app_content_loads_in_place() {
        assert_eq!(nav("tauri://localhost/index.html"), Nav::InPlace);
        assert_eq!(nav("http://localhost:5173/index.html"), Nav::InPlace);
        assert_eq!(nav("http://tauri.localhost/index.html"), Nav::InPlace);
    }

    #[test]
    fn web_links_go_to_the_browser() {
        assert_eq!(nav("https://www.booking.com/hotel/gr/x.html"), Nav::External);
        assert_eq!(nav("http://example.com"), Nav::External);
        assert_eq!(nav("mailto:someone@example.com"), Nav::External);
    }

    #[test]
    fn local_schemes_are_refused() {
        assert_eq!(nav("file:///Applications/Calculator.app"), Nav::Refuse);
        assert_eq!(nav("javascript:alert(1)"), Nav::Refuse);
    }

    /// A host that merely ends in "localhost" is not ours.
    #[test]
    fn lookalike_hosts_are_external() {
        assert_eq!(nav("https://evil-localhost.com"), Nav::External);
        assert_eq!(nav("https://localhost.evil.com"), Nav::External);
    }

    fn opens(s: &str) -> bool {
        link_opens_externally(&s.parse().unwrap())
    }

    #[test]
    fn alt_click_opens_web_links() {
        assert!(opens("https://example.com/page"));
        assert!(opens("mailto:someone@example.com"));
        // In the webview this is the dev server; asked for explicitly it is
        // still a link, so it goes to the browser.
        assert!(opens("http://localhost:5173/index.html"));
    }

    #[test]
    fn alt_click_refuses_what_navigation_refuses() {
        assert!(!opens("file:///Applications/Calculator.app"));
        assert!(!opens("javascript:alert(1)"));
        // App-internal schemes are not links to hand to `open`.
        assert!(!opens("tauri://localhost/index.html"));
        assert!(!opens("data:text/html,<script>alert(1)</script>"));
    }
}
