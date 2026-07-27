/**
 * Pure, dependency-free fuzzy matcher + ranker (Dev B), used by the Ctrl/Cmd+P
 * quick-open palette. Case-insensitive subsequence matching with a heuristic
 * score that rewards consecutive runs, matches at separators / word /
 * camelCase boundaries, and matches near the basename — so an exact basename
 * hit ranks above a path-scattered one.
 *
 * Kept allocation-light: a single positions array per match, no regexps.
 */

export interface FuzzyResult {
  /** Higher is a better match. */
  score: number;
  /** Indices into `text` of the matched characters, in order. */
  positions: number[];
}

/** True for characters that begin a "word" segment in a path. */
function isSeparator(ch: number): boolean {
  // '/' '\\' '.' '_' '-' ' '
  return ch === 47 || ch === 92 || ch === 46 || ch === 95 || ch === 45 || ch === 32;
}

function isUpper(ch: number): boolean {
  return ch >= 65 && ch <= 90;
}

function isLower(ch: number): boolean {
  return ch >= 97 && ch <= 122;
}

/**
 * Case-insensitive subsequence match of `query` against `text`. Returns the
 * matched positions and a heuristic score, or null when `query`'s characters
 * do not all appear in order. An empty query trivially matches with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (text.length === 0) return null;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Index of the basename start (char after the last path separator).
  let basenameStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 47 || text.charCodeAt(i) === 92) basenameStart = i + 1;
  }

  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2; // index of previously matched char in text

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charCodeAt(ti) !== q.charCodeAt(qi)) continue;

    positions.push(ti);

    // Base reward for any matched char.
    let bonus = 1;

    // Consecutive run: previous query char matched the immediately prior text char.
    if (prevMatch === ti - 1) {
      bonus += 5;
    }

    // Boundary bonuses (only meaningful when not already a consecutive run).
    const orig = text;
    const prevCh = ti > 0 ? orig.charCodeAt(ti - 1) : -1;
    const curCh = orig.charCodeAt(ti);
    if (ti === 0 || isSeparator(prevCh)) {
      // Start of the string or right after a separator (word boundary).
      bonus += 4;
    } else if (isUpper(curCh) && isLower(prevCh)) {
      // camelCase boundary.
      bonus += 3;
    }

    // Matches inside the basename are more valuable than deep-path matches.
    if (ti >= basenameStart) {
      bonus += 2;
    }

    score += bonus;
    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null;

  // Prefer matches whose span is tight (early + contiguous) over scattered ones.
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= (span - q.length) * 0.1;

  // Slightly prefer the match starting earlier in the basename.
  score -= positions[0] * 0.01;

  return { score, positions };
}

/**
 * Filter `items` to those whose `key` fuzzily matches `query`, sorted by score
 * descending. Stable for ties via shorter-text then localeCompare. An empty
 * query is a no-op: `items` is returned unchanged.
 */
export function fuzzyRank<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (query.trim().length === 0) return items;

  const scored: { item: T; text: string; score: number; idx: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const text = key(items[i]);
    const m = fuzzyMatch(query, text);
    if (m) scored.push({ item: items[i], text, score: m.score, idx: i });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.text.length !== b.text.length) return a.text.length - b.text.length;
    const c = a.text.localeCompare(b.text);
    if (c !== 0) return c;
    return a.idx - b.idx; // keep original order on full ties (stable)
  });

  return scored.map((s) => s.item);
}
