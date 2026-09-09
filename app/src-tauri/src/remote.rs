//! Open a document another Sidenote shares over the local network, as a tab
//! (dev builds only). The other end is `share.rs`.
//!
//! A remote document is a `DocEntry` whose path is
//! `sidenote://<host>:<port>/<token>`. Nothing about it is written to this
//! machine's `~/.sidenote`: every command the tab runs is posted to the
//! sharing Mac's RPC route and answered from its store, so the file, the
//! threads, the lock and the Claude session all stay there. The front end
//! decides per call (`ipc.ts`): a path or id that belongs to a remote
//! document goes through `remote_call` here instead of the local command.
//!
//! Change notification is a poll: once a second the tab's task asks the
//! other side for a fingerprint of the document and its review files, and
//! emits the same `fs-changed` events the local watcher would, with paths
//! the front end's filters recognise.
//!
//! Pairing: this machine has one secret (`~/.sidenote/peer-secret`, made on
//! first use). The first call to a sharing Mac fails with 401; `POST /pair`
//! then puts a dialog up over there, and once the user allows it the secret
//! is remembered and every later call carries it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::ServiceEvent;
use serde::Serialize;
use serde_json::{json, Value};
use sidenote_core::DocEntry;
use tauri::{AppHandle, Emitter};

use crate::share::{self, Changes, SERVICE_TYPE};
use crate::state::AppState;

/// One document opened from another Sidenote.
pub struct RemoteDoc {
    pub host: String,
    pub port: u16,
    pub token: String,
    /// The document's id on the sharing Mac; the tab uses it unchanged.
    pub id: String,
    /// Set to stop the change poll when the tab closes.
    pub stop: Option<Arc<AtomicBool>>,
}

/// A share seen over Bonjour.
#[derive(Clone, Serialize)]
pub struct NetworkShare {
    pub fullname: String,
    pub title: String,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub url: String,
}

pub fn remote_path(host: &str, port: u16, token: &str) -> String {
    format!("sidenote://{host}:{port}/{token}")
}

/// `http://host:port/d/token`, `http://host:port/d/token/anything`, or
/// `sidenote://host:port/token`.
pub fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://").ok_or("not a share link")?;
    let (hostport, path) = rest.split_once('/').ok_or("not a share link")?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "bad port")?),
        None => (hostport.to_string(), share::port()),
    };
    let token = match scheme {
        "http" | "https" => path.strip_prefix("d/").ok_or("not a share link")?,
        "sidenote" => path,
        _ => return Err("not a share link".into()),
    };
    let token = token.split('/').next().unwrap_or("").to_string();
    if host.is_empty() || token.is_empty() {
        return Err("not a share link".into());
    }
    Ok((host, port, token))
}

fn secret(state: &AppState) -> String {
    let p = state.store.home().join("peer-secret");
    if let Ok(s) = std::fs::read_to_string(&p) {
        let s = s.trim().to_string();
        if s.len() >= 16 {
            return s;
        }
    }
    let s = format!(
        "{}{}{}{}",
        sidenote_core::util::new_doc_id(),
        sidenote_core::util::new_doc_id(),
        sidenote_core::util::new_doc_id(),
        sidenote_core::util::new_doc_id()
    );
    let _ = std::fs::write(&p, &s);
    s
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
}

/// One RPC to the sharing Mac. `Err("not paired")` when it wants pairing.
async fn call(state: &AppState, host: &str, port: u16, token: &str, cmd: &str, args: Value) -> Result<Value, String> {
    let url = format!("http://{host}:{port}/d/{token}/rpc");
    let resp = client()
        .post(&url)
        .header("x-sidenote-peer", secret(state))
        .json(&json!({ "cmd": cmd, "args": args }))
        .send()
        .await
        .map_err(|e| format!("cannot reach {host}: {e}"))?;
    match resp.status().as_u16() {
        200 => {}
        401 => return Err("not paired".into()),
        404 => return Err("that document is no longer shared".into()),
        s => return Err(format!("{host} answered {s}")),
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(v.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("remote error").to_string())
    }
}

