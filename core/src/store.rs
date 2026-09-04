//! The app directory (`~/.sidenote/`) and every operation on it. The CLI and
//! the Tauri app are thin wrappers over this type.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::anchor::make_selector_chars;
use crate::diff::unified_ignore_ws;
use crate::error::{Result, SidenoteError};
use crate::fsutil::{atomic_write, read_json, read_to_string, update_json, write_json, FileLock};
use crate::model::*;
use crate::plain::plain_text;
use crate::snapshots;
use crate::suggest::{Suggestion, SuggestionsFile};
use crate::util::{age_secs, new_doc_id, next_thread_id, now, pid_alive, title_of};

#[derive(Debug, Clone)]
pub struct Store {
    home: PathBuf,
}

/// Result of `turn begin`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBegin {
    pub doc: DocEntry,
    pub took_over_from: Option<String>,
    pub threads: Vec<Thread>,
    pub snapshot: Option<String>,
    pub diff: String,
    /// Suggesting mode is on: edits made this turn will wait for the user.
    /// Reported here because a session has to know before it starts writing —
    /// what it says in its replies depends on it.
    pub suggesting: bool,
    /// Suggestions from earlier turns the user has not decided yet. A session
    /// that suggests the same change twice is the failure this prevents.
    pub pending: Vec<Suggestion>,
}

/// Result of `turn end`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnEnd {
    pub doc: DocEntry,
    pub snapshot: String,
    pub anchored: Vec<String>,
    pub orphaned: Vec<String>,
    pub open: usize,
    pub resolved: usize,
    pub new_user_messages: bool,
}

/// Result of `apply`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Applied {
    pub doc: DocEntry,
    /// The text now in the document where the replacement went. Empty when
    /// the edit was only suggested: nothing went anywhere yet.
    pub exact: String,
    pub thread: Option<Thread>,
    /// True when the thread could not be re-anchored to the new text.
    pub orphaned: bool,
    /// The lock was already held by this session, so `apply` left it held.
    pub kept_lock: bool,
    /// Set when the document is in suggesting mode: the edit was recorded for
    /// the user to decide, and the file is untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Suggestion>,
}

/// Result of accepting a suggestion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Accepted {
    pub doc: DocEntry,
    pub suggestion: Suggestion,
    pub thread: Option<Thread>,
    /// True when the thread could not be re-anchored to the new text.
    pub orphaned: bool,
}

impl Store {
    /// `~/.sidenote/`, created on first use. `SIDENOTE_HOME` overrides it (tests).
    pub fn open() -> Result<Store> {
        let home = match std::env::var_os("SIDENOTE_HOME") {
            Some(p) => PathBuf::from(p),
            None => {
                let h = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .ok_or_else(|| SidenoteError::Other("HOME is not set".into()))?;
                h.join(".sidenote")
            }
        };
        Store::at(home)
    }

    pub fn at(home: impl Into<PathBuf>) -> Result<Store> {
        let home = home.into();
        fs::create_dir_all(home.join("docs"))?;
        Ok(Store { home })
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    // ---- paths -----------------------------------------------------------

    pub fn index_path(&self) -> PathBuf {
        self.home.join("index.json")
    }
    /// Sessions connected to the running app. One file per port, so a dev
    /// app beside the installed one neither reads its sessions nor deletes
    /// its file on exit; the release port keeps the plain name.
    pub fn listeners_path(&self) -> PathBuf {
        let port = crate::app_port();
        if port == crate::DEFAULT_PORT {
            self.home.join("listeners.json")
        } else {
            self.home.join(format!("listeners-{port}.json"))
        }
    }
    pub fn doc_dir(&self, id: &str) -> PathBuf {
        self.home.join("docs").join(id)
    }
    pub fn threads_path(&self, id: &str) -> PathBuf {
        self.doc_dir(id).join("threads.json")
    }
    pub fn state_path(&self, id: &str) -> PathBuf {
        self.doc_dir(id).join("state.json")
    }

    /// Serialises writes to the markdown file itself, so `apply` from a
    /// session and the app's autosave cannot interleave.
    ///
    /// `state.json`'s busy flag does not do this job. It turns the editor
    /// read-only, but the app learns about it through the file watcher, which
    /// debounces; an autosave already in flight lands after a session has read
    /// the file and before it writes, and the session then writes back text
    /// that has no trace of it.
    ///
    /// The lock file lives under `docs/<id>/`, not beside the document. A
    /// `.plan.md.lock` appearing in the user's own repository is not something
    /// this feature is allowed to cost them.
    fn document_lock(&self, id: &str) -> Result<FileLock> {
        let dir = self.doc_dir(id);
        fs::create_dir_all(&dir)?;
        FileLock::acquire(&dir.join("document"))
    }

    /// Write the document text on the user's behalf: the app's autosave, or a
    /// snapshot restore. Refuses while a session holds a fresh lock.
    ///
    /// The app turns its editor read-only when it sees the busy flag, so this
    /// mostly never fires. "Mostly" is the reason it exists: `restore_snapshot`
    /// never consulted the lock at all, so restoring a version while Claude
    /// was writing overwrote it with no warning to either side.
    pub fn write_document(&self, path: &Path, content: &str) -> Result<()> {
        // An unregistered file has no state to consult. Writing it is still
        // better than losing what the user typed.
        let Some(doc) = self.find_doc(path)? else {
            return atomic_write(path, content.as_bytes());
        };
        let _guard = self.document_lock(&doc.id)?;
        let state = self.read_state(&doc.id)?;
        if Store::is_fresh_busy(&state) {
            return Err(SidenoteError::Locked {
                by: state.busy_by.clone().unwrap_or_else(|| "unknown".into()),
                since: state.busy_since.clone().unwrap_or_default(),
            });
        }
        atomic_write(Path::new(&doc.path), content.as_bytes())
    }

    // ---- index -----------------------------------------------------------

    pub fn read_index(&self) -> Result<IndexFile> {
        Ok(read_json(&self.index_path())?.unwrap_or_default())
    }

    pub fn list(&self) -> Result<Vec<DocEntry>> {
        let mut docs = self.read_index()?.docs;
        docs.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        Ok(docs)
    }

    pub fn doc_by_id(&self, id: &str) -> Result<DocEntry> {
        self.read_index()?
            .docs
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| SidenoteError::UnknownDoc(id.to_string()))
    }

