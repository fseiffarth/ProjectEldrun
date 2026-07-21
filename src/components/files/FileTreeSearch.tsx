/**
 * In-tree search results for `FileTree` — the flat result list shown in place of
 * the browsed listing whenever the tree's search box holds a query. Two modes,
 * both local-only (their backends walk the canonical local path, so `FileTree`
 * only mounts this for a non-remote-source tree):
 *
 *  - **name**: fuzzy filename/path search over the whole project tree
 *    (`list_project_paths`, ranked by the shared `fuzzy.ts`). Fetched lazily on
 *    the first keystroke and cached per project dir.
 *  - **content**: literal line search inside files (`project_search`, the same
 *    backend the right panel's Search view uses), debounced.
 *
 * Every result offers BOTH of the actions the feature asks for: **jump to this
 * path** (reveal + select the entry in the tree, via `onReveal`) and **open**
 * the file in a viewer tab (content hits open at the matched line). Which one is
 * the row's primary click depends on the mode — a filename hit reveals, a
 * content hit opens at its line — and the other is a trailing button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";
import { useEditorJumpStore } from "../../stores/editorJump";
import { basename, resolvePath } from "../../lib/paths";
import { fileIcon, folderIcon } from "../../lib/viewers/fileUtils";

/** The `.ext` (lowercased, dot-included) of a path's basename, matching the
 *  shape `fileIcon` and `FileEntry.extension` use; "" when there is none. */
function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

interface PathEntry {
  path: string;
  is_dir: boolean;
}

/** Mirror of the Rust `SearchMatch` struct from `commands::search`. */
interface SearchMatch {
  path: string;
  rel: string;
  line: number;
  col: number;
  text: string;
}

const MAX_NAME_RESULTS = 200;
const MAX_CONTENT_RESULTS = 500;
const MIN_CONTENT_LEN = 2;
const DEBOUNCE_MS = 220;

/** Highlight the literal (case-insensitive) substring match in a path. */
function HighlightedPath({ text, query }: { text: string; query: string }) {
  const parts = contentParts(text, query, false);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      <mark className="file-search-hl">{parts.hit}</mark>
      {parts.after}
    </>
  );
}

/** Split a content line around the literal match so the hit can be marked. */
function contentParts(
  text: string,
  query: string,
  caseSensitive: boolean,
): { before: string; hit: string; after: string } | null {
  if (!query) return null;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  return { before: text.slice(0, idx), hit: text.slice(idx, idx + query.length), after: text.slice(idx + query.length) };
}

