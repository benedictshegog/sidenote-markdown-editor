---
name: sidenote-review
description: Put a markdown document up for review in the Sidenote Mac app and handle the comments that come back. Use when the user asks to "open this in Sidenote", "send this for review", "let me comment on this", "connect to <file> in Sidenote" (the prompt the app copies for a new session), when a Sidenote comment event arrives on the monitor (a JSON frame with "event": "comment" | "reply" | "resolve"), or when the user asks to re-arm or check the Sidenote listener. Claude Code only; the `sidenote` CLI does every deterministic step.
---
<!-- sidenote-skill-version: 11 -->

# Sidenote review

Sidenote is a Mac app that shows a markdown file in a WYSIWYG editor and lets the user comment on ranges of text. Comments reach this session through a WebSocket monitor. This session edits the file in place and replies in the threads. The `sidenote` CLI owns the review data (`~/.sidenote/`); never write `threads.json`, `state.json` or `index.json` by hand.

CLI location: `sidenote` on the PATH (`/usr/local/bin/sidenote`, a symlink the app installs). If `command -v sidenote` fails, use the binary inside the app bundle: `/Applications/Sidenote.app/Contents/MacOS/sidenote`. The app must be installed in `/Applications` for `--open` to work.

Exit codes of `sidenote`:

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | continue |
| 1 | error | read stderr, fix, retry once |
| 2 | not registered | `sidenote register <file.md>` |
| 3 | the document belongs to another session | end the turn, say so. Only its owner may write to it |
| 4 | new comments arrived during the turn (`turn end`) | go back to `turn begin` |
| 5 | the user pressed Unlock while this session held the lock | stop; tell the user its edits may be overwritten |
| 6 | `apply` could not find its `--old` text exactly once | the user changed that passage; re-read the file and redo the edit against what is there now |
| 7 | `apply` needs the document open in the Sidenote app, and it is not (app not running, or the tab closed) | `sidenote open "<doc>"`, then retry once; if it fails again, tell the user and use the `lock` + Edit tool path below |

`sidenote lock` exits 3 when another session holds a fresh lock.

## Entry point A: put a document up for review

1. Write the markdown where it belongs (a repo plan, a Projects directory, the Desktop).
2. `sidenote register "<file.md>" --open`. This assigns an id, takes snapshot v001, records this session as owner and opens the app on the file.
3. Arm the monitor, once per session, if not already armed (see "Monitor").
4. End the turn. Tell the user, in one sentence, that the document is open in Sidenote and comments come straight here.

## Entry point C: connect this session to an existing document

The app's Document > Copy Connect Prompt (or a click on the grey listener dot) puts `Connect to "<path>" in Sidenote and handle its comments.` on the clipboard; the user pastes it into a new session.

1. `sidenote register "<path>"`. The document is already registered, so this only records this session as owner; comments now route here.
2. Arm the monitor (see "Monitor"). Register first: the app replays waiting comments to the owner the moment it connects, so ownership must be yours by then.
3. Comments left while no session was listening arrive as replayed frames. Handle them as in entry point B. `sidenote waiting "<path>"` names the threads still awaiting a reply if you want to check; `sidenote threads "<path>" --all` prints the history.
4. End the turn with one line: connected, and how many threads await.

## Entry point B: handle an event

An event is a text frame from the monitor, JSON: `{"event":"comment","doc":"/abs/path.md","thread":"c12"}` (also `reply`, `resolve`). Several frames may arrive together; handle the document once.

A frame with `"replay": true` is a comment that arrived while this session was not connected. The app sends the backlog when the monitor connects, so a burst of them at the start of a session is normal. Handle them exactly like live frames: one `ack` naming every thread, then one turn.

