# Sidenote: how should "view Claude's edits" work?

Date: 2026-08-26

## Short answer

Not as a diff viewer. As **suggesting mode**: a per-document switch that makes
`sidenote apply` propose an edit instead of making it, so the user accepts or
rejects each one the way they would in a word processor. The proposal is drawn
in the prose it would change — old words struck through, new words beside them
— and the markdown file does not move until the user accepts.

The alternative considered first was a review view over the snapshots: diff the
last two `vNNN.md` and paint the result. It answers "what changed" after the
fact. Suggesting mode answers "should this change" before it, which is the
question a reviewer actually has.

## Why `apply` is the seam

`apply` already takes one `old` passage and one `new` replacement and refuses to
run unless `old` occurs exactly once. That is a suggestion: a described edit
plus a check that it still fits. So the mode adds no second edit path.

Since 0.1.22 `apply` runs in the app: the CLI hands the edit over the socket,
the editor finds the passage in its own text and replaces it as one mapped
transaction. Suggesting mode branches at that same point — the `apply-request`
handler records the edit instead of dispatching it — and **accepting one goes
back through the very same `applyEdit`**. That last part is not a detail. An
accept that wrote the file instead would return through the watcher as a
whole-document reload and throw away the cursor, the scroll position and the
undo history, which is exactly what moving `apply` into the editor was for.

Consequences:

- **The exactly-once check happens twice**, once when the suggestion is made
  and once when it is accepted, both against the text the editor is showing. An
  edit written against a passage the user has already rewritten fails at exit 6
  as it always did, rather than being stored and failing later under their hand.
- **Rewriting the passage drops the suggestion.** It cannot be applied any more,
  so the choice is between removing it and keeping a card that can only be
  dismissed. A word processor removes it, and that is right: editing the text
  under a suggestion *is* an answer to it, and a dead card asking to be tidied
  away is worse than no card. Claude's reply stays in the thread, so what was
  proposed is still on the record. The check runs in the front end against its
  own editor — the file trails by an autosave, and the sentence being rewritten
  is precisely the one in question — and waits for typing to stop, so nothing
  disappears between two keystrokes of a word being retyped.
- **The user is never locked out.** Nothing is written, so no lock is taken and
  the read-only strip never appears.
- **The file path refuses.** `SIDENOTE_APPLY_FILE=1` (the e2e script) has no app
  in it and so cannot offer the user the decision the mode promises. It errors
  rather than writing anyway: the one guarantee the mode makes has to hold on
  every path, not just the usual one.

## What is on disk

`~/.sidenote/docs/<id>/suggestions.json`, holding pending suggestions only:
id, `old`, `new`, the thread it answers, the session, the time. Deciding one
removes it. The record of what was proposed and why survives in the thread's
reply, which is where a reader would look for it.

`old` is the **plain text** the app matched, not the markdown Claude sent —
the same form `apply` puts on the wire, and the form the editor searches for
again to draw the suggestion. `new` stays markdown, because accepting parses
and inserts it.

The file also carries a `next` counter. Ids must not be reused: deciding a
suggestion removes it, so deriving the next id from the highest one present
would hand `s3` out again the moment the first `s3` was rejected, and a card
already on screen would be answered by the wrong edit. Threads can derive
theirs — they are never removed.

The mode itself is `suggesting` in `state.json`. Per document, not global: it
is a property of how *this* document is being reviewed. `turn begin` and `lock`
report it, so a session knows before it writes that its edits will wait, and
lists what is already pending so it does not propose the same change twice.

The markdown file stays clean, which is the same rule comments follow. A
document with ten pending suggestions is byte-identical to one with none.

## How it is drawn

Word-level diff, rendered in place. The deletions are really in the document,
so they are inline decorations. The insertions exist nowhere yet, so each is a
ProseMirror widget — which is also why they cannot be typed into or selected.
That asymmetry is honest: accepting is what makes the new words part of the
document.

