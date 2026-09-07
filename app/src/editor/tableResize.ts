// Drag a column boundary in a table to change its width. Cursor-only, the
// way Google Docs and Notion do it: nothing is drawn on hover, the cursor
// becomes `col-resize` near an internal boundary, and while dragging the
// border being moved is highlighted.
//
// Why not prosemirror-tables' `columnResizing` (which the gfm preset exports
// but Crepe does not enable): it refuses to work when the view is not
// editable, so it would die under the document lock, and it paints widths
// through its own `TableView` node view with a `<colgroup>`. Crepe replaces
// that node view with its table block, which renders a bare `<table>`, so the
// stock plugin would have nowhere to write the widths. This plugin does the
// same job with its own DOM handling and works whether the document is
// locked or not, since how wide a column looks is a viewing affordance.
//
// A drag moves width between the two columns either side of the boundary,
// so the table's total width never changes. Widths are painted as
// percentages of that total, so the table keeps the stylesheet's full width
// when the window is resized. They live in the cells' `colwidth` attr, the
// attr the schema already has. GFM has no syntax for them, so they never
// reach the markdown: the serialised text is identical before and after a
// resize, no save is triggered, and the transaction stays out of the undo
// history. To survive a reload (and the rebuild that follows every change
// made on disk) they are remembered per document path in localStorage,
// keyed by the header row's text, and put back whenever a table with that
// header and column count appears without widths.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { cellAround, TableMap } from "@milkdown/kit/prose/tables";

export const tableResizeKey = new PluginKey<DecorationSet>(
  "sidenote-table-resize",
);

/** Pointer distance from a cell edge, in px, that counts as the boundary. */
const EDGE = 6;
const MIN_WIDTH = 40;
const STORAGE_PREFIX = "sidenote.tableWidths:";
/** Set on the table block while the pointer is on a boundary or dragging. */
const ZONE_ATTR = "data-col-resize";

type Stored = Record<string, number[]>;

function readStore(path: string): Stored {
  if (!path) return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + path);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function writeStore(path: string, data: Stored) {
  if (!path) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + path, JSON.stringify(data));
  } catch {
    // Storage full or unavailable: the widths still hold for this session.
  }
}

/** A table is identified by its header text and column count. */
function tableKey(table: PMNode): string | null {
  const row = table.firstChild;
  if (!row) return null;
  const cells: string[] = [];
  row.forEach((cell) => cells.push(cell.textContent.trim()));
  return `${cells.length}#${cells.join("|")}`;
}

/** Widths of the columns as the first row declares them, null where unset. */
function columnWidths(table: PMNode): (number | null)[] {
  const out: (number | null)[] = [];
  const row = table.firstChild;
  if (!row) return out;
  row.forEach((cell) => {
    const colspan: number = cell.attrs.colspan ?? 1;
    const colwidth: number[] | null = cell.attrs.colwidth ?? null;
    for (let j = 0; j < colspan; j++) out.push(colwidth?.[j] || null);
  });
  return out;
}

/**
 * Write the widths into a `<colgroup>` on the table, creating it once. Each
 * column gets its share of the total as a percentage; a table with no widths
 * gets an empty colgroup and lays out as before.
 */
function paint(tableEl: HTMLTableElement, widths: (number | null)[]) {
  let colgroup = tableEl.querySelector(":scope > colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    tableEl.insertBefore(colgroup, tableEl.firstChild);
  }
  const complete = widths.length > 0 && widths.every((w) => w);
  const cols = complete ? widths : [];
  while (colgroup.childElementCount > cols.length)
    colgroup.lastElementChild?.remove();
  while (colgroup.childElementCount < cols.length)
    colgroup.appendChild(document.createElement("col"));
  const total = cols.reduce<number>((a, w) => a + (w ?? 0), 0);
  cols.forEach((w, i) => {
    const col = colgroup.children[i] as HTMLElement;
    const css = `${((100 * (w ?? 0)) / total).toFixed(3)}%`;
    if (col.style.width !== css) col.style.width = css;
  });
}

/**
 * The `<table>` element Crepe's block renders for the table at `pos`, found
 * through the first row so it does not depend on the block's class names.
 */
function tableElementAt(view: EditorView, pos: number): HTMLTableElement | null {
  const row = view.nodeDOM(pos + 1);
  if (!(row instanceof HTMLElement)) return null;
  const el = row.closest("table");
  return el instanceof HTMLTableElement ? el : null;
}

/** Crepe's node view element for the table containing `el`. */
function blockOf(el: Element): HTMLElement | null {
  return el.closest(".milkdown-table-block");
}

/** Rendered width of every column, from the first row's cells. */
function renderedWidths(tableEl: HTMLTableElement): number[] {
  const row = tableEl.tBodies[0]?.rows[0];
  if (!row) return [];
  return Array.from(row.cells, (c) =>
    Math.round(c.getBoundingClientRect().width),
  );
}

