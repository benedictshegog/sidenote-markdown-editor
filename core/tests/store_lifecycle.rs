//! Plays the skill's steps against a temporary app directory, without an LLM.

use std::fs;
use std::path::Path;
use std::time::Duration;

use sidenote_core::{anchor, make_selector, plain_text, Store, ThreadStatus, SidenoteError};

const DOC: &str = r#"# Restore plan

The restore then deletes its own hold row in `finally`.

- one item
- two item with `code`
- run the job

| col a | col b |
|---|---|
| run the job | again |

Run the job once more at the end.
"#;

fn setup() -> (tempfile::TempDir, Store, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let store = Store::at(&home).unwrap();
    let doc = tmp.path().join("restore.md");
    fs::write(&doc, DOC).unwrap();
    (tmp, store, doc)
}

fn selector_for(md: &str, phrase: &str) -> sidenote_core::Selector {
    let text = plain_text(md);
    let start = text.find(phrase).expect("phrase present");
    let cs = text[..start].chars().count();
    let ce = cs + phrase.chars().count();
    make_selector(&text, cs, ce)
}

#[test]
fn register_is_idempotent_and_snapshots() {
    let (_t, store, doc) = setup();
    let (d1, created) = store.register(&doc, Some("sid-a")).unwrap();
    assert!(created);
    assert_eq!(d1.title, "Restore plan");
    assert_eq!(d1.owner_session.as_deref(), Some("sid-a"));
    assert_eq!(store.snapshots(&d1.id).unwrap().len(), 1);

    let (d2, created) = store.register(&doc, Some("sid-b")).unwrap();
    assert!(!created);
    assert_eq!(d2.id, d1.id);
    assert_eq!(d2.owner_session.as_deref(), Some("sid-b"));
    assert_eq!(store.list().unwrap().len(), 1);
}

#[test]
fn full_turn_cycle() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();

    // User comments on a phrase.
    let sel = selector_for(DOC, "deletes its own hold row");
    let th = store.create_thread(&d.id, sel, "Why in finally?").unwrap();
    assert_eq!(th.id, "c1");

    // User edits the document in the app.
    let edited = DOC.replace("two item", "second item");
    fs::write(&doc, &edited).unwrap();

    // Claude's turn begins.
    let tb = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    assert_eq!(tb.threads.len(), 1);
    assert_eq!(tb.snapshot.as_deref(), Some("v001"));
    assert!(tb.diff.contains("-- two item"), "{}", tb.diff);
    assert!(tb.diff.contains("+- second item"), "{}", tb.diff);
    // turn begin does not lock; lock does, right before an edit.
    assert!(!store.read_state(&d.id).unwrap().busy);
    store.lock(&doc, "sid-a", Duration::ZERO).unwrap();
    assert!(store.read_state(&d.id).unwrap().busy);

    // Claude rewrites the anchored sentence a little and replies.
    let rewritten = edited.replace(
        "deletes its own hold row in `finally`",
        "removes its own hold row inside `finally`",
    );
    fs::write(&doc, &rewritten).unwrap();
    store
        .reply(&doc, "sid-a", "c1", "Reworded; finally covers dead-letter returns.", true)
        .unwrap();

    let te = store.turn_end(&doc, "sid-a").unwrap();
    assert_eq!(te.snapshot, "v002");
    assert!(!te.new_user_messages);
    assert_eq!(te.open, 1);
    assert!(!store.read_state(&d.id).unwrap().busy);

    // Claude's reply leaves the thread open; only the user resolves.
    let threads = store.threads(&doc, true).unwrap();
    assert_eq!(threads[0].status, ThreadStatus::Open);
    assert_eq!(threads[0].messages.len(), 2);
    assert!(threads[0].done);
    assert!(!threads[0].awaits_claude());
    store.set_status(&d.id, "c1", ThreadStatus::Resolved).unwrap();
    assert_eq!(store.threads(&doc, false).unwrap().len(), 0);
}

