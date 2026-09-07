# Sidenote

A Mac app to review markdown documents written by Claude Code. Tauri 2 shell,
React + Milkdown Crepe front end, Rust core shared with a `sidenote` CLI.

`README.md` has the layout and the develop loop. This file is the working
agreement on top of it.

## Releasing

Use the script. Do not do the steps by hand — the ordering matters and it is
easy to publish a cask that no longer matches the file it points at.

```sh
scripts/release.sh 0.1.6          # prompts before anything is pushed
```

It bumps the four version sites and the README link, builds the sidecar and the
`.dmg`, commits and tags this repo, pushes the `.dmg` to the site repo, waits
for Vercel, **checks the served bytes against the local build**, and only then
updates the cask. If the checksum does not match it stops without touching the
cask, because a cask whose `sha256` disagrees with its URL breaks every install.

It needs the two sibling checkouts. Override if yours are elsewhere:

```sh
SIDENOTE_SITE_REPO=... SIDENOTE_TAP_REPO=... scripts/release.sh 0.1.6
```

### How installed copies learn about a release

Homebrew owns the install, so the app never replaces itself. It reads
`downloads/latest.json` — written by `release.sh` — at most once a day, and
when that names a newer version it offers to run `brew upgrade --cask sidenote`
for the user. The app quits, a helper script in `~/.sidenote/upgrade.sh` waits
for it to go, runs Homebrew, and reopens it. `~/.sidenote/upgrade.log` says
what happened.

Two rules hold this together:

- **`latest.json` is published last**, after the cask push. Announce a version
  Homebrew cannot serve yet and every running app sends its user to a
  `brew upgrade` that does nothing.
- **The helper lives outside the bundle.** Homebrew deletes
  `/Applications/Sidenote.app` during the upgrade, so a script inside it would
  be pulled out from under itself mid-run.

The app only offers the button when Homebrew really installed this copy: a
`Caskroom/sidenote` directory, a `brew` binary, and — in a release build — a
bundle under `/Applications`. Anything else gets a download link instead.

### Where releases live

Releases are served from the site, not GitHub Releases. Three repos are
involved:

| Repo | Visibility | Holds |
|---|---|---|
| `benedictshegog/sidenote-markdown-editor` | public | this source |
| `benedictshegog/benedictshegog.xyz` | public | the `.dmg` under `public/downloads/` |
| `benedictshegog/homebrew-sidenote` | public | `Casks/sidenote.rb` |

The tap has to stay public: `brew tap` clones it. The site repo has to stay
public: Homebrew downloads with no credentials.

The source is licensed PolyForm Noncommercial 1.0.0 (see `LICENSE`). Versions
released before 2026-08-20 went out under MIT and that grant still stands for
them. The old private source repo, `benedictshegog/sidenote`, is archived; it
holds the pre-release history.

## Ground rules

- **`~/.sidenote` is user data.** It holds every comment, thread and snapshot.
  Never run `brew uninstall --cask sidenote --zap`, and never delete the
  directory to "reset" — the plain uninstall leaves it alone, which is the
  point.
- **Build the CLI before compiling the app.** `bundle.externalBin` makes
  `tauri-build` fail until the sidecar exists: `app/scripts/build-cli.sh`.
- **Review UI changes in the running app before pushing.** `pnpm dev:app`
  (not bare `pnpm tauri dev`: the dev config gives the debug build its own
  identity, port and icon, so it runs beside the installed `Sidenote.app`
  instead of being turned away by the single-instance check). A debug CLI
  (`$CARGO_TARGET_DIR/debug/sidenote`, see `scripts/cargo-env.sh`) reaches the dev app; the installed `sidenote`
  reaches the installed app.
- **When a feature is done, launch the dev app for QA without being asked.**
  Benedict reviews every UI change in the running app himself. Start
  `pnpm dev:app` from the worktree, wait for the window, and say what to try.
  Leave it running; he quits it.
- **Use a worktree under `.worktrees/`** for non-trivial changes when other
  work is in flight, so two sessions do not fight over the tree.
- Do not commit QA scaffolding. A browser harness that mocks the Tauri
  backend is a good way to test the front end, but it belongs in a scratch
  directory, not in `app/`.

## Checks

```sh
cargo test -p sidenote-core     # unit + store lifecycle
cli/tests/e2e.sh                # plays the skill's steps against a temp ~/.sidenote
cd app && npx tsc -b && pnpm lint
```

`pnpm lint` has pre-existing `only-export-components` warnings; they are not
from your change unless the file is one you touched.

## Front end notes

- Crepe is themed through `--crepe-*` tokens in `sidenote.css`. Its floating
  popups need an **opaque** surface — `--surface` is a translucent overlay
  tint and shows the document through the popup.
- CodeMirror does not follow the app theme on its own. `editor/codeTheme.ts`
  drives it from `--code-*` tokens so one theme serves light and dark. Check
  contrast in **both** modes after changing those.
- The document lock is a `readonly` prop on `<Editor>`, not an imperative
  call. Crepe ignores `setReadonly` until its editor status is `Created`, so
  applying it from an effect alone loses the lock when a document opens
  already locked.

## Also

`.claude/PAPERCUTS.md` (local, untracked) records environment traps hit while
building this — read it before assuming a tool is broken.
