//! Share a document over the local network (dev builds only).
//!
//! An experiment in two layers. A phone or a second machine on the same
//! Wi-Fi opens a read-only rendering of a document the app has open, in a
//! browser. And a second Mac running Sidenote opens the same document as a
//! normal tab: its reads and writes come here over HTTP, so the file, the
//! review data and the Claude session all stay on this machine (`remote.rs`
//! is the other end).
//!
//! The server is a hand-rolled HTTP/1.1 responder on `0.0.0.0:<ws port + 100>`
//! (47394 for a dev build). It reads the file fresh on every request. Routes:
//!
//! - `GET /d/<token>`          the page (HTML, styles and the poll script inline)
//! - `GET /d/<token>/body`     the rendered body alone, for the poll to swap in
//! - `GET /d/<token>/version`  `{"v":<hash>}` of the file, for the poll to compare
//! - `GET /d/<token>/raw`      the markdown as `text/markdown`
//! - `POST /pair`              a Sidenote on another Mac asks to be let in
//! - `POST /d/<token>/rpc`     a paired Sidenote runs one of the document
//!                             commands here, `{"cmd": .., "args": {..}}`
//!
//! The token is random, so nothing on the network can enumerate shared files,
//! and the file path never leaves this machine. The browser page carries no
//! auth: it is read-only. The RPC route does everything the local UI can do
//! to a document, so it needs a paired peer: a secret the other Mac made up,
//! accepted once through a dialog here and kept in `~/.sidenote/peers.json`.
//!
//! Raw HTML in the markdown is rendered as text on the browser page: a
//! document is written by an agent, and a page served to other devices must
//! not carry a script the agent chose.
//!
//! Each share is advertised over Bonjour as `_sidenote._tcp`, so the other
//! Mac lists it without being sent a link.
//!
//! It is gated to `debug_assertions` at every entry point. A release build
//! does not bind the port, has no menu item, and refuses the commands.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::path::Path;
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceInfo};
use pulldown_cmark::{html, Event, Options, Parser};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::commands;
use crate::state::AppState;

/// Added to the WebSocket port, so a dev and a release build (were the latter
/// ever to share) would not collide any more than their sockets do.
const PORT_OFFSET: u16 = 100;

/// Largest request (head and body) read before the connection is dropped.
/// A document write carries the whole markdown, so this is generous.
const MAX_REQUEST: usize = 8 * 1024 * 1024;

/// The Bonjour service type every share is advertised under.
pub const SERVICE_TYPE: &str = "_sidenote._tcp.local.";

#[derive(Clone, Serialize)]
pub struct ShareInfo {
    /// The URL to hand out: the machine's LAN address.
    pub url: String,
    /// Every URL the page answers on: LAN address, then `<host>.local`.
    pub urls: Vec<String>,
    pub token: String,
    pub port: u16,
}

/// A Sidenote on another machine that was allowed in, by its secret.
#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    pub name: String,
    pub paired_at: String,
}

pub fn port() -> u16 {
    sidenote_core::app_port() + PORT_OFFSET
}

pub fn gate() -> Result<(), String> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err("sharing over the local network is only in dev builds".into())
    }
}

/// Start sharing `path`, or return the share it already has. Binds the
/// server on first use.
pub fn share(app: &AppHandle, state: &Arc<AppState>, path: &str) -> Result<ShareInfo, String> {
    gate()?;
    if !Path::new(path).is_file() {
        return Err(format!("not a file: {path}"));
    }
    ensure_server(app, state)?;
    let token = {
        let mut shares = state.shares.lock().unwrap();
        match shares.iter().find(|(_, p)| p.as_str() == path) {
            Some((t, _)) => t.clone(),
            None => {
                let t = sidenote_core::util::new_doc_id();
                shares.insert(t.clone(), path.to_string());
                t
            }
        }
    };
    log::info!("share: {path} at /d/{token}");
    advertise(state, &token, path);
    Ok(info(&token))
}

pub fn unshare(state: &Arc<AppState>, path: &str) -> Result<(), String> {
    gate()?;
    let tokens: Vec<String> = {
        let mut shares = state.shares.lock().unwrap();
        let t: Vec<String> = shares.iter().filter(|(_, p)| p.as_str() == path).map(|(t, _)| t.clone()).collect();
        shares.retain(|_, p| p != path);
        t
    };
    for t in tokens {
        withdraw(state, &t);
    }
    log::info!("share: stopped {path}");
    Ok(())
}