    /// Look a document up by path. The path is canonicalised when it exists.
    pub fn find_doc(&self, path: &Path) -> Result<Option<DocEntry>> {
        let abs = absolute(path);
        let idx = self.read_index()?;
        Ok(idx.docs.into_iter().find(|d| Path::new(&d.path) == abs))
    }

    pub fn require_doc(&self, path: &Path) -> Result<DocEntry> {
        self.find_doc(path)?
            .ok_or_else(|| SidenoteError::NotRegistered(absolute(path)))
    }

    fn update_doc<F: FnOnce(&mut DocEntry)>(&self, id: &str, f: F) -> Result<DocEntry> {
        update_json::<IndexFile, _, _>(&self.index_path(), |idx| {
            let d = idx
                .docs
                .iter_mut()
                .find(|d| d.id == id)
                .ok_or_else(|| SidenoteError::UnknownDoc(id.to_string()))?;
            f(d);
            Ok(d.clone())
        })
    }

    /// Register a markdown file. Idempotent: an already registered path
    /// returns its entry (and, when `session` is given, takes ownership).
    /// The bool is true when the document was newly registered.
    pub fn register(&self, path: &Path, session: Option<&str>) -> Result<(DocEntry, bool)> {
        if !path.is_file() {
            return Err(SidenoteError::FileNotFound(absolute(path)));
        }
        let abs = absolute(path);
        let content = read_to_string(&abs)?;
        let title = title_of(&content, &abs);
        let ts = now();

        if let Some(existing) = self.find_doc(&abs)? {
            let d = self.update_doc(&existing.id, |d| {
                d.title = title.clone();
                d.last_opened = ts.clone();
                if let Some(s) = session {
                    d.owner_session = Some(s.to_string());
                }
            })?;
            return Ok((d, false));
        }

        let id = loop {
            let id = new_doc_id();
            if !self.doc_dir(&id).exists() {
                break id;
            }
        };
        let dir = self.doc_dir(&id);
        fs::create_dir_all(&dir)?;
        write_json(&self.threads_path(&id), &ThreadsFile::default())?;
        write_json(&self.state_path(&id), &StateFile::default())?;
        snapshots::write_next(&dir, &content)?;

        let entry = DocEntry {
            id: id.clone(),
            path: abs.to_string_lossy().into_owned(),
            title,
            registered_at: ts.clone(),
            last_opened: ts,
            owner_session: session.map(|s| s.to_string()),
        };
        update_json::<IndexFile, _, _>(&self.index_path(), |idx| {
            idx.version = INDEX_VERSION;
            idx.docs.push(entry.clone());
            Ok(())
        })?;
        Ok((entry, true))
    }

    pub fn touch_opened(&self, id: &str) -> Result<DocEntry> {
        let ts = now();
        self.update_doc(id, |d| d.last_opened = ts)
    }

    /// Point a registered document at a new path (after a move or rename).
    pub fn relink(&self, id: &str, new_path: &Path) -> Result<DocEntry> {
        if !new_path.is_file() {
            return Err(SidenoteError::FileNotFound(absolute(new_path)));
        }
        let abs = absolute(new_path);
        let content = read_to_string(&abs)?;
        let title = title_of(&content, &abs);
        self.update_doc(id, |d| {
            d.path = abs.to_string_lossy().into_owned();
            d.title = title;
        })
    }