/// Ask the sharing Mac to let this one in. Waits for its user to answer.
async fn pair(state: &AppState, host: &str, port: u16) -> Result<(), String> {
    let name = share::computer_name().unwrap_or_else(|| "A Mac".into());
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
        .post(format!("http://{host}:{port}/pair"))
        .json(&json!({ "name": name, "secret": secret(state) }))
        .send()
        .await
        .map_err(|e| format!("cannot reach {host}: {e}"))?;
    match resp.status().as_u16() {
        200 => Ok(()),
        403 => Err(format!("{host} refused the pairing")),
        s => Err(format!("{host} answered {s} to the pairing")),
    }
}

/// Open a share as a document: pair if needed, fetch its entry, remember it.
pub async fn connect(state: &Arc<AppState>, url: &str) -> Result<DocEntry, String> {
    share::gate()?;
    let (host, port, token) = parse_url(url)?;
    let mut info = call(state, &host, port, &token, "info", json!({})).await;
    if matches!(&info, Err(e) if e == "not paired") {
        pair(state, &host, port).await?;
        info = call(state, &host, port, &token, "info", json!({})).await;
    }
    let mut doc: DocEntry = serde_json::from_value(info?).map_err(|e| e.to_string())?;
    let path = remote_path(&host, port, &token);
    doc.path = path.clone();
    let mut remotes = state.remotes.lock().unwrap();
    let stop = remotes.remove(&path).and_then(|r| r.stop);
    remotes.insert(
        path,
        RemoteDoc {
            host,
            port,
            token,
            id: doc.id.clone(),
            stop,
        },
    );
    Ok(doc)
}

fn find(state: &AppState, args: &Value) -> Option<(String, String, u16, String, String)> {
    let remotes = state.remotes.lock().unwrap();
    let by_path = ["path", "doc"]
        .iter()
        .filter_map(|k| args.get(k).and_then(|v| v.as_str()))
        .find(|p| p.starts_with("sidenote://"))
        .and_then(|p| remotes.get_key_value(p));
    let by_id = args
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|id| remotes.iter().find(|(_, r)| r.id == id));
    let (key, r) = by_path.or(by_id)?;
    Some((key.clone(), r.host.clone(), r.port, r.token.clone(), r.id.clone()))
}

/// Run a document command against the Sidenote that shares the document the
/// arguments name. A few commands are about this machine and are answered
/// here: the watcher, which becomes the change poll, and sharing, which a
/// remote document cannot do again.
pub async fn remote_call(app: &AppHandle, state: &Arc<AppState>, cmd: &str, args: Value) -> Result<Value, String> {
    share::gate()?;
    let Some((key, host, port, token, _id)) = find(state, &args) else {
        return Err("not a remote document".into());
    };
    match cmd {
        "watch_doc" => {
            start_poll(app, state, &key);
            Ok(Value::Null)
        }
        "unwatch_doc" => {
            stop_poll(state, &key);
            Ok(Value::Null)
        }
        "share_status" => Ok(Value::Null),
        "read_image" => Err("images are not fetched from a shared document yet".into()),
        _ => call(state, &host, port, &token, cmd, args).await,
    }
}

fn stop_poll(state: &AppState, key: &str) {
    if let Some(r) = state.remotes.lock().unwrap().get_mut(key) {
        if let Some(s) = r.stop.take() {
            s.store(true, Ordering::SeqCst);
        }
    }
}