pub fn status(state: &Arc<AppState>, path: &str) -> Result<Option<ShareInfo>, String> {
    gate()?;
    let shares = state.shares.lock().unwrap();
    Ok(shares
        .iter()
        .find(|(_, p)| p.as_str() == path)
        .map(|(t, _)| info(t)))
}

fn info(token: &str) -> ShareInfo {
    let port = port();
    let mut urls = Vec::new();
    if let Some(ip) = lan_ip() {
        urls.push(format!("http://{ip}:{port}/d/{token}"));
    }
    if let Some(host) = local_hostname() {
        urls.push(format!("http://{host}.local:{port}/d/{token}"));
    }
    if urls.is_empty() {
        urls.push(format!("http://127.0.0.1:{port}/d/{token}"));
    }
    ShareInfo {
        url: urls[0].clone(),
        urls,
        token: token.to_string(),
        port,
    }
}

/// The address another device on the LAN reaches this machine at. Connecting
/// a UDP socket sends nothing; it only asks the kernel which interface would
/// carry a packet to the outside, and that interface's address is the one.
pub fn lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// The Bonjour name (`scutil --get LocalHostName`), which every Apple device
/// on the network resolves as `<name>.local`.
pub fn local_hostname() -> Option<String> {
    scutil("LocalHostName")
}

/// The name in Sharing settings, for the pairing dialog on the other side.
pub fn computer_name() -> Option<String> {
    scutil("ComputerName").or_else(local_hostname)
}

fn scutil(key: &str) -> Option<String> {
    let out = std::process::Command::new("scutil").args(["--get", key]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

// ---- Bonjour ---------------------------------------------------------------

/// The mDNS daemon, made on first use and shared by advertising and browsing.
pub fn mdns(state: &AppState) -> Option<ServiceDaemon> {
    let mut guard = state.mdns.lock().unwrap();
    if guard.is_none() {
        match ServiceDaemon::new() {
            Ok(d) => *guard = Some(d),
            Err(e) => {
                log::warn!("share: no mDNS daemon: {e}");
                return None;
            }
        }
    }
    guard.clone()
}

fn advertise(state: &AppState, token: &str, path: &str) {
    let Some(daemon) = mdns(state) else { return };
    let host = format!("{}.local.", local_hostname().unwrap_or_else(|| "sidenote".into()));
    let title = std::fs::read_to_string(path)
        .map(|m| sidenote_core::util::title_of(&m, Path::new(path)))
        .unwrap_or_else(|_| "Document".into());
    let props = [("token", token), ("title", title.as_str())];
    let info = match ServiceInfo::new(SERVICE_TYPE, token, &host, "", port(), &props[..]) {
        Ok(i) => i.enable_addr_auto(),
        Err(e) => {
            log::warn!("share: cannot describe the service: {e}");
            return;
        }
    };
    if let Err(e) = daemon.register(info) {
        log::warn!("share: cannot advertise {token}: {e}");
    }
}

fn withdraw(state: &AppState, token: &str) {
    let Some(daemon) = mdns(state) else { return };
    let _ = daemon.unregister(&format!("{token}.{SERVICE_TYPE}"));
}

// ---- peers -----------------------------------------------------------------

fn peers_path(state: &AppState) -> std::path::PathBuf {
    state.store.home().join("peers.json")
}

fn load_peers(state: &AppState) -> HashMap<String, Peer> {
    std::fs::read_to_string(peers_path(state))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_peers(state: &AppState, peers: &HashMap<String, Peer>) {
    if let Ok(s) = serde_json::to_string_pretty(peers) {
        if let Err(e) = std::fs::write(peers_path(state), s) {
            log::warn!("share: cannot write peers.json: {e}");
        }
    }
}

fn peer_allowed(state: &AppState, secret: &str) -> bool {
    !secret.is_empty() && load_peers(state).contains_key(secret)
}

/// Ask the user whether to let a machine in. Blocks the calling thread until
/// the dialog is answered, so it runs on a blocking task.
fn pair(app: &AppHandle, state: &AppState, name: &str, secret: &str) -> bool {
    if secret.len() < 16 {
        return false;
    }
    if peer_allowed(state, secret) {
        return true;
    }
    let allowed = app
        .dialog()
        .message(format!(
            "\"{name}\" wants to open the documents you share on this network, comment on them and edit them.\n\nAllow it once and it stays paired; forget it by editing ~/.sidenote/peers.json."
        ))
        .title(format!("Pair with {name}?"))
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Refuse".into()))
        .blocking_show();
    if allowed {
        let mut peers = load_peers(state);
        peers.insert(
            secret.to_string(),
            Peer {
                name: name.to_string(),
                paired_at: sidenote_core::util::now(),
            },
        );
        save_peers(state, &peers);
        log::info!("share: paired with {name}");
    } else {
        log::info!("share: refused {name}");
    }
    allowed
}

// ---- the server ------------------------------------------------------------

fn ensure_server(app: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    let mut started = state.share_server.lock().unwrap();
    if *started {
        return Ok(());
    }
    let addr = format!("0.0.0.0:{}", port());
    // Bind synchronously so the caller learns about a taken port now, not
    // from a log line after the URL has been copied.
    let std_listener = std::net::TcpListener::bind(&addr).map_err(|e| format!("cannot bind {addr}: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("share: cannot adopt listener: {e}");
                return;
            }
        };
        log::info!("share: listening on {addr}");
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(e) => {
                    log::warn!("share: accept failed: {e}");
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(app, stream).await {
                    log::debug!("share: {peer}: {e}");
                }
            });
        }
    });
    *started = true;
    Ok(())
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn serve(app: AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    let req = match tokio::time::timeout(std::time::Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(Some(r))) => r,
        Ok(Ok(None)) => return Ok(()),
        Ok(Err(e)) => return Err(e),
        Err(_) => return Ok(()),
    };
    let head_only = req.method == "HEAD";
    let (status, ctype, body) = match req.method.as_str() {
        "GET" | "HEAD" => {
            let state = app.state::<Arc<AppState>>().inner().clone();
            route_get(&state, &req.path)
        }
        "POST" => {
            // Pairing blocks on a dialog and RPC runs store code; neither
            // belongs on the async workers.
            let app2 = app.clone();
            match tauri::async_runtime::spawn_blocking(move || route_post(&app2, &req)).await {
                Ok(r) => r,
                Err(_) => (500, "text/plain; charset=utf-8", "handler failed".into()),
            }
        }
        _ => (405, "text/plain; charset=utf-8", "method not allowed".into()),
    };
    respond(&mut stream, status, ctype, body.as_bytes(), head_only).await
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_REQUEST {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.lines();
    let Some(line) = lines.next() else { return Ok(None) };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_REQUEST {
        return Ok(None);
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Some(Request { method, path, headers, body }))
}