export function FileTreeSearch({
  projectDir,
  projectId,
  query,
  mode,
  caseSensitive,
  scopeRel,
  onReveal,
}: {
  projectDir: string;
  projectId: string | null;
  query: string;
  mode: "name" | "content";
  caseSensitive: boolean;
  /** Project-relative folder to confine the search to ("" = whole project).
   *  Filenames are filtered to this subtree; content search walks only it. */
  scopeRel: string;
  onReveal: (rel: string, isDir: boolean) => void;
}) {
  const openFile = useWindowsStore((s) => s.openFile);

  // The absolute directory the search is confined to (content search walks it;
  // name results are filtered to it). Rel-path bookkeeping stays project-rooted:
  // a content hit's project-relative path is `scopeRel` + the backend's `rel`.
  const scopeDir = scopeRel ? resolvePath(projectDir, scopeRel) : projectDir;

  // Name-mode source: the whole project path list, fetched lazily on first use
  // and cached for this projectDir (cleared when the dir changes).
  const [paths, setPaths] = useState<PathEntry[]>([]);
  const [namesLoaded, setNamesLoaded] = useState(false);
  const pathsFor = useRef<string | null>(null);

  const [content, setContent] = useState<SearchMatch[]>([]);
  const [contentSearched, setContentSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const trimmed = query.trim();

  // Fetch the project path list once per projectDir, only when name search is
  // actually used (a query in name mode). The fetch is keyed to the *directory*,
  // not the query — every keystroke re-runs this effect (via `trimmed`), so it
  // must NOT abort the in-flight fetch on a query change: the once-per-dir guard
  // (`pathsFor.current === projectDir`) would then skip re-fetching and the
  // results would never load ("Searching…" forever). Instead we tag the request
  // with the dir it was for and drop only results whose dir is no longer current
  // — so a second keystroke can never strand the first (and only) fetch.
  useEffect(() => {
    if (mode !== "name" || !projectDir || !trimmed) return;
    if (pathsFor.current === projectDir) return; // already fetched/fetching this dir
    pathsFor.current = projectDir;
    setNamesLoaded(false);
    setPaths([]);
    const forDir = projectDir;
    invoke<PathEntry[]>("list_project_paths", { projectDir })
      .then((entries) => {
        if (pathsFor.current !== forDir) return; // dir changed since; stale result
        setPaths(entries);
        setNamesLoaded(true);
      })
      .catch(() => {
        if (pathsFor.current !== forDir) return;
        pathsFor.current = null; // let a retry re-fetch
        setPaths([]);
        setNamesLoaded(true);
      });
  }, [mode, projectDir, trimmed]);

  // A dir change needs no separate reset effect: the fetch above already keys on
  // `projectDir`, so a genuine switch re-runs it (`pathsFor.current !== new dir`)
  // and it clears + re-fetches for the new dir. With an empty query the stale
  // `paths` are never shown either — `nameResults` guards on `!trimmed`. A second
  // effect resetting `pathsFor` here would only race and strand that fetch.

  const nameResults = useMemo(() => {
    if (mode !== "name" || !trimmed) return [];
    // Literal (case-insensitive) substring match on the path — NOT a fuzzy
    // subsequence, which for a whole project matches almost everything. Rank a
    // hit in the basename above one only in an ancestor folder, then a basename
    // prefix highest, then shorter paths.
    const q = trimmed.toLowerCase();
    const scoped = scopeRel ? paths.filter((e) => e.path.startsWith(`${scopeRel}/`)) : paths;
    const matched: { e: PathEntry; rank: number }[] = [];
    for (const e of scoped) {
      if (!e.path.toLowerCase().includes(q)) continue;
      const base = basename(e.path).toLowerCase();
      const rank = base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2;
      matched.push({ e, rank });
    }
    matched.sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : a.e.path.length !== b.e.path.length
          ? a.e.path.length - b.e.path.length
          : a.e.path.localeCompare(b.e.path),
    );
    return matched.slice(0, MAX_NAME_RESULTS).map((m) => m.e);
  }, [mode, trimmed, paths, scopeRel]);

  // Content search: debounced call into the shared literal search backend,
  // confined to `scopeDir`.
  useEffect(() => {
    if (mode !== "content" || !scopeDir) return;
    if (trimmed.length < MIN_CONTENT_LEN) {
      setContent([]);
      setContentSearched(false);
      setError(null);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      invoke<SearchMatch[]>("project_search", {
        projectDir: scopeDir,
        query: trimmed,
        caseSensitive,
        maxResults: MAX_CONTENT_RESULTS,
      })
        .then((matches) => {
          if (reqId.current !== id) return;
          setContent(matches);
          setContentSearched(true);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (reqId.current !== id) return;
          setContent([]);
          setContentSearched(true);
          setError(String(e));
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mode, scopeDir, trimmed, caseSensitive]);

  function openEntry(rel: string, isDir: boolean, line?: number, col?: number) {
    if (isDir) {
      onReveal(rel, true);
      return;
    }
    const abs = resolvePath(projectDir, rel);
    openFile(abs, undefined, projectId, "right_file_tree").catch(console.error);
    if (line != null) useEditorJumpStore.getState().requestJump(abs, line, col ?? 0);
  }

  if (mode === "content" && trimmed.length > 0 && trimmed.length < MIN_CONTENT_LEN) {
    return <div className="file-tree-empty">Type at least {MIN_CONTENT_LEN} characters</div>;
  }

  if (mode === "name") {
    if (!namesLoaded && paths.length === 0) {
      return <div className="file-tree-empty">Searching…</div>;
    }
    if (nameResults.length === 0) {
      return <div className="file-tree-empty">No matching files</div>;
    }
    return (
      <div className="file-search-results">
        <div className="file-search-count">
          {nameResults.length}
          {nameResults.length >= MAX_NAME_RESULTS ? "+" : ""} file
          {nameResults.length === 1 ? "" : "s"}
        </div>
        {nameResults.map((e) => {
          // Display the path relative to the browsed scope; reveal/open stay
          // project-rooted (`e.path`).
          const displayPath = scopeRel ? e.path.slice(scopeRel.length + 1) : e.path;
          return (
          <div
            key={e.path}
            className={`file-entry file-search-row ${e.is_dir ? "dir" : "file"}`}
            title={`${e.path} — click to reveal in tree`}
            onClick={() => onReveal(e.path, e.is_dir)}
            onDoubleClick={() => openEntry(e.path, e.is_dir)}
          >
            <span className="file-icon">{e.is_dir ? folderIcon() : fileIcon(extensionOf(e.path))}</span>
            <span className="file-name file-search-path">
              <HighlightedPath text={displayPath} query={trimmed} />
            </span>
            {!e.is_dir && (
              <button
                type="button"
                className="file-search-act"
                title="Open in a viewer tab"
                aria-label="Open file"
                onClick={(ev) => {
                  ev.stopPropagation();
                  openEntry(e.path, false);
                }}
              >
                ↗
              </button>
            )}
          </div>
          );
        })}
      </div>
    );
  }

  // content mode
  if (error) {
    return (
      <div className="file-tree-error" style={{ padding: "6px 8px", wordBreak: "break-all" }}>
        {error}
      </div>
    );
  }
  if (loading && content.length === 0) {
    return <div className="file-tree-empty">Searching…</div>;
  }
  if (contentSearched && content.length === 0) {
    return <div className="file-tree-empty">No results</div>;
  }
  return (
    <div className="file-search-results">
      {content.length > 0 && (
        <div className="file-search-count">
          {content.length}
          {content.length >= MAX_CONTENT_RESULTS ? "+" : ""} match
          {content.length === 1 ? "" : "es"}
        </div>
      )}
      {content.map((m, i) => {
        const parts = contentParts(m.text, trimmed, caseSensitive);
        // The backend's `rel` is relative to `scopeDir`; re-root it at the
        // project so reveal/open address the same path the tree uses.
        const projectRel = scopeRel ? `${scopeRel}/${m.rel}` : m.rel;
        return (
          <div
            key={`${projectRel}:${m.line}:${m.col}:${i}`}
            className="file-entry file-search-row file-search-content"
            title={`${projectRel}:${m.line} — click to open`}
            onClick={() => openEntry(projectRel, false, m.line, m.col)}
          >
            <div className="file-search-content-body">
              <span className="file-search-loc">
                {m.rel}:{m.line}
              </span>
              <span className="file-search-line">
                {parts ? (
                  <>
                    {parts.before}
                    <mark className="file-search-hl">{parts.hit}</mark>
                    {parts.after}
                  </>
                ) : (
                  m.text
                )}
              </span>
            </div>
            <button
              type="button"
              className="file-search-act"
              title="Reveal in tree"
              aria-label="Reveal in tree"
              onClick={(ev) => {
                ev.stopPropagation();
                onReveal(projectRel, false);
              }}
            >
              ◎
            </button>
          </div>
        );
      })}
    </div>
  );
}
