# Sidenote: may a document load remote images?

Date: 2026-08-23

## Short answer

No. `img-src` is `'self' data: blob:`, so a markdown file cannot make the app
fetch anything over the network. Local images still render: the Rust side reads
them and hands back a `blob:` URL.

Revisit if blocked images turn out to be common in real documents. The follow-up
is not "loosen the policy" — see **If this changes** below.

## What the risk is

An image URL in a document is a tracking pixel. Loading it tells whoever wrote
the URL that the document was opened, when, and from which address, and the
query string can say which document and which reader. There is no code
execution in this; the disclosure is the whole payload.

It fits this app badly. A Sidenote document is assembled by an agent out of
sources nobody vetted — a scraped page, a README, an issue thread. An attacker
needs no more than for their markdown to survive into the file.

Confirmed against the running app on 2026-08-23: a document holding
`![](http://127.0.0.1:8931/opened-the-document.png)` fetched it on open with no
policy, and did not with one.

Worth being straight about the starting point: 0.1.19 ships with `csp: null`, so
today remote images load. Blocking them is a new restriction rather than a
defence of current behaviour.

## Why not simply allow them

Every other markdown editor renders them, and a reader who pastes a document
from elsewhere will think Sidenote is broken. That is the real cost, and it is
paid on every document that legitimately references a hosted image.

It is a smaller cost than it looks here. Sidenote documents are plans, reviews
and notes about local work, and a local `![](./shot.png)` is the common case —
which `read_image` already serves. A hosted image is the exception.

Against that: the beacon is silent, fires on every open, and this application's
entire job is reviewing content whose provenance the reader is unsure of.

## Why not fetch them in Rust instead

Fetching remote images from the Rust side and serving them as `blob:` URLs
would render them while keeping the policy strict. It does not fix anything.
The request still leaves the user's machine from the user's address, so the
disclosure is identical; only the process making it changes.

It also costs a TLS stack in a binary that avoids one on purpose — `update.rs`
shells out to `curl` for its one request a day rather than link one — and adds
a request-forgery surface, since a document would be choosing what the app
connects to.

## If this changes

The answer is not a looser `img-src`. Tauri fixes the policy at build time, so
there is no way to relax it for one document at runtime.

Blocked-by-default with a per-document opt-in — the way mail clients settled
this — has to be built on the Rust fetch above, plus consent before it runs.
That is worth doing if hosted images turn out to be common, and the prompt is
itself useful: *this document wants to contact three hosts* is exactly the sort
of thing a review tool should say out loud.

## Consequences to pick up

- `app/src/editor/images.ts` on the `image-previews` branch passes `https?` URLs
  straight to the webview, where the policy now stops them. Its placeholder
  reads **"Image not found"**, which will be untrue: the file is not missing, it
  was refused. That copy has to change before the two branches meet.
- Nothing else needs to change. Local images already go through `read_image`.
