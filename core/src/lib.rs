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
pub use error::{exit, Result, SidenoteError};
pub use model::*;
pub use plain::plain_text;
pub use suggest::{Seg, SegKind, Suggestion, SuggestionsFile};
pub use store::{install_skill, Accepted, Applied, SkillInstall, Store, TurnBegin, TurnEnd, SKILL_MD, SKILL_NAME};
