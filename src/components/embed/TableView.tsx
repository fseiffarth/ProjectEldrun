import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ViewerHeader,
  useViewerState,
  useEditableFile,
  SaveButton,
  UndoRedoButtons,
  ExternalChangeBanner,
} from "./FileViewerPane";
import { Dropdown } from "../common/Dropdown";
import {
  parseTable,
  resolveDelimiter,
  bodyRefs,
  filterRefs,
  sortRefs,
  sortRefsByIndex,
  replaceCell,
  insertRowAfter,
  deleteRow,
  columnWidths,
  DELIMITER_CANDIDATES,
  type ParsedTable,
} from "../../lib/viewers/table";

/** Backend `read_spreadsheet` result (Dev G). Mirrors the Rust `SheetData`. */
interface SheetData {
  sheet_names: string[];
  active_sheet: string;
  rows: string[][];
}

/** Spreadsheet workbooks (xlsx/xls/xlsm) load via the backend `calamine` reader
 *  instead of the CSV text path — and are read-only: they arrive already parsed,
 *  with no source text for an edit to splice itself back into. */
const SHEET_RE = /\.(xlsx|xls|xlsm)$/i;

/** Fallback row height, in px, until a rendered row is measured (see `rowH`). */
const DEFAULT_ROW_H = 26;
/** Rows rendered beyond the viewport on each side, so a fast scroll stays fed. */
const OVERSCAN = 8;
/** Width of the row-number gutter, in px. */
const GUTTER_W = 56;
/** Horizontal padding of a body cell, in px — part of each column's box. */
const CELL_PAD_X = 20;
/** The sorted column's tint: the accent mixed into the panel, so it follows the
 *  active theme and stays opaque (the sticky header must not let body cells
 *  bleed through — and opaque mixes avoid the WebKitGTK translucent-color-mix
 *  caveat). */
const SORTED_COL_BG = "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))";
/** The zebra tint for odd body rows: the panel's own text mixed a hair into the
 *  panel, so it darkens on a light theme and lightens on a dark one, and stays
 *  opaque (the sticky gutter must not let body cells bleed through — and an opaque
 *  mix sidesteps the WebKitGTK translucent-color-mix caveat). */
const STRIPE_BG = "color-mix(in srgb, var(--text-primary) 5%, var(--bg-panel))";
/** The row-number gutter's own tint — a heavier mix than the zebra stripe so the
 *  sticky column reads as chrome, distinct from the body cells that scroll under
 *  it. Opaque, for the same sticky-bleed reason `STRIPE_BG` is. Paired with a
 *  2px right border (`GUTTER_BORDER`) that stays visible during a horizontal
 *  scroll. */
const GUTTER_BG = "color-mix(in srgb, var(--text-primary) 12%, var(--bg-panel))";
/** The gutter's right edge and the header's bottom edge: a heavier rule than the
 *  1px cell grid, so the sticky chrome stays legible against the scrolling body. */
const GUTTER_BORDER = "2px solid var(--border-color)";
/** Sentinel `SortSpec.col` for the row-number gutter: it sorts on each row's
 *  source index, not a cell value, so it needs a column id no real column has. */
const GUTTER_SORT_COL = -1;

/** The separator names offered in the header, keyed by the character itself. */
const DELIMITER_LABELS: Record<string, string> = {
  ",": "Comma",
  ";": "Semicolon",
  "\t": "Tab",
  "|": "Pipe",
};

const KNOWN_DELIMITERS = new Set<string>(DELIMITER_CANDIDATES);

/** How a separator reads in a menu — a tab has no glyph, so it needs a name. */
function delimiterLabel(ch: string): string {
  return DELIMITER_LABELS[ch] ?? `"${ch}"`;
}

interface SortSpec {
  col: number;
  dir: "asc" | "desc";
}

interface EditSpec {
  /** Index into the parsed rows — `0` is the header row. */
  row: number;
  col: number;
}

const EMPTY_TABLE: ParsedTable = { rows: [], cells: [], rowSpans: [], newline: "\n" };