    /// Remove a document from the index and delete its review data.
    pub fn forget(&self, id: &str) -> Result<()> {
        update_json::<IndexFile, _, _>(&self.index_path(), |idx| {
            idx.docs.retain(|d| d.id != id);
            Ok(())
        })?;
        let dir = self.doc_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    // ---- threads ---------------------------------------------------------

    pub fn read_threads(&self, id: &str) -> Result<ThreadsFile> {
        Ok(read_json(&self.threads_path(id))?.unwrap_or_default())
    }

    pub fn write_threads(&self, id: &str, threads: &ThreadsFile) -> Result<()> {
        write_json(&self.threads_path(id), threads)
    }

    pub fn update_threads<R, F: FnOnce(&mut ThreadsFile) -> Result<R>>(
        &self,
        id: &str,
        f: F,
    ) -> Result<R> {
        update_json::<ThreadsFile, _, _>(&self.threads_path(id), |t| {
            t.version = THREADS_VERSION;
            f(t)
        })
    }

    /// Create a thread with a first user message.
    pub fn create_thread(&self, id: &str, selector: Selector, body: &str) -> Result<Thread> {
        let ts = now();
        self.update_threads(id, |t| {
            let tid = next_thread_id(t.threads.iter().map(|x| x.id.as_str()));
            let thread = Thread {
                id: tid,
                status: ThreadStatus::Open,
                selector,
                created_at: ts.clone(),
                messages: vec![Message {
                    author: Author::User,
                    at: ts.clone(),
                    body: body.to_string(),
                }],
                done: false,
                working: false,
                working_since: None,
                read_count: None,
            };
            t.threads.push(thread.clone());
            Ok(thread)
        })
    }

    /// Append a message to a thread. `status` optionally changes the status.
    pub fn add_message(
        &self,
        id: &str,
        thread_id: &str,
        author: Author,
        body: &str,
        status: Option<ThreadStatus>,
    ) -> Result<Thread> {
        let ts = now();
        self.update_threads(id, |t| {
            let th = t
                .threads
                .iter_mut()
                .find(|x| x.id == thread_id)
                .ok_or_else(|| SidenoteError::ThreadNotFound(thread_id.to_string()))?;
            if !body.trim().is_empty() {
                th.messages.push(Message {
                    author,
                    at: ts.clone(),
                    body: body.to_string(),
                });
            }
            if let Some(s) = status {
                th.status = s;
            }
            Ok(th.clone())
        })
    }

    pub fn set_status(&self, id: &str, thread_id: &str, status: ThreadStatus) -> Result<Thread> {
        self.update_threads(id, |t| {
            let th = t
                .threads
                .iter_mut()
                .find(|x| x.id == thread_id)
                .ok_or_else(|| SidenoteError::ThreadNotFound(thread_id.to_string()))?;
            th.status = status;
            Ok(th.clone())
        })
    }

    pub fn set_selector(&self, id: &str, thread_id: &str, selector: Selector) -> Result<Thread> {
        self.update_threads(id, |t| {
            let th = t
                .threads
                .iter_mut()
                .find(|x| x.id == thread_id)
                .ok_or_else(|| SidenoteError::ThreadNotFound(thread_id.to_string()))?;
            th.selector = selector;
            if th.status == ThreadStatus::Orphaned {
                th.status = ThreadStatus::Open;
            }
            Ok(th.clone())
        })
    }

    /// Re-anchor every non-resolved thread against `markdown`. Returns
    /// (anchored ids, orphaned ids).
    pub fn reanchor(&self, id: &str, markdown: &str) -> Result<(Vec<String>, Vec<String>)> {
        let text = plain_text(markdown);
        let chars: Vec<char> = text.chars().collect();
        self.update_threads(id, |t| {
            let mut anchored = Vec::new();
            let mut orphaned = Vec::new();
            for th in t.threads.iter_mut() {
                if th.status == ThreadStatus::Resolved {
                    continue;
                }
                match crate::anchor::anchor_chars(&chars, &th.selector) {
                    Some(a) => {
                        th.selector = make_selector_chars(&chars, a.range.start, a.range.end);
                        th.status = ThreadStatus::Open;
                        anchored.push(th.id.clone());
                    }
                    None => {
                        th.status = ThreadStatus::Orphaned;
                        orphaned.push(th.id.clone());
                    }
                }
            }
            Ok((anchored, orphaned))
        })
    }

    // ---- state -----------------------------------------------------------

    pub fn read_state(&self, id: &str) -> Result<StateFile> {
        Ok(read_json(&self.state_path(id))?.unwrap_or_default())
    }

    pub fn write_state(&self, id: &str, state: &StateFile) -> Result<()> {
        write_json(&self.state_path(id), state)
    }

    /// Busy and younger than the stale threshold.
    pub fn is_fresh_busy(state: &StateFile) -> bool {
        state.busy
            && state
                .busy_since
                .as_deref()
                .and_then(age_secs)
                .map(|a| a < STALE_BUSY_SECS)
                .unwrap_or(false)
    }

    /// The app's Unlock button: clear the busy flag and record who lost it.
    pub fn unlock(&self, id: &str) -> Result<StateFile> {
        update_json::<StateFile, _, _>(&self.state_path(id), |s| {
            let was = s.busy_by.clone();
            s.busy = false;
            s.busy_since = None;
            s.busy_by = None;
            s.unlocked_at = Some(now());
            s.unlocked_session = was;
            Ok(s.clone())
        })
    }

    /// Only a document's owner may write to it. Ownership is claimed in one
    /// of two places and nowhere else: `register`, which the user triggers by
    /// connecting a session, and `turn_begin`, which inherits a document whose
    /// owner has gone. Every other write goes through here, so a second
    /// session cannot edit the file or answer a thread behind the owner's
    /// back. A document nobody owns is open to whoever gets there first.
    fn require_owner(&self, doc: &DocEntry, me: &str) -> Result<()> {
        match doc.owner_session.as_deref() {
            Some(owner) if owner != me => Err(SidenoteError::NotOwner {
                owner: owner.to_string(),
                me: me.to_string(),
            }),
            _ => Ok(()),
        }
    }

    fn check_not_unlocked(&self, state: &StateFile, me: &str) -> Result<()> {
        if !state.busy {
            if let (Some(at), Some(sess)) = (&state.unlocked_at, &state.unlocked_session) {
                if sess == me {
                    return Err(SidenoteError::Unlocked { at: at.clone() });
                }
            }
        }
        Ok(())
    }

    // ---- listeners -------------------------------------------------------

    /// Sessions connected to the running app, or empty when no app is alive.
    pub fn connected_sessions(&self) -> Result<Vec<String>> {
        let Some(l) = read_json::<ListenersFile>(&self.listeners_path())? else {
            return Ok(vec![]);
        };
        if !pid_alive(l.pid) {
            return Ok(vec![]);
        }
        Ok(l.sessions)
    }

    pub fn write_listeners(&self, sessions: Vec<String>) -> Result<()> {
        write_json(
            &self.listeners_path(),
            &ListenersFile {
                pid: std::process::id(),
                sessions,
                updated_at: now(),
            },
        )
    }

    /// Mark a thread as read: the user has seen every message it holds now.
    pub fn mark_read(&self, id: &str, thread_id: &str) -> Result<Thread> {
        self.update_threads(id, |tf| {
            let th = tf
                .threads
                .iter_mut()
                .find(|t| t.id == thread_id)
                .ok_or_else(|| SidenoteError::ThreadNotFound(thread_id.to_string()))?;
            th.read_count = Some(th.messages.len());
            Ok(th.clone())
        })
    }

    /// Threads Claude has written in that the user has not opened, per
    /// document, across everything registered. The app badges the Dock with
    /// the total, so a reply on a document you do not have open still reaches
    /// you. Documents whose review data cannot be read are skipped rather
    /// than failing the whole count.
    pub fn unread_counts(&self) -> Result<Vec<(DocEntry, usize)>> {
        let mut out = Vec::new();
        for doc in self.list()? {
            let Ok(tf) = self.read_threads(&doc.id) else {
                continue;
            };
            let n = tf.threads.iter().filter(|t| t.unread()).count();
            if n > 0 {
                out.push((doc, n));
            }
        }
        Ok(out)
    }

    /// Documents owned by `session` that hold threads awaiting a reply, with
    /// those thread ids. The app replays them as `comment` events when the
    /// session connects, so a comment left while nothing was listening is not
    /// lost.
    pub fn pending_for_session(&self, session: &str) -> Result<Vec<(DocEntry, Vec<String>)>> {
        let mut out = Vec::new();
        for doc in self.list()? {
            if doc.owner_session.as_deref() != Some(session) {
                continue;
            }
            let ids: Vec<String> = self
                .read_threads(&doc.id)?
                .threads
                .iter()
                .filter(|t| t.awaits_claude())
                .map(|t| t.id.clone())
                .collect();
            if !ids.is_empty() {
                out.push((doc, ids));
            }
        }
        Ok(out)
    }

    pub fn clear_listeners(&self) -> Result<()> {
        let p = self.listeners_path();
        if p.exists() {
            fs::remove_file(p)?;
        }
        Ok(())
    }

    // ---- turns -----------------------------------------------------------

    /// Start a Claude turn: take ownership when allowed, record the turn
    /// start, then report waiting threads and the user's edits since the
    /// latest snapshot. Does not lock the document; `lock` does that, only
    /// when Claude is about to edit.
    pub fn turn_begin(&self, path: &Path, session: &str, wait: Duration) -> Result<TurnBegin> {
        let doc = self.require_doc(path)?;
        let state = self.read_state(&doc.id)?;
        if Store::is_fresh_busy(&state) && state.busy_by.as_deref() != Some(session) {
            return Err(SidenoteError::Locked {
                by: state.busy_by.clone().unwrap_or_else(|| "unknown".into()),
                since: state.busy_since.clone().unwrap_or_default(),
            });
        }
        let mut took_over_from = None;
        if let Some(owner) = doc.owner_session.as_deref() {
            if owner != session {
                let connected = self.connected_sessions()?;
                if connected.iter().any(|s| s == owner) {
                    return Err(SidenoteError::OwnerConnected {
                        owner: owner.to_string(),
                        me: session.to_string(),
                    });
                }
                took_over_from = Some(owner.to_string());
            }
        }
        let doc = if doc.owner_session.as_deref() != Some(session) {
            self.update_doc(&doc.id, |d| d.owner_session = Some(session.to_string()))?
        } else {
            doc
        };

        update_json::<StateFile, _, _>(&self.state_path(&doc.id), |s| {
            s.turn_started_at = Some(now());
            s.turn_by = Some(session.to_string());
            s.unlocked_at = None;
            s.unlocked_session = None;
            Ok(())
        })?;

        if !wait.is_zero() {
            std::thread::sleep(wait);
        }

        let current = read_to_string(Path::new(&doc.path))?;
        let (snapshot, diff) = self.diff_since_snapshot(&doc.id, &current)?;
        let pending = self.read_suggestions(&doc.id)?.suggestions;

        // Mark what this turn picks up, so the app can show it is in hand.
        let threads = self.update_threads(&doc.id, |tf| {
            let mut served = Vec::new();
            let at = now();
            for t in tf.threads.iter_mut().filter(|t| t.awaits_claude()) {
                t.working = true;
                t.working_since = Some(at.clone());
                served.push(t.clone());
            }
            Ok(served)
        })?;

        Ok(TurnBegin {
            doc,
            took_over_from,
            threads,
            snapshot,
            diff,
            suggesting: state.suggesting,
            pending,
        })
    }

    fn diff_since_snapshot(&self, id: &str, current: &str) -> Result<(Option<String>, String)> {
        let dir = self.doc_dir(id);
        Ok(match snapshots::latest(&dir)? {
            Some(s) => {
                let old = read_to_string(&s.path)?;
                let name = s.name();
                let d = unified_ignore_ws(&old, current, &name, "current");
                (Some(name), d)
            }
            None => (None, String::new()),
        })
    }

    /// Lock the document before editing it. The app flushes its autosave and
    /// turns read-only; after `wait` the latest text and the diff since the
    /// snapshot are returned, so the edit starts from what the user sees.
    pub fn lock(&self, path: &Path, session: &str, wait: Duration) -> Result<TurnBegin> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let state = self.read_state(&doc.id)?;
        if Store::is_fresh_busy(&state) && state.busy_by.as_deref() != Some(session) {
            return Err(SidenoteError::Locked {
                by: state.busy_by.clone().unwrap_or_else(|| "unknown".into()),
                since: state.busy_since.clone().unwrap_or_default(),
            });
        }
        self.check_not_unlocked(&state, session)?;
        update_json::<StateFile, _, _>(&self.state_path(&doc.id), |s| {
            s.busy = true;
            s.busy_since = Some(now());
            s.busy_by = Some(session.to_string());
            if s.turn_started_at.is_none() {
                s.turn_started_at = Some(now());
                s.turn_by = Some(session.to_string());
            }
            Ok(())
        })?;
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let current = read_to_string(Path::new(&doc.path))?;
        let (snapshot, diff) = self.diff_since_snapshot(&doc.id, &current)?;
        let pending = self.read_suggestions(&doc.id)?.suggestions;
        Ok(TurnBegin {
            doc,
            took_over_from: None,
            threads: Vec::new(),
            snapshot,
            diff,
            suggesting: state.suggesting,
            pending,
        })
    }