#[test]
fn reanchor_fuzzy_and_orphan() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store
        .create_thread(&d.id, selector_for(DOC, "deletes its own hold row"), "q1")
        .unwrap();
    store
        .create_thread(&d.id, selector_for(DOC, "two item with code"), "q2")
        .unwrap();
    // Third thread on the repeated phrase inside the table.
    let text = plain_text(DOC);
    let start = text.rfind("run the job\nagain").unwrap();
    let cs = text[..start].chars().count();
    let sel = make_selector(&text, cs, cs + "run the job".chars().count());
    store.create_thread(&d.id, sel, "q3").unwrap();

    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    let rewritten = DOC
        .replace("deletes its own hold row in `finally`", "removes its hold row in `finally`")
        .replace("- two item with `code`\n", "- a completely different bullet about cabbages\n");
    fs::write(&doc, &rewritten).unwrap();
    let te = store.turn_end(&doc, "sid-a").unwrap();
    assert_eq!(te.orphaned, vec!["c2".to_string()]);
    assert_eq!(te.anchored, vec!["c1".to_string(), "c3".to_string()]);

    let threads = store.threads(&doc, true).unwrap();
    let c1 = threads.iter().find(|t| t.id == "c1").unwrap();
    assert_eq!(c1.status, ThreadStatus::Open);
    assert!(c1.selector.exact.contains("hold row"), "{:?}", c1.selector);
    let c3 = threads.iter().find(|t| t.id == "c3").unwrap();
    // Still the table occurrence, not the bullet or the closing sentence.
    assert!(c3.selector.suffix.starts_with("\nagain"), "{:?}", c3.selector);
    let new_text = plain_text(&rewritten);
    let a = anchor(&new_text, &c3.selector).unwrap();
    let got: String = new_text.chars().skip(a.range.start).take(a.range.end - a.range.start).collect();
    assert_eq!(got, "run the job");
}

#[test]
fn lock_and_ownership_rules() {
    let (_t, store, doc) = setup();
    store.register(&doc, Some("sid-a")).unwrap();

    // sid-a holds a fresh lock: sid-b is refused with exit 3.
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    store.lock(&doc, "sid-a", Duration::ZERO).unwrap();
    let err = store.turn_begin(&doc, "sid-b", Duration::ZERO).unwrap_err();
    assert!(matches!(err, SidenoteError::Locked { .. }), "{err}");
    assert_eq!(err.exit_code(), 3);
    store.turn_end(&doc, "sid-a").unwrap();

    // Owner connected (listeners file names it): sid-b is refused with exit 3.
    store.write_listeners(vec!["sid-a".into()]).unwrap();
    let err = store.turn_begin(&doc, "sid-b", Duration::ZERO).unwrap_err();
    assert!(matches!(err, SidenoteError::OwnerConnected { .. }), "{err}");
    assert_eq!(err.exit_code(), 3);

    // Owner absent: sid-b takes over.
    store.write_listeners(vec![]).unwrap();
    let tb = store.turn_begin(&doc, "sid-b", Duration::ZERO).unwrap();
    assert_eq!(tb.took_over_from.as_deref(), Some("sid-a"));
    assert_eq!(tb.doc.owner_session.as_deref(), Some("sid-b"));
    store.turn_end(&doc, "sid-b").unwrap();
}

#[test]
fn unlock_makes_reply_and_end_exit_5() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store
        .create_thread(&d.id, selector_for(DOC, "job once more"), "q")
        .unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    store.lock(&doc, "sid-a", Duration::ZERO).unwrap();
    store.unlock(&d.id).unwrap();

    let err = store.reply(&doc, "sid-a", "c1", "late", false).unwrap_err();
    assert!(matches!(err, SidenoteError::Unlocked { .. }), "{err}");
    assert_eq!(err.exit_code(), 5);
    let err = store.turn_end(&doc, "sid-a").unwrap_err();
    assert_eq!(err.exit_code(), 5);

    // A new turn clears the unlocked marker.
    let tb = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    assert_eq!(tb.threads.len(), 1);
    store.turn_end(&doc, "sid-a").unwrap();
}

