import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openLinkedFile } from "../embed/FileViewerPane";
import { useEditorJumpStore } from "../../stores/editorJump";

/** Mirror of the Rust `SearchMatch` struct from `commands::search`. */
interface SearchMatch {
  path: string;
  rel: string;
  line: number;
  col: number;
  text: string;
}

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 250;
const MAX_RESULTS = 500;

/** Split `text` around the (1-based char column) match of `query` so the hit can
 *  be highlighted. Falls back to the plain line when no match is locatable. */
function highlightParts(
  text: string,
  query: string,
  caseSensitive: boolean,
): { before: string; hit: string; after: string } | null {
  if (!query) return null;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  return {
    before: text.slice(0, idx),
    hit: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length),
  };
}

export function SearchPanel({
  projectDir,
  linkingTabKey,
}: {
  projectDir: string;
  linkingTabKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    if (!projectDir) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setError(null);
      setSearched(false);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      invoke<SearchMatch[]>("project_search", {
        projectDir,
        query: trimmed,
        caseSensitive,
        maxResults: MAX_RESULTS,
      })
        .then((matches) => {
          if (reqId.current !== id) return; // a newer query superseded this one
          setResults(matches);
          setError(null);
          setSearched(true);
          setLoading(false);
        })
        .catch((e) => {
          if (reqId.current !== id) return;
          setResults([]);
          setError(String(e));
          setSearched(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, projectDir]);

  function openResult(m: SearchMatch) {
    openLinkedFile(linkingTabKey, projectDir, {
      path: m.path,
      viewer: "text",
      label: m.rel.split("/").pop() ?? m.rel,
    });
    useEditorJumpStore.getState().requestJump(m.path, m.line, m.col);
  }

  if (!projectDir) {
    return (
      <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        <div className="file-tree-empty">Open a project to search</div>
      </div>
    );
  }

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LEN;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          padding: "6px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <input
          type="text"
          value={query}
          autoFocus
          placeholder="Search project files…"
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            fontSize: 12,
            background: "var(--bg-panel)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: 3,
            padding: "4px 6px",
            boxSizing: "border-box",
          }}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          <span>Case sensitive</span>
        </label>
      </div>

      <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {error ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--danger, #f85149)",
              wordBreak: "break-all",
              padding: "6px 8px",
            }}
          >
            {error}
          </div>
        ) : tooShort ? (
          <div className="file-tree-empty">Type at least {MIN_QUERY_LEN} characters</div>
        ) : loading && results.length === 0 ? (
          <div className="file-tree-empty">Searching…</div>
        ) : searched && results.length === 0 ? (
          <div className="file-tree-empty">No results</div>
        ) : (
          <>
            {results.length > 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  padding: "4px 8px",
                }}
              >
                {results.length}
                {results.length >= MAX_RESULTS ? "+" : ""} match
                {results.length === 1 ? "" : "es"}
              </div>
            )}
            {results.map((m, i) => {
              const parts = highlightParts(m.text, trimmed, caseSensitive);
              return (
                <button
                  key={`${m.path}:${m.line}:${m.col}:${i}`}
                  type="button"
                  className="file-entry"
                  onClick={() => openResult(m)}
                  title={`${m.rel}:${m.line}`}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 1,
                    padding: "3px 8px",
                  }}
                >
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {m.rel}:{m.line}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-primary)",
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {parts ? (
                      <>
                        {parts.before}
                        <mark
                          style={{
                            background: "var(--accent, #e3b341)",
                            color: "var(--bg-panel, #000)",
                            borderRadius: 2,
                          }}
                        >
                          {parts.hit}
                        </mark>
                        {parts.after}
                      </>
                    ) : (
                      m.text
                    )}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
