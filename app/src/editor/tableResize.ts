// Drag a column boundary in a table to change its width.
//
// Why not prosemirror-tables' `columnResizing` (which the gfm preset exports
// but Crepe does not enable): it refuses to work when the view is not
// editable, so it would die under the document lock, and it paints widths
// through its own `TableView` node view with a `<colgroup>`. Crepe replaces
// that node view with its table block, which renders a bare `<table>`, so the
// stock plugin would have nowhere to write the widths. This plugin does the
// same job with its own DOM handling: one floating handle, no decorations, no
// transactions on hover, and it works whether the document is locked or not,
// since changing how wide a column looks is a viewing affordance.
//
// Widths live in the cells' `colwidth` attr, the attr the schema already has.
// GFM has no syntax for them, so they never reach the markdown: the serialised
// text is identical before and after a resize, no save is triggered, and the
// transaction stays out of the undo history. To survive a reload (and the
// rebuild that follows every change made on disk) they are remembered per
// document path in localStorage, keyed by the header row's text, and put back
// whenever a table with that header and column count appears without widths.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { cellAround, TableMap } from "@milkdown/kit/prose/tables";

export const tableResizeKey = new PluginKey("sidenote-table-resize");

/** Pointer distance from a cell edge, in px, that counts as the boundary. */
const EDGE = 6;
const MIN_WIDTH = 40;
const STORAGE_PREFIX = "sidenote.tableWidths:";

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