#[test]
fn comment_during_turn_exits_4() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    // The user posts while Claude is busy.
    store
        .create_thread(&d.id, selector_for(DOC, "one item"), "during")
        .unwrap();
    let te = store.turn_end(&doc, "sid-a").unwrap();
    assert!(te.new_user_messages);
    assert!(!store.read_state(&d.id).unwrap().busy);
}

#[test]
fn unregistered_doc_is_exit_2() {
    let (_t, store, doc) = setup();
    let err = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap_err();
    assert_eq!(err.exit_code(), 2);
    assert!(store.find_doc(Path::new("/nonexistent.md")).unwrap().is_none());
}

#[test]
fn snapshot_prune_keeps_fifty() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    for i in 0..55 {
        store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
        fs::write(&doc, format!("{DOC}\nedit {i}\n")).unwrap();
        store.turn_end(&doc, "sid-a").unwrap();
    }
    let snaps = store.snapshots(&d.id).unwrap();
    assert_eq!(snaps.len(), 50);
    assert_eq!(snaps.last().unwrap().name(), "v056");
}

#[test]
fn anchor_thread_repoints_after_rewrite() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store
        .create_thread(&d.id, selector_for(DOC, "deletes its own hold row"), "rewrite")
        .unwrap();
    let rewritten = DOC.replace(
        "The restore then deletes its own hold row in `finally`.",
        "Cleanup happens in `finally`: the hold row goes away whatever the outcome.",
    );
    fs::write(&doc, &rewritten).unwrap();
    let t = store.anchor_thread(&doc, "sid-a", "c1", "the hold row goes away").unwrap();
    assert_eq!(t.selector.exact, "the hold row goes away");
    assert_eq!(t.status, ThreadStatus::Open);
    assert!(store.anchor_thread(&doc, "sid-a", "c1", "no such text").is_err());
}

#[test]
fn reply_only_turn_takes_no_snapshot() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.create_thread(&d.id, selector_for(DOC, "one item"), "q").unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    store.reply(&doc, "sid-a", "c1", "answer", false).unwrap();
    let te = store.turn_end(&doc, "sid-a").unwrap();
    assert_eq!(te.snapshot, "v001");
    assert_eq!(store.snapshots(&d.id).unwrap().len(), 1);
}

#[test]
fn note_creates_claude_thread() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let t = store.note(&doc, "sid-a", "two item", "Renamed this item.").unwrap();
    assert_eq!(t.messages[0].author, sidenote_core::Author::Claude);
    assert!(!t.awaits_claude());
    assert_eq!(t.selector.exact, "two item");
    assert!(store.note(&doc, "sid-a", "absent text", "x").is_err());
    assert_eq!(store.read_threads(&d.id).unwrap().threads.len(), 1);
}

#[test]
fn restore_snapshot_round_trip() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    fs::write(&doc, DOC.replace("one item", "first item")).unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    store.turn_end(&doc, "sid-a").unwrap(); // v002
    let diff = store.diff_snapshot(&d.id, "v001", None).unwrap();
    assert!(diff.contains("+- first item"), "{diff}");
    let snap = store.restore_snapshot(&d.id, "v001").unwrap();
    assert_eq!(fs::read_to_string(&doc).unwrap(), DOC);
    // v002 already held the pre-restore text, so only the restored state is added.
    assert_eq!(snap.name(), "v003");
    assert_eq!(store.read_snapshot(&d.id, "v003").unwrap(), DOC);
}

/// A comment left while the session was away is replayed when it reconnects:
/// the store can name every thread still waiting for the owner.
#[test]
fn pending_for_session_lists_waiting_threads_of_owned_docs() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();

    // Nothing waiting yet.
    assert!(store.pending_for_session("sid-a").unwrap().is_empty());

    let sel = selector_for(DOC, "deletes its own hold row");
    let t1 = store.create_thread(&d.id, sel, "why here?").unwrap();

    let pending = store.pending_for_session("sid-a").unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0.id, d.id);
    assert_eq!(pending[0].1, vec![t1.id.clone()]);

    // Another session owns nothing.
    assert!(store.pending_for_session("sid-b").unwrap().is_empty());

    // A reply clears it; the thread now waits on the user.
    store.reply(&doc, "sid-a", &t1.id, "because the hold is ours.", false).unwrap();
    assert!(store.pending_for_session("sid-a").unwrap().is_empty());

    // Ownership moves; the backlog moves with it.
    store.add_message(&d.id, &t1.id, sidenote_core::Author::User, "still unclear", None).unwrap();
    store.register(&doc, Some("sid-b")).unwrap();
    assert!(store.pending_for_session("sid-a").unwrap().is_empty());
    assert_eq!(store.pending_for_session("sid-b").unwrap().len(), 1);
}