    /// Append a Claude reply. Replies never change the status: resolving is
    /// the user's decision, made in the app.
    pub fn reply(
        &self,
        path: &Path,
        session: &str,
        thread_id: &str,
        body: &str,
        done: bool,
    ) -> Result<Thread> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let state = self.read_state(&doc.id)?;
        self.check_not_unlocked(&state, session)?;
        let ts = now();
        self.update_threads(&doc.id, |t| {
            let th = t
                .threads
                .iter_mut()
                .find(|x| x.id == thread_id)
                .ok_or_else(|| SidenoteError::ThreadNotFound(thread_id.to_string()))?;
            if !body.trim().is_empty() {
                th.messages.push(Message {
                    author: Author::Claude,
                    at: ts.clone(),
                    body: body.to_string(),
                });
            }
            if done {
                th.done = true;
            }
            th.working = false;
            th.working_since = None;
            Ok(th.clone())
        })
    }

    /// Mark threads as in a session's hands: the 👀 the app shows until a
    /// reply (or `turn end`) clears it. Unknown ids are skipped; the count of
    /// threads marked is returned.
    ///
    /// Deliberately not owner-guarded. The app calls this itself the instant a
    /// frame reaches a session's socket, which is what makes the eye appear
    /// without waiting on a model turn, and it marks nothing but a UI state.
    pub fn ack(&self, path: &Path, thread_ids: &[String]) -> Result<usize> {
        let doc = self.require_doc(path)?;
        self.update_threads(&doc.id, |tf| {
            let mut n = 0;
            for th in tf.threads.iter_mut() {
                if thread_ids.iter().any(|id| id == &th.id) && th.status != ThreadStatus::Resolved {
                    th.working = true;
                    th.working_since = Some(now());
                    n += 1;
                }
            }
            Ok(n)
        })
    }

    /// A Claude-initiated thread on `exact`: for a change made outside any
    /// comment, or a question on a passage. The thread starts with a Claude
    /// message, so it does not await Claude.
    pub fn note(&self, path: &Path, session: &str, exact: &str, body: &str) -> Result<Thread> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let state = self.read_state(&doc.id)?;
        self.check_not_unlocked(&state, session)?;
        let current = read_to_string(Path::new(&doc.path))?;
        let text = plain_text(&current);
        let chars: Vec<char> = text.chars().collect();
        let probe = Selector {
            exact: exact.to_string(),
            ..Default::default()
        };
        let a = crate::anchor::anchor_chars(&chars, &probe)
            .ok_or_else(|| SidenoteError::Other(format!("text not found in the document: {exact:?}")))?;
        let selector = make_selector_chars(&chars, a.range.start, a.range.end);
        let ts = now();
        self.update_threads(&doc.id, |t| {
            let tid = next_thread_id(t.threads.iter().map(|x| x.id.as_str()));
            let thread = Thread {
                id: tid,
                status: ThreadStatus::Open,
                selector,
                created_at: ts.clone(),
                messages: vec![Message {
                    author: Author::Claude,
                    at: ts.clone(),
                    body: body.to_string(),
                }],
                done: false,
                working: false,
                working_since: None,
                read_count: None,
            };
            t.threads.push(thread.clone());
            Ok(thread)
        })
    }

    /// Content of one snapshot.
    pub fn read_snapshot(&self, id: &str, name: &str) -> Result<String> {
        let snap = self
            .snapshots(id)?
            .into_iter()
            .find(|s| s.name() == name)
            .ok_or_else(|| SidenoteError::Other(format!("no snapshot {name}")))?;
        read_to_string(&snap.path)
    }

    /// Replace the document with a snapshot. The current text is snapshotted
    /// first, so the restore is itself undoable.
    pub fn restore_snapshot(&self, id: &str, name: &str) -> Result<snapshots::Snapshot> {
        let doc = self.doc_by_id(id)?;
        let wanted = self.read_snapshot(id, name)?;
        let current = read_to_string(Path::new(&doc.path))?;
        let dir = self.doc_dir(id);
        let latest_same = snapshots::latest(&dir)?
            .map(|s| read_to_string(&s.path).map(|c| c == current))
            .transpose()?
            .unwrap_or(false);
        if !latest_same {
            snapshots::write_next(&dir, &current)?;
        }
        // Through `write_document`, so a restore refuses while a session holds
        // the lock instead of overwriting whatever it is part-way through.
        self.write_document(Path::new(&doc.path), &wanted)?;
        let (_, _) = self.reanchor(id, &wanted)?;
        snapshots::write_next(&dir, &wanted)
    }

    /// Whitespace-insensitive unified diff between a snapshot and the
    /// current text (or another snapshot when `other` is given).
    pub fn diff_snapshot(&self, id: &str, name: &str, other: Option<&str>) -> Result<String> {
        let doc = self.doc_by_id(id)?;
        let old = self.read_snapshot(id, name)?;
        let (new, new_name) = match other {
            Some(o) => (self.read_snapshot(id, o)?, o.to_string()),
            None => (read_to_string(Path::new(&doc.path))?, "current".to_string()),
        };
        Ok(unified_ignore_ws(&old, &new, name, &new_name))
    }

    /// Point a thread at `exact` in the current text of the document, for
    /// use after Claude rewrites the anchored passage. Errors when the text
    /// is not found.
    pub fn anchor_thread(&self, path: &Path, session: &str, thread_id: &str, exact: &str) -> Result<Thread> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let current = read_to_string(Path::new(&doc.path))?;
        let text = plain_text(&current);
        let chars: Vec<char> = text.chars().collect();
        let sel = Selector {
            exact: exact.to_string(),
            ..Default::default()
        };
        let a = crate::anchor::anchor_chars(&chars, &sel)
            .ok_or_else(|| SidenoteError::Other(format!("text not found in the document: {exact:?}")))?;
        let selector = make_selector_chars(&chars, a.range.start, a.range.end);
        self.set_selector(&doc.id, thread_id, selector)
    }

    /// The checks every `apply` makes before it touches anything: this
    /// session owns the document, Unlock has not taken it back, and no other
    /// session holds a fresh lock. Returns the document and whether this
    /// session already holds the lock itself.
    pub fn apply_precheck(&self, path: &Path, session: &str) -> Result<(DocEntry, bool)> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let state = self.read_state(&doc.id)?;
        self.check_not_unlocked(&state, session)?;
        let kept_lock = state.busy && state.busy_by.as_deref() == Some(session);
        if Store::is_fresh_busy(&state) && !kept_lock {
            return Err(SidenoteError::Locked {
                by: state.busy_by.clone().unwrap_or_else(|| "unknown".into()),
                since: state.busy_since.clone().unwrap_or_default(),
            });
        }
        Ok((doc, kept_lock))
    }

    /// Replace `old` with `new` in the file on disk. The path `apply` takes
    /// when the app is not routing the edit into its editor (the e2e script,
    /// `SIDENOTE_APPLY_FILE=1`). Takes the lock so the app flushes its
    /// autosave first, and releases it again unless this session held it.
    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        &self,
        path: &Path,
        session: &str,
        old: &str,
        new: &str,
        thread_id: Option<&str>,
        reply: Option<&str>,
        done: bool,
        wait: Duration,
    ) -> Result<Applied> {
        if old.is_empty() {
            return Err(SidenoteError::Other("--old is empty".into()));
        }
        let (doc, kept_lock) = self.apply_precheck(path, session)?;

        // Suggestions are the app's business: it matches against the text it
        // is showing, and accepting one has to go back through its editor.
        // Refusing here rather than writing anyway keeps the one guarantee the
        // mode makes — that nothing lands without the user — true on the path
        // that has no app in it.
        if self.read_state(&doc.id)?.suggesting {
            return Err(SidenoteError::Other(format!(
                "{} is in suggesting mode; edits have to go through the app so the user can accept them",
                doc.path
            )));
        }

        // Take the lock so the app flushes its autosave, then read what the
        // user actually has. Released again below unless it was already held.
        if !kept_lock {
            update_json::<StateFile, _, _>(&self.state_path(&doc.id), |st| {
                st.busy = true;
                st.busy_since = Some(now());
                st.busy_by = Some(session.to_string());
                if st.turn_started_at.is_none() {
                    st.turn_started_at = Some(now());
                    st.turn_by = Some(session.to_string());
                }
                Ok(())
            })?;
            if !wait.is_zero() {
                std::thread::sleep(wait);
            }
        }

        let release = |store: &Store| -> Result<()> {
            if kept_lock {
                return Ok(());
            }
            update_json::<StateFile, _, _>(&store.state_path(&doc.id), |st| {
                st.busy = false;
                st.busy_since = None;
                st.busy_by = None;
                Ok(())
            })?;
            Ok(())
        };

        let file = Path::new(&doc.path);

        let written = self.replace_once(&doc.id, file, old, new);
        if let Err(e) = written {
            release(self)?;
            return Err(e);
        }

        let result = self.finish_apply(&doc, session, &plain_text(new), thread_id, reply, done);
        release(self)?;
        let mut applied = result?;
        applied.kept_lock = kept_lock;
        Ok(applied)
    }

    /// The second half of an `apply`, once the edit has landed: record where
    /// it went for the app to flash, re-point the thread at the new text and
    /// leave the reply. `landed` is the plain text now in the document where
    /// the replacement went (empty for a deletion). Used by both the file
    /// path above and the CLI when the app applied the edit in its editor.
    pub fn finish_apply(
        &self,
        doc: &DocEntry,
        session: &str,
        landed: &str,
        thread_id: Option<&str>,
        reply: Option<&str>,
        done: bool,
    ) -> Result<Applied> {
        let file = Path::new(&doc.path);

        // Where the change landed, for the app to show. An empty one (a
        // deletion) leaves the focus on nothing.
        let focus_exact = focus_text(landed);
        update_json::<StateFile, _, _>(&self.state_path(&doc.id), |st| {
            st.focus = focus_exact.as_ref().map(|e| Focus {
                exact: e.clone(),
                session: session.to_string(),
                at: now(),
                thread: thread_id.map(|t| t.to_string()),
            });
            Ok(())
        })?;

        // Re-point the thread at the new text so `turn end` cannot orphan it.
        let mut orphaned = false;
        let mut thread = None;
        if let Some(id) = thread_id {
            match focus_exact.as_deref() {
                Some(e) => match self.anchor_thread(file, session, id, e) {
                    Ok(t) => thread = Some(t),
                    Err(_) => orphaned = true,
                },
                None => orphaned = true,
            }
            if let Some(body) = reply {
                thread = Some(self.reply(file, session, id, body, done)?);
            }
        }

        Ok(Applied {
            doc: doc.clone(),
            exact: focus_exact.unwrap_or_default(),
            thread,
            orphaned,
            kept_lock: false,
            suggestion: None,
        })
    }

    /// Read, check and write as one step, under the same lock the app's
    /// autosave takes. The exactly-once check on `old` is the safety property
    /// of `apply`, and without the lock it guarded nothing: an autosave
    /// landing between the read and the write was rewritten away, because the
    /// write puts back the whole file as it looked at the read.
    fn replace_once(&self, id: &str, file: &Path, old: &str, new: &str) -> Result<()> {
        let _guard = self.document_lock(id)?;
        let current = read_to_string(file)?;
        let hits = current.matches(old).count();
        if hits != 1 {
            return Err(SidenoteError::Stale {
                found: hits,
                exact: old.chars().take(60).collect(),
            });
        }
        atomic_write(file, current.replacen(old, new, 1).as_bytes())
    }

    // ---- suggestions -----------------------------------------------------

    pub fn suggestions_path(&self, id: &str) -> PathBuf {
        self.doc_dir(id).join("suggestions.json")
    }

    pub fn read_suggestions(&self, id: &str) -> Result<SuggestionsFile> {
        Ok(read_json(&self.suggestions_path(id))?.unwrap_or_default())
    }

    pub fn update_suggestions<R, F: FnOnce(&mut SuggestionsFile) -> Result<R>>(
        &self,
        id: &str,
        f: F,
    ) -> Result<R> {
        update_json::<SuggestionsFile, _, _>(&self.suggestions_path(id), |s| {
            s.version = crate::suggest::SUGGESTIONS_VERSION;
            f(s)
        })
    }

    /// Turn suggesting mode on or off. The user's switch, not a session's:
    /// whoever is reviewing decides whether edits land or wait.
    ///
    /// Turning it off leaves any pending suggestions alone. They stay in the
    /// margin to be accepted or rejected, because throwing away work the user
    /// has not looked at is not what flipping a switch should mean.
    pub fn set_suggesting(&self, id: &str, on: bool) -> Result<StateFile> {
        update_json::<StateFile, _, _>(&self.state_path(id), |s| {
            s.suggesting = on;
            Ok(s.clone())
        })
    }

    /// Record an edit the app has decided not to make yet.
    ///
    /// `old` is the plain text the app matched in its editor, not the markdown
    /// Claude sent — the same form `apply` sends over the socket, and the form
    /// the app searches for again to draw the suggestion and to judge whether
    /// it still fits. `new` stays markdown, because that is what accepting
    /// eventually parses and inserts.
    ///
    /// The app has already checked that `old` occurs exactly once. It is the
    /// only place that check can be made honestly: the file on disk trails the
    /// editor by an autosave, and the user's unsaved sentence is exactly the
    /// one this is about.
    pub fn record_suggestion(
        &self,
        id: &str,
        session: &str,
        old: &str,
        new: &str,
        thread_id: Option<&str>,
    ) -> Result<Suggestion> {
        self.update_suggestions(id, |sf| {
            let s = Suggestion {
                id: sf.take_id(),
                old: old.to_string(),
                new: new.to_string(),
                thread: thread_id.map(|t| t.to_string()),
                session: session.to_string(),
                at: now(),
            };
            sf.suggestions.push(s.clone());
            Ok(s)
        })
    }

    /// The part of a suggested turn that is not the suggestion: leave the
    /// reply, so the card can say why the change is being proposed.
    ///
    /// `done` is deliberately not taken. The check mark means the file was
    /// changed for that comment, and nothing has been changed yet; it is the
    /// user's accept that earns it.
    pub fn finish_suggestion(
        &self,
        doc: &DocEntry,
        session: &str,
        thread_id: Option<&str>,
        reply: Option<&str>,
    ) -> Result<Option<Thread>> {
        let file = Path::new(&doc.path);
        Ok(match (thread_id, reply) {
            (Some(id), Some(body)) => Some(self.reply(file, session, id, body, false)?),
            (Some(id), None) => self.threads(file, true)?.into_iter().find(|t| t.id == id),
            (None, _) => None,
        })
    }

    fn require_suggestion(&self, id: &str, suggestion_id: &str) -> Result<Suggestion> {
        self.read_suggestions(id)?
            .suggestions
            .into_iter()
            .find(|s| s.id == suggestion_id)
            .ok_or_else(|| SidenoteError::Other(format!("no suggestion {suggestion_id}")))
    }

    /// Accept a suggestion the app's editor has already applied. `landed` is
    /// the plain text of what it inserted, which is what the thread re-anchors
    /// to — the editor's serialisation, not the markdown Claude sent, because
    /// that is what the document now holds.
    pub fn accept_suggestion_applied(
        &self,
        id: &str,
        suggestion_id: &str,
        landed: &str,
    ) -> Result<Accepted> {
        let doc = self.doc_by_id(id)?;
        let sug = self.require_suggestion(id, suggestion_id)?;
        self.finish_accept(id, doc, sug, landed)
    }

    /// The half of an accept that is not the edit: forget the suggestion, and
    /// re-point its thread at the new text so the next `turn end` cannot
    /// orphan it.
    ///
    /// Not session-scoped. Accepting is the user's act, and the session that
    /// proposed it may be long gone; making the re-anchor depend on ownership
    /// would silently orphan the thread whenever it was.
    fn finish_accept(
        &self,
        id: &str,
        doc: DocEntry,
        sug: Suggestion,
        landed: &str,
    ) -> Result<Accepted> {
        self.remove_suggestion(id, &sug.id)?;
        let mut orphaned = false;
        let mut thread = None;
        if let Some(tid) = sug.thread.as_deref() {
            match focus_text(landed) {
                Some(exact) => match self.anchor_here(id, Path::new(&doc.path), tid, &exact) {
                    Ok(t) => thread = Some(t),
                    Err(_) => orphaned = true,
                },
                None => orphaned = true,
            }
        }
        Ok(Accepted {
            doc,
            suggestion: sug,
            thread,
            orphaned,
        })
    }

    /// Reject a suggestion: drop it, change nothing. The thread keeps
    /// Claude's reply, so what was proposed and turned down is still readable.
    pub fn reject_suggestion(&self, id: &str, suggestion_id: &str) -> Result<Suggestion> {
        let sug = self.require_suggestion(id, suggestion_id)?;
        self.remove_suggestion(id, suggestion_id)?;
        Ok(sug)
    }

    fn remove_suggestion(&self, id: &str, suggestion_id: &str) -> Result<()> {
        self.update_suggestions(id, |sf| {
            sf.suggestions.retain(|s| s.id != suggestion_id);
            Ok(())
        })
    }

    /// Re-anchor without an ownership check, for the user's own acts. The
    /// session-scoped `anchor_thread` is the same thing plus `require_owner`.
    fn anchor_here(&self, id: &str, file: &Path, thread_id: &str, exact: &str) -> Result<Thread> {
        let current = read_to_string(file)?;
        let text = plain_text(&current);
        let chars: Vec<char> = text.chars().collect();
        let sel = Selector {
            exact: exact.to_string(),
            ..Default::default()
        };
        let a = crate::anchor::anchor_chars(&chars, &sel)
            .ok_or_else(|| SidenoteError::Other(format!("text not found in the document: {exact:?}")))?;
        let selector = make_selector_chars(&chars, a.range.start, a.range.end);
        self.set_selector(id, thread_id, selector)
    }

    /// End a Claude turn: re-anchor, snapshot when the text changed, prune,
    /// clear the lock and the turn marker.
    pub fn turn_end(&self, path: &Path, session: &str) -> Result<TurnEnd> {
        let doc = self.require_doc(path)?;
        self.require_owner(&doc, session)?;
        let state = self.read_state(&doc.id)?;
        self.check_not_unlocked(&state, session)?;
        let turn_started = state.turn_started_at.clone().or(state.busy_since.clone());

        let current = read_to_string(Path::new(&doc.path))?;
        let (anchored, orphaned) = self.reanchor(&doc.id, &current)?;
        let dir = self.doc_dir(&doc.id);
        let unchanged = match snapshots::latest(&dir)? {
            Some(s) => read_to_string(&s.path)? == current,
            None => false,
        };
        let snap_name = if unchanged {
            snapshots::latest(&dir)?.map(|s| s.name()).unwrap_or_default()
        } else {
            snapshots::write_next(&dir, &current)?.name()
        };

        let threads = self.read_threads(&doc.id)?.threads;
        let open = threads
            .iter()
            .filter(|t| t.status != ThreadStatus::Resolved)
            .count();
        let resolved = threads.len() - open;
        let new_user_messages = match turn_started.as_deref().and_then(crate::util::parse_time) {
            Some(start) => threads.iter().any(|t| {
                t.status != ThreadStatus::Resolved
                    && t.messages.iter().any(|m| {
                        m.author == Author::User
                            && crate::util::parse_time(&m.at)
                                .map(|at| at >= start)
                                .unwrap_or(false)
                    })
                    && t.last_author() == Some(Author::User)
            }),
            None => threads.iter().any(|t| t.awaits_claude()),
        };

        // Clearing the state and noticing an Unlock have to be the same step.
        // A blind `write_state(default)` erased an Unlock that landed after
        // the check at the top of this function, so the session it was meant
        // to stop was never told, and carried on into the next turn. Read and
        // clear under the lock instead, and report what was there.
        //
        // The state is cleared either way. The turn is over, and leaving a
        // busy flag behind to make a point would lock the user out for five
        // minutes.
        let unlocked_by_me = update_json::<StateFile, _, _>(&self.state_path(&doc.id), |s| {
            let hit = match (&s.unlocked_at, &s.unlocked_session) {
                (Some(at), Some(sess)) if sess == session && !s.busy => Some(at.clone()),
                _ => None,
            };
            *s = StateFile::default();
            Ok(hit)
        })?;
        // Nothing is in hand once the turn is over.
        self.update_threads(&doc.id, |tf| {
            for t in tf.threads.iter_mut() {
                t.working = false;
                t.working_since = None;
            }
            Ok(())
        })?;

        if let Some(at) = unlocked_by_me {
            return Err(SidenoteError::Unlocked { at });
        }

        // Refresh the title in case the heading changed.
        let title = title_of(&current, Path::new(&doc.path));
        let doc = self.update_doc(&doc.id, |d| d.title = title)?;

        Ok(TurnEnd {
            doc,
            snapshot: snap_name,
            anchored,
            orphaned,
            open,
            resolved,
            new_user_messages,
        })
    }

    pub fn threads(&self, path: &Path, all: bool) -> Result<Vec<Thread>> {
        let doc = self.require_doc(path)?;
        let t = self.read_threads(&doc.id)?.threads;
        Ok(if all {
            t
        } else {
            t.into_iter()
                .filter(|t| t.status != ThreadStatus::Resolved)
                .collect()
        })
    }

    pub fn snapshots(&self, id: &str) -> Result<Vec<snapshots::Snapshot>> {
        snapshots::list(&self.doc_dir(id))
    }
}