Two details cost more than they look:

- **Words carry their trailing whitespace into the diff.** `similar`'s own word
  splitter makes the space a token of its own, and the diff then matches the
  space after "every" against the space after "nightly" and calls it common
  text. A rewritten phrase came out interleaved with the words it replaced.
  Chunking as word-plus-space fixes it; comparing the chunks trimmed means a
  rewrapped line is not reported as a change.
- **One hue, two treatments.** Insertions and deletions share the suggestion
  colour and are told apart by underline against strikethrough, as a word
  processor does. A red/green pair reads as error and success rather than as
  before and after. The hue is not the app accent, because a proposed edit and
  a comment are different things and must not look like the same one.

## What this does not do

- **It cannot stop a session writing the file another way.** The skill says to
  keep using `apply` and not to reach for the Edit tool, but nothing enforces
  it; the document is an ordinary file. The mode is a working agreement the
  tooling supports, not a permission boundary. If sessions turn out to route
  around it, the fix is a `turn end` that notices the file moved while the mode
  was on and says so — not a lock, which would break the premise that the user
  keeps typing throughout.
- **Suggestions need the app.** They cannot be made or decided with the app
  closed, the same constraint `apply` already has. Reasonable, since the app is
  the only place the user could see them.
- **There is no partial accept.** A suggestion is one `apply`, accepted whole
  or not at all. Splitting one into per-word decisions would need the suggestion
  to be re-expressible as several `apply` calls, and Claude can already do that
  by making several smaller ones.
- **Suggestions are not re-anchored as the user types.** They are located by
  searching for their text; one whose text has moved on is dropped rather than
  matched onto a lookalike passage elsewhere. A real word processor keeps the
  suggestion alive across edits because it holds a position in the document, not
  a quote. Doing that here would mean suggestions living in the ProseMirror
  document rather than in a file beside it, which is a much larger change and
  would put review data back into the thing being reviewed.

## The mode is read per request, never cached

The app keeps a copy of `state.json` and refreshes it from the file watcher,
which debounces. The first version of this decided suggesting-vs-editing from
that copy, and QA caught the consequence at once: turn the mode on and issue an
`apply` before the refresh lands, and the edit is applied for real — the file
changed while the user had asked to be asked. It also re-anchored the comment to
text that was never in the document, which is how it was noticed.

So the mode now travels with the request. `ws.rs` reads `state.json` from disk
when the request arrives and puts the answer in the payload; the window obeys
that rather than its own copy. The rule this encodes is worth keeping: a cache
may drive what the toolbar draws, but never whether an edit lands.

## Undo

Accepting goes through the editor, so its step is in the undo history and Cmd+Z
takes the words back like any other edit. On its own that would lose the
proposal — the suggestion has been removed from the store, so the text returns
with nothing in the margin to decide again. So an accept is remembered for the
session and the undo is watched for in the text itself: the old words back and
the new ones gone is exactly what an undone accept looks like, and the
suggestion is recorded again. A redo removes it once more.

Watched in the text rather than hooked into `prosemirror-history` on purpose.
The condition above is the definition of the thing, so it needs nothing from
the history plugin's internals and cannot be broken by them changing.

Making this work at all needed the Edit menu fixed first. `PredefinedMenuItem::
undo` owns Cmd+Z, so macOS handled the key at the menu and the webview never saw
it — ProseMirror's history keymap never fired — and what the item did send was
WebKit's own DOM undo, which knows nothing about the editor's history. Undo is
now a normal menu id the UI routes: to the focused input when there is one, so a
half-typed comment still undoes itself, and to the document's history otherwise.

## Revisit if

Pending suggestions start outliving the session that made them often enough to
need an author on the card; a document collects enough of them that the margin
cannot hold them and they need a panel of their own; or dropping a suggestion
when the passage changes turns out to lose work people wanted, in which case the
answer is anchoring them in the document rather than reviving the dead card.