/** Set `width` on every cell of column `col`, skipping cells already there. */
function setColumnWidth(
  tr: Transaction,
  table: PMNode,
  start: number,
  map: TableMap,
  col: number,
  width: number,
) {
  for (let row = 0; row < map.height; row++) {
    const idx = row * map.width + col;
    if (row && map.map[idx] === map.map[idx - map.width]) continue;
    const pos = map.map[idx];
    const cell = table.nodeAt(pos);
    if (!cell) continue;
    const index = cell.attrs.colspan === 1 ? 0 : col - map.colCount(pos);
    if (cell.attrs.colwidth?.[index] === width) continue;
    const colwidth: number[] = cell.attrs.colwidth
      ? cell.attrs.colwidth.slice()
      : new Array(cell.attrs.colspan ?? 1).fill(0);
    colwidth[index] = width;
    tr.setNodeMarkup(start + pos, null, { ...cell.attrs, colwidth });
  }
}

/** Node decorations marking the right border of every cell in `col`. */
function columnDecorations(
  doc: PMNode,
  tablePos: number,
  col: number,
): DecorationSet {
  const table = doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return DecorationSet.empty;
  const map = TableMap.get(table);
  const start = tablePos + 1;
  const decos: Decoration[] = [];
  for (let row = 0; row < map.height; row++) {
    const idx = row * map.width + col;
    if (row && map.map[idx] === map.map[idx - map.width]) continue;
    const pos = map.map[idx];
    const cell = table.nodeAt(pos);
    if (!cell) continue;
    decos.push(
      Decoration.node(start + pos, start + pos + cell.nodeSize, {
        class: "sidenote-col-resizing",
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

interface Drag {
  /** Position of the table node. */
  tablePos: number;
  tableEl: HTMLTableElement;
  block: HTMLElement;
  /** Column on the left of the boundary; `col + 1` is on the right. */
  col: number;
  startX: number;
  /** Every column's width when the drag began, seeded if none was set. */
  startWidths: number[];
  widths: number[];
}

interface Zone {
  block: HTMLElement;
  tablePos: number;
  col: number;
}

class ResizeView {
  private readonly view: EditorView;
  private readonly docPath: () => string;
  private zone: Zone | null = null;
  private drag: Drag | null = null;
  private restoreQueued = false;
  /** Tables already offered their stored widths, so a miss is not retried. */
  private readonly restored = new WeakSet<PMNode>();

  constructor(view: EditorView, docPath: () => string) {
    this.view = view;
    this.docPath = docPath;
    view.dom.addEventListener("pointermove", this.onPointerMove);
    view.dom.addEventListener("pointerleave", this.onPointerLeave);
    // Capture: it must win before ProseMirror or Crepe see the press.
    view.dom.addEventListener("pointerdown", this.onPointerDown, true);
    this.sync();
  }

  update(view: EditorView, prev: EditorState) {
    if (view.state.doc === prev.doc) return;
    if (!this.drag) this.leaveZone();
    this.sync();
  }

  destroy() {
    this.endDrag(false);
    this.leaveZone();
    this.view.dom.removeEventListener("pointermove", this.onPointerMove);
    this.view.dom.removeEventListener("pointerleave", this.onPointerLeave);
    this.view.dom.removeEventListener("pointerdown", this.onPointerDown, true);
  }

  /** Paint every table from its attrs; queue a restore for those without. */
  private sync() {
    const { doc } = this.view.state;
    const path = this.docPath();
    let wantRestore = false;
    doc.descendants((node, pos) => {
      if (node.type.spec.tableRole !== "table") return true;
      const el = tableElementAt(this.view, pos);
      if (el) paint(el, columnWidths(node));
      if (path && !this.restored.has(node)) {
        this.restored.add(node);
        if (columnWidths(node).every((w) => !w)) wantRestore = true;
      }
      return false;
    });
    if (wantRestore && !this.restoreQueued) {
      this.restoreQueued = true;
      // Not from inside the state update that called us.
      queueMicrotask(() => {
        this.restoreQueued = false;
        this.restore();
      });
    }
  }

  private restore() {
    const view = this.view;
    if (view.isDestroyed) return;
    const stored = readStore(this.docPath());
    const { state } = view;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole !== "table") return true;
      if (!columnWidths(node).every((w) => !w)) return false;
      const key = tableKey(node);
      const widths = key ? stored[key] : undefined;
      const map = TableMap.get(node);
      if (!widths || widths.length !== map.width || !widths.every((w) => w > 0))
        return false;
      widths.forEach((w, col) => setColumnWidth(tr, node, pos + 1, map, col, w));
      return false;
    });
    if (!tr.docChanged) return;
    view.dispatch(tr.setMeta("addToHistory", false));
  }

  private remember(table: PMNode) {
    const path = this.docPath();
    const key = tableKey(table);
    if (!path || !key) return;
    const stored = readStore(path);
    stored[key] = columnWidths(table).map((w) => w ?? 0);
    writeStore(path, stored);
  }

  /**
   * The internal boundary under the pointer: the column whose right edge it
   * is on, or null. The table's outer edges do not count.
   */
  private boundaryAt(e: PointerEvent): Zone | null {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    let cell = target.closest("td, th") as HTMLElement | null;
    if (!cell || !this.view.dom.contains(cell)) return null;
    const r = cell.getBoundingClientRect();
    if (r.right - e.clientX <= EDGE) {
      if (!cell.nextElementSibling) return null;
    } else if (e.clientX - r.left <= EDGE) {
      const prev = cell.previousElementSibling;
      if (!(prev instanceof HTMLElement)) return null;
      cell = prev;
    } else {
      return null;
    }
    const block = blockOf(cell);
    if (!block) return null;
    let pos: number;
    try {
      pos = this.view.posAtDOM(cell, 0);
    } catch {
      return null;
    }
    const $cell = cellAround(this.view.state.doc.resolve(pos));
    if (!$cell) return null;
    const table = $cell.node(-1);
    const start = $cell.start(-1);
    const map = TableMap.get(table);
    const col =
      map.colCount($cell.pos - start) + ($cell.nodeAfter?.attrs.colspan ?? 1) - 1;
    if (col >= map.width - 1) return null;
    return { block, tablePos: start - 1, col };
  }

  private enterZone(zone: Zone) {
    if (this.zone && this.zone.block !== zone.block) this.leaveZone();
    zone.block.setAttribute(ZONE_ATTR, "");
    this.zone = zone;
  }

  private leaveZone() {
    this.zone?.block.removeAttribute(ZONE_ATTR);
    this.zone = null;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.drag) return;
    const hit = this.boundaryAt(e);
    if (hit) this.enterZone(hit);
    else if (this.zone) this.leaveZone();
  };

  private onPointerLeave = () => {
    if (!this.drag) this.leaveZone();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.drag) return;
    const zone = this.boundaryAt(e);
    if (!zone) return;
    const tableEl = tableElementAt(this.view, zone.tablePos);
    const table = this.view.state.doc.nodeAt(zone.tablePos);
    if (!tableEl || !table) return;
    // No caret, no cell selection and no Crepe handle: the press is a drag.
    e.preventDefault();
    e.stopPropagation();
    this.enterZone(zone);
    // A table that was never resized has no widths; seed every column with
    // what is on screen so the two either side of the boundary can trade.
    const attrs = columnWidths(table);
    const startWidths = attrs.every((w) => w)
      ? (attrs as number[])
      : renderedWidths(tableEl);
    if (startWidths.length !== TableMap.get(table).width) return;
    this.drag = {
      tablePos: zone.tablePos,
      tableEl,
      block: zone.block,
      col: zone.col,
      startX: e.clientX,
      startWidths,
      widths: startWidths.slice(),
    };
    document.documentElement.classList.add("sidenote-col-resizing");
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragCancel);
    this.view.dispatch(
      this.view.state.tr.setMeta(tableResizeKey, {
        decos: columnDecorations(this.view.state.doc, zone.tablePos, zone.col),
      }),
    );
  };

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!e.buttons) return this.endDrag(true);
    const pair = d.startWidths[d.col] + d.startWidths[d.col + 1];
    const left = Math.min(
      Math.max(MIN_WIDTH, Math.round(d.startWidths[d.col] + e.clientX - d.startX)),
      pair - MIN_WIDTH,
    );
    d.widths[d.col] = left;
    d.widths[d.col + 1] = pair - left;
    paint(d.tableEl, d.widths);
  };

  private onDragEnd = () => this.endDrag(true);
  private onDragCancel = () => this.endDrag(false);

  private endDrag(commit: boolean) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    document.documentElement.classList.remove("sidenote-col-resizing");
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragCancel);
    this.leaveZone();
    const { state } = this.view;
    const tr = state.tr.setMeta(tableResizeKey, { decos: DecorationSet.empty });
    const table = state.doc.nodeAt(d.tablePos);
    const map = table && table.type.spec.tableRole === "table" ? TableMap.get(table) : null;
    if (commit && table && map && map.width === d.widths.length) {
      d.widths.forEach((w, col) =>
        setColumnWidth(tr, table, d.tablePos + 1, map, col, w),
      );
    }
    const changed = tr.docChanged;
    this.view.dispatch(tr.setMeta("addToHistory", false));
    const after = this.view.state.doc.nodeAt(d.tablePos);
    if (changed && after) this.remember(after);
    // Nothing landed: put the DOM back the way the attrs say.
    if (!changed) this.sync();
  }
}

/**
 * `docPath` is read when needed, so the plugin follows the document the
 * editor shows; an empty path (a draft with no file yet) turns persistence off.
 */
export function tableResizePlugin(docPath: () => string): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tableResizeKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, value) {
        const meta = tr.getMeta(tableResizeKey) as
          | { decos: DecorationSet }
          | undefined;
        if (meta) return meta.decos;
        return tr.docChanged ? value.map(tr.mapping, tr.doc) : value;
      },
    },
    props: {
      decorations: (state) => tableResizeKey.getState(state),
    },
    view: (view) => new ResizeView(view, docPath),
  });
}
