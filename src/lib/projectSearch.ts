/**
 * Pure helpers for the project search — the one frontend of the backend's
 * `project_search` (literal content search) and `list_project_paths` (name
 * search) commands, rendered by `components/files/FileTreeSearch`. No React,
 * no invokes: the component owns fetching/debouncing, this module owns the
 * shapes and the ranking so they are unit-testable on their own.
 */
import { basename } from "./paths";

/** Mirror of the Rust `SearchMatch` struct from `commands::search`. */
export interface SearchMatch {
  path: string;
  rel: string;
  line: number;
  col: number;
  text: string;
}

/** One row of `list_project_paths` (`commands::fs`). */
export interface PathEntry {
  path: string;
  is_dir: boolean;
}

export const MIN_CONTENT_LEN = 2;
export const CONTENT_DEBOUNCE_MS = 220;
export const MAX_NAME_RESULTS = 200;
export const MAX_CONTENT_RESULTS = 500;

/** Split `text` around the first literal match of `query` so the hit can be
 *  highlighted; null when the query is empty or not found in the line. */
export function matchParts(
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

/**
 * Name-mode ranking: literal (case-insensitive) substring match on the path —
 * NOT a fuzzy subsequence, which for a whole project matches almost everything.
 * A hit in the basename ranks above one only in an ancestor folder, a basename
 * prefix highest of all, then shorter paths; `scopeRel` (project-relative, ""
 * = whole project) confines results to that subtree.
 */
export function rankNameMatches(
  paths: PathEntry[],
  query: string,
  scopeRel: string,
  cap: number = MAX_NAME_RESULTS,
): PathEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
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
  return matched.slice(0, cap).map((m) => m.e);
}
