//! `sidenote`: the command line the Claude Code skill drives. Every subcommand
//! is a thin wrapper over `sidenote_core::Store`; the exit codes are the
//! protocol.

use std::path::PathBuf;
use std::process::{exit, Command};
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use sidenote_core::{exit as code, store::Applied, SidenoteError, Store, Thread, ThreadStatus};

#[derive(Parser)]
#[command(
    name = "sidenote",
    version,
    about = "Review data for Sidenote documents",
    long_about = "Exit codes: 0 ok, 1 error, 2 not registered, 3 locked by another session, 4 new comments arrived during the turn, 5 the lock was cleared by Unlock, 6 the text an apply targets is missing or ambiguous, 7 apply needs the document open in the app."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Args)]
struct FileArg {
    /// Path of the markdown document.
    file: PathBuf,
}

#[derive(Subcommand)]
enum Cmd {
    /// Register a document for review (idempotent).
    Register {
        #[command(flatten)]
        file: FileArg,
        /// Open the document in the Sidenote app.
        #[arg(long)]
        open: bool,
        /// Print the index entry as JSON.
        #[arg(long)]
        json: bool,
    },
    /// List registered documents.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Start or end a Claude turn.
    Turn {
        #[command(subcommand)]
        cmd: TurnCmd,
    },
    /// Lock the document before editing it (the app turns read-only and
    /// flushes its autosave). Not needed for replies.
    Lock {
        #[command(flatten)]
        file: FileArg,
        /// Seconds to wait after locking so the app's autosave lands.
        #[arg(long, default_value = "1")]
        wait: f64,
    },
    /// Confirm receipt of one or more threads. The app shows 👀 on them
    /// until a reply (or `turn end`) clears it. Run it the moment an event
    /// arrives, before `turn begin`.
    Ack {
        #[command(flatten)]
        file: FileArg,
        /// Thread ids, for example c12 c13.
        #[arg(required = true)]
        threads: Vec<String>,
    },
    /// Append a Claude reply to a thread. Replies never resolve; the user
    /// resolves threads in the app.
    Reply {
        #[command(flatten)]
        file: FileArg,
        /// Thread id, for example c12.
        thread: String,
        /// Reply text.
        text: String,
        /// Mark the thread as actioned (a check mark in the app). Only when
        /// the file was changed for it, never for a reply-only answer.
        #[arg(long)]
        done: bool,
    },
    /// Start a thread yourself: a note on a passage you changed outside any
    /// comment, or a question for the user.
    Note {
        #[command(flatten)]
        file: FileArg,
        /// Exact text in the current document to anchor the note to.
        exact: String,
        /// Note text.
        text: String,
    },
    /// Replace one exact passage and answer its thread, as one operation.
    /// Preferred over the Edit tool: it holds the lock for the write alone,
    /// re-anchors the thread for you, and refuses an edit written against
    /// text the user has since changed.
    Apply {
        #[command(flatten)]
        file: FileArg,
        /// Exact text to replace. Must occur exactly once in the file.
        #[arg(long)]
        old: String,
        /// Replacement text. `-` reads it from stdin.
        #[arg(long)]
        new: String,
        /// Thread this edit answers; it is re-anchored to the new text.
        #[arg(long)]
        thread: Option<String>,
        /// Reply to leave on that thread.
        #[arg(long)]
        reply: Option<String>,
        /// Mark the thread actioned (a check mark in the app).
        #[arg(long)]
        done: bool,
        /// Accepted for the file path only (`SIDENOTE_APPLY_FILE=1`): seconds
        /// to wait after locking so the app's autosave lands. The app path
        /// needs no lock and ignores it.
        #[arg(long, default_value = "1")]
        wait: f64,
    },
    /// Show or set suggesting mode. While it is on, `apply` proposes the edit
    /// instead of making it and the user accepts or rejects it in the app.
    /// Normally the user sets this in the app; read it before you edit.
    Suggest {
        #[command(flatten)]
        file: FileArg,
        /// Turn suggesting mode on.
        #[arg(long, conflicts_with = "off")]
        on: bool,
        /// Turn it off. Pending suggestions are kept either way.
        #[arg(long)]
        off: bool,
        /// Print the mode and every pending suggestion as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Point a thread at new text after rewriting the passage it was on.
    Anchor {
        #[command(flatten)]
        file: FileArg,
        /// Thread id, for example c12.
        thread: String,
        /// Exact text in the current document to anchor the thread to.
        exact: String,
    },
    /// Print the ids of threads awaiting a Claude reply, one line, space
    /// separated (empty when none). Cheap and stable: the polling fallback
    /// watches this instead of `threads.json`, whose mtime a turn changes.
    Waiting {
        #[command(flatten)]
        file: FileArg,
    },
    /// Print threads as JSON (open and orphaned by default).
    Threads {
        #[command(flatten)]
        file: FileArg,
        /// Include resolved threads.
        #[arg(long)]
        all: bool,
    },
    /// Open a document in the Sidenote app (registers it first).
    Open {
        #[command(flatten)]
        file: FileArg,
    },
    /// Print the app directory path.
    Home,
    /// Install or update the Claude Code skill (~/.claude/skills/sidenote-review).
    InstallSkill {
        /// Overwrite an existing copy even if it is newer or edited.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
enum TurnCmd {
    /// Print waiting threads and the user's edits since the last snapshot.
    Begin {
        #[command(flatten)]
        file: FileArg,
        #[arg(long)]
        json: bool,
        /// Seconds to wait after locking so the app's autosave lands.
        #[arg(long, default_value = "1")]
        wait: f64,
    },
    /// Re-anchor threads, snapshot if the text changed, clear the lock.
    End {
        #[command(flatten)]
        file: FileArg,
        #[arg(long)]
        json: bool,
    },
}

fn main() {
    // Die quietly when stdout is closed early (`sidenote list | head`).
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = Cli::parse();
    match run(cli) {
        Ok(c) => exit(c),
        Err(e) => {
            eprintln!("sidenote: {e}");
            exit(e.exit_code());
        }
    }
}

fn session() -> String {
    sidenote_core::util::current_session().unwrap_or_else(|| "local".to_string())
}

/// Hand the edit to the running app, which lands it in its editor as one
/// transaction and writes the file itself. Nothing on disk is touched here,
/// so no lock is taken and the user keeps typing. Exit 7 when the app is not
/// running or does not have the document open.
fn apply_in_app(
    store: &Store,
    path: &std::path::Path,
    old: &str,
    new: &str,
    thread: Option<&str>,
    reply: Option<&str>,
    done: bool,
) -> Result<Applied, SidenoteError> {
    if old.is_empty() {
        return Err(SidenoteError::Other("--old is empty".into()));
    }
    let me = session();
    let (doc, _) = store.apply_precheck(path, &me)?;
    // The app matches against the text it shows, so the markdown Claude read
    // in the file is reduced to the same plain form first.
    let old_plain = sidenote_core::plain_text(old);
    if old_plain.trim().is_empty() {
        return Err(SidenoteError::Other(
            "--old has no text once markdown is stripped; give the words of the passage".into(),
        ));
    }
    let request = serde_json::json!({
        "req": "apply",
        "id": 1,
        "doc": doc.path,
        "old": old_plain,
        "new": new,
        // The thread rides along so that a suggestion the app records knows
        // which comment it answers. A direct edit does not need it — the
        // re-anchor happens here, after the app replies.
        "thread": thread,
        "session": me,
    });
    let response = ws_request(&request.to_string())?;
    let ok = response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let error = response.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(match error {
            "stale" => SidenoteError::Stale {
                found: response.get("found").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                exact: old.chars().take(60).collect(),
            },
            "not_open" => SidenoteError::NotOpen(format!("{} is not open in Sidenote", doc.path)),
            other => SidenoteError::Other(format!("the app refused the edit: {other}")),
        });
    }
    // Suggesting mode: the app recorded the edit rather than making it. The
    // reply still goes in, so the card can say what is being proposed; the
    // re-anchor does not, because the text has not moved.
    if let Some(id) = response.get("suggested").and_then(|v| v.as_str()) {
        let suggestion = store
            .read_suggestions(&doc.id)?
            .suggestions
            .into_iter()
            .find(|s| s.id == id);
        let thread = store.finish_suggestion(&doc, &me, thread, reply)?;
        let _ = done;
        return Ok(Applied {
            doc,
            exact: String::new(),
            thread,
            orphaned: false,
            kept_lock: false,
            suggestion,
        });
    }

    let landed = response.get("landed").and_then(|v| v.as_str()).unwrap_or("");
    store.finish_apply(&doc, &me, landed, thread, reply, done)
}

/// One request to the app's WebSocket, one reply. The socket offers the
/// `sidenote` subprotocol without a session token, so the app sends it no
/// comment events.
fn ws_request(frame: &str) -> Result<serde_json::Value, SidenoteError> {
    use tungstenite::client::IntoClientRequest;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::Message;

    let mut req = "ws://127.0.0.1:47293"
        .into_client_request()
        .map_err(|e| SidenoteError::Other(e.to_string()))?;
    req.headers_mut()
        .insert("Sec-WebSocket-Protocol", "sidenote".parse().unwrap());
    let (mut ws, _) = tungstenite::connect(req)
        .map_err(|_| SidenoteError::NotOpen("the Sidenote app is not running".into()))?;
    if let MaybeTlsStream::Plain(s) = ws.get_mut() {
        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    }
    ws.send(Message::Text(frame.into()))
        .map_err(|e| SidenoteError::Other(format!("cannot reach the app: {e}")))?;
    loop {
        let msg = ws
            .read()
            .map_err(|e| SidenoteError::Other(format!("no reply from the app: {e}")))?;
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        // Broadcast event frames for unowned documents can arrive too; only
        // the reply to this request carries `res`.
        if v.get("res").is_some() {
            let _ = ws.close(None);
            return Ok(v);
        }
    }
}

fn open_in_app(path: &std::path::Path) -> Result<(), SidenoteError> {
    let status = Command::new("open")
        .arg("-a")
        .arg("Sidenote")
        .arg(path)
        .status()?;
    if !status.success() {
        return Err(SidenoteError::Other(
            "could not launch the Sidenote app (is it installed in /Applications?)".into(),
        ));
    }
    Ok(())
}

fn run(cli: Cli) -> Result<i32, SidenoteError> {
    let store = Store::open()?;
    match cli.cmd {
        Cmd::Home => {
            println!("{}", store.home().display());
            Ok(0)
        }
        Cmd::InstallSkill { force } => {
            let (path, outcome) = sidenote_core::install_skill(force)?;
            println!(
                "{} {}",
                match outcome {
                    sidenote_core::SkillInstall::Installed => "installed skill at",
                    sidenote_core::SkillInstall::Updated => "updated skill at",
                    sidenote_core::SkillInstall::Current => "skill already current at",
                    sidenote_core::SkillInstall::Kept => "kept existing skill (newer or edited; use --force) at",
                },
                path.display()
            );
            Ok(0)
        }
        Cmd::Register { file, open, json } => {
            let (doc, created) = store.register(&file.file, Some(&session()))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&doc).unwrap());
            } else {
                println!(
                    "{} {} ({}) -> {}",
                    if created { "registered" } else { "already registered" },
                    doc.path,
                    doc.id,
                    store.doc_dir(&doc.id).display()
                );
            }
            if open {
                open_in_app(std::path::Path::new(&doc.path))?;
            }
            Ok(0)
        }
        Cmd::Open { file } => {
            let (doc, _) = store.register(&file.file, Some(&session()))?;
            open_in_app(std::path::Path::new(&doc.path))?;
            Ok(0)
        }
        Cmd::List { json } => {
            let docs = store.list()?;
            if json {
                println!("{}", serde_json::to_string_pretty(&docs).unwrap());
            } else if docs.is_empty() {
                println!("no documents registered");
            } else {
                let connected = store.connected_sessions()?;
                for d in docs {
                    let owner = d.owner_session.as_deref().unwrap_or("-");
                    let dot = match d.owner_session.as_deref() {
                        Some(o) if connected.iter().any(|s| s == o) => "connected",
                        _ if !connected.is_empty() => "other session connected",
                        _ => "no listener",
                    };
                    println!("{}  {}  owner={}  [{}]\n    {}", d.id, d.title, owner, dot, d.path);
                }
            }
            Ok(0)
        }
        Cmd::Waiting { file } => {
            let ids: Vec<String> = store
                .threads(&file.file, false)?
                .into_iter()
                .filter(|t| t.awaits_claude())
                .map(|t| t.id)
                .collect();
            println!("{}", ids.join(" "));
            Ok(0)
        }
        Cmd::Threads { file, all } => {
            let t = store.threads(&file.file, all)?;
            println!("{}", serde_json::to_string_pretty(&t).unwrap());
            Ok(0)
        }
        Cmd::Note { file, exact, text } => {
            let t = store.note(&file.file, &session(), &exact, &text)?;
            println!("noted {} on {:?}", t.id, t.selector.exact);
            Ok(0)
        }
        Cmd::Apply {
            file,
            old,
            new,
            thread,
            reply,
            done,
            wait,
        } => {
            let new = if new == "-" {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
                buf
            } else {
                new
            };
            let r = if std::env::var_os("SIDENOTE_APPLY_FILE").is_some() {
                store.apply(
                    &file.file,
                    &session(),
                    &old,
                    &new,
                    thread.as_deref(),
                    reply.as_deref(),
                    done,
                    Duration::from_secs_f64(wait.max(0.0)),
                )?
            } else {
                apply_in_app(&store, &file.file, &old, &new, thread.as_deref(), reply.as_deref(), done)?
            };
            if let Some(s) = &r.suggestion {
                // Not an error and not a failure: the mode is the user's
                // choice, and the edit is waiting for them, not lost.
                println!(
                    "suggested {} on {} (not applied: the document is in suggesting mode)",
                    s.id, r.doc.path
                );
                println!("the user accepts or rejects it in the app; do not repeat the edit or reach for the Edit tool.");
                if let Some(t) = &r.thread {
                    println!("reply left on thread {}", t.id);
                }
                return Ok(0);
            }
            println!("applied to {}", r.doc.path);
            match (&r.thread, r.orphaned) {
                (_, true) => println!(
                    "warning: could not re-anchor the thread to the new text; run `sidenote anchor` with a phrase from it"
                ),
                (Some(t), false) => println!(
                    "thread {} re-anchored to {:?}{}",
                    t.id,
                    t.selector.exact,
                    if t.done { ", done" } else { "" }
                ),
                (None, false) => {}
            }
            if r.kept_lock {
                println!("the lock this session already held is still held.");
            }
            Ok(0)
        }
        Cmd::Suggest { file, on, off, json } => {
            // `require_doc`, not `register`: reading the mode of a file
            // nobody has registered is exit 2, not a reason to register it.
            let doc = store.require_doc(&file.file)?;
            let st = if on || off {
                store.set_suggesting(&doc.id, on)?
            } else {
                store.read_state(&doc.id)?
            };
            let pending = store.read_suggestions(&doc.id)?.suggestions;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "suggesting": st.suggesting,
                        "pending": pending,
                    }))
                    .unwrap()
                );
                return Ok(0);
            }
            println!("suggesting: {}", if st.suggesting { "on" } else { "off" });
            if pending.is_empty() {
                println!("no suggestions await the user.");
            } else {
                println!("{} suggestion(s) await the user:", pending.len());
                for s in &pending {
                    println!(
                        "  {}{}  {:?} -> {:?}",
                        s.id,
                        s.thread.as_deref().map(|t| format!(" ({t})")).unwrap_or_default(),
                        s.old.chars().take(50).collect::<String>(),
                        s.new.chars().take(50).collect::<String>(),
                    );
                }
            }
            Ok(0)
        }
        Cmd::Anchor { file, thread, exact } => {
            let t = store.anchor_thread(&file.file, &session(), &thread, &exact)?;
            println!("anchored {} to {:?}", t.id, t.selector.exact);
            Ok(0)
        }
        Cmd::Ack { file, threads } => {
            let n = store.ack(&file.file, &threads)?;
            println!("acknowledged {} thread(s)", n);
            Ok(0)
        }
        Cmd::Reply {
            file,
            thread,
            text,
            done,
        } => {
            let t = store.reply(&file.file, &session(), &thread, &text, done)?;
            println!(
                "replied to {} ({}{})",
                t.id,
                match t.status {
                    ThreadStatus::Resolved => "resolved",
                    ThreadStatus::Open => "open",
                    ThreadStatus::Orphaned => "orphaned",
                },
                if t.done { ", done" } else { "" }
            );
            Ok(0)
        }
        Cmd::Lock { file, wait } => {
            let r = store.lock(&file.file, &session(), Duration::from_secs_f64(wait.max(0.0)))?;
            println!("locked {}; the app is read-only until `sidenote turn end`.", r.doc.path);
            print_suggesting(&r);
            match (&r.snapshot, r.diff.is_empty()) {
                (Some(s), false) => {
                    println!("edits by the user since snapshot {s} (whitespace ignored):");
                    println!();
                    print!("{}", r.diff);
                }
                (Some(s), true) => println!("no edits by the user since snapshot {s}."),
                (None, _) => {}
            }
            Ok(0)
        }
        Cmd::Turn { cmd } => match cmd {
            TurnCmd::Begin { file, json, wait } => {
                let r = store.turn_begin(
                    &file.file,
                    &session(),
                    Duration::from_secs_f64(wait.max(0.0)),
                )?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&r).unwrap());
                } else {
                    print_turn_begin(&r);
                }
                Ok(0)
            }
            TurnCmd::End { file, json } => {
                let r = store.turn_end(&file.file, &session())?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&r).unwrap());
                } else {
                    println!(
                        "turn ended: latest snapshot {}, {} thread(s) anchored, {} orphaned, {} open, {} resolved",
                        r.snapshot,
                        r.anchored.len(),
                        r.orphaned.len(),
                        r.open,
                        r.resolved
                    );
                    if !r.orphaned.is_empty() {
                        println!("orphaned: {}", r.orphaned.join(", "));
                    }
                    if r.new_user_messages {
                        println!("new comments arrived during the turn: run `sidenote turn begin` again");
                    }
                }
                Ok(if r.new_user_messages {
                    code::NEW_MESSAGES
                } else {
                    code::OK
                })
            }
        },
    }
}

