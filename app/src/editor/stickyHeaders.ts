// A table taller than the document pane keeps its header row in view: while
// the body scrolls past, a copy of the header sits at the top of the pane,
// and it scrolls away with the table's last row.
//
// Why a copy and not `position: sticky` on the header cells: a table that is
// wider than the page scrolls sideways inside its own `.table-wrapper`, and a
// sideways scroller is a scroll container in both axes, so a sticky cell
// inside it sticks to the wrapper (which never scrolls vertically) and never
// to the pane. Moving the real cells from script is no better. They live in
// ProseMirror's content DOM, so a style written on them is read back as a
// change to the document and redrawn away; a custom property set on the
// table instead restyles all of its cells on every scroll frame (about 45 ms
// for a 24,000-cell table in WebKit).
//
// So the copy lives outside the content DOM, in a strip placed just before
// the wrapper. The strip is `position: sticky` against the pane, so vertical
// scrolling runs no script at all. Script does three cheap things, all from
// observers rather than on every transaction:
//   - decides which tables are tall enough (ResizeObserver on each table),
//   - shows the copy only while the real header is above the pane's top edge
//     (IntersectionObserver on a 1px sentinel), so the caret and selection
//     in the real header are never covered,
//   - rebuilds the copy when the real header row changes (MutationObserver)
//     or a column changes width (ResizeObserver on the header cells), and
//     follows the wrapper's sideways scroll.
// A rebuild copies one row, runs at most once a frame, and reads no layout:
// every size comes from what the ResizeObserver last reported, and the
// sideways offset from the last scroll event. Measuring the real cells
// instead forces a layout of the whole table, about 60 ms a keystroke at
// 24,000 cells, since typing in a column widens its header cell too.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

export const stickyHeadersKey = new PluginKey("sidenote-sticky-headers");

const BLOCK = "milkdown-table-block";
/** Attributes that other code looks elements up by; the copy must not answer. */
const STRIP_ATTRS = ["id", "name", "data-comment-id", "data-suggestion-id"];
const STRIP_CLASSES = ["sidenote-find-current", "selectedCell", "ProseMirror-selectednode"];

interface Rec {
  block: HTMLElement;
  wrapper: HTMLElement;
  table: HTMLTableElement;
  /** Taller than the pane: the only tables that get a strip. */
  tall: boolean;
  /** The real header row is above the pane's top edge. */
  stuck: boolean;
  /** The copy no longer matches the real header. */
  stale: boolean;
  /** The header row being watched. */
  row: HTMLTableRowElement | null;
  /** How far the wrapper runs past the table: margin and scrollbar. */
  below: number;
  /** The wrapper's sideways scroll, as of its last scroll event. */
  x: number;
  sentinel: HTMLElement | null;
  strip: HTMLElement | null;
  copy: HTMLTableElement | null;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  const main = el.closest<HTMLElement>(".main");
  if (main) return main;
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
  }
  return null;
}

function cleanCopy(root: Element) {
  const all = [root, ...root.querySelectorAll("*")];
  for (const el of all) {
    for (const a of STRIP_ATTRS) el.removeAttribute(a);
    if (el.classList.length) el.classList.remove(...STRIP_CLASSES);
  }
}

function setPx(el: HTMLElement, prop: "height" | "marginTop" | "marginBottom", px: number) {
  const v = `${px}px`;
  if (el.style[prop] !== v) el.style[prop] = v;
}

class StickyView {
  private readonly view: EditorView;
  private scroller: HTMLElement | null = null;
  private readonly blocks: HTMLCollectionOf<Element>;
  private readonly recs = new Map<HTMLElement, Rec>();
  /** Tables, header cells and sentinels, back to their record. */
  private readonly owner = new WeakMap<Element, Rec>();
  /** Border-box sizes of tables and header cells, from the ResizeObserver. */
  private readonly sizes = new WeakMap<Element, { w: number; h: number }>();
  private paneH = 0;
  private resize: ResizeObserver | null = null;
  private watch: IntersectionObserver | null = null;
  private readonly mutations: MutationObserver;
  private blocksDirty = true;
  private frame = 0;

  constructor(view: EditorView) {
    this.view = view;
    // Live: cheap to walk, and kept current by the browser.
    this.blocks = view.dom.getElementsByClassName(BLOCK);
    this.mutations = new MutationObserver((records) => this.onMutate(records));
    this.schedule();
  }

  update(view: EditorView, prev: EditorState) {
    if (view.state.doc === prev.doc) return;
    // A table may have come or gone. Finding out is deferred to the frame.
    this.blocksDirty = true;
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.watch?.disconnect();
    this.mutations.disconnect();
    for (const rec of this.recs.values()) this.teardown(rec);
    this.recs.clear();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  }