/** Write the widths into a `<colgroup>` on the table, creating it once. */
function paint(
  table: PMNode,
  tableEl: HTMLTableElement,
  override?: { col: number; width: number },
) {
  let colgroup = tableEl.querySelector(":scope > colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    tableEl.insertBefore(colgroup, tableEl.firstChild);
  }
  const widths = columnWidths(table);
  if (override) widths[override.col] = override.width;
  while (colgroup.childElementCount > widths.length)
    colgroup.lastElementChild?.remove();
  while (colgroup.childElementCount < widths.length)
    colgroup.appendChild(document.createElement("col"));
  widths.forEach((w, i) => {
    const col = colgroup.children[i] as HTMLElement;
    const css = w ? `${w}px` : "";
    if (col.style.width !== css) col.style.width = css;
  });
  // With every column fixed the table is exactly their sum; otherwise it
  // keeps the stylesheet's full width and the free columns share the rest.
  const fixed = widths.length > 0 && widths.every((w) => w);
  const total = widths.reduce<number>((a, w) => a + (w ?? 0), 0);
  const css = fixed ? `${total}px` : "";
  if (tableEl.style.width !== css) tableEl.style.width = css;
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

/** Set `width` on every cell of column `col` in the table before `$cell`. */
function setColumnWidth(
  tr: Transaction,
  state: EditorState,
  cellPos: number,
  width: number,
): PMNode | null {
  const $cell = cellAround(state.doc.resolve(cellPos + 1));
  if (!$cell) return null;
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const col =
    map.colCount($cell.pos - start) + ($cell.nodeAfter?.attrs.colspan ?? 1) - 1;
  setColumnWidthIn(tr, table, start, map, col, width);
  return table;
}

function setColumnWidthIn(
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

interface Drag {
  cellPos: number;
  cellEl: HTMLElement;
  tableEl: HTMLTableElement;
  col: number;
  startX: number;
  startWidth: number;
  width: number;
}

class ResizeView {
  private readonly handle: HTMLDivElement;
  /** Position (before the cell) whose right edge the handle sits on. */
  private hoverPos = -1;
  private drag: Drag | null = null;
  private restoreQueued = false;
  /** Tables already offered their stored widths, so a miss is not retried. */
  private readonly restored = new WeakSet<PMNode>();

  private readonly view: EditorView;
  private readonly docPath: () => string;

  constructor(view: EditorView, docPath: () => string) {
    this.view = view;
    this.docPath = docPath;
    this.handle = document.createElement("div");
    this.handle.className = "sidenote-col-resize";
    this.handle.hidden = true;
    this.handle.addEventListener("pointerdown", this.onPointerDown);
    // No mousedown reaches ProseMirror or Crepe from the handle; a caret or a
    // cell selection is not what a drag on the boundary means.
    this.handle.addEventListener("mousedown", stop);
    view.dom.addEventListener("pointermove", this.onPointerMove);
    view.dom.addEventListener("pointerleave", this.onPointerLeave);
    this.sync();
  }

  update(view: EditorView, prev: EditorState) {
    if (view.state.doc === prev.doc) return;
    if (!this.drag) this.hide();
    this.sync();
  }

  destroy() {
    this.endDrag(false);
    this.view.dom.removeEventListener("pointermove", this.onPointerMove);
    this.view.dom.removeEventListener("pointerleave", this.onPointerLeave);
    this.handle.remove();
  }

  /** Paint every table from its attrs; queue a restore for those without. */
  private sync() {
    const { doc } = this.view.state;
    const path = this.docPath();
    let wantRestore = false;
    doc.descendants((node, pos) => {
      if (node.type.spec.tableRole !== "table") return true;
      const el = tableElementAt(this.view, pos);
      if (el) paint(node, el);
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
      if (!widths || widths.length !== map.width) return false;
      widths.forEach((w, col) => {
        if (w) setColumnWidthIn(tr, node, pos + 1, map, col, w);
      });
      return false;
    });
    if (!tr.docChanged) return;
    view.dispatch(tr.setMeta("addToHistory", false).setMeta(tableResizeKey, true));
  }

  private remember(table: PMNode) {
    const path = this.docPath();
    const key = tableKey(table);
    if (!path || !key) return;
    const stored = readStore(path);
    stored[key] = columnWidths(table).map((w) => w ?? 0);
    writeStore(path, stored);
  }

  private show(cellEl: HTMLElement, cellPos: number) {
    const tableEl = cellEl.closest("table");
    const wrapper = tableEl?.parentElement;
    if (!tableEl || !wrapper) return;
    if (this.handle.parentElement !== wrapper) wrapper.appendChild(this.handle);
    this.handle.hidden = false;
    // Measured against whichever ancestor positions the handle (the table
    // block is `position: relative`), not the wrapper it is appended to.
    const b = (this.handle.offsetParent ?? wrapper).getBoundingClientRect();
    const t = tableEl.getBoundingClientRect();
    const c = cellEl.getBoundingClientRect();
    this.handle.style.left = `${c.right - b.left}px`;
    this.handle.style.top = `${t.top - b.top}px`;
    this.handle.style.height = `${t.height}px`;
    this.hoverPos = cellPos;
  }

  private hide() {
    this.handle.hidden = true;
    this.hoverPos = -1;
  }

  /** The cell whose right edge is under the pointer, or null. */
  private boundaryAt(e: PointerEvent): { cell: HTMLElement; pos: number } | null {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    let cell = target.closest("td, th") as HTMLElement | null;
    if (!cell || !this.view.dom.contains(cell)) return null;
    const r = cell.getBoundingClientRect();
    if (r.right - e.clientX > EDGE) {
      if (e.clientX - r.left > EDGE) return null;
      const prev = cell.previousElementSibling;
      if (!(prev instanceof HTMLElement)) return null;
      cell = prev;
    }
    let pos: number;
    try {
      pos = this.view.posAtDOM(cell, 0);
    } catch {
      return null;
    }
    const $cell = cellAround(this.view.state.doc.resolve(pos));
    if (!$cell) return null;
    return { cell, pos: $cell.pos };
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.drag) return;
    if (e.target === this.handle) return;
    const hit = this.boundaryAt(e);
    if (!hit) {
      if (this.hoverPos !== -1) this.hide();
      return;
    }
    this.show(hit.cell, hit.pos);
  };

  private onPointerLeave = () => {
    if (!this.drag) this.hide();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.hoverPos === -1) return;
    e.preventDefault();
    e.stopPropagation();
    const $cell = this.tableAt(this.hoverPos);
    const el = this.view.nodeDOM(this.hoverPos);
    const tableEl = el instanceof HTMLElement ? el.closest("table") : null;
    if (!$cell || !(el instanceof HTMLElement) || !tableEl) return;
    const table = $cell.node(-1);
    const start = $cell.start(-1);
    const map = TableMap.get(table);
    const col =
      map.colCount($cell.pos - start) + ($cell.nodeAfter?.attrs.colspan ?? 1) - 1;
    const startWidth =
      columnWidths(table)[col] ?? Math.round(el.getBoundingClientRect().width);
    this.drag = {
      cellPos: $cell.pos,
      cellEl: el,
      tableEl,
      col,
      startX: e.clientX,
      startWidth,
      width: startWidth,
    };
    this.handle.classList.add("dragging");
    document.documentElement.classList.add("sidenote-col-resizing");
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragCancel);
  };

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!e.buttons) return this.endDrag(true);
    d.width = Math.max(MIN_WIDTH, Math.round(d.startWidth + e.clientX - d.startX));
    const $cell = this.tableAt(d.cellPos);
    if (!$cell) return this.endDrag(false);
    paint($cell.node(-1), d.tableEl, { col: d.col, width: d.width });
    this.show(d.cellEl, d.cellPos);
  };

  private onDragEnd = () => this.endDrag(true);
  private onDragCancel = () => this.endDrag(false);

  private tableAt(cellPos: number) {
    const { doc } = this.view.state;
    if (cellPos + 1 > doc.content.size) return null;
    const $cell = cellAround(doc.resolve(cellPos + 1));
    return $cell && $cell.pos === cellPos ? $cell : null;
  }

  private endDrag(commit: boolean) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.handle.classList.remove("dragging");
    document.documentElement.classList.remove("sidenote-col-resizing");
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragCancel);
    this.hide();
    const { state } = this.view;
    if (commit && d.width !== d.startWidth && this.tableAt(d.cellPos)) {
      const tr = state.tr;
      const table = setColumnWidth(tr, state, d.cellPos, d.width);
      if (table && tr.docChanged) {
        this.view.dispatch(
          tr.setMeta("addToHistory", false).setMeta(tableResizeKey, true),
        );
        const $cell = this.tableAt(d.cellPos);
        if ($cell) this.remember($cell.node(-1));
        return;
      }
    }
    // Nothing landed: put the DOM back the way the attrs say.
    this.sync();
  }
}

function stop(e: Event) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * `docPath` is read when needed, so the plugin follows the document the
 * editor shows; an empty path (a draft with no file yet) turns persistence off.
 */
export function tableResizePlugin(docPath: () => string): Plugin {
  return new Plugin({
    key: tableResizeKey,
    view: (view) => new ResizeView(view, docPath),
  });
}
