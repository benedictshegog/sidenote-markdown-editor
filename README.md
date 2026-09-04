# Sidenote

A Mac app to review markdown documents written by Claude Code.

Open a document, edit it in a Notion-style WYSIWYG editor, and leave comments on the text you select. The Claude Code session that wrote the document picks up your comments and replies in them. There is no Send button.

Or start from nothing: New Document (⌘N) opens a blank page to write on, and Save (⌘S) asks where the file goes. Closing a page with text on it asks first.

Your markdown file stays clean: comments, replies and versions are kept in `~/.sidenote/`.

## Install

Homebrew (Apple silicon, macOS 13 or later):

```sh
brew install --cask benedictshegog/sidenote/sidenote
```

The cask clears the quarantine flag after install (the app is unsigned; Homebrew 6 no longer has `--no-quarantine`). Or download the `.dmg` from [benedictshegog.xyz](https://benedictshegog.xyz/downloads/Sidenote_0.1.27_aarch64.dmg), copy `Sidenote.app` to `/Applications`, and allow it once under System Settings > Privacy & Security > Open Anyway. On first launch a welcome sheet offers the Claude Code integration (the `sidenote` command link, the `sidenote-review` skill) and, optionally, to make Sidenote the default app for `.md` files. Each is a checkbox; Settings (Cmd+,) repeats them.

## Layout

- `core/`: Rust crate `sidenote-core`. Data model, locked atomic JSON writes, markdown to plain text, selector re-anchoring, snapshots, whitespace-insensitive diff, and the turn operations. Shared by the CLI and the app.
- `cli/`: the `sidenote` binary. Thin wrapper over `core`; the exit codes are the protocol the Claude Code skill follows (0 ok, 1 error, 2 not registered, 3 locked, 4 new comments during the turn, 5 unlocked by the user).
- `app/`: Tauri 2 app. React + TypeScript + Milkdown Crepe frontend in `app/src`, Rust backend in `app/src-tauri` (WebSocket server on 127.0.0.1:47293, file watcher, native menu, commands).
- `skill/sidenote-review/SKILL.md`: the Claude Code skill. `core` embeds it (`include_str!`), so the app and `sidenote install-skill` write it to `~/.claude/skills/sidenote-review/`. Edit it here, bump `<!-- sidenote-skill-version: N -->`, and the next app launch updates installed copies (hand-edited or newer copies are kept; `sidenote install-skill --force` overwrites).

## Develop

```sh
# Rust toolchain: rustup (stable). Node: pnpm.
cd app && pnpm install
./scripts/build-cli.sh            # builds the sidenote sidecar the Tauri build expects
pnpm dev:app                      # runs the app with hot reload, beside the installed one
```

`pnpm dev:app` is `tauri dev` with `src-tauri/tauri.dev.conf.json` merged in,
which gives the debug build its own identity so it runs next to the installed
Sidenote rather than being turned away by it: a different bundle identifier
(the single-instance check keys on it), the name "Sidenote Dev", an orange
icon, and a "Dev" tag in the corner of every window. A debug build also
listens on port 47294 rather than 47293, and a debug CLI dials the same, so
`target/debug/sidenote` talks to the dev app and the installed `sidenote` to
the installed app. `SIDENOTE_PORT` overrides either side. Both apps share
`~/.sidenote`, so the dev app shows the same documents; only the listeners
file is split by port.

Tests:

```sh
cargo test -p sidenote-core          # unit + store lifecycle tests
cli/tests/e2e.sh                  # plays the skill's steps against a temp ~/.sidenote
```

## Structure of the frontend

`App.tsx` is the shell: tab bar, sidebar, settings, welcome sheet, menu routing. `DocumentView.tsx` is one open document (editor, autosave, comments, panel, versions, busy lock); one instance per tab, hidden when inactive. Document-scoped menu items are forwarded to the active tab through `DocumentActions`. `DraftView.tsx` is a document that has no file yet — New Document before Save — and is the editor alone; Save writes the file, registers it, and swaps the tab for a `DocumentView`. Quit is a round trip through the backend (`request_quit`) so every window can ask about its drafts first.

## Release

Use the script. The ordering matters, and doing it by hand is how you publish a
cask whose checksum disagrees with the file it points at, which breaks every
install.

```sh
scripts/release.sh 0.1.13          # prompts before anything is pushed
scripts/release.sh 0.1.13 --yes    # no prompt, for a re-run you already vetted
```

It bumps the four version sites (`Cargo.toml`, `Cargo.lock`, `tauri.conf.json`,
`app/package.json`) and the download link above, builds the sidecar and the
`.dmg`, commits and tags this repo, pushes the `.dmg` to the site repo, waits
for Vercel, **compares the bytes actually served against the local build**, and
only then updates the cask. A mismatch stops it with the cask untouched. It
finishes by upgrading the local install, so this machine runs what it published.

Preflight refuses to start if any of the three repos has uncommitted changes to
tracked files, if the tag exists, or if a Sidenote disk image is still mounted
(a leftover read-write image makes the `.dmg` step fail — `hdiutil info`, then
`hdiutil detach /dev/diskN`).

It needs the two sibling checkouts. Override if yours are elsewhere:

```sh
SIDENOTE_SITE_REPO=... SIDENOTE_TAP_REPO=... scripts/release.sh 0.1.13
```

Releases are not hosted on GitHub Releases: the `.dmg` sits on the site. Three
repos are involved — this source, `benedictshegog.xyz` for the `.dmg` under
`public/downloads/` (public, because Homebrew downloads with no credentials),
and `homebrew-sidenote` for `Casks/sidenote.rb` (public, because `brew tap`
clones it).

## Build the app

```sh
cd app && ./scripts/build-cli.sh release && pnpm tauri build
```

The `.app` and `.dmg` land in `target/release/bundle/`. The `.dmg` is the whole distribution: app, `sidenote` CLI (sidecar inside the bundle) and the Claude Code skill (embedded). Copy `Sidenote.app` to `/Applications` (`ditto target/release/bundle/macos/Sidenote.app /Applications/Sidenote.app`). On first launch the app offers to install the Claude Code integration: a symlink `/usr/local/bin/sidenote` to the bundled binary (admin prompt when needed) and the skill in `~/.claude/skills/`. Sidenote menu > Install Claude Code Integration… repeats it. Manual equivalents: `sudo ln -sf /Applications/Sidenote.app/Contents/MacOS/sidenote /usr/local/bin/sidenote` and `sidenote install-skill`.

The app icon is generated from `app/app-icon.png` with `pnpm tauri icon app-icon.png` (run inside `app/`; delete the `android/` and `ios/` output).

Sharing without a Developer ID: a source build has no quarantine flag; the unsigned `.dmg` needs System Settings > Privacy & Security > Open Anyway once (or `xattr -dr com.apple.quarantine /Applications/Sidenote.app`); the Homebrew cask strips the flag in a `postflight` step, so brew users see no prompt. Signing and notarisation (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` at build time) remove the friction and enable the updater.

Preferences (appearance, typeface) are stored in the webview's localStorage under `sidenote.*`; Settings is Cmd+, in the app.

Diagnostics: JS errors and the boot marker go to `~/.sidenote/ui.log`. The dev app forwards Rust logs to the terminal.

## Files on disk

```
~/.sidenote/
  index.json              doc id -> path, title, last opened, owner_session
  listeners.json          sessions connected to the running app (valid while pid lives)
  listeners-47294.json    the same for a dev build, which listens on its own port
  docs/<id>/
    threads.json          comment threads with text quote selectors
    state.json            busy lock, suggesting mode
    suggestions.json      edits Claude has proposed and you have not decided
    vNNN.md               snapshots, one per Claude turn, last 50 kept
```

## Suggesting mode

Turn it on for a document (the pen in the toolbar, Document > Suggesting, or
⌘⇧E) and Claude's edits stop landing in the file. Each one appears where it
would go — the old words struck through, the new ones beside them — with Accept
and Reject in the margin. The markdown file does not change until you accept,
so you are never read-only while Claude works.

It runs through the same `sidenote apply` that a direct edit does, and accepting
one lands in the editor the same way, so your cursor, scroll position and undo
history survive — Cmd+Z takes an accepted edit back, and the suggestion returns
to the margin with it. Rewrite a suggested passage yourself and the suggestion
is dropped: you have answered it, and Claude's reply stays in the thread.
`sidenote suggest "<doc>"` prints the mode and what is pending;
`docs/decisions/2026-08-26-suggesting-mode.md` says why it works this way.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): use, modify and share it freely for
any noncommercial purpose. Commercial use needs written permission. Versions
released before 2026-08-20 went out under MIT and that grant still stands for
them.
