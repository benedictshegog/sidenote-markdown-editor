//! WebSocket server on 127.0.0.1:47293. Claude Code sessions connect with
//! the subprotocols `sidenote` and `sid-<CLAUDE_CODE_SESSION_ID>`; the session
//! id routes document events to the owning session.
//!
//! The socket also carries one request the CLI makes of the app: `apply`,
//! which lands an edit in the editor as a single transaction instead of
//! rewriting the file. A request frame is `{"req":"apply","id":n,...}`; the
//! reply is `{"res":n,"ok":true,...}` or `{"res":n,"ok":false,"error":..}`.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::state::{AppState, Client};

pub const PORT: u16 = 47293;

/// Sockets held at once. One Claude Code session needs one, and a handful of
/// sessions is a busy day, so this is far above real use and only bounds what
/// a stuck or hostile client can accumulate.
const MAX_CLIENTS: usize = 64;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let addr = format!("127.0.0.1:{PORT}");
        let listener = match TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("ws: cannot bind {addr}: {e}");
                let state = app.state::<Arc<AppState>>();
                state.hub.lock().unwrap().port_error = Some(e.to_string());
                let _ = app.emit("listeners-changed", ());
                return;
            }
        };
        log::info!("ws: listening on {addr}");
        {
            let state = app.state::<Arc<AppState>>().inner().clone();
            publish_listeners(&app, &state);
        }
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(e) => {
                    log::warn!("ws: accept failed: {e}");
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle(app, stream).await {
                    log::debug!("ws: {peer} closed: {e}");
                }
            });
        }
    });
}

async fn handle(app: AppHandle, stream: tokio::net::TcpStream) -> anyhow_lite::Result<()> {
    let mut session: Option<String> = None;
    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, mut resp: Response| {
        // A WebSocket handshake is not subject to the same-origin policy, so
        // any page in any browser can open this port. It cannot send us
        // anything — the read loop below drops every inbound frame — but it
        // would receive the broadcast frames for unowned documents, which
        // carry absolute file paths, and it could squat a session id in
        // `listeners.json` and block a legitimate takeover.
        //
        // A browser always sends `Origin` on a WebSocket handshake and a
        // program never does, so refusing the header is the whole check.
        if req.headers().contains_key("Origin") {
            log::warn!("ws: refused a handshake carrying an Origin header");
            let mut refusal = ErrorResponse::new(Some(
                "sidenote accepts local programs, not pages".to_string(),
            ));
            *refusal.status_mut() = StatusCode::FORBIDDEN;
            return Err(refusal);
        }
        if let Some(v) = req.headers().get("Sec-WebSocket-Protocol") {
            let offered = v.to_str().unwrap_or("");
            let mut has_sidenote = false;
            for p in offered.split(',').map(|s| s.trim()) {
                if p == "sidenote" {
                    has_sidenote = true;
                }
                if let Some(sid) = p.strip_prefix("sid-") {
                    if !sid.is_empty() {
                        session = Some(sid.to_string());
                    }
                }
            }
            if has_sidenote {
                resp.headers_mut()
                    .insert("Sec-WebSocket-Protocol", "sidenote".parse().unwrap());
            }
        }
        Ok(resp)
    })
    .await?;

    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let state = app.state::<Arc<AppState>>().inner().clone();
    let replay_tx = tx.clone();
    let id = {
        let mut hub = state.hub.lock().unwrap();
        if hub.clients.len() >= MAX_CLIENTS {
            log::warn!("ws: refusing a connection, {MAX_CLIENTS} already open");
            return Ok(());
        }
        let id = hub.next_id;
        hub.next_id += 1;
        hub.clients.insert(
            id,
            Client {
                session: session.clone(),
                tx,
            },
        );
        id
    };
    log::info!("ws: client {id} connected (session {:?})", session);
    publish_listeners(&app, &state);

    // Comments left while this session was away are still waiting in
    // `threads.json`; nothing redelivers them, so send them now.
    if let Some(sid) = session.as_deref() {
        let n = replay_pending(&state, sid, &replay_tx);
        if n > 0 {
            log::info!("ws: client {id} replayed {n} waiting comment(s)");
        }
    }

    // Writer: forward routed frames to the socket.
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader: answer requests; drop everything else (pings are answered by
    // tungstenite) until close.
    while let Some(msg) = source.next().await {
        match msg {
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Text(text)) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v.get("req").is_some() {
                        let app = app.clone();
                        let state = state.clone();
                        let reply_tx = replay_tx.clone();
                        tauri::async_runtime::spawn(async move {
                            let reply = handle_request(&app, &state, v).await;
                            let _ = reply_tx.send(reply.to_string());
                        });
                    }
                }
            }
            Ok(_) => {}
        }
    }

    writer.abort();
    {
        let mut hub = state.hub.lock().unwrap();
        hub.clients.remove(&id);
    }
    log::info!("ws: client {id} disconnected");
    publish_listeners(&app, &state);
    Ok(())
}

