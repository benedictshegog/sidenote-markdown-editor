#!/bin/bash
# Cut a Sidenote release: bump, build, publish the .dmg, update the cask.
#
# The .dmg is not hosted on GitHub Releases — it goes to the
# public site repo and Homebrew points at that. The cask is only updated after
# the served bytes are confirmed to match the local build, because a cask whose
# sha256 does not match what the URL returns breaks every install.
#
# It finishes by upgrading the local install, so this machine runs what was
# just published.
#
#   scripts/release.sh 0.1.6          prompts before anything is pushed
#   scripts/release.sh 0.1.6 --yes    no prompt, for a re-run you already vetted
#
# Override the sibling checkouts if yours live elsewhere:
#   SIDENOTE_SITE_REPO=... SIDENOTE_TAP_REPO=... scripts/release.sh 0.1.6

set -euo pipefail

VERSION="${1:-}"
ASSUME_YES=""

SITE_REPO="${SIDENOTE_SITE_REPO:-$HOME/Projects/Current/2023-04 Personal Site}"
TAP_REPO="${SIDENOTE_TAP_REPO:-$HOME/Projects/Current/2026-08 Sidenote Tap}"
DOWNLOAD_BASE="https://benedictshegog.xyz/downloads"
CASK="Casks/sidenote.rb"

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
. scripts/cargo-env.sh

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

# Parsed here rather than beside the assignment so a typo is an error instead
# of a silently ignored prompt.
case "${2:-}" in
  --yes|-y) ASSUME_YES=1 ;;
  "")       ;;
  *)        die "unknown option: $2" ;;
esac

# ---- preflight ------------------------------------------------------------
# Everything here is cheap and reversible. Anything that pushes comes later,
# after the confirmation gate.

[ -n "$VERSION" ] || die "usage: scripts/release.sh X.Y.Z [--yes]"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version must look like 0.1.6, got '$VERSION'"

DMG_NAME="Sidenote_${VERSION}_aarch64.dmg"
DMG_PATH="$CARGO_TARGET_DIR/release/bundle/dmg/$DMG_NAME"
DMG_URL="$DOWNLOAD_BASE/$DMG_NAME"

say "Preflight"

[ -d "$SITE_REPO" ] || die "site repo not found: $SITE_REPO"
[ -d "$TAP_REPO/Casks" ] || die "tap repo not found: $TAP_REPO"

CURRENT="$(grep -m1 '^version = ' Cargo.toml | sed 's/.*"\(.*\)".*/\1/')"
[ "$CURRENT" != "$VERSION" ] || die "Cargo.toml is already at $VERSION"
info "version: $CURRENT -> $VERSION"

for repo in "$REPO_ROOT" "$SITE_REPO" "$TAP_REPO"; do
  branch="$(git -C "$repo" branch --show-current)"
  [ -n "$branch" ] || die "$(basename "$repo") is in a detached HEAD"
  # Untracked files are fine; staged or modified tracked files are not, or the
  # release commit would sweep up unrelated work.
  git -C "$repo" diff --quiet && git -C "$repo" diff --cached --quiet \
    || die "$(basename "$repo") has uncommitted changes to tracked files"
  # Behind origin is just as fatal as dirty, and fails far later: the tap push
  # is rejected after the .dmg is already built, tagged and published, which
  # leaves a release half-done. Catch it here, while nothing has happened yet.
  if git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git -C "$repo" fetch -q || die "cannot reach origin for $(basename "$repo")"
    behind="$(git -C "$repo" rev-list --count 'HEAD..@{u}')"
    [ "$behind" -eq 0 ] \
      || die "$(basename "$repo") is $behind commit(s) behind origin; pull first"
  fi
  info "$(basename "$repo"): $branch, clean, up to date"
done

git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
  && die "tag v$VERSION already exists"

command -v cargo >/dev/null || die "cargo not on PATH"
command -v pnpm  >/dev/null || die "pnpm not on PATH"

if [ -z "$ASSUME_YES" ]; then
  cat <<EOF

This will build $VERSION, then PUSH to three places:
  source  $REPO_ROOT (commit + tag v$VERSION)
  site    $SITE_REPO (adds $DMG_NAME, deploys to Vercel)
  tap     $TAP_REPO (points Homebrew at the new file)

EOF
  read -r -p "Continue? [y/N] " reply
  case "$reply" in [yY]*) ;; *) die "cancelled" ;; esac
fi

# ---- bump -----------------------------------------------------------------

say "Bumping to $VERSION"
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" \
  app/package.json app/src-tauri/tauri.conf.json
sed -i '' "s/^version = \"$CURRENT\"/version = \"$VERSION\"/" Cargo.toml
# Keep the README's download link pointing at a file that exists.
sed -i '' "s|$DOWNLOAD_BASE/Sidenote_${CURRENT}_aarch64.dmg|$DMG_URL|" README.md
cargo update -w --quiet   # rewrites Cargo.lock with the new workspace version
info "app/package.json, tauri.conf.json, Cargo.toml, Cargo.lock, README.md"

# ---- build ----------------------------------------------------------------

say "Building"
# A previously mounted read-write image makes bundle_dmg.sh fail; see
# .claude/PAPERCUTS.md.
hdiutil info | awk '/image-path.*Sidenote/ {found=1} END {exit !found}' \
  && die "a Sidenote disk image is still mounted; run 'hdiutil info' and detach it"
rm -f "$CARGO_TARGET_DIR"/release/bundle/macos/rw.*.dmg

./app/scripts/build-cli.sh release
(cd app && pnpm tauri build)

[ -f "$DMG_PATH" ] || die "expected $DMG_PATH, not produced"
SHA="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
BUILT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$CARGO_TARGET_DIR/release/bundle/macos/Sidenote.app/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || die "bundle says $BUILT, expected $VERSION"
info "$DMG_NAME  $(du -h "$DMG_PATH" | awk '{print $1}')"
info "sha256 $SHA"

