import { useMemo, useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewerHeader, useViewerState, useReadonlyFile } from "./FileViewerPane";
import { parseDelimited, sortRows, delimiterForPath } from "../../lib/viewers/table";

/** Backend `read_spreadsheet` result (Dev G). Mirrors the Rust `SheetData`. */
interface SheetData {
  sheet_names: string[];
  active_sheet: string;
  rows: string[][];
}

/** Spreadsheet workbooks (xlsx/xls/xlsm) load via the backend `calamine` reader
 *  instead of the CSV text path. */
const SHEET_RE = /\.(xlsx|xls|xlsm)$/i;

/** Above this many body rows we window the render to a leading slice to keep a
 *  huge CSV from freezing the webview; a notice tells the reader the rest is
 *  hidden (open externally for the full file). Dependency-free, v1-simple. */
const MAX_RENDER_ROWS = 2000;

interface SortSpec {
  col: number;
  dir: "asc" | "desc";
}

/**
 * In-app CSV/TSV table viewer (#40). Read-only for v1: loads the file via the
 * shared `useReadonlyFile` hook (auto-reloads on disk change), parses it RFC
 * 4180-style with `parseDelimited` (delimiter chosen by extension), and renders a
 * scrollable grid. Row 0 is the header; clicking a header cell toggles a sort on
 * that column (asc → desc → asc) applied to the body rows only. Ragged rows are
 * padded to the header width. Very large files render a capped slice with a note.
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

  // CSV/TSV text path (unchanged). For spreadsheets we don't read the raw file;
  // the hook still runs (hooks can't be conditional) but its content is ignored.
  const file = useReadonlyFile(path);
  const viewPos = useViewerState(tabKey);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  const persistTimer = useRef<number | null>(null);

  // Spreadsheet state: backend-loaded rows + sheet list + selected sheet.
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

  // Unify the two sources into the loading/error/content the render pipeline uses.
  const content = isSheet ? null : file.content;
  const error = isSheet ? sheetError : file.error;
  const loaded = isSheet ? sheetLoaded : file.loaded;

  const delimiter = useMemo(() => delimiterForPath(path), [path]);

  const { header, body, width } = useMemo(() => {
    // Spreadsheets arrive as already-parsed string[][] from the backend.
    const rows = isSheet
      ? sheetData?.rows ?? null
      : content == null
        ? null
        : parseDelimited(content, delimiter);
    if (rows == null) return { header: [] as string[], body: [] as string[][], width: 0 };
    if (rows.length === 0) return { header: [] as string[], body: [] as string[][], width: 0 };
    const head = rows[0];
    const bod = rows.slice(1);
    // Width is the widest row so ragged rows pad rather than truncate.
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return { header: head, body: bod, width: w };
  }, [isSheet, sheetData, content, delimiter]);

  const sortedBody = useMemo(() => {
    if (!sort) return body;
    return sortRows(body, sort.col, sort.dir);
  }, [body, sort]);

  const truncated = sortedBody.length > MAX_RENDER_ROWS;
  const visibleRows = truncated ? sortedBody.slice(0, MAX_RENDER_ROWS) : sortedBody;

  const toggleSort = (col: number) => {
    setSort((cur) => {
      if (!cur || cur.col !== col) return { col, dir: "asc" };
      return { col, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  };

  // Restore the saved scroll position once the body renders, then persist as the
  // reader scrolls (throttled, trailing-edge) — mirrors the other viewers.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !restored.current) return;
    const top = el.scrollTop;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => viewPos.persist({ scrollTop: top }), 200);
  };

  const onScrollRef = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el && !restored.current && loaded) {
      restored.current = true;
      const top = viewPos.initial?.scrollTop;
      if (top && top > 0) el.scrollTop = top;
    }
  };

  // Column index range for padding ragged rows out to the header width.
  const cols = useMemo(() => Array.from({ length: width }, (_, i) => i), [width]);

  return (
    <div className="file-viewer" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {isSheet && sheetData && sheetData.sheet_names.length > 1 && (
          <select
            value={selectedSheet ?? sheetData.active_sheet}
            onChange={(e) => setSelectedSheet(e.target.value)}
            title="Select sheet"
            style={{
              fontSize: 12,
              alignSelf: "center",
              background: "var(--bg-panel)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            {sheetData.sheet_names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
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
            {body.length} {body.length === 1 ? "row" : "rows"}
            {truncated ? ` (showing first ${MAX_RENDER_ROWS})` : ""}
          </span>
        )}
      </ViewerHeader>
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
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text-primary)",
          }}
        >
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: 13,
              fontFamily: "var(--font-mono, monospace)",
              width: "max-content",
              minWidth: "100%",
            }}
          >
            <thead>
              <tr>
                {cols.map((c) => {
                  const active = sort?.col === c;
                  return (
                    <th
                      key={c}
                      style={{
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                        background: "var(--bg-panel)",
                        borderBottom: "2px solid var(--border-color)",
                        borderRight: "1px solid var(--border-color)",
                        padding: 0,
                        textAlign: "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <button
                        onClick={() => toggleSort(c)}
                        title="Sort by this column"
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
                        <span>{header[c] ?? ""}</span>
                        <span style={{ opacity: active ? 0.9 : 0.25, fontSize: 11 }}>
                          {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, ri) => (
                <tr key={ri}>
                  {cols.map((c) => (
                    <td
                      key={c}
                      style={{
                        borderBottom: "1px solid var(--border-color)",
                        borderRight: "1px solid var(--border-color)",
                        padding: "4px 10px",
                        whiteSpace: "pre",
                        verticalAlign: "top",
                      }}
                    >
                      {row[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {truncated && (
            <div
              style={{
                padding: "8px 10px",
                fontSize: 12,
                opacity: 0.7,
                borderTop: "1px solid var(--border-color)",
              }}
            >
              Showing first {MAX_RENDER_ROWS} of {sortedBody.length} rows. Open
              externally to view the entire file.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