async fn respond(stream: &mut TcpStream, status: u16, ctype: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.shutdown().await
}

type Reply = (u16, &'static str, String);

fn text(status: u16, s: impl Into<String>) -> Reply {
    (status, "text/plain; charset=utf-8", s.into())
}

/// Which shared file a `/d/<token>...` path names, and what follows the token.
fn shared_file<'a>(state: &AppState, path: &'a str) -> Option<(String, String, &'a str)> {
    let rest = path.strip_prefix("/d/")?;
    let (token, sub) = match rest.split_once('/') {
        Some((t, s)) => (t, s),
        None => (rest, ""),
    };
    let shares = state.shares.lock().unwrap();
    let file = shares.get(token)?.clone();
    Some((token.to_string(), file, sub))
}

/// The browser routes: the page and what its poll fetches. No auth; read-only.
fn route_get(state: &AppState, path: &str) -> Reply {
    let Some((token, file, sub)) = shared_file(state, path) else { return text(404, "not found") };
    let markdown = match std::fs::read_to_string(&file) {
        Ok(m) => m,
        Err(e) => return text(404, format!("cannot read the document: {e}")),
    };
    match sub {
        "" => {
            let title = Path::new(&file)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Sidenote".into());
            (200, "text/html; charset=utf-8", page(&title, &token, &render(&markdown), version(&markdown)))
        }
        "body" => (200, "text/html; charset=utf-8", render(&markdown)),
        "version" => (200, "application/json", format!("{{\"v\":{}}}", version(&markdown))),
        "raw" => (200, "text/markdown; charset=utf-8", markdown),
        _ => text(404, "not found"),
    }
}

/// The Sidenote-to-Sidenote routes: pairing and RPC.
fn route_post(app: &AppHandle, req: &Request) -> Reply {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let body: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(e) => return text(400, format!("bad json: {e}")),
    };
    if req.path == "/pair" {
        let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("A Mac");
        let secret = body.get("secret").and_then(|v| v.as_str()).unwrap_or("");
        return if pair(app, &state, name, secret) {
            (200, "application/json", json!({"ok": true, "name": computer_name()}).to_string())
        } else {
            text(403, "refused")
        };
    }
    let secret = req.headers.get("x-sidenote-peer").map(String::as_str).unwrap_or("");
    if !peer_allowed(&state, secret) {
        return text(401, "not paired");
    }
    let Some((_, file, sub)) = shared_file(&state, &req.path) else { return text(404, "not found") };
    if sub != "rpc" {
        return text(404, "not found");
    }
    let cmd = body.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let args = body.get("args").cloned().unwrap_or(json!({}));
    let reply = match rpc(app, &state, &file, &cmd, args) {
        Ok(v) => json!({"ok": true, "value": v}),
        Err(e) => json!({"ok": false, "error": e}),
    };
    (200, "application/json", reply.to_string())
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let v = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| format!("bad argument {key}: {e}"))
}