  private ensureObservers(): boolean {
    if (this.scroller) return true;
    const scroller = scrollParent(this.view.dom);
    if (!scroller) return false;
    this.scroller = scroller;
    this.resize = new ResizeObserver((entries) => this.onResize(entries));
    this.resize.observe(scroller);
    this.watch = new IntersectionObserver((entries) => this.onCross(entries), {
      root: scroller,
      threshold: [0, 1],
    });
    return true;
  }

  private run() {
    if (this.view.isDestroyed || !this.ensureObservers()) return;
    if (this.blocksDirty) {
      this.blocksDirty = false;
      this.syncBlocks();
    }
    for (const rec of this.recs.values()) {
      if (rec.tall && rec.stuck && rec.stale) this.rebuild(rec);
    }
  }

  /** Track the table blocks now in the document; drop the ones gone. */
  private syncBlocks() {
    const seen = new Set<HTMLElement>();
    for (const el of Array.from(this.blocks)) {
      const block = el as HTMLElement;
      seen.add(block);
      const rec = this.recs.get(block);
      if (rec && block.contains(rec.table)) continue;
      if (rec) this.forget(rec);
      const table = block.querySelector<HTMLTableElement>("table.children");
      const wrapper = block.querySelector<HTMLElement>(".table-wrapper");
      if (!table || !wrapper) continue;
      const fresh: Rec = {
        block,
        wrapper,
        table,
        tall: false,
        stuck: false,
        stale: true,
        row: null,
        below: 0,
        x: 0,
        sentinel: null,
        strip: null,
        copy: null,
      };
      this.recs.set(block, fresh);
      this.owner.set(table, fresh);
      // Fires once with the current size, then on every change.
      this.resize?.observe(table);
    }
    for (const rec of this.recs.values()) {
      if (!seen.has(rec.block)) this.forget(rec);
    }
  }

  private forget(rec: Rec) {
    this.resize?.unobserve(rec.table);
    this.teardown(rec);
    this.recs.delete(rec.block);
  }

  private onResize(entries: ResizeObserverEntry[]) {
    const scroller = this.scroller;
    if (!scroller) return;
    // Layout is fresh inside this callback, so reading it here costs nothing.
    const tables = new Set<Rec>();
    let all = false;
    for (const e of entries) {
      if (e.target === scroller) {
        this.paneH = scroller.clientHeight;
        all = true;
        continue;
      }
      const box = e.borderBoxSize?.[0];
      const size = {
        w: box?.inlineSize ?? e.contentRect.width,
        h: box?.blockSize ?? e.contentRect.height,
      };
      const was = this.sizes.get(e.target);
      this.sizes.set(e.target, size);
      const rec = this.owner.get(e.target);
      if (!rec) continue;
      if (e.target === rec.table) {
        tables.add(rec);
        // A body edit makes the table taller; only its width is in the copy.
        if (was?.w !== size.w) rec.stale = true;
      } else {
        // A header cell changed size: a column was resized or reflowed.
        rec.stale = true;
      }
    }
    for (const rec of all ? this.recs.values() : tables) {
      // A block the browser has skipped (content-visibility) reports no
      // size; it is measured again when it comes into view.
      const tall = (this.sizes.get(rec.table)?.h ?? 0) > this.paneH;
      if (tall !== rec.tall) {
        rec.tall = tall;
        if (tall) this.setup(rec);
        else this.teardown(rec);
      }
      if (rec.strip) {
        const below = this.measureBelow(rec);
        if (below !== rec.below) {
          rec.below = below;
          rec.stale = true;
        }
      }
    }
    this.schedule();
  }

  private measureBelow(rec: Rec): number {
    const t = rec.table.getBoundingClientRect().bottom;
    return Math.max(0, Math.round(rec.wrapper.getBoundingClientRect().bottom - t));
  }

  private onMutate(records: MutationRecord[]) {
    for (const m of records) {
      const block = (m.target as Element).parentElement?.closest<HTMLElement>(`.${BLOCK}`);
      const rec = block ? this.recs.get(block) : undefined;
      if (!rec?.strip) continue;
      rec.stale = true;
      // The tbody's own children changed: the header row may be a new one.
      if (m.target === rec.table.tBodies[0]) this.watchRow(rec);
    }
    this.schedule();
  }

