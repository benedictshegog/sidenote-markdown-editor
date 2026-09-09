use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use notify::RecommendedWatcher;
use sidenote_core::Store;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// One connected WebSocket client.
pub struct Client {
    pub session: Option<String>,
    pub tx: UnboundedSender<String>,
}

#[derive(Default)]
pub struct Hub {
    pub next_id: u64,
    pub clients: HashMap<u64, Client>,
    pub port_error: Option<String>,
    /// Requests a CLI has sent over the socket and the UI has not answered
    /// yet, by request id. `apply_result` completes them.
    pub pending: HashMap<u64, oneshot::Sender<serde_json::Value>>,
    pub next_request: u64,
}

impl Hub {
    pub fn sessions(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .clients
            .values()
            .filter_map(|c| c.session.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    }
}

pub struct AppState {
    pub store: Store,
    pub hub: Mutex<Hub>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Watches every document's `threads.json` so the Dock badge recounts when
    /// a reply lands. It covers every document rather than the open ones: the
    /// recount is cheap, and keeping the watch set in step with the tabs would
    /// buy nothing.
    pub badge_watcher: Mutex<Option<RecommendedWatcher>>,
    /// Directories each open document needs watched: window label -> document path -> dirs.
    pub watched: Mutex<HashMap<String, HashMap<String, Vec<PathBuf>>>>,
    /// Directories currently registered with the watcher.
    pub active_dirs: Mutex<Vec<PathBuf>>,
    /// Document paths open (as tabs) in each window.
    pub windows: Mutex<HashMap<String, Vec<String>>>,
    pub next_window: Mutex<u32>,
    /// Files requested via Finder / `open -a` before the UI was ready.
    pub pending_opens: Mutex<Vec<PathBuf>>,
    pub ui_ready: Mutex<bool>,
    /// Windows a Quit is still waiting on; `None` when no quit is in progress.
    /// See `commands::request_quit`.
    pub quit_pending: Mutex<Option<HashSet<String>>>,
    /// Documents served over the local network (dev builds): token -> path.
    pub shares: Mutex<HashMap<String, String>>,
    /// Whether the share server has been bound. See `share::ensure_server`.
    pub share_server: Mutex<bool>,
    /// Bonjour daemon, shared by advertising shares and browsing for them.
    pub mdns: Mutex<Option<mdns_sd::ServiceDaemon>>,
    pub browsing: Mutex<bool>,
    /// Shares seen on the network, by Bonjour full name.
    pub discovered: Mutex<HashMap<String, crate::remote::NetworkShare>>,
    /// Documents opened from another Sidenote, by their `sidenote://` path.
    pub remotes: Mutex<HashMap<String, crate::remote::RemoteDoc>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            hub: Mutex::new(Hub::default()),
            watcher: Mutex::new(None),
            badge_watcher: Mutex::new(None),
            watched: Mutex::new(HashMap::new()),
            active_dirs: Mutex::new(Vec::new()),
            windows: Mutex::new(HashMap::new()),
            next_window: Mutex::new(1),
            pending_opens: Mutex::new(Vec::new()),
            ui_ready: Mutex::new(false),
            quit_pending: Mutex::new(None),
            shares: Mutex::new(HashMap::new()),
            share_server: Mutex::new(false),
            mdns: Mutex::new(None),
            browsing: Mutex::new(false),
            discovered: Mutex::new(HashMap::new()),
            remotes: Mutex::new(HashMap::new()),
        }
    }
}
