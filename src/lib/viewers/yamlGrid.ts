/**
 * The YAML/JSON **card grid** model (#yaml-grid) — a third view on the same text the
 * tree and Source share, and the pure helpers behind it.
 *
 * The VIEW is recursive and tree-like: the document is one centred top card (or, for
 * a root list, a row of them); every nested mapping/sequence is a card, and its own
 * nested collections become **subcards laid out in columns below it** — click a
 * card's header to collapse/expand. Scalars are the editable fields inside a card.
 * So a deep config reads as a wall of nested cards you drill into, not a ladder you
 * scroll (the RENDER lives in `components/embed/YamlGrid`).
 *
 * Like the tree, the cards are a VIEW ON THE TEXT, not a model of it: every EDIT is
 * delegated back to `lib/viewers/yaml`'s splice ops (`setValue` for a field,
 * `addChild` for a new field/card, `deleteNode` for a record), so a card edit keeps
 * comments, quoting and untouched bytes exactly as the tree's does, and lands in the
 * same draft as an ordinary dirty/undoable/saveable change. Two views, one text.
 *
 * What a field can be (mirrors the tree's honesty rule — never offer an edit it
 * can't make):
 *  - a **scalar** the tree could rewrite → an editable field (`setValue`),
 *  - a **scalar the tree won't touch** (anchor/alias/multiline) → shown, read-only,
 *  - a **nested collection** → a **subcard** (recursively), or — inside a flat cell,
 *    e.g. the tabular helpers below — a read-only `{…}` / `[…]` chip.
 *
 * This file also keeps the **tabular** helpers (`gridModelFor` / `gridCandidates` /
 * `hasGrid`): the flat rows × columns model of a single list/map-of-records. The
 * card view doesn't render it, but it stays a tested, reusable way to ask "is this
 * region a table?" — and it is what {@link cellKind} / {@link nestedLabel} classify
 * cells for.
 *
 * Pure: no React, no Tauri, no fs. Unit-tested in `src/__tests__/YamlGrid.test.ts`.
 */

import { parseYaml, isFlow, type YamlDoc, type YamlNode } from "./yaml";

/** True when `node` is a mapping or sequence — i.e. it renders as a card, not a
 *  scalar field. */
export function isContainer(node: YamlNode): boolean {
  return node.kind === "map" || node.kind === "seq";
}

/** Whether the card view has anything worth showing over the plain tree: at least
 *  one collection nested inside another (a map/seq as a child of the root or deeper).
 *  A wholly flat file (a map of scalars, or a list of scalars) has no subcards, so
 *  the Grid toggle stays hidden and the tree/Source carry it. */
export function hasCards(text: string, strict = false): boolean {
  const doc = parseYaml(text, { strict });
  if (doc.error) return false;
  const hasNestedContainer = (node: YamlNode): boolean => {
    for (const c of node.children) {
      if (isContainer(c)) return true;
      if (hasNestedContainer(c)) return true;
    }
    return false;
  };
  return doc.docs.some(hasNestedContainer);
}

/** One record's cell for a column: the scalar/container node that holds it, or
 *  `null` when this row's mapping has no such key (an editable empty cell). */
export type GridCell = YamlNode | null;

export interface GridRow {
  /** Stable across re-parses (the row mapping's node id), so an open cell editor
   *  and the selection survive the re-parse an edit triggers. */
  id: string;
  /** What heads the row: the list index (`0`, `1`, …) for a list-of-maps, or the
   *  outer key for a map-of-maps. Display only. */
  header: string;
  /** The record itself — the container child. Usually the mapping ({@link map}),
   *  but a non-mapping member (a bare list scalar) keeps its node here so a card can
   *  still render its one value. */
  node: YamlNode;
  /** The mapping node this row's cells live in — the target a missing-cell add or
   *  a whole-row delete addresses. A non-mapping member (a bare list scalar) has
   *  none, so its row is all-empty and cannot grow cells. */
  map: YamlNode | null;
  /** Whether the whole row can be removed on its own (`deleteNode` on `map`). */
  deletable: boolean;
  /** Cells aligned 1:1 to {@link YamlGridModel.columns}. */
  cells: GridCell[];
}

export interface YamlGridModel {
  /** The collection that was gridded (a `seq` or a `map`). */
  container: YamlNode;
  /** `seq` = list of mappings (rows headed by index); `map` = map of mappings
   *  (rows headed by key). Decides how a new row is added and what heads a row. */
  shape: "seq" | "map";
  /** The union of keys across the rows, in first-seen order — the columns. */
  columns: string[];
  rows: GridRow[];
  /** Whether the grid can add a new row (`addChild` to the container). A flow
   *  container can, a synthetic root cannot carry one, etc.— all editable here. */
  canAddRow: boolean;
  /** A short, stable label for the region (`items` / a key path), so a file with
   *  more than one tabular region can offer a pick between them. */
  label: string;
}

/** How much of a container's children must be mappings for it to read as a table
 *  rather than a plain config collection. Two records is the floor (one is not a
 *  pattern); a strong majority keeps a mostly-scalar map (with one nested block)
 *  from masquerading as a grid. */