  private onCross(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const rec = this.owner.get(e.target);
      if (!rec || !e.rootBounds) continue;
      const stuck = !e.isIntersecting && e.boundingClientRect.top < e.rootBounds.top;
      if (stuck === rec.stuck) continue;
      rec.stuck = stuck;
      if (stuck && rec.stale) this.rebuild(rec);
      rec.strip?.toggleAttribute("data-stuck", stuck);
    }
  }

  /** Put the sentinel and the sticky strip in front of the wrapper. */
  private setup(rec: Rec) {
    if (rec.strip) return;
    const parent = rec.wrapper.parentElement;
    const body = rec.table.tBodies[0];
    if (!parent || !body) return;
    const sentinel = document.createElement("div");
    sentinel.className = "sidenote-sticky-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    const strip = document.createElement("div");
    strip.className = "sidenote-sticky-head";
    strip.setAttribute("aria-hidden", "true");
    strip.contentEditable = "false";
    parent.insertBefore(sentinel, rec.wrapper);
    parent.insertBefore(strip, rec.wrapper);
    rec.sentinel = sentinel;
    rec.strip = strip;
    rec.stale = true;
    rec.wrapper.addEventListener("scroll", this.onSideScroll, { passive: true });
    this.owner.set(sentinel, rec);
    this.watch?.observe(sentinel);
    this.mutations.observe(body, { childList: true });
    rec.below = this.measureBelow(rec);
    rec.x = rec.wrapper.scrollLeft;
    this.watchRow(rec);
  }

  /** Watch the current header row and its cells. */
  private watchRow(rec: Rec) {
    const row = rec.table.tBodies[0]?.rows[0] ?? null;
    if (row === rec.row) return;
    if (rec.row) for (const c of Array.from(rec.row.cells)) this.resize?.unobserve(c);
    rec.row = row;
    if (!row) return;
    this.mutations.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    for (const c of Array.from(row.cells)) {
      this.owner.set(c, rec);
      this.resize?.observe(c);
    }
  }

  private teardown(rec: Rec) {
    if (!rec.strip) return;
    if (rec.sentinel) this.watch?.unobserve(rec.sentinel);
    if (rec.row) for (const c of Array.from(rec.row.cells)) this.resize?.unobserve(c);
    // MutationObserver has no per-target unobserve. Its callback ignores a
    // table without a strip, and observing ends when the nodes are gone.
    rec.wrapper.removeEventListener("scroll", this.onSideScroll);
    rec.sentinel?.remove();
    rec.strip.remove();
    rec.wrapper.style.marginTop = "";
    rec.sentinel = rec.strip = rec.copy = rec.row = null;
    rec.stuck = false;
  }

  /** Copy the header row and give every column the real one's width. */
  private rebuild(rec: Rec) {
    const strip = rec.strip;
    const row = rec.row;
    const table = this.sizes.get(rec.table);
    if (!strip || !row || !table) return;
    const cells = Array.from(row.cells, (c) => this.sizes.get(c));
    // A cell the observer has not reported yet: its first report rebuilds.
    if (cells.some((c) => !c)) return;
    rec.stale = false;
    const widths = cells.map((c) => c!.w);
    const rowH = Math.max(0, ...cells.map((c) => c!.h));
    const below = rec.below;

    const copy = document.createElement("table");
    const body = document.createElement("tbody");
    const tr = row.cloneNode(true) as HTMLTableRowElement;
    cleanCopy(tr);
    Array.from(tr.cells).forEach((c, i) => {
      c.style.width = `${widths[i] ?? 0}px`;
    });
    tr.style.height = `${rowH}px`;
    body.appendChild(tr);
    copy.appendChild(body);
    copy.style.width = `${table.w}px`;
    strip.replaceChildren(copy);
    rec.copy = copy;

    // The strip takes the header's height, and a bottom margin for what the
    // wrapper has below the table, so it stops, like a sticky header does,
    // when its bottom meets the table's last row. The wrapper is pulled up
    // by the same amount so nothing below moves.
    setPx(strip, "height", rowH);
    setPx(strip, "marginBottom", below);
    setPx(rec.wrapper, "marginTop", -(rowH + below));
    this.alignSideways(rec);
  }

  private alignSideways(rec: Rec) {
    if (!rec.copy) return;
    rec.copy.style.transform = rec.x ? `translateX(${-rec.x}px)` : "";
  }

  private onSideScroll = (e: Event) => {
    const block = (e.currentTarget as HTMLElement).closest<HTMLElement>(`.${BLOCK}`);
    const rec = block ? this.recs.get(block) : undefined;
    if (!rec) return;
    rec.x = rec.wrapper.scrollLeft;
    this.alignSideways(rec);
  };
}

export const stickyHeadersPlugin = new Plugin({
  key: stickyHeadersKey,
  view: (view) => new StickyView(view),
});