/// `apply` replaces the passage, re-anchors the thread, replies and leaves
/// the lock clear, all in one call.
#[test]
fn apply_edits_reanchors_and_releases_the_lock() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let sel = selector_for(DOC, "deletes its own hold row");
    let t1 = store.create_thread(&d.id, sel, "say which hold").unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();

    let r = store
        .apply(
            &doc,
            "sid-a",
            "deletes its own hold row in `finally`",
            "drops the hold it took in `finally`",
            Some(&t1.id),
            Some("named the hold."),
            true,
            Duration::ZERO,
        )
        .unwrap();

    let text = fs::read_to_string(&doc).unwrap();
    assert!(text.contains("drops the hold it took"));
    assert!(!text.contains("deletes its own hold row"));
    assert!(!r.orphaned);
    assert!(!r.kept_lock);

    // The thread followed the text, and the reply landed.
    let th = r.thread.unwrap();
    assert!(th.selector.exact.contains("drops the hold it took"));
    assert!(th.done);
    assert_eq!(th.messages.last().unwrap().body, "named the hold.");
    assert!(!th.working, "a reply clears the working marker");

    // The lock is clear, and the focus says where the edit landed.
    let st = store.read_state(&d.id).unwrap();
    assert!(!st.busy, "apply must not leave the document read-only");
    let focus = st.focus.expect("focus recorded");
    assert!(focus.exact.contains("drops the hold it took"));
    assert_eq!(focus.session, "sid-a");
    assert_eq!(focus.thread.as_deref(), Some(t1.id.as_str()));

    // turn end clears the focus with the rest of the turn state.
    store.turn_end(&doc, "sid-a").unwrap();
    assert!(store.read_state(&d.id).unwrap().focus.is_none());
}

/// When the app has already landed the edit in its editor, the CLI only has
/// the second half to do: focus, re-anchor and reply. The file is the app's
/// to write, so this must not touch it.
#[test]
fn finish_apply_records_the_edit_without_writing_the_file() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let sel = selector_for(DOC, "deletes its own hold row");
    let t1 = store.create_thread(&d.id, sel, "say which hold").unwrap();
    store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();

    // The app wrote the file itself, as its autosave does.
    let edited = DOC.replace("deletes its own hold row in `finally`", "drops the hold it took in `finally`");
    fs::write(&doc, &edited).unwrap();
    let before = fs::metadata(&doc).unwrap().modified().unwrap();

    let (d2, kept) = store.apply_precheck(&doc, "sid-a").unwrap();
    assert!(!kept);
    let r = store
        .finish_apply(&d2, "sid-a", "drops the hold it took in finally", Some(&t1.id), Some("named the hold."), true)
        .unwrap();

    assert_eq!(fs::read_to_string(&doc).unwrap(), edited);
    assert_eq!(fs::metadata(&doc).unwrap().modified().unwrap(), before);
    assert!(!r.orphaned);
    let th = r.thread.unwrap();
    assert!(th.selector.exact.contains("drops the hold it took"));
    assert!(th.done);
    assert_eq!(th.messages.last().unwrap().body, "named the hold.");
    let st = store.read_state(&d.id).unwrap();
    assert!(!st.busy);
    assert!(st.focus.unwrap().exact.contains("drops the hold it took"));

    // Another session may not finish an apply on a document it does not own.
    assert_eq!(store.apply_precheck(&doc, "sid-b").unwrap_err().exit_code(), 3);
}