/// Once a second, ask for the fingerprint and report what moved with the
/// events the local watcher would have sent.
fn start_poll(app: &AppHandle, state: &Arc<AppState>, key: &str) {
    stop_poll(state, key);
    let stop = Arc::new(AtomicBool::new(false));
    let (host, port, token, id) = {
        let mut remotes = state.remotes.lock().unwrap();
        let Some(r) = remotes.get_mut(key) else { return };
        r.stop = Some(stop.clone());
        (r.host.clone(), r.port, r.token.clone(), r.id.clone())
    };
    let app = app.clone();
    let state = state.clone();
    let key = key.to_string();
    tauri::async_runtime::spawn(async move {
        let mut last: Option<Changes> = None;
        let docs_prefix = format!("remote:/docs/{id}/");
        while !stop.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = match call(&state, &host, port, &token, "changes", json!({})).await {
                Ok(v) => serde_json::from_value::<Changes>(v).unwrap_or_default(),
                Err(e) => {
                    log::debug!("remote: poll {key}: {e}");
                    continue;
                }
            };
            if let Some(prev) = &last {
                if prev.doc != now.doc {
                    let _ = app.emit("fs-changed", key.clone());
                }
                if prev.threads != now.threads {
                    let _ = app.emit("fs-changed", format!("{docs_prefix}threads.json"));
                }
                if prev.state != now.state {
                    let _ = app.emit("fs-changed", format!("{docs_prefix}state.json"));
                }
                if prev.suggestions != now.suggestions {
                    let _ = app.emit("fs-changed", format!("{docs_prefix}suggestions.json"));
                }
            }
            last = Some(now);
        }
        log::info!("remote: poll for {key} stopped");
    });
}

// ---- discovery -------------------------------------------------------------

/// Watch Bonjour for `_sidenote._tcp` and keep the list current.
pub fn start_browse(state: &Arc<AppState>) {
    if !cfg!(debug_assertions) {
        return;
    }
    {
        let mut b = state.browsing.lock().unwrap();
        if *b {
            return;
        }
        *b = true;
    }
    let Some(daemon) = share::mdns(state) else { return };
    let rx = match daemon.browse(SERVICE_TYPE) {
        Ok(rx) => rx,
        Err(e) => {
            log::warn!("remote: cannot browse: {e}");
            return;
        }
    };
    let state = state.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            match ev {
                ServiceEvent::ServiceResolved(info) => {
                    let token = info.get_property_val_str("token").unwrap_or("").to_string();
                    if token.is_empty() {
                        continue;
                    }
                    // Our own shares come back too; the sidebar is for the
                    // other Macs.
                    if state.shares.lock().unwrap().contains_key(&token) {
                        continue;
                    }
                    let Some(ip) = info.get_addresses_v4().into_iter().next() else { continue };
                    let host = ip.to_string();
                    let port = info.get_port();
                    let title = info.get_property_val_str("title").unwrap_or("Document").to_string();
                    let entry = NetworkShare {
                        fullname: info.get_fullname().to_string(),
                        title,
                        url: format!("http://{host}:{port}/d/{token}"),
                        host,
                        port,
                        token,
                    };
                    log::info!("remote: found {} at {}", entry.title, entry.url);
                    state.discovered.lock().unwrap().insert(entry.fullname.clone(), entry);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    state.discovered.lock().unwrap().remove(&fullname);
                }
                _ => {}
            }
        }
    });
}

pub fn network_shares(state: &AppState) -> Vec<NetworkShare> {
    let mut v: Vec<NetworkShare> = state.discovered.lock().unwrap().values().cloned().collect();
    v.sort_by(|a, b| a.title.cmp(&b.title));
    v
}

#[cfg(test)]
mod tests {
    use super::parse_url;

    #[test]
    fn parses_both_link_forms() {
        assert_eq!(
            parse_url("http://10.0.0.5:47394/d/abc123").unwrap(),
            ("10.0.0.5".into(), 47394, "abc123".into())
        );
        assert_eq!(
            parse_url("http://mac.local:47394/d/abc123/raw").unwrap(),
            ("mac.local".into(), 47394, "abc123".into())
        );
        assert_eq!(
            parse_url("sidenote://10.0.0.5:47394/abc123").unwrap(),
            ("10.0.0.5".into(), 47394, "abc123".into())
        );
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("http://10.0.0.5:47394/").is_err());
    }
}