/**
 * In-app table viewer for delimited text (#40), and read-only for spreadsheet
 * workbooks. Three things shape it:
 *
 *  - **The separator is a guess the reader can overrule.** `.csv` does not say
 *    which character separates the columns, so it is sniffed from the content
 *    (`resolveDelimiter`) and offered in the header — where a semicolon or pipe
 *    file the sniffer misread gets corrected. An explicit choice is persisted per
 *    tab; "Auto" is not, leaving the sniffer free to do better on the next open.
 *
 *  - **An edit is a splice, not a re-write.** Cell edits go through
 *    `replaceCell`/`insertRowAfter`/`deleteRow` into the *text* draft that
 *    `useEditableFile` already owns — the same draft the code editor would show.
 *    So a table edit is an ordinary dirty/undoable/autosaved/Ctrl+S change, and
 *    the cells nobody touched keep their bytes exactly (see `lib/viewers/table.ts`).
 *    It is also why sorting and filtering carry each row's *source* index: what a
 *    splice must address is the row a cell really came from, not the row it
 *    happens to occupy on screen.
 *
 *  - **Only the visible rows are rendered.** A million-row CSV would otherwise
 *    freeze the webview, so the body is windowed against the scroll position —
 *    which is in turn why the column widths are measured over the whole file up
 *    front: sizing them to what is on screen would resize every column as the
 *    reader scrolled.
 */