/// An edit written against text the user has since changed fails loudly
/// instead of overwriting them, and leaves the file and the lock alone.
#[test]
fn apply_refuses_text_that_is_missing_or_ambiguous() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let before = fs::read_to_string(&doc).unwrap();

    for (old, found) in [("text the user already rewrote", 0usize), ("run the job", 2)] {
        let e = store
            .apply(&doc, "sid-a", old, "x", None, None, false, Duration::ZERO)
            .unwrap_err();
        match e {
            SidenoteError::Stale { found: n, .. } => assert_eq!(n, found, "for {old:?}"),
            other => panic!("expected Stale for {old:?}, got {other:?}"),
        }
        assert_eq!(e.exit_code(), 6);
    }

    assert_eq!(fs::read_to_string(&doc).unwrap(), before, "file untouched");
    assert!(!store.read_state(&d.id).unwrap().busy, "lock released");
}

/// `working_since` separates the thread Claude is on now from the ones a
/// turn merely picked up.
#[test]
fn working_since_marks_the_live_thread() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let a = store
        .create_thread(&d.id, selector_for(DOC, "one item"), "trim this")
        .unwrap();
    let b = store
        .create_thread(&d.id, selector_for(DOC, "two item"), "and this")
        .unwrap();
    assert!(a.working_since.is_none());

    let begun = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    assert_eq!(begun.threads.len(), 2);
    assert!(begun.threads.iter().all(|t| t.working && t.working_since.is_some()));

    // Replying to one clears only that one.
    store.reply(&doc, "sid-a", &a.id, "trimmed.", true).unwrap();
    let threads = store.read_threads(&d.id).unwrap().threads;
    let live: Vec<&sidenote_core::Thread> = threads.iter().filter(|t| t.working).collect();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].id, b.id);
    assert!(live[0].working_since.is_some());
}

/// Only the owner writes. A second session cannot edit the file or answer a
/// thread behind the owner's back, whether or not the owner is connected —
/// it has to take the document over through `turn begin` first.
#[test]
fn a_non_owner_session_cannot_write() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let t1 = store
        .create_thread(&d.id, selector_for(DOC, "one item"), "trim this")
        .unwrap();
    let before = fs::read_to_string(&doc).unwrap();

    let is_not_owner = |e: &SidenoteError| {
        assert!(matches!(e, SidenoteError::NotOwner { .. }), "got {e:?}");
        assert_eq!(e.exit_code(), 3);
    };

    is_not_owner(&store.reply(&doc, "sid-b", &t1.id, "mine now", false).unwrap_err());
    is_not_owner(&store.lock(&doc, "sid-b", Duration::ZERO).unwrap_err());
    is_not_owner(&store.note(&doc, "sid-b", "one item", "hello").unwrap_err());
    is_not_owner(&store.anchor_thread(&doc, "sid-b", &t1.id, "two item").unwrap_err());
    is_not_owner(&store.turn_end(&doc, "sid-b").unwrap_err());
    is_not_owner(
        &store
            .apply(&doc, "sid-b", "one item", "ONE ITEM", None, None, false, Duration::ZERO)
            .unwrap_err(),
    );

    assert_eq!(fs::read_to_string(&doc).unwrap(), before, "file untouched");
    assert_eq!(
        store.read_threads(&d.id).unwrap().threads[0].messages.len(),
        1,
        "no reply was appended"
    );

    // The owner is unaffected, and the documented way in still works: the
    // owner is not connected here, so turn begin hands the document over.
    store.reply(&doc, "sid-a", &t1.id, "trimmed.", true).unwrap();
    store.turn_end(&doc, "sid-a").unwrap();
    store.add_message(&d.id, &t1.id, sidenote_core::Author::User, "again", None).unwrap();
    let begun = store.turn_begin(&doc, "sid-b", Duration::ZERO).unwrap();
    assert_eq!(begun.took_over_from.as_deref(), Some("sid-a"));
    store.reply(&doc, "sid-b", &t1.id, "now mine", false).unwrap();
}