const MIN_ROWS = 2;
const MIN_MAP_FRACTION = 0.6;

/** The mapping children of a container, in order — the rows-to-be. */
function mapChildren(node: YamlNode): YamlNode[] {
  return node.children.filter((c) => c.kind === "map");
}

/** Whether `node` is a collection worth showing as a grid: a seq or map whose
 *  members are (mostly) mappings, with at least {@link MIN_ROWS} of them. */
function isGridContainer(node: YamlNode): boolean {
  if (node.kind !== "seq" && node.kind !== "map") return false;
  if (node.children.length < MIN_ROWS) return false;
  const maps = mapChildren(node);
  if (maps.length < MIN_ROWS) return false;
  return maps.length / node.children.length >= MIN_MAP_FRACTION;
}

/** A stable, human label for a container by its path (`items`, `services`,
 *  `spec.containers`), or `document` for a bare root collection. */
function labelFor(node: YamlNode): string {
  if (!node.path.length) return "document";
  return node.path.map((p) => String(p)).join(".");
}

/** Build the grid model for one container. Columns are the union of the row
 *  mappings' keys in first-seen order; each row's cells are aligned to them, with
 *  `null` where a row lacks that key. */
export function gridModelFor(container: YamlNode): YamlGridModel {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const child of container.children) {
    if (child.kind !== "map") continue;
    for (const entry of child.children) {
      if (entry.key !== null && !seen.has(entry.key)) {
        seen.add(entry.key);
        columns.push(entry.key);
      }
    }
  }

  const rows: GridRow[] = container.children.map((child, i) => {
    const isMap = child.kind === "map";
    const byKey = new Map<string, YamlNode>();
    if (isMap) for (const e of child.children) if (e.key !== null) byKey.set(e.key, e);
    return {
      id: child.id,
      header: container.kind === "map" ? child.key ?? String(i) : String(i),
      node: child,
      map: isMap ? child : null,
      deletable: child.deletable,
      cells: columns.map((col) => byKey.get(col) ?? null),
    };
  });

  return {
    container,
    shape: container.kind === "map" ? "map" : "seq",
    columns,
    rows,
    canAddRow: container.deletable !== false,
    label: labelFor(container),
  };
}

/** Every tabular region in the document, largest first — a file may hold more than
 *  one (a list of jobs *and* a map of hosts). "Largest" = most cells, so the one a
 *  reader most wants a grid for is offered first; ties break toward the shallower,
 *  earlier region so the choice is stable across re-parses. */
export function gridCandidates(doc: YamlDoc): YamlNode[] {
  if (doc.error) return [];
  const found: YamlNode[] = [];
  const walk = (node: YamlNode) => {
    if (isGridContainer(node)) found.push(node);
    for (const c of node.children) walk(c);
  };
  for (const root of doc.docs) walk(root);
  const area = (n: YamlNode) => {
    const model = gridModelFor(n);
    return model.rows.length * Math.max(1, model.columns.length);
  };
  return found.sort((a, b) => {
    const d = area(b) - area(a);
    if (d !== 0) return d;
    const depth = a.path.length - b.path.length;
    if (depth !== 0) return depth;
    return a.start - b.start;
  });
}

/** The parsed document plus its tabular regions — one parse feeds both the toggle
 *  (is a grid available?) and the grid itself. */
export interface YamlGridDoc {
  doc: YamlDoc;
  candidates: YamlNode[];
}

export function parseGridDoc(text: string, opts: { strict?: boolean } = {}): YamlGridDoc {
  const doc = parseYaml(text, opts);
  return { doc, candidates: gridCandidates(doc) };
}

/** Whether this text has any region worth a grid — what the Grid toggle keys on,
 *  so it appears exactly for the files where it does something. */
export function hasGrid(text: string, strict = false): boolean {
  return parseGridDoc(text, { strict }).candidates.length > 0;
}

/** A cell's editability, so the grid never offers a control it can't honour
 *  (mirrors the tree's `source only` rule):
 *   - `"scalar"`  — a scalar the tree can rewrite in place,
 *   - `"empty"`   — no node yet; typing adds the key to the row (a new scalar),
 *   - `"nested"`  — a sub-collection, read-only in a flat grid,
 *   - `"locked"`  — a scalar the tree won't touch (anchor/alias/multiline). */
export type CellKind = "scalar" | "empty" | "nested" | "locked";

export function cellKind(cell: GridCell, rowMap: YamlNode | null): CellKind {
  if (cell === null) return rowMap ? "empty" : "locked";
  if (cell.kind !== "scalar") return "nested";
  return cell.editable ? "scalar" : "locked";
}

/** The read-only chip shown for a nested cell — `{ N }` for a map, `[ N ]` for a
 *  list — so a sub-collection reads as one at a glance without expanding it. */
export function nestedLabel(cell: YamlNode): string {
  const n = cell.children.length;
  const flow = isFlow(cell);
  if (cell.kind === "seq") return flow ? `[ ${n} ]` : `${n} item${n === 1 ? "" : "s"}`;
  return flow ? `{ ${n} }` : `${n} key${n === 1 ? "" : "s"}`;
}
