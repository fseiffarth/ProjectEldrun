/**
 * The persisted "does this `.py` deserve a ▶?" verdict — and the bounded content
 * scan that fills it.
 *
 * The Run button on a `.py` row is gated on the file being a *script*: one with a
 * module-level `if __name__ == "__main__":` guard (`viewers/python`). That is a
 * fact about the file's **content**, and a directory listing carries only names,
 * sizes and mtimes — so somebody has to read the bytes.
 *
 * Reading them on every listing is what this module exists to stop. The old
 * arrangement kept the verdicts in a component-lifetime `useRef`, so every reopen
 * of the file viewer re-read every visible `.py`; and because that cost is an SFTP
 * round trip per file on a remote listing, the remote side skipped the check
 * altogether and showed ▶ on *every* `.py`. Hence the bug this replaces: the same
 * library module offered a Run button on the host and none on the mirror.
 *
 * So a verdict is computed **once per version of a file** and persisted in
 * settings.json, keyed by absolute path and stamped with the `(size, mtime)` it
 * was computed from:
 *
 *  - unchanged file → the stored verdict is reused, forever, across viewer
 *    reopens and across restarts. No read.
 *  - edited file → size or mtime moves, so exactly that one file is re-read.
 *  - explicit ↻ refresh → the caller re-checks the listing regardless of the
 *    stamp, which is the point of a manual refresh (it also covers the case the
 *    stamp cannot see: a same-second write that lands on the same size).
 *
 * The stamp is what makes it safe to persist. A cache keyed on the path alone
 * would answer for a file that has since become something else entirely.
 */

import { isPythonMainScript } from "./viewers/python";

/** One cached verdict: the answer, plus the file version it was computed from. */
export interface PyMainVerdict {
  /** Whether the file has a module-level `if __name__ == "__main__":` guard. */
  main: boolean;
  /** Size in bytes, as the directory listing reports it (`FileEntry.size`). */
  size: number;
  /** Whole-second mtime (`FileEntry.modified_secs`); 0 when the listing had none. */
  mtime: number;
}

/** The whole cache: absolute path → verdict. Lives in `Settings.python_main_scripts`. */
export type PyMainCache = Record<string, PyMainVerdict>;

/** One file the scan may have to read, as the listing describes it. */
export interface PyMainFile {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Files above this are assumed runnable without being read.
 *
 * The whole point is to avoid pulling megabytes over SFTP to decide the fate of
 * an 18px button, and the guard can sit on the last line so there is no cheap
 * partial read that settles it. Defaulting such a file to *runnable* is the
 * conservative direction: a spurious ▶ costs a wasted click, a missing one hides
 * a script the user meant to run.
 */
export const PY_MAIN_MAX_BYTES = 2 * 1024 * 1024;

/** Concurrent content reads. Small on purpose: on a remote listing each one is an
 *  SFTP round trip, and a folder of 200 modules must not saturate the channel the
 *  tree itself is being listed over. */
export const PY_MAIN_CONCURRENCY = 4;

/** Cache entries kept. Each is ~80 bytes of JSON, so this is a small settings file
 *  even when full; the pruner drops least-recently-written entries (see
 *  {@link mergeVerdicts}) rather than letting the map grow without bound. */
export const PY_MAIN_MAX_ENTRIES = 4000;

/** Whether `f` still needs a content read, i.e. no stored verdict matches the
 *  version of the file the listing is showing. */
export function needsMainCheck(cache: PyMainCache | undefined, f: PyMainFile): boolean {
  const v = cache?.[f.path];
  if (!v) return true;
  return v.size !== f.size || v.mtime !== f.mtime;
}

/**
 * The verdict to *render* for `path` — deliberately ignoring the stamp.
 *
 * A stale verdict is still the best answer available: while a re-check of a
 * just-edited script is in flight, keeping the previous answer leaves ▶ where it
 * was instead of making it blink out from under the pointer. Unknown means no ▶,
 * matching what the gate is for (a file we have never read is not yet known to be
 * a script).
 */
export function isMainScriptCached(cache: PyMainCache | undefined, path: string): boolean {
  return cache?.[path]?.main ?? false;
}

/**
 * Read each file and decide whether it is a main script, at most
 * `concurrency` reads at a time. Returns only the files that produced a verdict.
 *
 * `read` returns the file's text, or null/throws when it cannot be read.
 */
export async function checkMainScripts(
  files: PyMainFile[],
  read: (path: string) => Promise<string | null>,
  opts?: { concurrency?: number; cancelled?: () => boolean },
): Promise<PyMainCache> {
  const out: PyMainCache = {};
  const queue = [...files];
  const lanes = Math.max(1, opts?.concurrency ?? PY_MAIN_CONCURRENCY);
  const worker = async () => {
    for (;;) {
      if (opts?.cancelled?.()) return;
      const f = queue.shift();
      if (!f) return;
      if (f.size > PY_MAIN_MAX_BYTES) {
        out[f.path] = { main: true, size: f.size, mtime: f.mtime };
        continue;
      }
      const text = await read(f.path).catch(() => null);
      if (opts?.cancelled?.()) return;
      // A failed read — a dropped SSH connection, a file deleted mid-scan, a
      // permission wall — yields NO verdict rather than a false one. Persisting
      // "not a script" here would survive the outage and keep ▶ hidden until the
      // file's mtime happened to change.
      if (text == null) continue;
      out[f.path] = { main: isPythonMainScript(text), size: f.size, mtime: f.mtime };
    }
  };
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}

/**
 * Fold fresh verdicts into the stored cache, keeping it bounded.
 *
 * Updated paths are re-inserted at the end so JS object key order doubles as a
 * recency list, and the prune drops from the front — a folder browsed once years
 * ago ages out before one being worked in today.
 */
export function mergeVerdicts(cache: PyMainCache | undefined, updates: PyMainCache): PyMainCache {
  const merged: PyMainCache = { ...(cache ?? {}) };
  for (const [path, verdict] of Object.entries(updates)) {
    delete merged[path];
    merged[path] = verdict;
  }
  const keys = Object.keys(merged);
  if (keys.length > PY_MAIN_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - PY_MAIN_MAX_ENTRIES)) delete merged[k];
  }
  return merged;
}

/** Whether `updates` would change nothing in `cache` — the guard that keeps a
 *  re-listing of an unchanged folder from rewriting settings.json. */
export function verdictsUnchanged(cache: PyMainCache | undefined, updates: PyMainCache): boolean {
  const entries = Object.entries(updates);
  if (entries.length === 0) return true;
  return entries.every(([path, v]) => {
    const cur = cache?.[path];
    return cur != null && cur.main === v.main && cur.size === v.size && cur.mtime === v.mtime;
  });
}
