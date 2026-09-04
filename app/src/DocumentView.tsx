import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";

import { Editor, type EditorHandle, type PresenceItem } from "./editor/Editor";
import { ipc } from "./ipc";
import { CommentMargin, type Draft } from "./panel/CommentMargin";
import { VersionsPanel } from "./panel/VersionsPanel";
import {
  isUnread,
  type DocEntry,
  type ListenerStatus,
  type StateView,
  type Suggestion,
  type Thread,
} from "./types";

/** What a reload has to refresh. */
interface Reload {
  doc: boolean;
  threads: boolean;
  state: boolean;
  suggestions: boolean;
}

const AUTOSAVE_MS = 500;
/** How many accepts back an undo can still bring the suggestion with it. */
const ACCEPT_UNDO_DEPTH = 10;
const IDLE_MS = 1200;
/** A thread in hand this long is a session that died mid-turn. Matches
 *  `STALE_BUSY_SECS` in the core model. */
const PRESENCE_STALE_MS = 5 * 60 * 1000;
/** The last edit flashes once and is done; this only has to outlast the
 *  animation in `sidenote.css`. */
const FOCUS_FRESH_MS = 2500;

/** Milliseconds until `at` is older than `within`; 0 when it already is. */
function remaining(at: string | null | undefined, within: number): number {
  if (!at) return 0;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, within - (Date.now() - t));
}

/**
 * Where Claude is working, from what the store already records: the anchors
 * of threads it has in hand, plus the passage its last edit landed on.
 *
 * Both ride the comment highlights that are already on the page, so nothing
 * new appears in the margins. Holding a comment brightens its highlight;
 * landing an edit flashes over it once. Nothing here is a lock — `apply`
 * already refuses an edit written against text you have since changed.
 */
function presenceOf(
  threads: Thread[],
  state: StateView | null,
): PresenceItem[] {
  const raw = state?.state.focus;
  const focus = remaining(raw?.at, FOCUS_FRESH_MS) > 0 ? raw : null;
  const items: PresenceItem[] = threads
    .filter(
      (t) =>
        t.working &&
        t.status !== "resolved" &&
        remaining(t.working_since, PRESENCE_STALE_MS) > 0,
    )
    .map((t) => ({ selector: t.selector, tier: "working" as const }));
  // The edit itself, on top. It flashes over its own highlight when it
  // answered a comment, and over bare prose when it did not — an edit made
  // outside any thread has no highlight to borrow.
  if (focus)
    items.push({
      selector: { exact: focus.exact, prefix: "", suffix: "" },
      tier: "changed",
    });
  return items;
}

type CopyKind = "markdown" | "html" | "text";

const COACH_KEY = "sidenote.sessionCoachSeen";

function coachSeen(): boolean {
  try {
    return localStorage.getItem(COACH_KEY) === "1";
  } catch {
    return true; // no storage means no way to remember; better silent than repeating
  }
}

function dismissCoach(set: (v: boolean) => void) {
  set(false);
  try {
    localStorage.setItem(COACH_KEY, "1");
  } catch {
    /* nothing to do */
  }
}

export function connectPrompt(path: string): string {
  return `Connect to "${path}" in Sidenote and handle its comments.`;
}

/** What the shell can ask a tab to do (menu routing, closing). */
export interface DocumentActions {
  /** Handle a document-scoped menu id. Returns false when not handled. */
  menu(id: string): Promise<boolean>;
  /** Write any pending autosave now. */
  flush(): Promise<void>;
}

interface Props {
  doc: DocEntry;
  active: boolean;
  onToast: (t: string) => void;
  /** The document was relinked to a new path; the shell updates the tab. */
  onDocChanged: (doc: DocEntry) => void;
}

interface Loaded {
  doc: DocEntry;
  markdown: string;
}