# ---- commit and tag the source -------------------------------------------

say "Committing source"
git add app/package.json app/src-tauri/tauri.conf.json Cargo.toml Cargo.lock README.md
git commit -q -m "$VERSION"
git tag -a "v$VERSION" -m "Sidenote $VERSION"
git push -q --follow-tags
info "pushed $(git rev-parse --short HEAD) and tag v$VERSION"

# ---- publish the .dmg -----------------------------------------------------

say "Publishing the .dmg"
mkdir -p "$SITE_REPO/public/downloads"
cp "$DMG_PATH" "$SITE_REPO/public/downloads/$DMG_NAME"
# A few MB over HTTP overruns git's default post buffer and the push 400s.
git -C "$SITE_REPO" config http.postBuffer 524288000
git -C "$SITE_REPO" add "public/downloads/$DMG_NAME"
git -C "$SITE_REPO" commit -q -m "Host the Sidenote $VERSION download"
git -C "$SITE_REPO" push -q
info "pushed; waiting for Vercel"

# ---- verify what the URL actually serves ----------------------------------
# The cask is not touched until this passes. A mismatch here means every
# install would fail the checksum, so it is worth being slow about.

say "Verifying $DMG_URL"
# Cloudflare fronts Vercel, so two requests can hit different cache states.
# Poll on a cache-busting query first: a 404 answered before the deploy lands
# would otherwise be cached against the real URL for hours (max-age=14400).
for attempt in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -L "$DMG_URL?probe=$SHA" || true)"
  [ "$code" = "200" ] && break
  info "probe $attempt: HTTP $code"
  sleep 10
done
[ "$code" = "200" ] || die "still HTTP $code after 5 minutes; the cask was not touched"

# Then check the canonical URL — the one Homebrew will use — and compare the
# bytes actually received, not a status code from a different request. An edge
# still serving the old object just costs another round.
SERVED=""
for attempt in $(seq 1 20); do
  SERVED="$(curl -sL "$DMG_URL" | shasum -a 256 | awk '{print $1}')"
  [ "$SERVED" = "$SHA" ] && break
  info "attempt $attempt: served $SERVED, want $SHA"
  sleep 15
done
[ "$SERVED" = "$SHA" ] \
  || die "served sha256 $SERVED != built $SHA after 5 minutes; the cask was not touched"
info "served bytes match the local build"

# ---- point Homebrew at it -------------------------------------------------

say "Updating the cask"
sed -i '' "s/^  version \".*\"/  version \"$VERSION\"/" "$TAP_REPO/$CASK"
sed -i '' "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$TAP_REPO/$CASK"
grep -q "version \"$VERSION\"" "$TAP_REPO/$CASK" || die "cask version not rewritten"
grep -q "sha256 \"$SHA\"" "$TAP_REPO/$CASK" || die "cask sha256 not rewritten"
git -C "$TAP_REPO" add "$CASK"
git -C "$TAP_REPO" commit -q -m "Sidenote $VERSION"
git -C "$TAP_REPO" push -q

# ---- announce it ----------------------------------------------------------
# Last, and on purpose. latest.json is what installed copies read to learn a
# new version exists, and the only thing they can do about it is
# `brew upgrade`. Publish it before the cask push above and every running app
# tells its user to upgrade to a version Homebrew cannot serve yet.

say "Announcing $VERSION"
cat > "$SITE_REPO/public/downloads/latest.json" <<EOF
{
  "version": "$VERSION",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "url": "$DMG_URL",
  "sha256": "$SHA",
  "cask": "benedictshegog/sidenote/sidenote"
}
EOF
git -C "$SITE_REPO" add public/downloads/latest.json
git -C "$SITE_REPO" commit -q -m "Announce Sidenote $VERSION"
git -C "$SITE_REPO" push -q
info "installed copies will offer $VERSION within a day"

# ---- install it here too --------------------------------------------------
# Everything above is published, so nothing below may abort the release: a
# brew hiccup must not make a finished release look like a failure.

say "Installing locally"
# Homebrew replaces /Applications/Sidenote.app, which fails or force-quits if
# the app is open. Ask it to quit first so the upgrade is not a surprise.
if pgrep -f "Sidenote.app/Contents/MacOS" >/dev/null; then
  info "quitting the running app"
  osascript -e 'quit app "Sidenote"' >/dev/null 2>&1 || true
  sleep 2
fi
brew update --quiet >/dev/null 2>&1 || true
# Upgrade if it is already here, install (and tap) if it is not: a machine
# that has just tested a from-scratch uninstall still ends up on the new build.
# Fully qualified throughout: a machine that has ever tapped a second repo
# carrying a `sidenote` cask makes the bare name ambiguous, and brew then
# refuses to do anything at all.
if brew list --cask benedictshegog/sidenote/sidenote >/dev/null 2>&1; then
  INSTALL_CMD=(brew upgrade --cask benedictshegog/sidenote/sidenote)
else
  INSTALL_CMD=(brew install --cask benedictshegog/sidenote/sidenote)
fi
if "${INSTALL_CMD[@]}"; then
  info "local install now at $VERSION"
else
  info "could not install; run: ${INSTALL_CMD[*]}"
fi

say "Released $VERSION"
cat <<EOF
    brew update && brew upgrade --cask benedictshegog/sidenote/sidenote

    Check it with a real fetch (verifies the checksum, installs nothing):
      brew fetch --cask benedictshegog/sidenote/sidenote --force

    Never 'brew uninstall --cask sidenote --zap': zap deletes ~/.sidenote,
    which holds every comment, thread and snapshot.
EOF
