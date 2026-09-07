# One build cache for every checkout and worktree of this repo. Source it;
# do not run it.
#
# Cargo puts compiled crates under the checkout's own target/, so each
# worktree starts cold and rebuilds all ~400 dependency crates. Pointing every
# checkout at one directory means a new worktree only compiles the Sidenote
# crates. sccache, when installed (`brew install sccache`), also caches the
# compiled dependencies by content, which covers the cases the shared
# directory does not: a cargo update, or a rustc upgrade.
#
# Both are overridable from the environment. Set CARGO_TARGET_DIR to a
# checkout-local path to get the old behaviour back.

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/sidenote/target}"
if [ -z "${RUSTC_WRAPPER:-}" ] && command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache
fi