/// How long the UI gets to land an edit. The transaction itself is
/// immediate; the wait is for the autosave that follows it, so the file
/// holds the edit by the time the CLI returns.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Serve one request frame. Only `apply` exists: find the window showing the
/// document, hand the edit to its UI, wait for the result.
async fn handle_request(app: &AppHandle, state: &Arc<AppState>, v: serde_json::Value) -> serde_json::Value {
    let id = v.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let fail = |error: &str| serde_json::json!({ "res": id, "ok": false, "error": error });
    if v.get("req").and_then(|r| r.as_str()) != Some("apply") {
        return fail("unknown_request");
    }
    let Some(doc) = v.get("doc").and_then(|d| d.as_str()) else {
        return fail("bad_request");
    };
    let label = {
        let wins = state.windows.lock().unwrap();
        wins.iter()
            .find(|(_, paths)| paths.iter().any(|p| p == doc))
            .map(|(l, _)| l.clone())
    };
    let Some(label) = label else {
        return fail("not_open");
    };
    let (tx, rx) = oneshot::channel();
    let rid = {
        let mut hub = state.hub.lock().unwrap();
        let rid = hub.next_request;
        hub.next_request += 1;
        hub.pending.insert(rid, tx);
        rid
    };
    // The mode, read from disk for this request rather than taken from
    // whatever the window last loaded.
    //
    // The UI keeps a copy of `state.json` and refreshes it from the file
    // watcher, which debounces. Deciding from that copy meant an `apply`
    // arriving before the refresh was applied for real — the file edited while
    // the user had asked for suggestions, which is the one thing the mode must
    // never do. It is a cache, so it cannot be the authority; this can.
    let suggesting = state
        .store
        .require_doc(std::path::Path::new(doc))
        .and_then(|d| state.store.read_state(&d.id))
        .map(|st| st.suggesting)
        .unwrap_or(false);

    let payload = serde_json::json!({
        "rid": rid,
        "doc": doc,
        "old": v.get("old").cloned().unwrap_or_default(),
        "new": v.get("new").cloned().unwrap_or_default(),
        "suggesting": suggesting,
        // Only suggesting mode reads these: a suggestion is recorded by the UI
        // and has to know which comment it answers and who proposed it. A
        // direct edit re-anchors its thread back in the CLI, after the reply.
        "thread": v.get("thread").cloned().unwrap_or(serde_json::Value::Null),
        "session": v.get("session").cloned().unwrap_or(serde_json::Value::Null),
    });
    if let Err(e) = app.emit_to(&label, "apply-request", payload) {
        log::warn!("ws: cannot hand request {rid} to window {label}: {e}");
        state.hub.lock().unwrap().pending.remove(&rid);
        return fail("not_open");
    }
    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(mut result)) => {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("res".into(), id);
            }
            result
        }
        Ok(Err(_)) => fail("ui_gone"),
        Err(_) => {
            state.hub.lock().unwrap().pending.remove(&rid);
            fail("timeout")
        }
    }
}

/// Write `listeners.json` for the CLI and tell the UI.
pub fn publish_listeners(app: &AppHandle, state: &AppState) {
    let sessions = state.hub.lock().unwrap().sessions();
    if let Err(e) = state.store.write_listeners(sessions) {
        log::warn!("ws: cannot write listeners.json: {e}");
    }
    let _ = app.emit("listeners-changed", ());
}

/// Send the waiting comments of every document this session owns. Returns
/// the number of frames queued.
fn replay_pending(state: &AppState, session: &str, tx: &mpsc::UnboundedSender<String>) -> usize {
    let pending = match state.store.pending_for_session(session) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("ws: cannot list pending threads for {session}: {e}");
            return 0;
        }
    };
    let mut n = 0;
    for (doc, threads) in pending {
        for thread in threads {
            let frame = serde_json::json!({
                "event": "comment",
                "doc": doc.path,
                "thread": thread,
                "replay": true,
            })
            .to_string();
            if tx.send(frame).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Route a frame to the document's owning session. An owner that is offline
/// gets it from `replay_pending` when it reconnects, so the frame is never
/// broadcast to an unrelated session — two sessions answering one document is
/// worse than a comment that waits. A document with no owner yet is fair game
/// for any connected session to adopt.
/// Returns the number of sockets that received it.
pub fn route(state: &AppState, owner: Option<&str>, frame: &str) -> usize {
    let hub = state.hub.lock().unwrap();
    let targets: Vec<&Client> = match owner {
        Some(o) => hub
            .clients
            .values()
            .filter(|c| c.session.as_deref() == Some(o))
            .collect(),
        None => hub.clients.values().collect(),
    };
    let mut n = 0;
    for c in targets {
        if c.tx.send(frame.to_string()).is_ok() {
            n += 1;
        }
    }
    n
}

mod anyhow_lite {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}
