import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewerHeader } from "./FileViewerPane";

/** One page of a table, mirroring the backend `SqlitePage` struct. */
type SqlitePage = {
  columns: string[];
  rows: string[][];
  total: number;
};

/** Page size for the row grid. */
const PAGE_SIZE = 100;

/**
 * Read-only SQLite database browser (Dev C, frontend half). Lists the
 * database's tables/views in a left rail and renders the selected table's rows
 * in a paged, scrollable grid. Backend: `sqlite_tables(path)` and
 * `sqlite_page(path, table, limit, offset)` in `src-tauri/src/commands/
 * sqlite.rs`. All cells are React children (auto-escaped) — never raw HTML.
 */
export function SqliteView({
  path,
  onOpenExternally,
  tabKey: _tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const [tables, setTables] = useState<string[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<SqlitePage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  // Load the table list on mount (and whenever the file changes); pick the
  // first table by default.
  useEffect(() => {
    let cancelled = false;
    setTables(null);
    setTablesError(null);
    setSelected(null);
    setOffset(0);
    invoke<string[]>("sqlite_tables", { path })
      .then((names) => {
        if (cancelled) return;
        setTables(names);
        setSelected(names.length > 0 ? names[0] : null);
      })
      .catch((e) => {
        if (!cancelled) setTablesError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Load the selected table's page whenever the table or offset changes.
  useEffect(() => {
    if (selected == null) {
      setPage(null);
      setPageError(null);
      return;
    }
    let cancelled = false;
    setPage(null);
    setPageError(null);
    invoke<SqlitePage>("sqlite_page", {
      path,
      table: selected,
      limit: PAGE_SIZE,
      offset,
    })
      .then((p) => {
        if (!cancelled) setPage(p);
      })
      .catch((e) => {
        if (!cancelled) setPageError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, selected, offset]);

  function selectTable(name: string) {
    setSelected(name);
    setOffset(0); // reset paging when switching tables
  }

  const total = page?.total ?? 0;
  const rowCount = page?.rows.length ?? 0;
  const firstRow = total === 0 ? 0 : offset + 1;
  const lastRow = offset + rowCount;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally} />
      <div
        className="file-viewer-body"
        style={{ display: "flex", overflow: "hidden", minHeight: 0 }}
      >
        {tablesError != null ? (
          <div className="file-viewer-error" style={{ padding: "1rem", color: "#f85149" }}>
            {tablesError}
          </div>
        ) : tables == null ? (
          <div
            className="file-viewer-loading"
            style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}
          >
            Loading database…
          </div>
        ) : tables.length === 0 ? (
          <div
            className="file-viewer-empty"
            style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}
          >
            No tables in this database.
          </div>
        ) : (
          <>
            {/* Left rail: table/view list. */}
            <div
              className="sqlite-rail"
              style={{
                flex: "0 0 auto",
                width: "12em",
                overflow: "auto",
                borderRight: "1px solid var(--border-color)",
                background: "var(--bg-panel)",
              }}
            >
              {tables.map((name) => {
                const active = name === selected;
                return (
                  <button
                    key={name}
                    className="sqlite-table-item"
                    onClick={() => selectTable(name)}
                    title={name}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "0.4em 0.75em",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono, ui-monospace, Menlo, Consolas, monospace)",
                      fontSize: "12px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      background: active
                        ? "var(--bg-elevated, rgba(255,255,255,0.08))"
                        : "transparent",
                      color: active
                        ? "var(--text-primary)"
                        : "var(--text-secondary, #8b949e)",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            {/* Right: paged grid for the selected table. */}
            <div
              className="sqlite-grid-pane"
              style={{
                flex: "1 1 auto",
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                minHeight: 0,
                background: "var(--bg-panel)",
                color: "var(--text-primary)",
              }}
            >
              {pageError != null ? (
                <div
                  className="sqlite-error"
                  style={{ padding: "1rem", color: "#f85149" }}
                >
                  {pageError}
                </div>
              ) : page == null ? (
                <div
                  className="sqlite-loading"
                  style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}
                >
                  Loading rows…
                </div>
              ) : (
                <>
                  {/* Scrollable grid. */}
                  <div
                    className="sqlite-grid"
                    style={{
                      flex: "1 1 auto",
                      overflow: "auto",
                      minHeight: 0,
                      fontFamily:
                        "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
                      fontSize: "12px",
                    }}
                  >
                    <table
                      style={{
                        borderCollapse: "collapse",
                        width: "max-content",
                        minWidth: "100%",
                      }}
                    >
                      <thead>
                        <tr>
                          {page.columns.map((col, ci) => (
                            <th
                              key={ci}
                              style={{
                                position: "sticky",
                                top: 0,
                                textAlign: "left",
                                padding: "0.35em 0.6em",
                                background: "var(--bg-elevated, rgba(255,255,255,0.06))",
                                borderBottom: "1px solid var(--border-color)",
                                borderRight: "1px solid var(--border-color)",
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {page.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td
                                key={ci}
                                style={{
                                  padding: "0.3em 0.6em",
                                  borderBottom: "1px solid var(--border-color)",
                                  borderRight: "1px solid var(--border-color)",
                                  whiteSpace: "pre",
                                  verticalAlign: "top",
                                }}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pager footer. */}
                  <div
                    className="sqlite-pager"
                    style={{
                      flex: "0 0 auto",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75em",
                      padding: "0.4em 0.75em",
                      borderTop: "1px solid var(--border-color)",
                      fontSize: "12px",
                      color: "var(--text-secondary, #8b949e)",
                    }}
                  >
                    <span>
                      {total === 0
                        ? "0 rows"
                        : `rows ${firstRow}–${lastRow} of ${total}`}
                    </span>
                    <span style={{ flex: "1 1 auto" }} />
                    <button
                      onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                      disabled={!canPrev}
                      style={{
                        cursor: canPrev ? "pointer" : "default",
                        opacity: canPrev ? 1 : 0.4,
                      }}
                    >
                      ‹ Prev
                    </button>
                    <button
                      onClick={() =>
                        setOffset((o) => (o + PAGE_SIZE < total ? o + PAGE_SIZE : o))
                      }
                      disabled={!canNext}
                      style={{
                        cursor: canNext ? "pointer" : "default",
                        opacity: canNext ? 1 : 0.4,
                      }}
                    >
                      Next ›
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
