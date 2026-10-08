# Release notes

## Unreleased

- A mermaid code block now renders as a diagram. The picture is shown by default, with a button to see or edit the source, and it follows the light and dark themes.
- You can comment and reply while Claude holds the document lock. The editor stays read-only, but the margin does not: select text and press ⌘⇧M, or use the Comment button in the lock capsule. Resolving waits for the lock to clear.
- A comment you were still writing when the text changed under it is closed instead of failing on send, and the toast offers to copy your words.

## 0.1.34 (2026-10-02)

- A table of contents sits to the left of the document and marks the section you are reading. Click a heading to jump to it. In a narrow window it folds into a rail you hover to open. Turn it off in View.
- Clicking a link no longer opens it inside Sidenote. Web and local server links open in your browser, and links to a heading scroll to it.
- In full screen, the sidebar button moves to the left edge.

## 0.1.33 (2026-09-23)

- After an update, a small note in the corner links to what changed. Settings has the full history.
- Tables with six or more columns scroll sideways instead of squeezing every column into the page.
- Dragging a column border now resizes just that column, so the table grows or shrinks. The right edge can be dragged too.
- Columns can no longer be made narrower than a short word.

## 0.1.32 (2026-09-22)

- Switch tabs with ⌘1 to ⌘9, and drag a tab to reorder it. Hold ⌘ to see each tab's number.
- The panel toggles move to ⇧⌘1 and ⇧⌘2. Versions no longer has a shortcut.
- YAML front matter now survives a round trip unchanged.
- The document no longer replays its opening animation each time you switch tabs.

## 0.1.31 (2026-09-18)

- Long inline code now wraps inside its table cell.

## 0.1.30 (2026-09-15)

- Updates now work after an Xcode update, without first accepting the Xcode licence.
- When an update fails, the alert now shows the reason Homebrew gave.

## 0.1.29 (2026-09-15)

- Footnote references show as small linked numbers. Click one to jump to its note.
- Hover over a footnote reference to preview its note in a card.
- Footnotes are now a compact numbered list. Click a number to go back to the text.
- Claude's edits no longer break footnote references.

## 0.1.28 (2026-09-07)

- Drag a table column boundary to resize the columns. Sidenote remembers the widths for each document.
- Rich text you copy now pastes into Outlook with the correct paragraph spacing.

## 0.1.27 (2026-09-04)

- New Document (⌘N) opens a blank page. Save (⌘S) asks where to put it.
- Sidenote now asks you to save unsaved pages before you close a window, quit or update.
- New Window moves to ⇧⌘N.

## 0.1.26 (2026-09-04)

- The Comment button is now clickable for selections near the right edge.
- Toggle the sidebar with a button in the tab bar, or with ⌘1.
- The sidebar heading no longer collides with the window buttons.
- The popovers on the session pill now close each other.

## 0.1.25 (2026-09-01)

- Finding a moved file no longer triggers macOS permission prompts for Music, Pictures or iCloud Drive.

## 0.1.24 (2026-08-26)

- Turn on suggesting mode to have Claude propose edits instead of making them.
- Accept or reject each suggestion in the margin. Removed words and new words show in different colours.
- ⌘Z now undoes in the document, and an undone accept brings its suggestion back.
- Rewriting a suggested passage removes the suggestion.

## 0.1.23 (2026-08-26)

- Find text in the document with ⌘F. Step through matches with Enter or ⌘G.

## 0.1.22 (2026-08-25)

- Reopen a closed tab in its old place with ⇧⌘T.
- Claude's edits now keep your cursor, scroll position and undo history.

## 0.1.21 (2026-08-24)

- Connect a session with Copy Connect Prompt (⇧⌘K), then paste the prompt into Claude Code.
- Sidenote no longer starts sessions in a terminal app itself.

## 0.1.20 (2026-08-23)

- Local images now show in the document, and their alt text survives a save.
- Remote images are blocked, so a document cannot tell anyone that you opened it.
- The Dock badge now counts unread comments on open documents only.
- Typing stays responsive while Claude works, and a failed autosave no longer loses your text.
- A second window now works fully, and menu items act on one window only.

## 0.1.19 (2026-08-22)

- Keep writing while Claude works. Claude now changes only the passage it edits.
- A comment card shows when Claude is working on it, and each edit flashes as it arrives.
- The Dock icon shows a badge for unread comment threads.
- Comments you leave while a session is away now reach it when it reconnects.
- Dropping a markdown file on the window opens it again.

## 0.1.18 (2026-08-21)

- Starting a new comment no longer scrolls the document.

## 0.1.17 (2026-08-21)

- Comments now sit in the margin beside their text, like in Google Docs.
- Reply to or resolve a comment from its card. A chip shows or hides resolved comments.
- Turn a block back into text or a heading from the selection toolbar, or with Backspace.
- A comment card shows when Claude has received it.

## 0.1.16 (2026-08-21)

- A one-time tip points to the session button the first time you open a document.

## 0.1.15 (2026-08-21)

- The first-run welcome now explains Sidenote before it asks to install anything.

## 0.1.14 (2026-08-21)

- Small fixes and internal improvements.

## 0.1.13 (2026-08-21)

- Sidenote now tells you when a new version is available and installs it through Homebrew.

## 0.1.12 (2026-08-21)

- Choose which app a Claude Code session starts in from the session button.

## 0.1.11 (2026-08-21)

- The title bar now matches the Claude app, with smaller tabs.

## 0.1.10 (2026-08-20)

- Drop a markdown file on the window to open it.

## 0.1.9 (2026-08-20)

- Settings now shows the installed version.
- The start screen has cleaner spacing, and long paths no longer show stray characters.

## 0.1.8 (2026-08-20)

- Documents now use a cleaner type scale and the system font by default. Inter is still available.
- Recent documents now show on the start screen. ⌘1 shows them in the sidebar.

## 0.1.7 (2026-08-20)

- Click a link to see it and open it in your browser, or ⌘-click to open it directly.

## 0.1.6 (2026-08-20)

- Links in a document now open in your browser. Links to local files are refused.
- Code blocks are now readable in light mode.
- The document lock now stops you typing while Claude writes.
- Code blocks and blockquotes now render cleanly.

## 0.1.4 (2026-08-20)

- Cycle through tabs with Ctrl+Tab.
- Scrolling and panels now work correctly with tabs.

## 0.1.3 (2026-08-20)

- Documents now open in tabs instead of separate windows.

## 0.1.2 (2026-08-20)

- The welcome sheet now lists only the steps you have not done yet.
- Sidenote now detects a command line tool installed by Homebrew.

## 0.1.1 (2026-08-20)

- A welcome sheet helps you set up Sidenote on first launch.
- Make Sidenote the default app for markdown files.
- Open Settings with ⌘, and compare versions of a document in the Versions panel.

## 0.1.0 (2026-08-20)

- Review markdown documents that Claude Code writes, in a WYSIWYG editor.
- Leave comments anchored to text. The original Claude Code session replies to them.
- Your markdown file stays clean. Sidenote keeps all review data in `~/.sidenote/`.
- The document locks while Claude writes, and each turn saves a version.
- Install the `sidenote` command and the Claude Code skill from the app.
