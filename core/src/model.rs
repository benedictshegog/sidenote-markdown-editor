//! On-disk data model. Every struct here maps one-to-one to a JSON file
//! under `~/.sidenote/`.

use serde::{Deserialize, Serialize};

pub const INDEX_VERSION: u32 = 1;
pub const THREADS_VERSION: u32 = 1;
pub const CONTEXT_CHARS: usize = 32;
pub const SNAPSHOT_KEEP: usize = 50;
pub const STALE_BUSY_SECS: i64 = 5 * 60;

/// `~/.sidenote/index.json`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexFile {
    pub version: u32,
    #[serde(default)]
    pub docs: Vec<DocEntry>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            docs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocEntry {
    pub id: String,
    /// Absolute path of the markdown file.
    pub path: String,
    pub title: String,
    pub registered_at: String,
    pub last_opened: String,
    /// `CLAUDE_CODE_SESSION_ID` of the session that owns the document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_session: Option<String>,
}

/// `~/.sidenote/docs/<id>/threads.json`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadsFile {
    pub version: u32,
    #[serde(default)]
    pub threads: Vec<Thread>,
}

impl Default for ThreadsFile {
    fn default() -> Self {
        Self {
            version: THREADS_VERSION,
            threads: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Open,
    Resolved,
    Orphaned,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Author {
    User,
    Claude,
}

/// W3C Web Annotation text quote selector, plus an optional position hint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Selector {
    pub exact: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    /// Character offset of `exact` in the plain text when the selector was
    /// last computed. A hint for fuzzy matching, never authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub author: Author,
    pub at: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Thread {
    pub id: String,
    pub status: ThreadStatus,
    pub selector: Selector,
    pub created_at: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// Claude made the requested change (shown as a check mark). Never set
    /// for reply-only answers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    /// A session has picked this thread up (`turn begin` listed it) and has
    /// not replied yet. Shown as 👀 on the card; cleared by the reply or by
    /// `turn end`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub working: bool,
    /// When `working` was last set. A turn picks every waiting thread up at
    /// once, so this is what separates the passage Claude is on now from the
    /// ones it has merely taken: the newest stamp is the live one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_since: Option<String>,
    /// How many messages the thread held when the user last opened it.
    /// Claude's replies only render on an expanded card, so expanding one is
    /// the moment they can have read it.
    ///
    /// A count, not a timestamp: timestamps here are whole seconds, so a
    /// reply landing in the same second as the read would compare equal and
    /// be missed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_count: Option<usize>,
}

impl Thread {
    pub fn last_author(&self) -> Option<Author> {
        self.messages.last().map(|m| m.author)
    }

    /// True when the thread needs a reply from Claude.
    pub fn awaits_claude(&self) -> bool {
        self.status != ThreadStatus::Resolved && self.last_author() == Some(Author::User)
    }

    /// True when Claude has written something here the user has not opened.
    /// A resolved thread is never unread: resolving it is the user's own act,
    /// and it can only follow reading.
    pub fn unread(&self) -> bool {
        if self.status == ThreadStatus::Resolved {
            return false;
        }
        let Some(last) = self.messages.last() else {
            return false;
        };
        if last.author != Author::Claude {
            return false;
        }
        self.messages.len() > self.read_count.unwrap_or(0)
    }
}

/// `~/.sidenote/docs/<id>/state.json`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct StateFile {
    /// Set by `sidenote lock` while Claude edits the file; the app is read-only.
    pub busy: bool,
    #[serde(default)]
    pub busy_since: Option<String>,
    #[serde(default)]
    pub busy_by: Option<String>,
    /// Set by `turn begin`, cleared by `turn end`. Used to detect comments
    /// that arrive during a turn (exit 4). Does not lock anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_by: Option<String>,
    /// Set by the app's Unlock button. Cleared by the next `turn begin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlocked_at: Option<String>,
    /// The session whose lock was cleared by Unlock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlocked_session: Option<String>,
    /// The passage Claude last wrote, so the app can show where it is
    /// working. Advisory only: it locks nothing, and the app ignores it when
    /// the owning session is not connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<Focus>,
    /// Suggesting mode. While it is on, `apply` records the edit as a pending
    /// suggestion instead of writing it, and the user accepts or rejects it in
    /// the app. Set by the user, read by every session; per document, because
    /// it is a property of how this document is being reviewed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub suggesting: bool,
}

/// Where a session last changed the text. Set by `sidenote apply`, cleared
/// by `turn end`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Focus {
    /// Exact text now in the document, for the app to anchor against.
    pub exact: String,
    pub session: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
}

/// `~/.sidenote/listeners.json`, written by the app. Lists the Claude Code
/// sessions currently connected to the WebSocket server. Valid only while
/// `pid` is alive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ListenersFile {
    pub pid: u32,
    #[serde(default)]
    pub sessions: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
}
