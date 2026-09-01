import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import {
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  DOMSerializer,
  Slice,
  type Mark,
  type NodeType,
} from "@milkdown/kit/prose/model";
import { setBlockType } from "@milkdown/kit/prose/commands";
import { redo, undo } from "@milkdown/kit/prose/history";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";

import { ipc } from "../ipc";
import type { ApplyResult, Selector, Suggestion, Thread } from "../types";
import { codeTheme } from "./codeTheme";
import { commentMark, DRAFT_ID } from "./commentMark";
import {
  presencePlugin,
  setPresenceMeta,
  type PresenceRange,
} from "./presence";
import {
  suggestionAt,
  suggestionPlugin,
  setSuggestionsMeta,
  type SuggestionRange,
} from "./suggestions";
import { findKey, findPlugin, setFindMeta } from "./find";
import { TextMap } from "./textmap";
import { normaliseMarkdown } from "./normalise";
import { ImageResolver } from "./images";

export interface EditorHandle {
  getMarkdown(): string;
  /** Plain text, blocks separated by blank lines. */
  getPlainText(): string;
  /** HTML of the document without comment highlight spans. */
  getHtml(): string;
  /** Replace the content (keeps the editor instance). */
  setMarkdown(md: string): void;
  /**
   * Land one CLI edit as a single mapped transaction: `old` (plain text,
   * exactly once in the document) becomes the markdown `next`. Selection,
   * scroll and the other comment marks move with it; marks on the replaced
   * passage are carried onto the new text. Returns the plain text that
   * landed, or why nothing did.
   */
  applyEdit(old: string, next: string): ApplyResult;
  /** Locate threads and paint their marks. Returns ids that could not be anchored. */
  applyThreads(threads: Thread[]): Promise<string[]>;
  /** Current selectors from the marks, for every thread id present. */
  currentSelectors(ids: string[]): Promise<Map<string, Selector | null>>;
  /** Show where Claude is working. Anchors each selector and marks its block. */
  setPresence(items: PresenceItem[]): Promise<void>;
  /** Draw pending suggestions in the prose. */
  setSuggestions(items: Suggestion[], selected: string | null): void;
  /** How many times each passage occurs, without changing anything. The same
   *  search `applyEdit` makes, so a suggestion is called stale exactly when
   *  applying it would be refused. Takes them all at once: one pass over the
   *  document answers for every suggestion on it. */
  locateAll(quotes: string[]): number[];
  /** Step the document's own history. Driven by the Edit menu: the native
   *  Undo item owns Cmd+Z and never reaches the editor's keymap. */
  undo(): void;
  redo(): void;
  /** Highlight every match of `query` and scroll to the nearest. */
  find(query: string): FindResult;
  /** Move to the next (+1) or previous (-1) match, wrapping. */
  findStep(dir: 1 | -1): FindResult;
  clearFind(): void;
  /** Mark the current selection as a draft. Returns the selected text or null. */
  beginDraft(): string | null;
  cancelDraft(): void;
  /** Rename the draft mark to the thread id. */
  commitDraft(id: string): void;
  /** Selector for the current selection (used by Relocate). */
  selectionSelector(): Promise<Selector | null>;
  hasSelection(): boolean;
  scrollTo(id: string, block?: ScrollLogicalPosition): void;
  setSelected(id: string | null): void;
  setReadonly(v: boolean): void;
  focus(): void;
}

/** Where the find bar stands: 1-based `current`, 0 when nothing matches. */
export interface FindResult {
  current: number;
  total: number;
}

/** One passage Claude has in hand, before it is located in the document. */
export interface PresenceItem {
  selector: Selector;
  tier: "working" | "changed";
}

interface Props {
  initialMarkdown: string;
  /** Absolute path of the file on disk. Image URLs resolve against its folder. */
  docPath: string;
  onChange: (markdown: string) => void;
  /** A highlight was clicked, or (null) the document was clicked elsewhere. */
  onMarkClick: (id: string | null) => void;
  /** A suggestion's text was clicked. */
  onSuggestionClick: (id: string) => void;
  onRequestComment: () => void;
  onSelectionChange: (hasSelection: boolean) => void;
  /** Locked while the Claude Code session holds the document. */
  readonly: boolean;
}