export const DocumentView = forwardRef<DocumentActions, Props>(
  function DocumentView({ doc, active, onToast, onDocChanged }, ref) {
    const editor = useRef<EditorHandle>(null);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [missing, setMissing] = useState<{
      doc: DocEntry;
      suggestion: string | null;
    } | null>(null);
    const [threads, setThreads] = useState<Thread[]>([]);
    const [unanchored, setUnanchored] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [stateView, setStateView] = useState<StateView | null>(null);
    const [listeners, setListeners] = useState<ListenerStatus | null>(null);
    const [panelForced, setPanelForced] = useState<boolean | null>(null);
    const [showResolved, setShowResolved] = useState(false);
    const [showSource, setShowSource] = useState(false);
    const [source, setSource] = useState("");
    const [hasSelection, setHasSelection] = useState(false);
    const [copyMenu, setCopyMenu] = useState(false);
    const [find, setFind] = useState<{
      query: string;
      current: number;
      total: number;
    } | null>(null);
    const findInput = useRef<HTMLInputElement>(null);
    const [sessionMenu, setSessionMenu] = useState(false);
    const [coach, setCoach] = useState(false);
    const [panelMode, setPanelMode] = useState<"threads" | "versions">(
      "threads",
    );
    // `tick` drives the held-for duration in the busy strip, once a second.
    // `presenceEpoch` redraws the in-document decorations, which costs an IPC
    // round trip with the whole document in it, so it moves only when it must.
    const [tick, setTick] = useState(0);
    const [presenceEpoch, setPresenceEpoch] = useState(0);
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [selectedSug, setSelectedSug] = useState<string | null>(null);
    // Bumped when the document may have reflowed, so the margin re-measures.
    const [revision, setRevision] = useState(0);

    const loadedRef = useRef<Loaded | null>(null);
    loadedRef.current = loaded;
    const docRef = useRef(doc);
    docRef.current = doc;
    const threadsRef = useRef<Thread[]>([]);
    threadsRef.current = threads;
    const busyRef = useRef(false);
    // Accepts this session, and what each one did to the text.
    //
    // `applyEdit` keeps its step in the undo history, so Cmd+Z takes the words
    // back. On its own that would lose the proposal: the suggestion is gone
    // from the store, so the text returns with nothing in the margin to decide
    // again. These entries let the pass below notice the edit has been undone
    // and put the suggestion back — and notice a redo and take it away again.
    const accepts = useRef<
      { sug: Suggestion; landed: string; id: string; live: boolean }[]
    >([]);
    const pendingMarkdown = useRef<string | null>(null);
    const lastWritten = useRef<string>("");
    // False from the moment the editor content is replaced until the comment
    // marks are painted back onto it. Selector updates are suspended in between:
    // with no marks in the document every thread reads as unanchored.
    const marksPainted = useRef(false);
    const saveTimer = useRef<number | null>(null);
    const lastEditAt = useRef(0);
    const reloadTimer = useRef<number | null>(null);
    const pendingReload = useRef<Reload>({
      doc: false,
      threads: false,
      state: false,
      suggestions: false,
    });
    const mainRef = useRef<HTMLElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);

    const busy = !!stateView?.state.busy && !!stateView.fresh;
    const staleBusy = !!stateView?.state.busy && !stateView.fresh;
    busyRef.current = busy;

    const panelVisible = panelForced ?? (threads.length > 0 || !!draft);
    const panelVisibleRef = useRef(false);
    panelVisibleRef.current = panelVisible;

    const refreshListeners = useCallback(async () => {
      setListeners(await ipc.listenerStatus(docRef.current.id));
    }, []);

    const refreshState = useCallback(async () => {
      setStateView(await ipc.readState(docRef.current.id));
    }, []);

    const applyThreads = useCallback(async (ts: Thread[]) => {
      const miss = (await editor.current?.applyThreads(ts)) ?? [];
      marksPainted.current = true;
      setUnanchored(new Set(miss));
      setRevision((r) => r + 1);
    }, []);

    const refreshThreads = useCallback(async () => {
      const tf = await ipc.readThreads(docRef.current.id);
      setThreads(tf.threads);
      await applyThreads(tf.threads);
    }, [applyThreads]);

    const refreshSuggestions = useCallback(async () => {
      const sv = await ipc.readSuggestions(docRef.current.id);
      setSuggestions(sv.suggestions);
      // A card whose suggestion has been decided must not stay selected, or
      // the margin lays everything out around one that is not there.
      setSelectedSug((cur) =>
        cur && sv.suggestions.some((x) => x.id === cur) ? cur : null,
      );
    }, []);

    // ---- saving -------------------------------------------------------------

    const flushSave = useCallback(async () => {
      const cur = loadedRef.current;
      const md = pendingMarkdown.current;
      if (!cur || md === null) return;
      pendingMarkdown.current = null;
      if (md === lastWritten.current) return;
      const previous = lastWritten.current;
      lastWritten.current = md;
      try {
        await ipc.writeDoc(cur.doc.path, md);
      } catch (e) {
        // Put the text back on the queue. `lastWritten` is what the next
        // autosave compares against, so leaving it set to text that never
        // reached the disk made every later save a no-op and quietly dropped
        // everything the user had typed.
        lastWritten.current = previous;
        if (pendingMarkdown.current === null) pendingMarkdown.current = md;
        onToast(`Save failed: ${e}`);
        return;
      }
      // Only threads whose marks are actually painted may have their selectors
      // rewritten. Between `setMarkdown` and the repaint there are no marks at
      // all, and a save landing in that gap reports every selector as missing.
      if (!marksPainted.current) return;
      const live = threadsRef.current.filter((t) => t.status !== "resolved");
      if (live.length && editor.current) {
        const sels = await editor.current.currentSelectors(
          live.map((t) => t.id),
        );
        const updates = live.map((t) => ({
          thread_id: t.id,
          selector: sels.get(t.id) ?? null,
        }));
        const changed = await ipc.updateSelectors(cur.doc.id, updates);
        if (changed) {
          const tf = await ipc.readThreads(cur.doc.id);
          setThreads(tf.threads);
          setUnanchored(
            new Set(
              tf.threads
                .filter((t) => t.status === "orphaned")
                .map((t) => t.id),
            ),
          );
        }
      }
    }, [onToast]);

    const flushNow = useCallback(async () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      await flushSave();
    }, [flushSave]);

    const onEditorChange = useCallback(
      (md: string) => {
        lastEditAt.current = Date.now();
        setRevision((r) => r + 1);
        if (busyRef.current) return;
        pendingMarkdown.current = md;
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          void flushSave();
        }, AUTOSAVE_MS);
      },
      [flushSave],
    );

    // ---- loading ------------------------------------------------------------

    const load = useCallback(
      async (d: DocEntry) => {
        setDraft(null);
        setSelected(null);
        setMissing(null);
        let markdown: string;
        try {
          markdown = await ipc.readDoc(d.path);
        } catch {
          const suggestion = await ipc.suggestRelink(d.id).catch(() => null);
          setLoaded(null);
          setMissing({ doc: d, suggestion });
          return;
        }
        lastWritten.current = markdown;
        pendingMarkdown.current = null;
        setLoaded({ doc: d, markdown });
        setPanelForced(null);
        setPanelMode("threads");
        await ipc.watchDoc(d.id, d.path).catch(() => {});
        const [tf, st, sv] = await Promise.all([
          ipc.readThreads(d.id),
          ipc.readState(d.id),
          ipc.readSuggestions(d.id),
        ]);
        setThreads(tf.threads);
        setStateView(st);
        setSuggestions(sv.suggestions);
        setSelectedSug(null);
        await refreshListeners();
      },
      [refreshListeners],
    );

    useEffect(() => {
      void load(doc);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [doc.id, doc.path]);

    const relink = useCallback(
      async (d: DocEntry, path?: string) => {
        let target = path;
        if (!target) {
          const picked = await open({
            multiple: false,
            directory: false,
            filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
            title: `Locate “${d.title}”`,
          });
          if (typeof picked !== "string") return;
          target = picked;
        }
        const updated = await ipc.relinkDoc(d.id, target);
        onDocChanged(updated);
      },
      [onDocChanged],
    );

    // Paint marks once the editor has mounted.
    useEffect(() => {
      if (!loaded) return;
      let cancelled = false;
      const t = window.setTimeout(async () => {
        if (cancelled) return;
        const tf = await ipc.readThreads(loaded.doc.id);
        if (cancelled) return;
        setThreads(tf.threads);
        await applyThreads(tf.threads);
      }, 60);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded?.doc.id]);

    // Presence: where Claude is, drawn in the document. Gated on the owning
    // session being connected right now, so a `working` flag stranded by a
    // crashed session draws nothing and needs no cleanup pass. Re-applied after
    // a reload too, because replacing the content drops the decorations.
    //
    // `tick` is deliberately not a dependency. It fires every second while the
    // document is locked, and setPresence sends the whole document text over
    // IPC, so this ran a full round trip per second per open tab for as long as
    // Claude held the lock. The two things tick drives — the flash expiring and
    // the held-for duration — are handled by the timeout below and by a plain
    // re-render.
    useEffect(() => {
      if (!loaded) return;
      const items = listeners?.connected ? presenceOf(threads, stateView) : [];
      void editor.current?.setPresence(items);
    }, [loaded, threads, stateView, listeners?.connected, presenceEpoch]);

    // Nothing on disk changes when the flash expires, so schedule the redraw.
    // Its own counter rather than `tick`: this has to redraw the decorations,
    // which is the expensive path, and it fires once per edit rather than once
    // per second.
    useEffect(() => {
      const ms = remaining(stateView?.state.focus?.at, FOCUS_FRESH_MS);
      if (ms <= 0) return;
      const t = window.setTimeout(
        () => setPresenceEpoch((x) => x + 1),
        ms + 50,
      );
      return () => window.clearTimeout(t);
    }, [stateView?.state.focus?.at]);

    // The lock itself is a prop on <Editor>; this only flushes pending text
    // before Claude Code starts writing.
    useEffect(() => {
      if (busy && pendingMarkdown.current !== null) void flushNow();
    }, [busy, flushNow]);

    useEffect(() => {
      if (!stateView?.state.busy) return;
      const i = window.setInterval(() => setTick((x) => x + 1), 1000);
      return () => window.clearInterval(i);
    }, [stateView?.state.busy]);

    useEffect(() => {
      if (!stateView?.state.busy) return;
      const i = window.setInterval(() => void refreshState(), 15000);
      return () => window.clearInterval(i);
    }, [stateView?.state.busy, refreshState]);

    // ---- disk changes -------------------------------------------------------

    const runReload = useCallback(
      async (plan?: Reload) => {
        const cur = loadedRef.current;
        if (!cur) return;
        let p: Reload;
        if (plan) {
          p = { ...plan };
        } else {
          p = pendingReload.current;
          pendingReload.current = { doc: false, threads: false, state: false, suggestions: false };
        }
        if (p.state) await refreshState();
        if (p.doc) {
          try {
            const md = await ipc.readDoc(cur.doc.path);
            if (md !== lastWritten.current && md !== pendingMarkdown.current) {
              lastWritten.current = md;
              pendingMarkdown.current = null;
              const main = mainRef.current;
              const top = main?.scrollTop ?? 0;
              marksPainted.current = false;
              // Replacing the content throws the undo history away, so an
              // accept made before this can never be undone now. Forget them:
              // left in place, the watcher would read a change made outside
              // the app that happens to restore the old words — a revert, a
              // checkout, another editor — as an undo, and resurrect a
              // suggestion the user had already accepted.
              accepts.current = [];
              editor.current?.setMarkdown(md);
              requestAnimationFrame(() => {
                if (main) main.scrollTop = top;
                setRevision((r) => r + 1);
              });
              setLoaded({ doc: cur.doc, markdown: md });
              if (showSource) setSource(md);
              p.threads = true;
              // The text moved, so which suggestions still fit has changed.
              p.suggestions = true;
            }
          } catch {
            const suggestion = await ipc
              .suggestRelink(cur.doc.id)
              .catch(() => null);
            setMissing({ doc: cur.doc, suggestion });
            return;
          }
        }
        if (p.threads) await refreshThreads();
        if (p.suggestions) await refreshSuggestions();
      },
      [refreshState, refreshThreads, refreshSuggestions, showSource],
    );

    const scheduleReload = useCallback(() => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      // Only the document text waits for you to stop typing — replacing it under
      // the cursor is the whole reason for the wait. Threads and state paint a
      // marker beside the text and disturb nothing, so they go straight through;
      // holding them back would delay the 👀 exactly while you watch for it.
      const attempt = () => {
        reloadTimer.current = null;
        const p = pendingReload.current;
        const idle = Date.now() - lastEditAt.current;
        const holdDoc = p.doc && idle < IDLE_MS && !busyRef.current;
        pendingReload.current = { doc: holdDoc, threads: false, state: false, suggestions: false };
        void runReload({
          doc: p.doc && !holdDoc,
          threads: p.threads,
          state: p.state,
          suggestions: p.suggestions,
        });
        if (holdDoc)
          reloadTimer.current = window.setTimeout(attempt, IDLE_MS - idle);
      };
      reloadTimer.current = window.setTimeout(attempt, 150);
    }, [runReload]);

    useEffect(() => {
      const un1 = listen<string>("fs-changed", (e) => {
        const d = docRef.current;
        const p = e.payload;
        if (p === d.path) pendingReload.current.doc = true;
        else if (p.endsWith("/threads.json") && p.includes(`/docs/${d.id}/`))
          pendingReload.current.threads = true;
        else if (
          p.endsWith("/suggestions.json") &&
          p.includes(`/docs/${d.id}/`)
        )
          pendingReload.current.suggestions = true;
        else if (p.endsWith("/state.json") && p.includes(`/docs/${d.id}/`))
          pendingReload.current.state = true;
        else return;
        scheduleReload();
      });
      const un2 = listen("listeners-changed", () => void refreshListeners());
      return () => {
        void un1.then((f) => f());
        void un2.then((f) => f());
      };
    }, [refreshListeners, scheduleReload]);

    // ---- edits from the CLI -------------------------------------------------

    // `sidenote apply` hands its edit to the app instead of rewriting the
    // file. The editor lands it as one transaction, the autosave path writes
    // the file and re-records the thread selectors from the moved marks, and
    // only then does the CLI hear back, so the file holds the edit when it
    // returns.
    useEffect(() => {
      const un = listen<{
        rid: number;
        doc: string;
        old: string;
        new: string;
        suggesting: boolean;
        thread: string | null;
        session: string | null;
      }>(
        "apply-request",
        async (e) => {
          const {
            rid,
            doc: path,
            old,
            new: next,
            suggesting: mode,
            thread,
            session,
          } = e.payload;
          if (path !== docRef.current.path) return;

          // Suggesting mode: record the edit rather than making it. The check
          // is the same one `applyEdit` makes and against the same text, so a
          // passage the user has already rewritten is refused now rather than
          // sitting in the margin waiting to fail under their hand.
          // `mode` comes with the request, read from disk when it was made.
          // The copy this view holds is refreshed by a debounced watcher, so
          // it can still say "off" for a moment after the user turns it on —
          // and acting on that would edit the file behind their back.
          if (mode) {
            const hits = editor.current?.locateAll([old])?.[0] ?? 0;
            if (hits !== 1) {
              await ipc
                .applyResult(rid, { ok: false, error: "stale", found: hits })
                .catch(() => {});
              return;
            }
            try {
              const sug = await ipc.recordSuggestion(
                docRef.current.id,
                session ?? "",
                old,
                next,
                thread,
              );
              await ipc
                .applyResult(rid, { ok: true, suggested: sug.id })
                .catch(() => {});
              await refreshSuggestions();
            } catch {
              await ipc
                .applyResult(rid, { ok: false, error: "not_ready" })
                .catch(() => {});
            }
            return;
          }

          let result = editor.current?.applyEdit(old, next) ?? {
            ok: false as const,
            error: "not_ready" as const,
          };
          if (result.ok) {
            lastEditAt.current = Date.now();
            pendingMarkdown.current = editor.current?.getMarkdown() ?? null;
            try {
              await flushNow();
            } catch {
              result = { ok: false, error: "not_ready" };
            }
            setRevision((r) => r + 1);
          }
          await ipc.applyResult(rid, result).catch(() => {});
        },
      );
      return () => {
        void un.then((f) => f());
      };
    }, [flushNow, refreshSuggestions]);

    // ---- suggestions --------------------------------------------------------

    // What the toolbar and the menu show. Never what an incoming edit is
    // judged by — see the `apply-request` handler.
    const suggesting = !!stateView?.state.suggesting;

    // Rewrite the passage yourself and the suggestion goes.
    //
    // It cannot be applied any more — `applyEdit` would refuse it — so the
    // choice is between dropping it and keeping a card that can only be
    // dismissed. A word processor drops it: editing the text under a
    // suggestion is an answer to it, and a dead card asking to be tidied away
    // is worse than no card. Claude's reply stays in the thread, so what was
    // proposed is still on the record.
    //
    // Asked of the editor, not of the file: the file trails by an autosave and
    // the sentence being rewritten right now is exactly the one in question.
    // It waits for typing to stop, so a suggestion does not vanish between two
    // keystrokes of a word being retyped.
    useEffect(() => {
      if (!loaded || suggestions.length === 0) return;
      const t = window.setTimeout(() => {
        void (async () => {
          const cur = loadedRef.current;
          // Between replacing the content and repainting the marks the
          // document is not itself; a pass in that window would find nothing
          // and retire every suggestion on it.
          if (!cur || !marksPainted.current) return;
          const counts =
            editor.current?.locateAll(suggestions.map((x) => x.quote)) ?? [];
          const gone = suggestions.filter((_, i) => counts[i] !== 1);
          if (gone.length === 0) return;
          // Count the ones this pass actually removed. A suggestion accepted a
          // moment ago is gone from the store already and its passage is gone
          // from the text, so it looks retired from here — and saying "you
          // rewrote that passage" about an edit the user just accepted would
          // be a lie.
          let dropped = 0;
          for (const g of gone) {
            const ok = await ipc
              .rejectSuggestion(cur.doc.id, g.id)
              .then(() => true)
              .catch(() => false);
            if (ok) dropped++;
          }
          if (dropped === 0) return;
          await refreshSuggestions();
          onToast(
            dropped === 1
              ? "Suggestion dropped: you rewrote that passage."
              : `${dropped} suggestions dropped: you rewrote those passages.`,
          );
        })();
      }, IDLE_MS);
      return () => window.clearTimeout(t);
    }, [loaded, suggestions, revision, refreshSuggestions, onToast]);

    // Undo and redo of an accept, watched in the text rather than in the
    // history plugin.
    //
    // Accepting goes through the editor, so Cmd+Z already takes the words
    // back; on its own that loses the proposal, because the suggestion has
    // been removed from the store and nothing in the margin offers it again.
    // What defines an undone accept is exactly this: the old words are back
    // and the new ones are gone. Checking that needs nothing from
    // prosemirror-history's internals and cannot be broken by them changing.
    useEffect(() => {
      if (!loaded || accepts.current.length === 0) return;
      const t = window.setTimeout(() => {
        void (async () => {
          const cur = loadedRef.current;
          if (!cur || !marksPainted.current) return;
          const entries = accepts.current;
          const probes = entries.flatMap((e) => [e.sug.quote, e.landed]);
          const counts = editor.current?.locateAll(probes) ?? [];
          if (counts.length !== probes.length) return;
          let changed = false;
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const backAgain = counts[i * 2] === 1;
            // A suggestion that only deletes leaves no new words to look for,
            // so the old ones coming back is the whole signal.
            const deletion = e.landed.trim() === "";
            const landedGone = deletion ? backAgain : counts[i * 2 + 1] === 0;
            const landedThere = deletion ? !backAgain : counts[i * 2 + 1] >= 1;
            if (!e.live && backAgain && landedGone) {
              const again = await ipc
                .recordSuggestion(
                  cur.doc.id,
                  e.sug.session,
                  e.sug.quote,
                  e.sug.markdown,
                  e.sug.thread ?? null,
                )
                .catch(() => null);
              if (again) {
                e.id = again.id;
                e.live = true;
                changed = true;
              }
            } else if (e.live && !backAgain && landedThere) {
              // Redone: the edit is in the text again, so the card goes.
              await ipc.rejectSuggestion(cur.doc.id, e.id).catch(() => {});
              e.live = false;
              changed = true;
            }
          }
          if (changed) await refreshSuggestions();
        })();
      }, 400);
      return () => window.clearTimeout(t);
    }, [loaded, revision, refreshSuggestions]);

    // Drawing them costs no IPC — the backend already sent the text to find
    // and the segments to draw — so it can redraw on every change.
    useEffect(() => {
      if (!loaded) return;
      editor.current?.setSuggestions(suggestions, selectedSug);
    }, [loaded, suggestions, selectedSug]);

    // The menu tick belongs to the document in front, not to the last click.
    // Only the active tab writes it, so two tabs cannot fight over one menu.
    useEffect(() => {
      if (!active || !loaded) return;
      void ipc.setMenuChecked("toggle_suggesting", suggesting);
    }, [active, loaded, suggesting]);

    const toggleSuggesting = useCallback(async () => {
      const cur = loadedRef.current;
      if (!cur) return;
      const next = !suggesting;
      const st = await ipc.setSuggesting(cur.doc.id, next);
      setStateView((v) => (v ? { ...v, state: st } : v));
      onToast(
        next
          ? "Suggesting: Claude's edits will wait here for you to accept."
          : "Editing: Claude's edits go straight into the document.",
      );
    }, [suggesting, onToast]);

    /// Accepting goes through the editor, exactly as a direct `apply` does.
    /// Writing the file instead would come back through the watcher as a
    /// whole-document reload and throw away the cursor, the scroll position
    /// and the undo history.
    const acceptOne = useCallback(
      async (sug: Suggestion): Promise<boolean> => {
        const cur = loadedRef.current;
        if (!cur) return false;
        const result = editor.current?.applyEdit(sug.quote, sug.markdown) ?? {
          ok: false as const,
          error: "not_ready" as const,
        };
        if (!result.ok || !("landed" in result)) return false;
        lastEditAt.current = Date.now();
        pendingMarkdown.current = editor.current?.getMarkdown() ?? null;
        await flushNow();
        setRevision((r) => r + 1);
        await ipc.acceptSuggestion(cur.doc.id, sug.id, result.landed);
        accepts.current.push({
          sug,
          landed: result.landed,
          id: sug.id,
          live: false,
        });
        // Each entry costs two searches per settle, forever. Undoing further
        // back than this is not a thing anyone does, and the text edit stays
        // undoable either way — only the suggestion coming back with it is
        // given up.
        if (accepts.current.length > ACCEPT_UNDO_DEPTH) accepts.current.shift();
        return true;
      },
      [flushNow],
    );

    const decide = useCallback(
      async (id: string, accept: boolean) => {
        const cur = loadedRef.current;
        if (!cur) return;
        const sug = suggestions.find((x) => x.id === id);
        if (!sug) return;
        if (accept) {
          const ok = await acceptOne(sug);
          if (!ok) {
            onToast("That passage has changed; the suggestion no longer fits.");
          }
        } else {
          await ipc.rejectSuggestion(cur.doc.id, id).catch((e) => {
            onToast(`Reject failed: ${e}`);
          });
        }
        await refreshSuggestions();
      },
      [acceptOne, onToast, refreshSuggestions, suggestions],
    );

    const decideAll = useCallback(
      async (accept: boolean) => {
        const cur = loadedRef.current;
        if (!cur) return;
        let done = 0;
        let failed = 0;
        // One at a time. Each accept moves the text the next one is measured
        // against, so they cannot be applied in parallel — and one that no
        // longer fits is left alone rather than forced.
        for (const sug of suggestions) {
          if (accept) {
            if (await acceptOne(sug)) done++;
            else failed++;
          } else {
            await ipc.rejectSuggestion(cur.doc.id, sug.id).catch(() => {});
            done++;
          }
        }
        await refreshSuggestions();
        const verb = accept ? "Accepted" : "Rejected";
        onToast(
          failed
            ? `${verb} ${done}. ${failed} left: the text under them has changed.`
            : `${verb} ${done} suggestion${done === 1 ? "" : "s"}.`,
        );
      },
      [acceptOne, onToast, refreshSuggestions, suggestions],
    );

    // ---- comments -----------------------------------------------------------

    const requestComment = useCallback(() => {
      if (busyRef.current) {
        onToast("Claude is editing; wait for the lock to clear.");
        return;
      }
      const quote = editor.current?.beginDraft();
      if (!quote) {
        onToast("Select some text first.");
        return;
      }
      setSelected(null);
      setDraft({ quote });
      setPanelMode("threads");
      setPanelForced(true);
    }, [onToast]);

    const cancelDraft = useCallback(() => {
      editor.current?.cancelDraft();
      setDraft(null);
      editor.current?.focus();
    }, []);

    const submitDraft = useCallback(
      async (body: string) => {
        const cur = loadedRef.current;
        if (!cur || !editor.current) return;
        const sels = await editor.current.currentSelectors(["__draft__"]);
        const sel = sels.get("__draft__");
        if (!sel) {
          onToast("The selection was lost; try again.");
          cancelDraft();
          return;
        }
        if (pendingMarkdown.current !== null) await flushNow();
        const t = await ipc.createThread(cur.doc.id, sel, body);
        editor.current.commitDraft(t.id);
        setDraft(null);
        setPanelForced(null);
        setThreads((ts) => [...ts, t]);
        setSelected(t.id);
        const r = await ipc.emitEvent(cur.doc.id, "comment", t.id);
        // The backend marks the thread when a session takes the frame; paint it
        // from the result rather than waiting for the file watcher to come back.
        if (r.marked)
          setThreads((ts) =>
            ts.map((x) => (x.id === t.id ? { ...x, working: true } : x)),
          );
        if (r.delivered === 0)
          onToast("Saved. It reaches Claude Code when a session connects.");
        await refreshListeners();
      },
      [cancelDraft, flushNow, refreshListeners, onToast],
    );

    const reply = useCallback(async (id: string, body: string) => {
      const cur = loadedRef.current;
      if (!cur) return;
      const t = await ipc.addUserMessage(cur.doc.id, id, body);
      setThreads((ts) => ts.map((x) => (x.id === id ? t : x)));
      const r = await ipc.emitEvent(cur.doc.id, "reply", id);
      if (r.marked)
        setThreads((ts) =>
          ts.map((x) => (x.id === id ? { ...x, working: true } : x)),
        );
    }, []);

    // Expanding a card is the first moment its replies are on screen, so it is
    // the honest place to call the thread read. Fire and forget: the badge and
    // the dot both follow from the write, and a failure here must never stop a
    // card from opening.
    const markRead = useCallback((id: string) => {
      const cur = loadedRef.current;
      if (!cur) return;
      const t = threadsRef.current.find((x) => x.id === id);
      if (!t || !isUnread(t)) return;
      void ipc
        .markThreadRead(cur.doc.id, id)
        .then((next) =>
          setThreads((ts) => ts.map((x) => (x.id === id ? next : x))),
        )
        .catch(() => {});
    }, []);

    const setStatus = useCallback(
      async (id: string, status: "open" | "resolved") => {
        const cur = loadedRef.current;
        if (!cur) return;
        const t = await ipc.setThreadStatus(cur.doc.id, id, status);
        const next = threadsRef.current.map((x) => (x.id === id ? t : x));
        setThreads(next);
        await applyThreads(next);
        if (status === "resolved")
          await ipc.emitEvent(cur.doc.id, "resolve", id);
      },
      [applyThreads],
    );

    const relocate = useCallback(
      async (id: string) => {
        const cur = loadedRef.current;
        if (!cur || !editor.current) return;
        const sel = await editor.current.selectionSelector();
        if (!sel) {
          onToast("Select the text to attach this comment to.");
          return;
        }
        const t = await ipc.setThreadSelector(cur.doc.id, id, sel);
        const next = threadsRef.current.map((x) => (x.id === id ? t : x));
        setThreads(next);
        await applyThreads(next);
        setSelected(id);
      },
      [applyThreads, onToast],
    );

    // The card sits level with its highlight, so selecting one rarely needs a
    // scroll; 'nearest' only moves when the highlight is off screen.
    const selectThread = useCallback(
      (id: string | null) => {
        setSelected(id);
        editor.current?.setSelected(id);
        if (id) {
          editor.current?.scrollTo(id, "nearest");
          markRead(id);
        }
      },
      [markRead],
    );

    useEffect(() => {
      editor.current?.setSelected(selected);
    }, [selected, threads]);

    const unlock = useCallback(async () => {
      const cur = loadedRef.current;
      if (!cur) return;
      const ok = await ask(
        "Claude may still be editing this document. Unlocking lets you edit now; Claude’s next write is refused and it stops.",
        {
          title: "Unlock document?",
          kind: "warning",
          okLabel: "Unlock",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;
      await ipc.unlockDoc(cur.doc.id);
      await refreshState();
    }, [refreshState]);

    const toggleVersions = useCallback(() => {
      if (panelMode === "versions" && panelVisibleRef.current) {
        setPanelMode("threads");
      } else {
        setPanelMode("versions");
        setPanelForced(true);
      }
    }, [panelMode]);

    const toggleThreads = useCallback(() => {
      if (panelMode !== "threads") {
        setPanelMode("threads");
        setPanelForced(true);
      } else {
        setPanelForced(!panelVisibleRef.current);
      }
    }, [panelMode]);

    const copyAs = useCallback(
      async (kind: CopyKind) => {
        setCopyMenu(false);
        const ed = editor.current;
        if (!ed || !loadedRef.current) return;
        try {
          if (kind === "markdown") {
            await navigator.clipboard.writeText(ed.getMarkdown());
            onToast("Copied as Markdown.");
          } else if (kind === "text") {
            await navigator.clipboard.writeText(ed.getPlainText());
            onToast("Copied as plain text.");
          } else {
            const html = ed.getHtml();
            const text = ed.getPlainText();
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([text], { type: "text/plain" }),
              }),
            ]);
            onToast("Copied as rich text.");
          }
        } catch (e) {
          onToast(`Copy failed: ${e}`);
        }
      },
      [onToast],
    );

    // ---- find ---------------------------------------------------------------

    const openFind = useCallback(() => {
    setFind((f) => f ?? { query: '', current: 0, total: 0 })
    // Already open: take the cursor back to the field.
    findInput.current?.focus()
    findInput.current?.select()
  }, [])

  // Focus on mount. A timer from `openFind` fires before React has put the
  // input in the DOM, so the ref does the job when the element appears.
  const mountFindInput = useCallback((el: HTMLInputElement | null) => {
    findInput.current = el
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const closeFind = useCallback(() => {
      setFind(null);
      editor.current?.clearFind();
      editor.current?.focus();
    }, []);

    const runFind = useCallback((query: string) => {
      const r = editor.current?.find(query) ?? { current: 0, total: 0 };
      setFind({ query, ...r });
    }, []);

    const stepFind = useCallback((dir: 1 | -1) => {
      setFind((f) => {
        if (!f) return f;
        const r = editor.current?.findStep(dir) ?? { current: 0, total: 0 };
        return { ...f, ...r };
      });
    }, []);

    // The bar drops when the document is shown as source; there is nothing to decorate.
    useEffect(() => {
      if (showSource && find) closeFind();
    }, [showSource, find, closeFind]);

    // ---- shell interface ----------------------------------------------------

    useImperativeHandle(
      ref,
      () => ({
        flush: flushNow,
        menu: async (id: string) => {
          const cur = loadedRef.current;
          if (id.startsWith("copy_as:")) {
            await copyAs(id.slice("copy_as:".length) as CopyKind);
            return true;
          }
          switch (id) {
            case "find":
              if (cur && !showSource) openFind();
              return true;
            case "find_next":
              if (find) stepFind(1);
              return true;
            case "find_prev":
              if (find) stepFind(-1);
              return true;
            case "undo":
              editor.current?.undo();
              return true;
            case "redo":
              editor.current?.redo();
              return true;
            case "comment":
              requestComment();
              return true;
            case "toggle_threads":
              toggleThreads();
              return true;
            case "toggle_versions":
              if (cur) toggleVersions();
              return true;
            case "toggle_resolved":
              setShowResolved((v) => !v);
              return true;
            case "show_source":
              if (cur) setSource(editor.current?.getMarkdown() ?? cur.markdown);
              setShowSource((v) => !v);
              return true;
            case "relink":
              await relink(missing?.doc ?? docRef.current);
              return true;
            case "reveal_doc":
              await ipc.revealPath(docRef.current.path).catch(() => {});
              return true;
            case "unlock":
              if (stateView?.state.busy) await unlock();
              return true;
            case "reload":
              pendingReload.current = { doc: true, threads: true, state: true, suggestions: true };
              await runReload();
              return true;
            case "copy_path":
              await navigator.clipboard.writeText(docRef.current.path);
              onToast("Path copied.");
              return true;
            case "copy_connect":
              await navigator.clipboard.writeText(
                connectPrompt(docRef.current.path),
              );
              onToast("Prompt copied. Paste it into a Claude Code session.");
              return true;
            case "toggle_suggesting":
              if (cur) await toggleSuggesting();
              return true;
            case "accept_all":
              if (cur && suggestions.length) await decideAll(true);
              return true;
            case "reject_all":
              if (cur && suggestions.length) await decideAll(false);
              return true;
          }
          return false;
        },
      }),
      [
        copyAs,
        decideAll,
        suggestions.length,
        toggleSuggesting,
        find,
        flushNow,
        missing,
        onToast,
        openFind,
        relink,
        requestComment,
        runReload,
        showSource,
        stateView,
        stepFind,
        toggleThreads,
        toggleVersions,
        unlock,
      ],
    );

    // Point at the session button the first time someone has a document open
    // with nothing connected to it. Opening a file explains itself; connecting a
    // session to it does not, and the button is a 14px robot in the corner.
    // Once only, ever, on the machine.
    useEffect(() => {
      if (!active || !loaded || coachSeen()) return;
      if (listeners === null) return; // status not in yet; do not guess
      if (listeners.connected) return;
      // Let the document paint first: a tip that arrives with the text reads as
      // part of the chrome and gets dismissed without being read.
      const t = window.setTimeout(() => setCoach(true), 900);
      return () => window.clearTimeout(t);
    }, [active, loaded, listeners]);

    // Anything that shows they have found it counts as having seen it.
    useEffect(() => {
      if (!coach) return;
      if (sessionMenu || listeners?.connected) dismissCoach(setCoach);
    }, [coach, sessionMenu, listeners]);

    useEffect(() => {
      if (!copyMenu && !sessionMenu) return;
      const close = () => {
        setCopyMenu(false);
        setSessionMenu(false);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      window.addEventListener("mousedown", close);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("mousedown", close);
        window.removeEventListener("keydown", onKey);
      };
    }, [copyMenu, sessionMenu]);

    useEffect(() => {
      const onBlur = () => void flushNow();
      window.addEventListener("blur", onBlur);
      return () => window.removeEventListener("blur", onBlur);
    }, [flushNow]);

    // ---- render -------------------------------------------------------------

    const openCount = threads.filter((t) => t.status !== "resolved").length;
    const resolvedCount = threads.length - openCount;
    const heldSecs = stateView?.state.busy_since
      ? Math.max(
          0,
          Math.round(
            (Date.now() - Date.parse(stateView.state.busy_since)) / 1000,
          ),
        )
      : 0;
    void tick;

    // Two states, because there are only two outcomes: a comment reaches a
    // session or it waits. Which session, and whether some unrelated one is
    // running, is not the reader's problem — only the owner can write to this
    // document, so nobody else could pick the comment up anyway.
    const dotClass = listeners?.connected ? "dot-green" : "dot-grey";
    const dotTitle = listeners?.port_error
      ? `Listener port unavailable: ${listeners.port_error}`
      : listeners?.connected
        ? "Connected. Comments go straight to Claude Code."
        : "Not connected. Comments wait here until a session picks them up. Click for the connect prompt.";

    const marginOpen = panelVisible && !!loaded && panelMode === "threads";
    const sideOpen = panelVisible && !!loaded && panelMode === "versions";

    return (
      <div
        className={`docview ${sideOpen ? "panel-open" : ""} ${marginOpen ? "margin-open" : ""}`}
        hidden={!active}
      >
        <div className="pill">
          <span className="pill-menu" onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`session ${listeners?.connected ? "is-on" : ""}`}
              title={dotTitle}
              onClick={() => {
                // One popover at a time: the two hang from the same pill.
                setCopyMenu(false);
                setSessionMenu((v) => !v);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-2 10H6V7h12v12zm-9-6c-.83 0-1.5-.67-1.5-1.5S8.17 10 9 10s1.5.67 1.5 1.5S9.83 13 9 13zm7.5-1.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM8 15h8v2H8v-2z" />
              </svg>
              <span className={`dot ${dotClass}`} />
            </button>
            {coach && !sessionMenu && (
              <div className="coach" role="status">
                <div className="coach-title">Connect a session</div>
                <p>
                  Copy the connect prompt and paste it into a Claude&nbsp;Code
                  session. Your comments go to it, and its replies come back
                  here.
                </p>
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => dismissCoach(setCoach)}
                >
                  Got it
                </button>
              </div>
            )}
            {sessionMenu && (
              <div className="pop" role="menu">
                <div className="pop-note">
                  {/* The dot is binary, but the menu is where knowing more
                      earns its place: a document that has had a session can
                      say so, and a session that ended is a different thing
                      from one that never existed. */}
                  {listeners?.connected
                    ? "This document’s Claude Code session is connected. Pasting the prompt into another session moves the document to that one."
                    : listeners?.owner
                      ? "This document’s Claude Code session is no longer running. Paste the connect prompt into a session to pick the comments up."
                      : "No Claude Code session is connected. Paste the connect prompt into a Claude Code session to connect one."}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setSessionMenu(false);
                    await navigator.clipboard.writeText(
                      connectPrompt(docRef.current.path),
                    );
                    onToast(
                      "Prompt copied. Paste it into a Claude Code session.",
                    );
                  }}
                >
                  Copy connect prompt
                </button>
              </div>
            )}
          </span>
          {busy && <span className="pill-text">Claude is editing</span>}
          {staleBusy && <span className="pill-text pill-warn">Stale lock</span>}
          {loaded && (
            <span
              className="pill-menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`pill-btn ${copyMenu ? "is-on" : ""}`}
                title="Copy document as…"
                onClick={() => {
                  setSessionMenu(false);
                  setCopyMenu((v) => !v);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  aria-hidden="true"
                >
                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                </svg>
              </button>
              {copyMenu && (
                <div className="pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void copyAs("markdown")}
                  >
                    Copy as Markdown
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void copyAs("html")}
                  >
                    Copy as Rich Text
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void copyAs("text")}
                  >
                    Copy as Plain Text
                  </button>
                </div>
              )}
            </span>
          )}
          {loaded && (
            <button
              type="button"
              className={`pill-btn ${suggesting ? "is-on" : ""}`}
              title={
                suggesting
                  ? "Suggesting: Claude proposes edits and you accept them (⌘⇧E)"
                  : "Editing: Claude's edits go straight in. Click to switch to suggesting (⌘⇧E)"
              }
              onClick={() => void toggleSuggesting()}
            >
              {/* A pen over a page: what a word processor uses for the mode,
                  and distinct from the comment bubble beside it. */}
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
              {suggestions.length > 0 && (
                <span className="pill-count">{suggestions.length}</span>
              )}
            </button>
          )}
          {loaded && (
            <button
              type="button"
              className={`pill-btn ${panelVisible && panelMode === "versions" ? "is-on" : ""}`}
              title="Versions (⌘3)"
              onClick={toggleVersions}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
              </svg>
            </button>
          )}
          {loaded && (
            <button
              type="button"
              className={`pill-btn ${panelVisible && panelMode === "threads" ? "is-on" : ""}`}
              title={`${panelVisible && panelMode === "threads" ? "Hide" : "Show"} comments (⌘2)`}
              onClick={toggleThreads}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM6 12h12v2H6zm0-3h12v2H6zm0-3h12v2H6z" />
              </svg>
              {openCount > 0 && <span className="pill-count">{openCount}</span>}
            </button>
          )}
        </div>

        {stateView?.state.busy && loaded && (
          <div className="busy-strip">
            <div className={`busy-capsule ${staleBusy ? "busy-stale" : ""}`}>
              <span>
                {staleBusy
                  ? "Stale lock ignored"
                  : "Read-only while Claude edits"}
                {" · "}
                {formatDuration(heldSecs)}
              </span>
              <button
                type="button"
                className="btn-link"
                onClick={() => void unlock()}
              >
                Unlock
              </button>
            </div>
          </div>
        )}

        <main className="main" ref={mainRef}>
          {find && (
            <div className="find-wrap">
              <div className="find-bar" role="search">
                <input
                  ref={mountFindInput}
                  type="text"
                  placeholder="Find in document"
                  value={find.query}
                  spellCheck={false}
                  onChange={(e) => runFind(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepFind(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeFind();
                    }
                  }}
                />
                <span
                  className={`find-count${find.query && !find.total ? " find-none" : ""}`}
                >
                  {find.query
                    ? find.total
                      ? `${find.current} of ${find.total}`
                      : "No matches"
                    : ""}
                </span>
                <button
                  type="button"
                  className="btn-quiet"
                  title="Previous (Shift+Enter)"
                  disabled={!find.total}
                  onClick={() => stepFind(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  title="Next (Enter)"
                  disabled={!find.total}
                  onClick={() => stepFind(1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  title="Close (Esc)"
                  onClick={closeFind}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          {missing && (
            <div className="empty">
              <h2>File not found</h2>
              <p className="muted">{missing.doc.path}</p>
              {missing.suggestion && (
                <p>
                  Possible match: <code>{missing.suggestion}</code>{" "}
                  <button
                    type="button"
                    className="btn-accent"
                    onClick={() =>
                      void relink(missing.doc, missing.suggestion!)
                    }
                  >
                    Relink
                  </button>
                </p>
              )}
              <p>
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => void relink(missing.doc)}
                >
                  Locate…
                </button>
              </p>
            </div>
          )}

          {loaded && (
            <div className="canvas" ref={canvasRef}>
              <div className="doc">
                <div className="doc-path" title={loaded.doc.path}>
                  <span dir="ltr">{loaded.doc.path}</span>
                </div>
                {showSource ? (
                  <pre className="source">{source}</pre>
                ) : (
                  <Editor
                    ref={editor}
                    initialMarkdown={loaded.markdown}
                    docPath={loaded.doc.path}
                    onChange={onEditorChange}
                    onMarkClick={selectThread}
                    onRequestComment={requestComment}
                    onSelectionChange={setHasSelection}
                    onSuggestionClick={(id) => {
                      // Selecting the suggestion selects the comment it
                      // answers too, so the one card carrying both opens.
                      const sg = suggestions.find((x) => x.id === id);
                      setSelectedSug(id);
                      setSelected(sg?.thread ?? null);
                      setPanelMode("threads");
                      setPanelForced(true);
                    }}
                    readonly={busy}
                  />
                )}
              </div>
              {panelMode === "threads" && (
                <CommentMargin
                  threads={threads}
                  unanchored={unanchored}
                  selected={selected}
                  showResolved={showResolved}
                  draft={draft}
                  readonly={busy}
                  canvasRef={canvasRef}
                  revision={revision}
                  onSelect={selectThread}
                  onSubmitDraft={(b) => void submitDraft(b)}
                  onCancelDraft={cancelDraft}
                  onReply={(id, b) => void reply(id, b)}
                  onSetStatus={(id, s) => void setStatus(id, s)}
                  onRelocate={(id) => void relocate(id)}
                  canRelocate={hasSelection}
                  onToggleResolved={() => setShowResolved((v) => !v)}
                  suggestions={suggestions}
                  selectedSuggestion={selectedSug}
                  onSelectSuggestion={setSelectedSug}
                  onDecide={(id, accept) => void decide(id, accept)}
                />
              )}
            </div>
          )}
        </main>

        {marginOpen && resolvedCount > 0 && (
          <button
            type="button"
            className="resolved-chip"
            onClick={() => setShowResolved((v) => !v)}
          >
            {resolvedCount} resolved · {showResolved ? "Hide" : "Show"}
          </button>
        )}

        <div className="panel-cell" aria-hidden={!sideOpen}>
          {loaded && panelMode === "versions" && (
            <VersionsPanel
              docId={loaded.doc.id}
              onClose={() => setPanelMode("threads")}
              onRestored={(name) => {
                onToast(`Restored; current text saved as ${name}.`);
                pendingReload.current = {
                  doc: true,
                  threads: true,
                  state: false,
                  suggestions: true,
                };
                void runReload();
              }}
            />
          )}
        </div>
      </div>
    );
  },
);

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}
