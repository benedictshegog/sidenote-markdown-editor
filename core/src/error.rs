use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, SidenoteError>;

/// Exit codes used by the CLI. The skill branches on these.
pub mod exit {
    pub const OK: i32 = 0;
    pub const ERROR: i32 = 1;
    pub const NOT_REGISTERED: i32 = 2;
    pub const LOCKED: i32 = 3;
    pub const NEW_MESSAGES: i32 = 4;
    pub const UNLOCKED: i32 = 5;
    /// `apply` found the text to replace missing or ambiguous: the document
    /// moved under the edit.
    pub const STALE: i32 = 6;
    /// `apply` needs the document open in the app, and it is not.
    pub const NOT_OPEN: i32 = 7;
}

#[derive(Debug, Error)]
pub enum SidenoteError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON in {0}: {1}")]
    Json(String, serde_json::Error),
    #[error("file not found: {0}")]
    FileNotFound(PathBuf),
    #[error("document is not registered: {0}\nrun `sidenote register <file.md>` first")]
    NotRegistered(PathBuf),
    #[error("document {0} is not in the index")]
    UnknownDoc(String),
    #[error("thread not found: {0}")]
    ThreadNotFound(String),
    #[error("document is busy: session {by} holds the lock since {since}")]
    Locked { by: String, since: String },
    #[error("document is owned by session {owner}, which is connected; this session is {me}")]
    OwnerConnected { owner: String, me: String },
    #[error("document is owned by session {owner}, not this one ({me})\nonly its owner may write to it; `sidenote turn begin` takes it over, and succeeds only when {owner} is gone")]
    NotOwner { owner: String, me: String },
    #[error("the lock held by this session was cleared by Unlock at {at}; the user owns the document again")]
    Unlocked { at: String },
    #[error("the text to replace occurs {found} times, not once: {exact:?}\nre-read the document; the user may have changed it")]
    Stale { found: usize, exact: String },
    #[error("{0}\nopen the document in Sidenote (`sidenote open <file.md>`) and retry")]
    NotOpen(String),
    #[error("{0}")]
    Other(String),
}

impl SidenoteError {
    pub fn exit_code(&self) -> i32 {
        match self {
            SidenoteError::NotRegistered(_) | SidenoteError::UnknownDoc(_) => exit::NOT_REGISTERED,
            SidenoteError::Locked { .. }
            | SidenoteError::OwnerConnected { .. }
            | SidenoteError::NotOwner { .. } => exit::LOCKED,
            SidenoteError::Unlocked { .. } => exit::UNLOCKED,
            SidenoteError::Stale { .. } => exit::STALE,
            SidenoteError::NotOpen(_) => exit::NOT_OPEN,
            _ => exit::ERROR,
        }
    }
}