fn out<T: Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Run one document command for a paired Sidenote, on the shared file only.
///
/// The token names one file; `args.id` has to be that file's id and any path
/// argument is replaced with the file, so a peer with one share cannot reach
/// another document through it. Two commands exist only here: `info`, the
/// `DocEntry` the other side opens as a tab, and `changes`, the fingerprint
/// its poll compares.
fn rpc(app: &AppHandle, state: &Arc<AppState>, file: &str, cmd: &str, mut args: Value) -> Result<Value, String> {
    let doc = state.store.require_doc(Path::new(file)).map_err(|e| e.to_string())?;
    if let Some(obj) = args.as_object_mut() {
        for key in ["path", "doc"] {
            if obj.get(key).and_then(|v| v.as_str()).is_some_and(|p| p.starts_with("sidenote://")) {
                obj.insert(key.into(), Value::String(file.to_string()));
            }
        }
        if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
            if id != doc.id {
                return Err("that document is not shared".into());
            }
        }
        if obj.get("path").and_then(|v| v.as_str()).is_some_and(|p| p != file) {
            return Err("that document is not shared".into());
        }
    }
    let a = &args;
    let s = || app.state::<Arc<AppState>>();
    match cmd {
        "info" => out(Ok(doc)),
        "changes" => out(Ok(changes(state, &doc))),
        "read_doc" => out(commands::read_doc(arg(a, "path")?)),
        "write_doc" => out(commands::write_doc(s(), arg(a, "path")?, arg(a, "content")?)),
        "read_threads" => out(commands::read_threads(s(), arg(a, "id")?)),
        "create_thread" => out(commands::create_thread(s(), arg(a, "id")?, arg(a, "selector")?, arg(a, "body")?)),
        "add_user_message" => out(commands::add_user_message(s(), arg(a, "id")?, arg(a, "threadId")?, arg(a, "body")?)),
        "mark_thread_read" => out(commands::mark_thread_read(app.clone(), s(), arg(a, "id")?, arg(a, "threadId")?)),
        "set_thread_status" => out(commands::set_thread_status(app.clone(), s(), arg(a, "id")?, arg(a, "threadId")?, arg(a, "status")?)),
        "set_thread_selector" => out(commands::set_thread_selector(s(), arg(a, "id")?, arg(a, "threadId")?, arg(a, "selector")?)),
        "update_selectors" => out(commands::update_selectors(s(), arg(a, "id")?, arg(a, "updates")?)),
        "read_state" => out(commands::read_state(s(), arg(a, "id")?)),
        "unlock_doc" => out(commands::unlock_doc(s(), arg(a, "id")?)),
        "read_suggestions" => out(commands::read_suggestions(s(), arg(a, "id")?)),
        "record_suggestion" => out(commands::record_suggestion(s(), arg(a, "id")?, arg(a, "session")?, arg(a, "old")?, arg(a, "new")?, arg(a, "thread")?)),
        "set_suggesting" => out(commands::set_suggesting(s(), arg(a, "id")?, arg(a, "on")?)),
        "accept_suggestion" => out(commands::accept_suggestion(s(), arg(a, "id")?, arg(a, "suggestion")?, arg(a, "landed")?)),
        "reject_suggestion" => out(commands::reject_suggestion(s(), arg(a, "id")?, arg(a, "suggestion")?)),
        "emit_event" => out(commands::emit_event(s(), arg(a, "id")?, arg(a, "event")?, arg(a, "thread")?)),
        "listener_status" => out(commands::listener_status(s(), arg(a, "id")?)),
        "list_snapshots" => out(commands::list_snapshots(s(), arg(a, "id")?)),
        "read_snapshot" => out(commands::read_snapshot(s(), arg(a, "id")?, arg(a, "name")?)),
        "diff_snapshot" => out(commands::diff_snapshot(s(), arg(a, "id")?, arg(a, "name")?, arg(a, "other")?)),
        "restore_snapshot" => out(commands::restore_snapshot(s(), arg(a, "id")?, arg(a, "name")?)),
        _ => Err(format!("unknown command {cmd}")),
    }
}