0. `sidenote ack "<doc>" <thread> [<thread>…]` first, for every `comment` and `reply` frame, before reading or thinking about anything. The card shows 👀 from that moment until your reply clears it, so the user knows the comment has reached you.
1. `sidenote turn begin "<doc>"`. This does not lock the document.
   - Exit 3: another session owns the document. End the turn with one line.
   - The output lists every thread whose last message is from the user (id, anchored text, context, messages) and a whitespace-insensitive diff of the user's own edits since the last snapshot. Read the diff: the user may have changed prose you are about to touch.
   - Threads it lists are also marked 👀 (for the polling fallback and for entry point C, where no ack ran).
2. Decide per thread whether the file needs an edit. Reply-only turns need no lock and no `apply`.
3. For each thread:
   - Read the anchored text and the user's message.
   - **If the comment asks for a change, use `sidenote apply`.** One call replaces the passage, re-points the thread at the new text and leaves the reply:

     ```sh
     sidenote apply "<doc>" --thread c12 \
       --old "<the exact text to replace>" \
       --new "<the replacement>" \
       --reply "<one or two sentences saying what changed>" --done
     ```

     Prefer it over the Edit tool. The app lands the edit inside its editor as one change, so the file is never rewritten under the user, no lock is taken, and their cursor, scroll and undo history survive; it re-anchors for you, so the thread cannot be orphaned; and it refuses an edit whose `--old` text is missing or appears more than once (exit 6), which is how you find out the user rewrote that passage while you were thinking. `--old` is matched against the text as the editor shows it, so give the words of the passage; inline markdown (backticks, `**`) in `--old` is stripped before matching, and line wraps do not matter. `--new -` reads the replacement from stdin when the text is long or awkward to quote. The document must be open in the app (exit 7 otherwise).
   - Keep edits surgical; do not reformat untouched prose.
   - **In suggesting mode `apply` proposes rather than writes.** See below.
   - For a change too large to express as one replacement (restructuring the whole document), fall back to the old path: `sidenote lock "<doc>"` once, the Edit tool, then `sidenote reply` and `sidenote anchor "<doc>" <thread> "<a short exact phrase from the new text>"`. Without the re-anchor, `turn end` orphans the thread.
   - `sidenote reply "<doc>" <thread> "<one or two sentences>"` on its own answers a comment that needs no change. Never add `--done` to a reply-only answer.
   - When you change a passage nobody commented on (a fix you noticed, a knock-on change), `sidenote apply` it without `--thread`, then leave a note: `sidenote note "<doc>" "<short exact phrase>" "<one sentence>"`. A note also works for a question to the user. Notes start with your message, so they do not come back to you.
   - Never resolve a thread. Resolving is the user's decision, made in the app after reading the reply; the CLI has no option for it. When no change is needed, say why in the reply and leave it at that.
   - Exit 5: stop everything and tell the user.
4. `sidenote turn end "<doc>"`. It re-anchors every thread to the new text (a rewritten sentence orphans its thread; say so in the reply beforehand when you rewrite anchored text), writes a snapshot when the text changed, clears the lock.
   - Exit 4: new comments arrived while you worked. Go to step 1.
   - Exit 5: stop and tell the user.
5. End the turn. No summary is needed beyond one line; the replies are in the app.

A `resolve` event needs no reply. A `reply` event is handled like `comment`. A thread whose last message is Claude's is not served again by `turn begin` until the user writes in it.

## Monitor

Arm one persistent monitor per session. The subprotocol token carries this session's id so the app can route frames to the owner:

```
Monitor({
  ws: { url: "ws://127.0.0.1:47293", protocols: ["sidenote", "sid-<CLAUDE_CODE_SESSION_ID>"] },
  persistent: true,
  description: "Sidenote review comments"
})
```

Read `CLAUDE_CODE_SESSION_ID` from the environment (`echo $CLAUDE_CODE_SESSION_ID`) before arming; `sidenote` reads the same variable.

- Nothing is lost while the socket is down. Comments stay in the thread and the app replays them on the next connect, so re-arming is the whole recovery.
- Socket close arrives as an event. Re-arm with backoff: 1 s, 5 s, 30 s. After three failures fall back to polling: a Monitor that runs `sidenote waiting "<doc>"` every few seconds and fires when the output changes. Poll `sidenote waiting`, not `threads.json`: the file is scoped to no one document and a turn rewrites it, so an mtime poll wakes on other documents and on this session's own writes.
- Two monitors on one session deliver duplicates. Harmless: `turn begin` returns only threads awaiting a reply, so the second pass is a no-op.
- If the app is not running, the connection is refused. Say so once and do not loop; arm again when the user opens the app or asks.

