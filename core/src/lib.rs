//! Sidenote core: data model, storage, snapshots and selector re-anchoring.
//! Shared by the `sidenote` CLI and the Tauri app.

pub mod anchor;
pub mod diff;
pub mod error;
pub mod fsutil;
pub mod model;
pub mod plain;
pub mod snapshots;
pub mod store;
pub mod suggest;
pub mod util;

pub use anchor::{anchor, make_selector, Anchored, Method, Range};

/// The port a release app listens on and a release CLI dials.
pub const DEFAULT_PORT: u16 = 47293;

/// The port this build of the app and the CLI meet on.
///
/// `SIDENOTE_PORT` in the environment wins. Otherwise a debug build takes the
/// port above the release one, so `pnpm dev:app` can run beside the installed
/// Sidenote: each app binds its own port, each CLI dials the one it was built
/// with, and the two never answer each other's requests. The listeners file is
/// split the same way, in `Store::listeners_path`.
pub fn app_port() -> u16 {
    if let Some(p) = std::env::var("SIDENOTE_PORT").ok().and_then(|v| v.parse().ok()) {
        return p;
    }
    if cfg!(debug_assertions) {
        DEFAULT_PORT + 1
    } else {
        DEFAULT_PORT
    }
}
pub use error::{exit, Result, SidenoteError};
pub use model::*;
pub use plain::plain_text;
pub use suggest::{Seg, SegKind, Suggestion, SuggestionsFile};
pub use store::{install_skill, Accepted, Applied, SkillInstall, Store, TurnBegin, TurnEnd, SKILL_MD, SKILL_NAME};