/// The Claude Code skill, embedded so the app and the CLI can install it.
pub const SKILL_MD: &str = include_str!("../../skill/sidenote-review/SKILL.md");
pub const SKILL_NAME: &str = "sidenote-review";

fn skill_version(text: &str) -> u32 {
    text.lines()
        .take(12)
        .find_map(|l| {
            l.trim()
                .strip_prefix("<!-- sidenote-skill-version:")
                .and_then(|r| r.trim().strip_suffix("-->"))
                .and_then(|n| n.trim().parse().ok())
        })
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillInstall {
    Installed,
    Updated,
    Current,
    /// A newer or hand-edited copy exists; left untouched.
    Kept,
}

/// Write the embedded skill to `~/.claude/skills/sidenote-review/SKILL.md`.
/// `force` overwrites whatever is there.
pub fn install_skill(force: bool) -> Result<(PathBuf, SkillInstall)> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| SidenoteError::Other("HOME is not set".into()))?;
    let dir = home.join(".claude").join("skills").join(SKILL_NAME);
    let path = dir.join("SKILL.md");
    let existing = fs::read_to_string(&path).ok();
    let outcome = match &existing {
        None => SkillInstall::Installed,
        Some(e) if e == SKILL_MD => return Ok((path, SkillInstall::Current)),
        Some(e) if force || skill_version(e) < skill_version(SKILL_MD) => SkillInstall::Updated,
        Some(_) => return Ok((path, SkillInstall::Kept)),
    };
    fs::create_dir_all(&dir)?;
    crate::fsutil::atomic_write(&path, SKILL_MD.as_bytes())?;
    Ok((path, outcome))
}

/// Absolute, canonicalised when possible (resolves symlinks such as /tmp).
/// The phrase the app anchors the focus marker to: the first non-empty line
/// of the replacement, capped so a whole rewritten section does not become
/// one enormous selector. `None` for a deletion, which has nothing to point
/// at.
fn focus_text(plain: &str) -> Option<String> {
    const MAX: usize = 240;
    let line = plain.lines().map(str::trim).find(|l| !l.is_empty())?;
    let out: String = line.chars().take(MAX).collect();
    Some(out)
}

pub fn absolute(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}