export function TableView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const isSheet = useMemo(() => SHEET_RE.test(path), [path]);

  // The text draft behind a CSV/TSV. For a spreadsheet we don't edit the file at
  // all; the hook still runs (hooks can't be conditional) but its content is
  // ignored in favour of the backend's parsed rows.
  const file = useEditableFile(path);
  const {
    content,
    draft,
    setDraft,
    save,
    isDirty,
    saving,
    saveError,
    undo,
    redo,
    canUndo,
    canRedo,
    externalChange,
    reloadFromDisk,
    keepMine,
  } = file;

  const viewPos = useViewerState(tabKey);

  // ── Spreadsheet path: rows arrive pre-parsed from the backend ──────────────
  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);

  useEffect(() => {
    if (!isSheet) return;
    let cancelled = false;
    setSheetLoaded(false);
    setSheetError(null);
    invoke<SheetData>("read_spreadsheet", { path, sheet: selectedSheet ?? undefined })
      .then((data) => {
        if (cancelled) return;
        setSheetData(data);
        // Adopt the sheet the backend actually returned (covers the default-pick).
        setSelectedSheet((cur) => cur ?? data.active_sheet);
        setSheetLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setSheetError(String(e));
        setSheetLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isSheet, path, selectedSheet]);

  const error = isSheet ? sheetError : file.error;
  const loaded = isSheet ? sheetLoaded : file.loaded;
  /** Spreadsheets have no source text to splice into, so they stay read-only. */
  const editable = !isSheet && loaded && error == null;

  // ── The separator ─────────────────────────────────────────────────────────
  // Sniffed from what is on disk, not from the draft: re-sniffing mid-edit could
  // change the delimiter under the reader as they type (blanking a row can flip
  // the modal column count), and re-cut every column with it.
  const sniffed = useMemo(
    () => (content == null ? "," : resolveDelimiter(path, content)),
    [path, content],
  );

  // `null` = auto. An override is seeded from the tab's persisted state, so the
  // correction a reader made to a mis-sniffed file survives reopen and restart.
  const [override, setOverride] = useState<string | null>(
    () => viewPos.initial?.delimiter ?? null,
  );
  // Held apart from `override` so that a custom character which happens to be one
  // of the offered ones doesn't silently snap the menu back off "Custom…".
  const [customMode, setCustomMode] = useState<boolean>(() => {
    const seed = viewPos.initial?.delimiter;
    return seed != null && !KNOWN_DELIMITERS.has(seed);
  });

  const delimiter = override ?? sniffed;

  // Persist the override, and only the override — "Auto" writes nothing, so the
  // sniffer stays free to read the file better next time.
  useEffect(() => {
    viewPos.persist({ delimiter: override ?? undefined });
  }, [override, viewPos]);

  const onPickDelimiter = (choice: string) => {
    if (choice === "auto") {
      setCustomMode(false);
      setOverride(null);
    } else if (choice === "custom") {
      setCustomMode(true);
      setOverride(delimiter); // start from whatever is in force, so nothing jumps
    } else {
      setCustomMode(false);
      setOverride(choice);
    }
  };

  // ── The table ─────────────────────────────────────────────────────────────
  const table = useMemo(
    () => (isSheet ? EMPTY_TABLE : parseTable(draft, delimiter)),
    [isSheet, draft, delimiter],
  );
  const rows = isSheet ? (sheetData?.rows ?? []) : table.rows;

  const header = rows.length > 0 ? rows[0] : [];
  // Width is the widest row, so ragged rows pad rather than truncate.
  const width = useMemo(() => rows.reduce((m, r) => Math.max(m, r.length), 0), [rows]);
  const widths = useMemo(() => columnWidths(rows, width), [rows, width]);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec | null>(null);

  // ── Hidden columns ────────────────────────────────────────────────────────
  const [hidden, setHidden] = useState<Set<number>>(
    () => new Set(viewPos.initial?.hiddenColumns ?? []),
  );

  useEffect(() => {
    viewPos.persist({
      hiddenColumns: hidden.size > 0 ? [...hidden].sort((a, b) => a - b) : undefined,
    });
  }, [hidden, viewPos]);

  // A hidden column is an *index*, and only the separator that produced it gives
  // that index a meaning. Re-cut the row with a different one and index 3 is a
  // different column — so a delimiter change drops the hiding rather than
  // silently hiding whatever now lands there. The first delimiter seen after the
  // file loads is not a change: it is the sniffer arriving, and it must not wipe
  // the set the tab was restored with.
  const settledDelimiter = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (settledDelimiter.current == null) {
      settledDelimiter.current = delimiter;
      return;
    }
    if (settledDelimiter.current === delimiter) return;
    settledDelimiter.current = delimiter;
    setHidden(new Set());
  }, [loaded, delimiter]);

  const toggleColumn = (col: number) => {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  /** The columns actually rendered, as indices into the *parsed* row — never
   *  re-numbered, so an edit still addresses the column the cell came from. */
  const cols = useMemo(
    () => Array.from({ length: width }, (_, i) => i).filter((c) => !hidden.has(c)),
    [width, hidden],
  );

  // ── Flash rows gained on a disk reload ──────────────────────────────────────
  // `content` changes only on a (re)load from disk, never on an in-app keystroke
  // (edits move `draft`, not `content`) — so a CSV appended to underneath the
  // viewer re-reads here, and we briefly highlight whichever body rows weren't
  // there before. The comparison keys on `content` alone: sorting, filtering and
  // delimiter changes all leave it untouched, so none of them flash. The first
  // load (and every path switch, when `content` resets to null) only seeds the
  // baseline. Rows are matched by value as a multiset, so an unchanged row that
  // merely slid down when an earlier row was inserted is not counted as new.
  const [flashRows, setFlashRows] = useState<Set<number>>(new Set());
  const prevSigsRef = useRef<Map<string, number> | null>(null);
  const flashTimers = useRef<number[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (isSheet) return;
    if (content == null) {
      prevSigsRef.current = null;
      return;
    }
    const bodyRows = rowsRef.current.slice(1);
    const counts = new Map<string, number>();
    for (const cells of bodyRows) {
      const sig = JSON.stringify(cells);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    const prev = prevSigsRef.current;
    prevSigsRef.current = counts;
    if (prev == null) return; // first settled content: seed only, don't flash

    const remaining = new Map(prev);
    const added = new Set<number>();
    bodyRows.forEach((cells, i) => {
      const sig = JSON.stringify(cells);
      const left = remaining.get(sig) ?? 0;
      if (left > 0) remaining.set(sig, left - 1);
      else added.add(i + 1); // +1: source index, past the header at 0
    });
    if (added.size === 0) return;

    setFlashRows((cur) => new Set([...cur, ...added]));
    const timer = window.setTimeout(() => {
      setFlashRows((cur) => {
        const next = new Set(cur);
        for (const idx of added) next.delete(idx);
        return next;
      });
    }, 3000);
    flashTimers.current.push(timer);
  }, [content, isSheet]);

  useEffect(() => () => flashTimers.current.forEach((t) => clearTimeout(t)), []);

  const body = useMemo(() => bodyRefs(rows), [rows]);
  // Filtering follows the eye: a row matched on a hidden column would show up with
  // nothing on it to explain why.
  const filtered = useMemo(() => filterRefs(body, query, cols), [body, query, cols]);
  const visible = useMemo(() => {
    if (!sort) return filtered;
    if (sort.col === GUTTER_SORT_COL) return sortRefsByIndex(filtered, sort.dir);
    return sortRefs(filtered, sort.col, sort.dir);
  }, [filtered, sort]);

  // ── Windowing ─────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [rowH, setRowH] = useState(DEFAULT_ROW_H);
  const restored = useRef(false);
  const persistTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);

  // Measure a rendered row rather than trusting the CSS to add up: the window's
  // arithmetic is only right if this height is the one actually on screen.
  const measureRow = useCallback(
    (el: HTMLTableRowElement | null) => {
      if (!el) return;
      const h = el.offsetHeight;
      if (h > 0 && h !== rowH) setRowH(h);
    },
    [rowH],
  );

  const total = visible.length;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const lastRow = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);
  const rendered = visible.slice(firstRow, lastRow);
  const padTop = firstRow * rowH;
  const padBottom = Math.max(0, (total - lastRow) * rowH);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // Coalesce to a frame: scroll fires far faster than we can usefully re-window.
    if (scrollFrame.current == null) {
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null;
        setScrollTop(scrollRef.current?.scrollTop ?? top);
      });
    }
    if (!restored.current) return;
    if (persistTimer.current != null) clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => viewPos.persist({ scrollTop: top }), 200);
  };

  const onScrollRef = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (!el) return;
    if (!restored.current && loaded) {
      restored.current = true;
      const top = viewPos.initial?.scrollTop;
      if (top && top > 0) {
        el.scrollTop = top;
        setScrollTop(top);
      }
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, [loaded]);

  useEffect(
    () => () => {
      if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
      if (persistTimer.current != null) clearTimeout(persistTimer.current);
    },
    [],
  );

  // ── Editing ───────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<EditSpec | null>(null);
  const [editValue, setEditValue] = useState("");

  const beginEdit = (row: number, col: number) => {
    if (!editable) return;
    setEditing({ row, col });
    setEditValue(rows[row]?.[col] ?? "");
  };

  const commitEdit = (next?: "right") => {
    if (!editing) return;
    const { row, col } = editing;
    if (editValue !== (rows[row]?.[col] ?? "")) {
      setDraft(replaceCell(draft, table, row, col, editValue, delimiter));
    }
    // Tab walks to the next *visible* column — a hidden one has no cell on screen
    // to put the cursor in. Its value is untouched by the splice just made, so it
    // can be read from the current parse without waiting for the re-parse.
    if (next === "right") {
      const right = cols[cols.indexOf(col) + 1];
      if (right != null) {
        setEditing({ row, col: right });
        setEditValue(rows[row]?.[right] ?? "");
        return;
      }
    }
    setEditing(null);
  };

  const onEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEdit("right");
    }
  };

  const addRow = () => {
    if (!editable || rows.length === 0) return;
    setDraft(insertRowAfter(draft, table, rows.length - 1, width, delimiter));
  };

  const removeRow = (row: number) => {
    if (!editable) return;
    setEditing(null);
    setDraft(deleteRow(draft, table, row));
  };

  // A single click on a header sorts, a double click renames it — so when the file
  // is editable the sort waits long enough to find out which it was. A read-only
  // sheet has no second meaning to disambiguate, so it sorts immediately.
  const sortClick = useRef<number | null>(null);

  // asc → desc → default: the third click clears the sort, which is the only
  // way back to the file's own row order once a column has been sorted.
  const toggleSort = (col: number) => {
    setSort((cur) => {
      if (!cur || cur.col !== col) return { col, dir: "asc" };
      if (cur.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  };

  // The gutter has no second meaning to disambiguate (no rename, no double-click),
  // so it sorts immediately — asc restores the file's row order, desc reverses it.
  const onGutterClick = () => toggleSort(GUTTER_SORT_COL);

  const onHeaderClick = (col: number) => {
    if (!editable) {
      toggleSort(col);
      return;
    }
    if (sortClick.current != null) return;
    sortClick.current = window.setTimeout(() => {
      sortClick.current = null;
      toggleSort(col);
    }, 200);
  };

  const onHeaderDoubleClick = (col: number) => {
    if (sortClick.current != null) {
      clearTimeout(sortClick.current);
      sortClick.current = null;
    }
    beginEdit(0, col);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editable) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void save();
    } else if (editing == null && key === "z") {
      // While a cell input is open, ctrl+z belongs to that input's own text.
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (editing == null && key === "y") {
      e.preventDefault();
      redo();
    }
  };

  const gutterSorted = sort?.col === GUTTER_SORT_COL;

  const totalCh = cols.reduce((sum, c) => sum + widths[c], 0);
  const tableWidth = `calc(${totalCh}ch + ${cols.length * CELL_PAD_X + GUTTER_W}px)`;

  /** The names shown in the columns menu — a column with a blank header still
   *  needs something to click on. */
  const columnNames = useMemo(
    () =>
      Array.from({ length: width }, (_, c) => {
        const name = header[c] ?? "";
        return name.trim() === "" ? `Column ${c + 1}` : name;
      }),
    [width, header],
  );

  const countLabel =
    query.trim() !== ""
      ? `${visible.length} of ${body.length} rows`
      : `${body.length} ${body.length === 1 ? "row" : "rows"}`;

  return (
    <div
      className="file-viewer"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
      onKeyDown={onKeyDown}
    >
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {isSheet && sheetData && sheetData.sheet_names.length > 1 && (
          <Dropdown
            value={selectedSheet ?? sheetData.active_sheet}
            onChange={setSelectedSheet}
            title="Select sheet"
            options={sheetData.sheet_names.map((name) => ({ value: name, label: name }))}
          />
        )}
        {!isSheet && loaded && !error && (
          <>
            <Dropdown
              value={customMode ? "custom" : (override ?? "auto")}
              onChange={onPickDelimiter}
              title="Column separator"
              options={[
                { value: "auto", label: `Auto (${delimiterLabel(sniffed)})` },
                ...DELIMITER_CANDIDATES.map((d) => ({ value: d, label: delimiterLabel(d) })),
                { value: "custom", label: "Custom…" },
              ]}
            />
            {customMode && (
              <input
                value={override ?? ""}
                onChange={(e) => {
                  // Take the last character typed, so typing over a filled box
                  // swaps the separator instead of being swallowed.
                  const ch = e.target.value.slice(-1);
                  if (ch) setOverride(ch);
                }}
                title="Separator character"
                aria-label="Separator character"
                style={{
                  width: 28,
                  textAlign: "center",
                  padding: "2px 4px",
                  background: "var(--bg-input, var(--bg-panel))",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono, monospace)",
                }}
              />
            )}
          </>
        )}
        {loaded && !error && width > 0 && (
          <ColumnsMenu
            names={columnNames}
            hidden={hidden}
            onToggle={toggleColumn}
            onShowAll={() => setHidden(new Set())}
            onHideAll={() => setHidden(new Set(Array.from({ length: width }, (_, i) => i)))}
          />
        )}
        {loaded && !error && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter rows…"
            aria-label="Filter rows"
            style={{
              width: 140,
              padding: "2px 6px",
              background: "var(--bg-input, var(--bg-panel))",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
            }}
          />
        )}
        {loaded && !error && (
          <span
            style={{
              fontSize: 12,
              color: "var(--text-secondary, var(--text-primary))",
              opacity: 0.7,
              alignSelf: "center",
              whiteSpace: "nowrap",
            }}
          >
            {countLabel}
          </span>
        )}
        {editable && (
          <button
            onClick={addRow}
            title="Append a row"
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 12,
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            + Row
          </button>
        )}
        {editable && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        {editable && <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />}
      </ViewerHeader>
      {!isSheet && externalChange && (
        <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />
      )}
      {!isSheet && saveError && <div className="file-viewer-error">{saveError}</div>}
      {error != null ? (
        <div className="file-viewer-error">{error}</div>
      ) : !loaded ? (
        <div className="file-viewer-loading">Loading…</div>
      ) : header.length === 0 ? (
        <div className="file-viewer-loading">Empty file</div>
      ) : (
        <div
          ref={onScrollRef}
          onScroll={onScroll}
          tabIndex={0}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            outline: "none",
            background: "var(--bg-panel)",
            color: "var(--text-primary)",
          }}
        >
          <table
            style={{
              borderCollapse: "collapse",
              tableLayout: "fixed",
              fontSize: 13,
              fontFamily: "var(--font-mono, monospace)",
              width: tableWidth,
              minWidth: "100%",
            }}
          >
            <colgroup>
              <col style={{ width: GUTTER_W }} />
              {cols.map((c) => (
                <col key={c} style={{ width: `calc(${widths[c]}ch + ${CELL_PAD_X}px)` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {/* The gutter's header holds the corner while both the header row
                    and the gutter column are stuck to their edges — and it sorts
                    by row order: click to restore the file's order, again to
                    reverse it. */}
                <th
                  style={{
                    position: "sticky",
                    top: 0,
                    left: 0,
                    zIndex: 2,
                    background: gutterSorted ? SORTED_COL_BG : GUTTER_BG,
                    borderBottom: GUTTER_BORDER,
                    borderRight: GUTTER_BORDER,
                    padding: 0,
                  }}
                >
                  <button
                    onClick={onGutterClick}
                    title={
                      gutterSorted
                        ? "Row order — click to reverse, again to clear"
                        : "Sort by row order (restore the file's order)"
                    }
                    aria-label="Sort by row order"
                    style={{
                      all: "unset",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 3,
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 6px",
                      cursor: "pointer",
                      fontSize: 11,
                      color: "var(--text-secondary, var(--text-primary))",
                    }}
                  >
                    <span aria-hidden="true">#</span>
                    <span style={{ opacity: gutterSorted ? 0.9 : 0.25 }}>
                      {gutterSorted ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                </th>
                {cols.map((c) => {
                  const active = sort?.col === c;
                  const isEditing = editing?.row === 0 && editing.col === c;
                  return (
                    <th
                      key={c}
                      style={{
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                        // The sorted column wears a light theme tint down its
                        // whole length, header included.
                        background: active ? SORTED_COL_BG : "var(--bg-panel)",
                        borderBottom: "2px solid var(--border-color)",
                        borderRight: "1px solid var(--border-color)",
                        padding: 0,
                        textAlign: "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isEditing ? (
                        <CellInput
                          value={editValue}
                          onChange={setEditValue}
                          onKeyDown={onEditKeyDown}
                          onBlur={() => commitEdit()}
                        />
                      ) : (
                        <button
                          onClick={() => onHeaderClick(c)}
                          onDoubleClick={() => onHeaderDoubleClick(c)}
                          title={
                            editable
                              ? "Sort by this column — double-click to rename"
                              : "Sort by this column"
                          }
                          style={{
                            all: "unset",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            width: "100%",
                            boxSizing: "border-box",
                            padding: "6px 10px",
                            cursor: "pointer",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {header[c] ?? ""}
                          </span>
                          <span
                            style={{
                              marginLeft: "auto",
                              opacity: active ? 0.9 : 0.25,
                              fontSize: 11,
                            }}
                          >
                            {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr style={{ height: padTop }} aria-hidden="true">
                  <td colSpan={cols.length + 1} style={{ padding: 0, border: "none" }} />
                </tr>
              )}
              {rendered.map((row, i) => {
                // Zebra stripe by on-screen position (not source index), so rows
                // stay alternating after a sort or filter reorders them.
                const stripeBg = (firstRow + i) % 2 === 1 ? STRIPE_BG : undefined;
                return (
                <tr
                  key={row.index}
                  ref={i === 0 ? measureRow : undefined}
                  className={flashRows.has(row.index) ? "csv-row-flash" : undefined}
                  style={{ height: rowH }}
                >
                  <td
                    style={{
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      // Its own chrome tint, not the zebra stripe, so the sticky
                      // column stays distinct from the body scrolling under it.
                      background: GUTTER_BG,
                      borderBottom: "1px solid var(--border-color)",
                      borderRight: GUTTER_BORDER,
                      padding: "4px 8px",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      // Opacity dims only the number, not the cell — a translucent
                      // sticky gutter would let the scrolling body cells bleed
                      // through it. The background stays solid.
                      color: "var(--text-secondary, var(--text-primary))",
                    }}
                  >
                    {/* The source row number, not the position on screen: it is the
                        row a sort or filter came from, and the row an edit lands in. */}
                    {editable ? (
                      <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <span>{row.index}</span>
                        <button
                          onClick={() => removeRow(row.index)}
                          title={`Delete row ${row.index}`}
                          aria-label={`Delete row ${row.index}`}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            padding: "0 2px",
                            color: "var(--text-primary)",
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      row.index
                    )}
                  </td>
                  {cols.map((c) => {
                    const isEditing = editing?.row === row.index && editing.col === c;
                    const sorted = sort?.col === c;
                    const value = row.cells[c] ?? "";
                    return (
                      <td
                        key={c}
                        onDoubleClick={() => beginEdit(row.index, c)}
                        // A column clips at its measured width, so the full value
                        // has to stay reachable somewhere.
                        title={isEditing ? undefined : value}
                        style={{
                          background: sorted ? SORTED_COL_BG : stripeBg,
                          borderBottom: "1px solid var(--border-color)",
                          borderRight: "1px solid var(--border-color)",
                          padding: isEditing ? 0 : "4px 10px",
                          // `pre`, not `nowrap`: a padded field's spaces are part
                          // of its value. It still clips-with-ellipsis, since that
                          // only needs overflow hidden and no wrapping.
                          whiteSpace: "pre",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          verticalAlign: "middle",
                          cursor: editable ? "text" : "default",
                        }}
                      >
                        {isEditing ? (
                          <CellInput
                            value={editValue}
                            onChange={setEditValue}
                            onKeyDown={onEditKeyDown}
                            onBlur={() => commitEdit()}
                          />
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
                );
              })}
              {padBottom > 0 && (
                <tr style={{ height: padBottom }} aria-hidden="true">
                  <td colSpan={cols.length + 1} style={{ padding: 0, border: "none" }} />
                </tr>
              )}
            </tbody>
          </table>
          {total === 0 && body.length > 0 && (
            <div style={{ padding: "8px 10px", fontSize: 12, opacity: 0.7 }}>
              No rows match “{query}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The column list: every column by name, click to hide, click again to show.
 *
 * Built on the same chrome as {@link Dropdown} (whose native `<select>` WebKitGTK
 * refuses to theme) but it is a *multi*-select, so it does NOT close on a click —
 * hiding six of twenty columns is one visit to the menu, not six. A hidden column
 * stays listed, struck through: the list is the only way back, so a column that
 * vanished from it would be a column you could not get back.
 */
function ColumnsMenu({
  names,
  hidden,
  onToggle,
  onShowAll,
  onHideAll,
}: {
  names: string[];
  hidden: Set<number>;
  onToggle: (col: number) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = names.length - hidden.size;

  return (
    <div className="dropdown" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Show or hide columns"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {hidden.size > 0 ? `Columns ${shown}/${names.length}` : "Columns"}
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="context-menu dropdown-menu" role="listbox" aria-multiselectable>
          {/* Whole-set toggle: with all columns shown it deselects everything —
              picking three of twenty is "deselect all, click three", not
              seventeen hides — and once anything is hidden it selects all. */}
          <button
            type="button"
            onClick={hidden.size > 0 ? onShowAll : onHideAll}
            style={{ borderBottom: "1px solid var(--border-color)" }}
          >
            <span aria-hidden="true" style={{ display: "inline-block", width: 16, opacity: 0.9 }}>
              {hidden.size > 0 ? "✓" : "–"}
            </span>
            {hidden.size > 0 ? "Select all" : "Deselect all"}
          </button>
          {names.map((name, c) => {
            const isHidden = hidden.has(c);
            return (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={!isHidden}
                onClick={() => onToggle(c)}
                title={isHidden ? "Click to show this column" : "Click to hide this column"}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 16,
                    opacity: isHidden ? 0.45 : 0.9,
                  }}
                >
                  {isHidden ? "–" : "✓"}
                </span>
                <span
                  style={{
                    textDecoration: isHidden ? "line-through" : "none",
                    opacity: isHidden ? 0.55 : 1,
                  }}
                >
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The in-cell editor: one input, sized to the cell it stands in for. */
function CellInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: "4px 10px",
        border: "none",
        outline: "2px solid var(--accent-color, #6ab)",
        outlineOffset: -2,
        background: "var(--bg-input, var(--bg-panel))",
        color: "var(--text-primary)",
        font: "inherit",
      }}
    />
  );
}