/// A document nobody owns is open to whoever gets there first — that is the
/// file you opened with Cmd+O, not one a session created.
#[test]
fn an_unowned_document_accepts_any_session() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, None).unwrap();
    assert!(d.owner_session.is_none());
    let t1 = store
        .create_thread(&d.id, selector_for(DOC, "one item"), "trim this")
        .unwrap();
    store.reply(&doc, "sid-whoever", &t1.id, "done", true).unwrap();
}

/// Unread is Claude's word arriving where the user has not looked since.
#[test]
fn unread_tracks_claude_replies_the_user_has_not_opened() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let t1 = store
        .create_thread(&d.id, selector_for(DOC, "one item"), "trim this")
        .unwrap();

    // The user's own comment is not unread to the user.
    assert!(!store.read_threads(&d.id).unwrap().threads[0].unread());
    assert!(store.unread_counts().unwrap().is_empty());

    store.reply(&doc, "sid-a", &t1.id, "trimmed.", true).unwrap();
    assert!(store.read_threads(&d.id).unwrap().threads[0].unread());
    let counts = store.unread_counts().unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].1, 1);

    // Opening it clears the count.
    store.mark_read(&d.id, &t1.id).unwrap();
    assert!(!store.read_threads(&d.id).unwrap().threads[0].unread());
    assert!(store.unread_counts().unwrap().is_empty());

    // A later reply makes it unread again.
    store.add_message(&d.id, &t1.id, sidenote_core::Author::User, "one more thing", None).unwrap();
    store.reply(&doc, "sid-a", &t1.id, "done.", false).unwrap();
    assert!(store.read_threads(&d.id).unwrap().threads[0].unread());

    // Resolving is the user's own act, so it can only follow reading.
    store.set_status(&d.id, &t1.id, ThreadStatus::Resolved).unwrap();
    assert!(!store.read_threads(&d.id).unwrap().threads[0].unread());
    assert!(store.unread_counts().unwrap().is_empty());
}

/// A thread Claude starts itself is unread from the moment it exists.
#[test]
fn a_note_from_claude_is_unread() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.note(&doc, "sid-a", "one item", "Renamed while tidying.").unwrap();
    assert_eq!(store.unread_counts().unwrap()[0].1, 1);
}

/// The app's autosave and a snapshot restore both go through `write_document`,
/// which respects the lock a session holds. Before this, `restore_snapshot`
/// wrote the file with no check at all, so restoring a version while Claude
/// was mid-turn overwrote it and told nobody.
#[test]
fn the_app_cannot_write_a_locked_document() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.lock(&doc, "sid-a", Duration::ZERO).unwrap();

    let err = store.write_document(&doc, "the user's autosave").unwrap_err();
    assert!(matches!(err, SidenoteError::Locked { .. }), "{err:?}");
    assert_eq!(fs::read_to_string(&doc).unwrap(), DOC, "the file is untouched");

    let restore = store.restore_snapshot(&d.id, "v001").unwrap_err();
    assert!(matches!(restore, SidenoteError::Locked { .. }), "{restore:?}");

    // Once the turn ends the same write goes through.
    store.turn_end(&doc, "sid-a").unwrap();
    store.write_document(&doc, "the user's autosave").unwrap();
    assert_eq!(fs::read_to_string(&doc).unwrap(), "the user's autosave");
}

/// An update that changes nothing must not touch the file. Every write here
/// wakes the recursive watcher on `docs/`, which recounts the Dock badge over
/// every registered document, and the per-document watcher, which reloads
/// threads in each open tab. The app calls `update_selectors` after every
/// autosave, so this ran on each keystroke burst whether or not a selector
/// had actually moved.
#[test]
fn an_update_that_changes_nothing_does_not_write() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store
        .create_thread(&d.id, selector_for(DOC, "deletes its own hold row"), "q1")
        .unwrap();

    let path = store.threads_path(&d.id);
    let before = fs::metadata(&path).unwrap().modified().unwrap();

    // A no-op pass over the threads.
    store.update_threads(&d.id, |_t| Ok(())).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        before,
        "threads.json was rewritten with identical content"
    );

    // A real change still lands.
    store.set_status(&d.id, "c1", ThreadStatus::Resolved).unwrap();
    assert_ne!(fs::metadata(&path).unwrap().modified().unwrap(), before);
}