// Block-type buttons for the selection toolbar. Crepe has no way back from a
// heading: its slash-menu "Text" item clears the block first, and the only
// other route is the unlabelled Mod-Alt-0. Text-as-glyph icons keep them
// readable at 20px where a generic pilcrow would not.
const glyphIcon = (text: string, size: number) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><text x="12" y="16.6" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-size="${size}" font-weight="600" letter-spacing="-0.02em">${text}</text></svg>`;

const BLOCK_TYPES: {
  key: string;
  label: string;
  icon: string;
  level: number;
}[] = [
  { key: "text", label: "Text", icon: glyphIcon("T", 14), level: 0 },
  { key: "h1", label: "Heading 1", icon: glyphIcon("H1", 11.5), level: 1 },
  { key: "h2", label: "Heading 2", icon: glyphIcon("H2", 11.5), level: 2 },
  { key: "h3", label: "Heading 3", icon: glyphIcon("H3", 11.5), level: 3 },
];

/**
 * Where `needle` occurs exactly once in `text`, as `[start, end]`; otherwise
 * the number of hits. A second pass ignores runs of whitespace, because the
 * markdown in the file wraps lines where the editor shows one space.
 */
function findOnce(text: string, needle: string): [number, number] | number {
  if (!needle) return 0;
  const exact = countHits(text, needle);
  if (exact.length === 1) return [exact[0], exact[0] + needle.length];
  if (exact.length > 1) return exact.length;
  // Collapse whitespace on both sides, keeping a map back to the original.
  const back: number[] = [];
  let squashed = "";
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!space && squashed.length) {
        squashed += " ";
        back.push(i);
      }
      space = true;
    } else {
      squashed += c;
      back.push(i);
      space = false;
    }
  }
  const wanted = needle.trim().replace(/\s+/g, " ");
  if (!wanted) return 0;
  const loose = countHits(squashed, wanted);
  if (loose.length !== 1) return loose.length;
  const a = back[loose[0]];
  const b = back[loose[0] + wanted.length - 1] + 1;
  return [a, b];
}

function countHits(text: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits; // indexOf('') never returns -1
  let i = text.indexOf(needle);
  while (i >= 0) {
    hits.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return hits;
}

/** The heading level of the block the selection starts in; 0 for a paragraph, -1 for anything else. */
function blockLevel(view: EditorView): number {
  const node = view.state.selection.$from.parent;
  if (node.type.name === "paragraph") return 0;
  if (node.type.name === "heading") return Number(node.attrs.level) || 0;
  return -1;
}

function setLevel(view: EditorView, level: number) {
  const { schema } = view.state;
  const type: NodeType | undefined =
    level === 0 ? schema.nodes.paragraph : schema.nodes.heading;
  if (!type) return;
  setBlockType(type, level === 0 ? undefined : { level })(
    view.state,
    view.dispatch,
  );
  view.focus();
}

/** Backspace at the very start of a heading turns it back into a paragraph,
 *  the way Notion does. It joins with the block above only on the next press.
 *  This is the inverse of the edit that produces an accidental heading: a
 *  backspace at the start of the block under one, which merges the two. */
function backspaceUnstylesHeading(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  if (
    event.key !== "Backspace" ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return false;
  const { $from, empty } = view.state.selection;
  if (
    !empty ||
    $from.parentOffset !== 0 ||
    $from.parent.type.name !== "heading"
  )
    return false;
  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return false;
  event.preventDefault();
  return setBlockType(paragraph)(view.state, view.dispatch);
}

const COMMENT_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path transform="translate(3.6 3.6) scale(0.7)" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM6 12h12v2H6zm0-3h12v2H6zm0-3h12v2H6z"/></svg>';

/** Stop the image block from spending the alt text on its own layout.
 *
 *  Milkdown's `image-block` keeps a resize ratio on the node, and serialises
 *  it into the markdown `alt` slot while putting the caption in `title`
 *  (checked in 7.22.1). So a round trip through the editor rewrites
 *  `![A chart of prices](chart.png)` as `![1.00](chart.png "")` and the alt
 *  text is gone — a silent loss in a file the user may publish.
 *
 *  Alt text is the part a reader depends on, and a plain markdown file has
 *  nowhere to record a ratio, so alt wins: the caption round-trips as alt, and
 *  a resize lasts for the session only. `resizeHandle` is hidden in
 *  `sidenote.css` so nobody is offered a size that will not survive the save.
 *
 *  This edits the ctx slice the schema is read from, rather than calling
 *  `extendSchema`, which returns a fresh plugin the editor never registered. */
function keepImageAltText(ctx: Ctx) {
  ctx.update(imageBlockSchema.key, (prev) => (c) => {
    const schema = prev(c);
    return {
      ...schema,
      parseMarkdown: {
        match: ({ type }) => type === "image-block",
        runner: (state, node, type) => {
          state.addNode(type, {
            src: (node.url as string) ?? "",
            caption: (node.alt as string) ?? "",
            ratio: 1,
          });
        },
      },
      toMarkdown: {
        match: (node) => node.type.name === "image-block",
        runner: (state, node) => {
          state.openNode("paragraph");
          state.addNode("image", undefined, undefined, {
            url: node.attrs.src,
            alt: node.attrs.caption,
            title: null,
          });
          state.closeNode();
        },
      },
    };
  });
}

/** Hand a URL to the Rust side, which re-checks it against the window
 *  navigation guard before opening it in the user's browser. */
function openExternally(href: string) {
  void ipc
    .openLink(href)
    .catch((err) => void ipc.uiLog(`open_link: ${String(err)}`));
}

export const Editor = forwardRef<EditorHandle, Props>(
  function Editor(props, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyRef = useRef(false);
    const propsRef = useRef(props);
    propsRef.current = props;
    const suppressChange = useRef(0);
    const imagesRef = useRef<ImageResolver | null>(null);

    useEffect(() => {
      const root = rootRef.current!;
      const images = new ImageResolver(() => propsRef.current.docPath);
      imagesRef.current = images;
      const crepe = new Crepe({
        root,
        defaultValue: props.initialMarkdown,
        features: {
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.AI]: false,
        },
        featureConfigs: {
          // The ⠿ handle is hidden in CSS, not here. BlockEdit cannot be turned
          // off — it owns the slash menu too — and its `blockHandle.shouldShow`
          // option is a dead end: Crepe forwards it, but BlockProvider's
          // constructor never reads it (checked in 7.22.1).
          [Crepe.Feature.Placeholder]: { text: "Start writing…", mode: "doc" },
          [Crepe.Feature.Cursor]: { virtual: false },
          [Crepe.Feature.CodeMirror]: { theme: codeTheme },
          // proxyDomURL runs on the URL as the node view mounts, so the markdown
          // keeps the path the file actually says and only the DOM sees the blob.
          // The one ImageBlock feature owns both the block and the inline image.
          [Crepe.Feature.ImageBlock]: { proxyDomURL: images.resolve },
          [Crepe.Feature.Toolbar]: {
            buildToolbar: (builder) => {
              const blocks = builder.addGroup("block", "Turn into");
              for (const b of BLOCK_TYPES) {
                blocks.addItem(b.key, {
                  icon: b.icon,
                  label: b.label,
                  active: (ctx) =>
                    blockLevel(ctx.get(editorViewCtx)) === b.level,
                  onRun: (ctx) => setLevel(ctx.get(editorViewCtx), b.level),
                });
              }
              builder.addGroup("sidenote", "Comment").addItem("comment", {
                icon: COMMENT_ICON,
                label: "Comment",
                shortcut: "⌘⇧M",
                active: () => false,
                onRun: () => propsRef.current.onRequestComment(),
              });
            },
          },
        },
      });

      crepe.editor
        .config((ctx) => {
          ctx.set(remarkStringifyOptionsCtx, {
            bullet: "-",
            emphasis: "_",
            strong: "*",
            rule: "-",
            fences: true,
            listItemIndent: "one",
            resourceLink: false,
          });
          ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
          keepImageAltText(ctx);
          // Cmd-click a link to open it, the way Word, Pages and VS Code do.
          // Plain click keeps placing the caret: in an editor a link is text you
          // may want to edit as often as follow. (Not Alt — in WebKit that means
          // "download linked file".)
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            handleKeyDown: (view, event) => {
              if (backspaceUnstylesHeading(view, event)) return true;
              return prev.handleKeyDown?.(view, event) ?? false;
            },
            handleDOMEvents: {
              ...prev.handleDOMEvents,
              // Dragging text inside the editor is off, and deliberately so.
              // `dragDropEnabled` is on in tauri.conf.json because only Tauri's
              // native handler reports a real path for a dropped file, and wry
              // claims every drag before WebKit sees it. A drag that starts here
              // is therefore captured by the file-drop layer: the veil appears
              // over a text drag and the drop does nothing. Refusing outright is
              // honest; a selection that lifts and then dies is not.
              dragstart: (_view, event) => {
                event.preventDefault();
                return true;
              },
              mousedown: (_view, event) => {
                const e = event as MouseEvent;
                if (!e.metaKey || e.button !== 0) return false;
                const href = (e.target as HTMLElement | null)
                  ?.closest("a[href]")
                  ?.getAttribute("href");
                if (!href) return false;
                e.preventDefault();
                openExternally(href);
                return true;
              },
            },
          }));
        })
        .use(commentMark)
        .use($prose(() => presencePlugin))
        .use($prose(() => suggestionPlugin))
        .use($prose(() => findPlugin));

      crepe.on((api) => {
        api.markdownUpdated((_ctx, md, prev) => {
          if (md === prev) return;
          if (suppressChange.current > 0) return;
          propsRef.current.onChange(normaliseMarkdown(md));
        });
        api.selectionUpdated((_ctx, selection) => {
          propsRef.current.onSelectionChange(!selection.empty);
        });
      });

      let cancelled = false;
      const created = crepe
        .create()
        .then(() => {
          if (cancelled) return;
          readyRef.current = true;
          crepeRef.current = crepe;
          crepe.setReadonly(propsRef.current.readonly);
        })
        .catch((e) => {
          console.error("sidenote: editor failed to create", e);
        });

      const onClick = (e: MouseEvent) => {
        // A suggestion sits on top of any comment highlight it overlaps, so a
        // click inside one is aimed at it and not at the comment underneath.
        const sug = suggestionAt(e.target);
        if (sug) {
          propsRef.current.onSuggestionClick(sug);
          return;
        }
        const el = (e.target as HTMLElement).closest(
          "[data-comment-id]",
        ) as HTMLElement | null;
        const id = el?.getAttribute("data-comment-id") ?? null;
        if (id === DRAFT_ID) return;
        propsRef.current.onMarkClick(id);
      };
      root.addEventListener("click", onClick);

      return () => {
        cancelled = true;
        root.removeEventListener("click", onClick);
        readyRef.current = false;
        crepeRef.current = null;
        imagesRef.current = null;
        void created.then(() => crepe.destroy()).catch(() => {});
        images.dispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const withView = <T,>(fn: (view: EditorView) => T): T | null => {
      const crepe = crepeRef.current;
      if (!crepe || !readyRef.current) return null;
      let out: T | null = null;
      crepe.editor.action((ctx) => {
        out = fn(ctx.get(editorViewCtx));
      });
      return out;
    };

    const markType = (view: EditorView) => view.state.schema.marks.comment;

    const runFind = (meta: {
      query?: string;
      step?: 1 | -1;
      clear?: boolean;
    }): FindResult => {
      const out = withView((view) => {
        const tr = setFindMeta(view.state.tr, meta);
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
        const st = findKey.getState(view.state);
        return {
          current: st && st.current >= 0 ? st.current + 1 : 0,
          total: st?.matches.length ?? 0,
        };
      });
      // The decoration is in the DOM once dispatch returns, so scroll to it here
      // rather than through view.domAtPos, which lands on the text node.
      rootRef.current
        ?.querySelector(".sidenote-find-current")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
      return out ?? { current: 0, total: 0 };
    };

    /** All mark ranges by id, in document order. */
    const collectMarks = (
      view: EditorView,
    ): Map<string, { from: number; to: number }[]> => {
      const out = new Map<string, { from: number; to: number }[]>();
      const type = markType(view);
      view.state.doc.descendants((node, pos) => {
        if (!node.isText) return true;
        for (const m of node.marks) {
          if (m.type !== type) continue;
          const id = m.attrs.id as string;
          const arr = out.get(id) ?? [];
          const last = arr[arr.length - 1];
          const from = pos;
          const to = pos + node.nodeSize;
          if (last && last.to === from) last.to = to;
          else arr.push({ from, to });
          out.set(id, arr);
        }
        return true;
      });
      return out;
    };

    const removeMarksWithId = (view: EditorView, id: string) => {
      const ranges = collectMarks(view).get(id);
      if (!ranges?.length) return;
      const type = markType(view);
      const tr = view.state.tr;
      for (const r of ranges) tr.removeMark(r.from, r.to, type.create({ id }));
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    };

    // The link chip Crepe shows on a plain click is the primary way to open a
    // link — no modifier, and it is visible rather than remembered. Its URL is
    // an <a target="_blank">, which opens a tab in a browser but does nothing
    // useful inside a webview, so intercept it. The chip is a tooltip rather
    // than editor content, so this cannot ride on the ProseMirror handler.
    // defaultPrevented dedupes: hidden tabs keep their editors mounted, so more
    // than one of these listeners is live at a time.
    useEffect(() => {
      const onClick = (event: MouseEvent) => {
        if (event.defaultPrevented) return;
        const a = (event.target as HTMLElement | null)?.closest(
          "a.link-display",
        );
        const href = a?.getAttribute("href");
        if (!href) return;
        event.preventDefault();
        openExternally(href);
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    }, []);

    // Declarative lock: React re-applies it on every change, and the create
    // handler applies it at mount, so it cannot be dropped by a mount race.
    useEffect(() => {
      if (readyRef.current) crepeRef.current?.setReadonly(props.readonly);
    }, [props.readonly]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () =>
        normaliseMarkdown(crepeRef.current?.getMarkdown() ?? ""),

      getPlainText: () =>
        withView((view) =>
          view.state.doc.textBetween(
            0,
            view.state.doc.content.size,
            "\n\n",
            "\n",
          ),
        ) ?? "",

      getHtml: () =>
        withView((view) => {
          const serializer = DOMSerializer.fromSchema(view.state.schema);
          const fragment = serializer.serializeFragment(view.state.doc.content);
          const holder = document.createElement("div");
          holder.appendChild(fragment);
          holder.querySelectorAll("[data-comment-id]").forEach((el) => {
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
          });
          return holder.innerHTML;
        }) ?? "",

      setMarkdown: (md) => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        // A reload means the file changed on disk, and the images beside it may
        // have changed with it. Drop the cache so they are read again.
        imagesRef.current?.dispose();
        suppressChange.current++;
        try {
          crepe.editor.action(replaceAll(md, true));
        } finally {
          // replaceAll dispatches synchronously; release on the next tick in
          // case listeners run after.
          setTimeout(() => {
            suppressChange.current--;
          }, 0);
        }
      },

      applyEdit: (old, next) => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current)
          return { ok: false, error: "not_ready" };
        let out: ApplyResult = { ok: false, error: "not_ready" };
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const map = new TextMap(view.state.doc);
          const hit = findOnce(map.text, old);
          if (typeof hit === "number") {
            out = { ok: false, error: "stale", found: hit };
            return;
          }
          const from = map.indexToPos(hit[0], "start");
          const to = map.indexToPos(hit[1], "end");
          if (from === null || to === null || to < from) {
            out = { ok: false, error: "stale", found: 0 };
            return;
          }
          const { doc } = view.state;
          const $from = doc.resolve(from);
          const $to = doc.resolve(to);
          // Comment marks on the passage, to carry onto the new text.
          const carried = new Set<string>();
          doc.nodesBetween(from, to, (node) => {
            for (const m of node.marks) {
              if (m.type === markType(view) && m.attrs.id !== DRAFT_ID)
                carried.add(m.attrs.id as string);
            }
          });
          const parsed = next.trim() ? ctx.get(parserCtx)(next) : null;
          const tr = view.state.tr;
          // Whole blocks replaced by whole blocks keep their block types (a
          // heading stays a heading). Anything else is an inline splice: the
          // fragment's edges merge into the paragraph around the passage, the
          // way replacing text in the file splits or joins the surrounding
          // paragraph.
          const wholeBlocks =
            $from.parent.isTextblock &&
            $to.parent.isTextblock &&
            $from.parentOffset === 0 &&
            $to.parentOffset === $to.parent.content.size;
          if (!parsed) {
            if (wholeBlocks) {
              // Deleting the only block of a list item (or any wrapper) takes
              // the wrapper with it; an empty item would serialise as `<br />`.
              let d = $from.depth;
              while (
                d > 1 &&
                $from.node(d - 1).childCount === 1 &&
                $from.sameParent($to)
              )
                d--;
              tr.delete($from.before(d), $to.after(d));
            } else {
              tr.delete(from, to);
            }
          } else if (wholeBlocks) {
            tr.replaceRange(
              $from.before(),
              $to.after(),
              new Slice(parsed.content, 0, 0),
            );
          } else {
            tr.replaceRange(from, to, new Slice(parsed.content, 1, 1));
          }
          const start = wholeBlocks && parsed ? $from.before() : from;
          const end = tr.mapping.map(wholeBlocks ? $to.after() : to);
          if (parsed && end > start) {
            const type = markType(view);
            for (const id of carried)
              tr.addMark(start, end, type.create({ id }));
          }
          tr.setMeta("sidenote-apply", true);
          view.dispatch(tr);
          const landed =
            parsed && end > start ? tr.doc.textBetween(start, end, "\n") : "";
          out = { ok: true, landed };
        });
        return out;
      },

      applyThreads: async (threads) => {
        const live = threads.filter((t) => t.status !== "resolved");
        const map = withView((view) => new TextMap(view.state.doc));
        if (!map) return live.map((t) => t.id);
        const found = live.length
          ? await ipc.anchorThreads(
              map.text,
              live.map((t) => t.selector),
            )
          : [];
        const missing: string[] = [];
        withView((view) => {
          const type = markType(view);
          const tr = view.state.tr;
          // Clear every non-draft comment mark.
          const existing = collectMarks(view);
          for (const [id, ranges] of existing) {
            if (id === DRAFT_ID) continue;
            for (const r of ranges)
              tr.removeMark(r.from, r.to, type.create({ id }));
          }
          live.forEach((t, i) => {
            const a = found[i];
            if (!a) {
              missing.push(t.id);
              return;
            }
            const jsFrom = map.cpToIndex(a.range.start);
            const jsTo = map.cpToIndex(a.range.end);
            const ranges = map.rangesFor(jsFrom, jsTo);
            if (!ranges.length) {
              missing.push(t.id);
              return;
            }
            for (const r of ranges)
              tr.addMark(r.from, r.to, type.create({ id: t.id }));
          });
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);
        });
        return missing;
      },

      setPresence: async (items) => {
        const map = withView((view) => new TextMap(view.state.doc));
        if (!map) return;
        const found = items.length
          ? await ipc.anchorThreads(
              map.text,
              items.map((i) => i.selector),
            )
          : [];
        const ranges: PresenceRange[] = [];
        items.forEach((item, i) => {
          const a = found[i];
          if (!a) return;
          // The same ranges the comment marks use, so the two line up exactly.
          const jsFrom = map.cpToIndex(a.range.start);
          const jsTo = map.cpToIndex(a.range.end);
          for (const r of map.rangesFor(jsFrom, jsTo))
            ranges.push({ ...r, tier: item.tier });
        });
        withView((view) => {
          const tr = setPresenceMeta(view.state.tr, ranges);
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);
        });
      },

      setSuggestions: (items, selected) => {
        withView((view) => {
          const map = new TextMap(view.state.doc);
          const ranges: SuggestionRange[] = [];
          for (const s of items) {
            // `findOnce`, the same search `applyEdit` makes, so what is drawn
            // and what would be replaced are the same passage. A suggestion
            // whose text is gone or has become ambiguous draws nothing: the
            // card still says it is stale, and pointing at a lookalike
            // elsewhere would be worse than pointing at nothing.
            const hit = findOnce(map.text, s.quote);
            if (typeof hit === "number") continue;
            const from = map.indexToPos(hit[0], "start");
            if (from === null) continue;
            ranges.push({
              id: s.id,
              from,
              segs: s.segs,
              selected: s.id === selected,
            });
          }
          const tr = setSuggestionsMeta(view.state.tr, ranges);
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);
        });
      },

      locateAll: (quotes) => {
        const counts = withView((view) => {
          const map = new TextMap(view.state.doc);
          return quotes.map((q) => {
            const hit = findOnce(map.text, q);
            return typeof hit === "number" ? hit : 1;
          });
        });
        // No editor yet is not the same as no match. Claiming one hit leaves
        // the suggestion alone until there is something to measure it against.
        return counts ?? quotes.map(() => 1);
      },

      undo: () => {
        withView((view) => undo(view.state, view.dispatch));
      },

      redo: () => {
        withView((view) => redo(view.state, view.dispatch));
      },

      find: (query) => runFind({ query }),
      findStep: (dir) => runFind({ step: dir }),
      clearFind: () => {
        runFind({ clear: true });
      },

      currentSelectors: async (ids) => {
        const result = new Map<string, Selector | null>();
        const snap = withView((view) => {
          const map = new TextMap(view.state.doc);
          const marks = collectMarks(view);
          return { map, marks };
        });
        if (!snap) return result;
        const ranges: [number, number][] = [];
        const order: string[] = [];
        for (const id of ids) {
          const rs = snap.marks.get(id);
          if (!rs?.length) {
            result.set(id, null);
            continue;
          }
          const a = snap.map.posToIndex(rs[0].from);
          const b = snap.map.posToIndex(rs[rs.length - 1].to);
          if (a === null || b === null || b <= a) {
            result.set(id, null);
            continue;
          }
          ranges.push([snap.map.indexToCp(a), snap.map.indexToCp(b)]);
          order.push(id);
        }
        if (ranges.length) {
          const sels = await ipc.makeSelectors(snap.map.text, ranges);
          order.forEach((id, i) => result.set(id, sels[i]));
        }
        return result;
      },

      beginDraft: () => {
        return (
          withView((view) => {
            const { from, to, empty } = view.state.selection;
            if (empty) return null;
            removeMarksWithId(view, DRAFT_ID);
            const type = markType(view);
            const tr = view.state.tr.addMark(
              from,
              to,
              type.create({ id: DRAFT_ID }),
            );
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);
            return view.state.doc.textBetween(from, to, "\n");
          }) ?? null
        );
      },

      cancelDraft: () => {
        withView((view) => removeMarksWithId(view, DRAFT_ID));
      },

      commitDraft: (id) => {
        withView((view) => {
          const ranges = collectMarks(view).get(DRAFT_ID);
          if (!ranges?.length) return;
          const type = markType(view);
          const tr = view.state.tr;
          for (const r of ranges) {
            tr.removeMark(r.from, r.to, type.create({ id: DRAFT_ID }));
            tr.addMark(r.from, r.to, type.create({ id }));
          }
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);
        });
      },

      selectionSelector: async () => {
        const snap = withView((view) => {
          const { from, to, empty } = view.state.selection;
          if (empty) return null;
          const map = new TextMap(view.state.doc);
          const a = map.posToIndex(from);
          const b = map.posToIndex(to);
          if (a === null || b === null || b <= a) return null;
          return {
            text: map.text,
            range: [map.indexToCp(a), map.indexToCp(b)] as [number, number],
          };
        });
        if (!snap) return null;
        const [sel] = await ipc.makeSelectors(snap.text, [snap.range]);
        return sel ?? null;
      },

      hasSelection: () =>
        withView((view) => !view.state.selection.empty) ?? false,

      scrollTo: (id, block = "center") => {
        const el = rootRef.current?.querySelector(
          `[data-comment-id="${CSS.escape(id)}"]`,
        );
        el?.scrollIntoView({ block, behavior: "smooth" });
      },

      setSelected: (id) => {
        const root = rootRef.current;
        if (!root) return;
        root
          .querySelectorAll(".sidenote-comment-selected")
          .forEach((el) => el.classList.remove("sidenote-comment-selected"));
        if (id) {
          root
            .querySelectorAll(`[data-comment-id="${CSS.escape(id)}"]`)
            .forEach((el) => el.classList.add("sidenote-comment-selected"));
        }
      },

      setReadonly: (v) => {
        crepeRef.current?.setReadonly(v);
      },

      focus: () => {
        withView((view) => view.focus());
      },
    }));

    // Re-export marks for unit testing via a hidden helper.
    void (null as unknown as Mark);

    return <div className="sidenote-editor" ref={rootRef} />;
  },
);