## Suggesting mode

The user can put a document in **suggesting mode**, the way they would in a
word processor. While it is on, `sidenote apply` records the edit instead of
making it: the file does not change, the proposal appears in the document with
the old words struck through and the new ones beside them, and the user accepts
or rejects it. Nothing else about the turn changes.

`turn begin` and `lock` say so at the top of their output, and print the
suggestions still waiting. `sidenote suggest "<doc>"` asks at any time.

What it changes for you:

- **Use `apply` exactly as before.** One call per change, `--old` and `--new`,
  same exactly-once rule. It exits 0 and says `suggested s1 … (not applied)`.
  That is success, not a failure to retry.
- **Never work around it.** Do not reach for the Edit tool, do not `lock` and
  write the file yourself, do not repeat the edit because the file "did not
  change". Suggesting mode is the user asking to approve changes first;
  editing the file directly takes that decision away from them. For a
  restructuring too large to express as replacements, say so and ask them to
  turn the mode off — do not do it behind the switch.
- **Word replies as proposals.** "Suggested naming the hold", not "named the
  hold". The change has not happened yet.
- **Never `--done`.** The check mark means the file was changed for that
  comment. The CLI drops the flag in this mode; do not try to set it another
  way. It is the user's accept that finishes the job, and their resolve that
  closes the thread.
- **Do not propose the same thing twice.** `turn begin` lists what is already
  pending. A suggestion still in the margin is not one the user has missed.
- **A suggestion that disappears has been answered.** Either the user rejected
  it, or they rewrote that passage themselves — which drops it. Both are an
  answer. Do not re-propose it; ask, or leave it.

Exits work exactly as they do otherwise. The app checks `--old` against the
text it is showing before it stores anything, so an edit written against a
passage the user has already rewritten is exit 6 at once rather than a
suggestion that waits in the margin to fail under their hand. Exit 7 still
means the document is not open — suggesting mode needs the app even more than a
direct edit does, because the app is where the user decides.

## The user is not locked out

The app shows the user where you are, on the comment highlights themselves: a thread you have acked has its highlight brightened, and the passage your last `apply` landed on flashes once. They can keep writing throughout. Two things follow.

- **The document moves under you.** Read the diff `turn begin` prints, and expect exit 6 from `apply` when the user has rewritten the passage you were about to change. That is the system working: re-read and redo the edit, do not force it.
- **Ack early.** The marker appears when you ack, so acking first is what tells the user which paragraphs to leave alone.
- In suggesting mode they are never locked at all: nothing is written, so `apply` takes no lock.

## Rules

- Never edit review data by hand. Only `sidenote` writes under `~/.sidenote/`.
- Never add marks, comments or frontmatter to the document. The file stays clean markdown.
- Prefer the smallest edit that answers the comment. The user's own edits (shown in the diff) win over the snapshot.
- Replies are one or two sentences, plain, no greetings. Say what changed.
- Only the user resolves threads.
- `sidenote suggest "<doc>"` shows whether suggesting mode is on and what is pending. The user turns it on and off in the app; do not set it for them.
- `sidenote list` shows registered documents and which sessions are connected. `sidenote waiting "<doc>"` names the threads awaiting a reply. `sidenote threads "<doc>" --all` prints every thread as JSON when you need history.
- **One document, one session.** Events go only to the owner, and only the owner may write: `lock`, `apply`, `reply`, `note`, `anchor` and `turn end` all exit 3 for anyone else, whether or not the owner is still running. Ownership is claimed in exactly two places — `register`, when the user connects a session, and `turn begin`, which inherits a document whose owner has gone. If a document belongs to a live session, say so and stop; do not go looking for another way in.