/// The point of the lock `apply` takes: the app cannot land an autosave in the
/// middle of a session's read-modify-write.
///
/// `apply` marks the document busy, waits for the app to flush, then reads and
/// writes under the document lock. An autosave arriving inside that window is
/// refused rather than applied on top — which is what used to make the
/// session's write, built from the earlier read, erase it.
#[test]
fn an_autosave_cannot_land_inside_an_apply() {
    let (_t, store, doc) = setup();
    store.register(&doc, Some("sid-a")).unwrap();

    let bg = {
        let store = store.clone();
        let doc = doc.clone();
        std::thread::spawn(move || {
            store.apply(
                &doc,
                "sid-a",
                "deletes its own hold row",
                "removes the hold row",
                None,
                None,
                false,
                Duration::from_millis(600),
            )
        })
    };

    // Inside the wait, while the session holds it.
    std::thread::sleep(Duration::from_millis(200));
    let err = store
        .write_document(&doc, "an autosave that must not win")
        .unwrap_err();
    assert!(matches!(err, SidenoteError::Locked { .. }), "{err:?}");

    let applied = bg.join().unwrap().unwrap();
    assert!(!applied.kept_lock);

    let after = fs::read_to_string(&doc).unwrap();
    assert!(after.contains("removes the hold row"), "the edit landed");
    assert!(after.contains("# Restore plan"), "the rest of the file survived");
    assert!(!after.contains("an autosave that must not win"));

    // The lock is released, so the app can write again.
    store.write_document(&doc, "the user types again").unwrap();
    assert_eq!(fs::read_to_string(&doc).unwrap(), "the user types again");
}

// ---- suggesting mode -----------------------------------------------------
//
// The mode lives on the app path: the app matches `old` against the text it is
// showing and records the suggestion, and accepting one goes back through its
// editor. These tests stand in for the app, calling the primitives it calls.

/// The whole point of the mode: the file does not move until the user accepts.
#[test]
fn a_suggestion_leaves_the_file_alone_until_it_is_accepted() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let sel = selector_for(DOC, "deletes its own hold row");
    let t1 = store.create_thread(&d.id, sel, "say which hold").unwrap();
    store.set_suggesting(&d.id, true).unwrap();
    let before = fs::read_to_string(&doc).unwrap();

    let sug = store
        .record_suggestion(
            &d.id,
            "sid-a",
            "deletes its own hold row in finally",
            "drops the hold it took in `finally`",
            Some(&t1.id),
        )
        .unwrap();
    let thread = store
        .finish_suggestion(&d, "sid-a", Some(&t1.id), Some("Suggested naming the hold."))
        .unwrap()
        .expect("the thread comes back");

    assert_eq!(sug.id, "s1");
    assert_eq!(fs::read_to_string(&doc).unwrap(), before, "the file must not move");
    assert_eq!(store.read_suggestions(&d.id).unwrap().suggestions.len(), 1);

    // The reply lands so the card can say why — but not the check mark.
    assert_eq!(thread.messages.last().unwrap().body, "Suggested naming the hold.");
    assert!(!thread.done, "a pending suggestion has not done anything yet");

    // Nothing was written, so nothing needed the user to go read-only.
    let st = store.read_state(&d.id).unwrap();
    assert!(!st.busy);
    assert!(st.focus.is_none());

    // The app applies the edit in its editor and saves, then reports what
    // landed; the store does the bookkeeping. Stand in for both halves.
    let text = fs::read_to_string(&doc).unwrap();
    fs::write(
        &doc,
        text.replace(
            "deletes its own hold row in `finally`",
            "drops the hold it took in `finally`",
        ),
    )
    .unwrap();
    let acc = store
        .accept_suggestion_applied(&d.id, &sug.id, "drops the hold it took in finally")
        .unwrap();
    assert!(!acc.orphaned);
    assert!(
        acc.thread.unwrap().selector.exact.contains("drops the hold it took"),
        "the thread follows the text it is about"
    );
    assert!(store.read_suggestions(&d.id).unwrap().suggestions.is_empty());
}