fn print_thread(t: &Thread) {
    let status = match t.status {
        ThreadStatus::Open => "open",
        ThreadStatus::Resolved => "resolved",
        ThreadStatus::Orphaned => "orphaned (anchor text no longer found)",
    };
    println!("--- thread {} [{}]", t.id, status);
    println!("anchored text: {:?}", t.selector.exact);
    if !t.selector.prefix.is_empty() || !t.selector.suffix.is_empty() {
        println!(
            "context: ...{}[[{}]]{}...",
            t.selector.prefix, t.selector.exact, t.selector.suffix
        );
    }
    for m in &t.messages {
        let who = match m.author {
            sidenote_core::Author::User => "user",
            sidenote_core::Author::Claude => "claude",
        };
        println!("[{} {}] {}", who, m.at, m.body);
    }
    println!();
}

/// The mode, and what it means for this turn. Printed wherever a session is
/// about to start editing, because it changes what `apply` does and therefore
/// how the replies should be worded.
fn print_suggesting(r: &sidenote_core::TurnBegin) {
    if !r.suggesting && r.pending.is_empty() {
        return;
    }
    if r.suggesting {
        println!("suggesting mode is ON: `apply` proposes the edit and the user accepts or rejects it in the app. Write replies as proposals, and never mark one --done.");
    }
    if !r.pending.is_empty() {
        println!(
            "{} earlier suggestion(s) still await the user: {}. Do not propose them again.",
            r.pending.len(),
            r.pending.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(" ")
        );
    }
}

fn print_turn_begin(r: &sidenote_core::TurnBegin) {
    println!("document: {} (id {})", r.doc.path, r.doc.id);
    if let Some(from) = &r.took_over_from {
        println!("ownership taken over from session {from}");
    }
    println!("not locked: run `sidenote lock` before editing the file; replies need no lock.");
    print_suggesting(r);
    println!();
    if r.threads.is_empty() {
        println!("no threads await a reply.");
        println!();
    } else {
        println!("{} thread(s) await a reply:", r.threads.len());
        println!();
        for t in &r.threads {
            print_thread(t);
        }
    }
    match (&r.snapshot, r.diff.is_empty()) {
        (None, _) => println!("no snapshot yet."),
        (Some(s), true) => println!("no edits by the user since snapshot {s}."),
        (Some(s), false) => {
            println!("edits by the user since snapshot {s} (whitespace ignored):");
            println!();
            print!("{}", r.diff);
        }
    }
}
