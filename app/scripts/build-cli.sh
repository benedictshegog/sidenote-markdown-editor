#!/bin/sh
# Build the sidenote CLI and place it where Tauri expects the sidecar binary.
set -e
cd "$(dirname "$0")/../.."
# Only fall back to rustup's bin if cargo is not already on PATH; prepending it
# unconditionally shadows a newer toolchain (e.g. Homebrew's).
command -v cargo >/dev/null 2>&1 || export PATH="$HOME/.cargo/bin:$PATH"
. scripts/cargo-env.sh
PROFILE="${1:-debug}"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$PROFILE" = "release" ]; then
  cargo build -p sidenote-cli --release
else
  cargo build -p sidenote-cli
fi
mkdir -p app/src-tauri/binaries
cp "$CARGO_TARGET_DIR/$PROFILE/sidenote" "app/src-tauri/binaries/sidenote-$TRIPLE"
echo "sidecar: app/src-tauri/binaries/sidenote-$TRIPLE ($PROFILE)"