#[test]
fn rejecting_drops_the_suggestion_and_changes_nothing() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.set_suggesting(&d.id, true).unwrap();
    let before = fs::read_to_string(&doc).unwrap();

    let sug = store
        .record_suggestion(&d.id, "sid-a", "Run the job once more", "Run it again", None)
        .unwrap();
    store.reject_suggestion(&d.id, &sug.id).unwrap();

    assert_eq!(fs::read_to_string(&doc).unwrap(), before);
    assert!(store.read_suggestions(&d.id).unwrap().suggestions.is_empty());
    // Gone for good, and asking again is an error rather than a silent no-op.
    assert!(store.reject_suggestion(&d.id, &sug.id).is_err());
    assert!(store.accept_suggestion_applied(&d.id, &sug.id, "anything").is_err());
}

/// The file path has no app in it, so it cannot offer the user the decision the
/// mode promises. It must refuse rather than write anyway.
#[test]
fn the_file_path_refuses_while_the_mode_is_on() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.set_suggesting(&d.id, true).unwrap();
    let before = fs::read_to_string(&doc).unwrap();

    let e = store
        .apply(&doc, "sid-a", "Run the job once more", "Run it again", None, None, false, Duration::ZERO)
        .unwrap_err();
    assert!(format!("{e}").contains("suggesting mode"), "{e}");
    assert_eq!(fs::read_to_string(&doc).unwrap(), before);

    // With the mode off it writes as it always did.
    store.set_suggesting(&d.id, false).unwrap();
    store
        .apply(&doc, "sid-a", "Run the job once more", "Run it again", None, None, false, Duration::ZERO)
        .unwrap();
    assert!(fs::read_to_string(&doc).unwrap().contains("Run it again"));
}

/// A session has to be told the mode before it decides how to phrase a turn,
/// and what is already pending so it does not propose the same thing twice.
#[test]
fn turn_begin_reports_the_mode_and_what_is_pending() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();

    let tb = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    assert!(!tb.suggesting);
    assert!(tb.pending.is_empty());

    store.set_suggesting(&d.id, true).unwrap();
    store
        .record_suggestion(&d.id, "sid-a", "Run the job once more", "Run it again", None)
        .unwrap();

    let tb = store.turn_begin(&doc, "sid-a", Duration::ZERO).unwrap();
    assert!(tb.suggesting);
    assert_eq!(tb.pending.len(), 1, "a session must see what it already proposed");
    assert_eq!(tb.pending[0].old, "Run the job once more");
}

/// Turning the mode off must not throw away work the user has not looked at.
#[test]
fn leaving_the_mode_keeps_pending_suggestions() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    store.set_suggesting(&d.id, true).unwrap();
    store
        .record_suggestion(&d.id, "sid-a", "Run the job once more", "Run it again", None)
        .unwrap();

    let st = store.set_suggesting(&d.id, false).unwrap();
    assert!(!st.suggesting);
    assert_eq!(store.read_suggestions(&d.id).unwrap().suggestions.len(), 1);
}

/// Ids are unique for the document's life, so a card cannot inherit the
/// decision meant for a suggestion that has already gone.
#[test]
fn suggestion_ids_do_not_repeat() {
    let (_t, store, doc) = setup();
    let (d, _) = store.register(&doc, Some("sid-a")).unwrap();
    let a = store.record_suggestion(&d.id, "sid-a", "one item", "first item", None).unwrap();
    let b = store.record_suggestion(&d.id, "sid-a", "two item", "second item", None).unwrap();
    assert_eq!((a.id.as_str(), b.id.as_str()), ("s1", "s2"));
    store.reject_suggestion(&d.id, &b.id).unwrap();
    let c = store.record_suggestion(&d.id, "sid-a", "two item", "second item", None).unwrap();
    assert_eq!(c.id, "s3", "a freed id must not be handed out again");
}