/// A fingerprint per file the other side cares about: size and mtime, which
/// is what the local watcher reacts to as well.
#[derive(Serialize, Deserialize, Default, PartialEq, Clone, Debug)]
pub struct Changes {
    pub doc: String,
    pub threads: String,
    pub state: String,
    pub suggestions: String,
}

fn changes(state: &AppState, doc: &sidenote_core::DocEntry) -> Changes {
    let dir = state.store.doc_dir(&doc.id);
    let stamp = |p: &Path| -> String {
        match std::fs::metadata(p) {
            Ok(m) => {
                let t = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                format!("{}:{t}", m.len())
            }
            Err(_) => String::new(),
        }
    };
    Changes {
        doc: stamp(Path::new(&doc.path)),
        threads: stamp(&dir.join("threads.json")),
        state: stamp(&dir.join("state.json")),
        suggestions: stamp(&dir.join("suggestions.json")),
    }
}

// ---- the browser page ------------------------------------------------------

/// A cheap fingerprint of the text for the poll to compare. FNV-1a; the page
/// only asks whether it changed.
fn version(markdown: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in markdown.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Markdown to HTML, with raw HTML shown as text rather than interpreted.
pub fn render(markdown: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    let parser = Parser::new_ext(markdown, opts).map(|ev| match ev {
        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
        other => other,
    });
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn page(title: &str, token: &str, body: &str, v: u64) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --line: rgba(0,0,0,.08); --code: rgba(0,0,0,.05); --accent: #5E5CE6; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fg: #e8e8ea; --bg: #1c1c1e; --muted: #98989d; --line: rgba(255,255,255,.12); --code: rgba(255,255,255,.08); --accent: #7D7AFF; }} }}
html {{ background: var(--bg); }}
body {{ margin: 0; color: var(--fg); font: 17px/1.6 "Avenir Next", -apple-system, system-ui, sans-serif; -webkit-text-size-adjust: 100%; }}
main {{ max-width: 680px; margin: 0 auto; padding: 48px 20px 96px; }}
h1, h2, h3, h4 {{ font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; margin: 1.6em 0 .5em; }}
h1 {{ font-size: 1.9em; margin-top: 0; }} h2 {{ font-size: 1.5em; }} h3 {{ font-size: 1.25em; }}
p, ul, ol, blockquote, pre, table {{ margin: 0 0 1em; }}
a {{ color: var(--accent); }}
code {{ font: .9em "SF Mono", Menlo, monospace; background: var(--code); border-radius: 4px; padding: .1em .3em; }}
pre {{ background: var(--code); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }}
pre code {{ background: none; padding: 0; }}
blockquote {{ border-left: 3px solid var(--line); margin-left: 0; padding-left: 1em; color: var(--muted); }}
table {{ border-collapse: collapse; width: 100%; font-size: .95em; display: block; overflow-x: auto; }}
th, td {{ border-bottom: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }}
th {{ font-weight: 600; }}
hr {{ border: 0; border-top: 1px solid var(--line); margin: 2em 0; }}
img {{ max-width: 100%; }}
.pill {{ position: fixed; right: 12px; bottom: 10px; font: 11px/18px -apple-system, system-ui, sans-serif; color: var(--muted); background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 0 8px; }}
.pill.live::before {{ content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 3px; background: var(--accent); margin-right: 6px; vertical-align: 1px; }}
</style>
</head>
<body>
<main id="doc">{body}</main>
<div class="pill live" id="pill">Sidenote · live</div>
<script>
(function () {{
  var v = "{v}";
  var base = "/d/{token}";
  var pill = document.getElementById("pill");
  async function poll() {{
    try {{
      var r = await fetch(base + "/version", {{ cache: "no-store" }});
      var j = await r.json();
      var nv = String(j.v);
      if (nv !== v) {{
        var b = await fetch(base + "/body", {{ cache: "no-store" }});
        document.getElementById("doc").innerHTML = await b.text();
        v = nv;
      }}
      pill.className = "pill live";
      pill.textContent = "Sidenote · live";
    }} catch (e) {{
      pill.className = "pill";
      pill.textContent = "Sidenote · offline";
    }}
  }}
  setInterval(poll, 2000);
}})();
</script>
</body>
</html>
"#,
        title = escape(title),
        body = body,
        v = v,
        token = token,
    )
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn raw_html_is_text_not_markup() {
        let out = render("hello <script>alert(1)</script> world");
        assert!(!out.contains("<script>"));
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn gfm_extensions_render() {
        let out = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~");
        assert!(out.contains("<table>"));
        assert!(out.contains("checked"));
        assert!(out.contains("<del>"));
    }
}
