import { describe, it, expect } from "vitest";
import {
  checkMainScripts,
  isMainScriptCached,
  mergeVerdicts,
  needsMainCheck,
  verdictsUnchanged,
  PY_MAIN_MAX_BYTES,
  PY_MAIN_MAX_ENTRIES,
  type PyMainCache,
} from "../lib/pythonMainCache";

const SCRIPT = 'def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n';
const MODULE = '"""Shared helpers."""\nfrom pathlib import Path\n\n\ndef helper():\n    return 1\n';

describe("needsMainCheck", () => {
  it("needs a read when nothing is cached", () => {
    expect(needsMainCheck(undefined, { path: "/a.py", size: 10, mtime: 5 })).toBe(true);
    expect(needsMainCheck({}, { path: "/a.py", size: 10, mtime: 5 })).toBe(true);
  });

  it("reuses a verdict whose stamp still matches — the whole point of persisting", () => {
    const cache: PyMainCache = { "/a.py": { main: true, size: 10, mtime: 5 } };
    expect(needsMainCheck(cache, { path: "/a.py", size: 10, mtime: 5 })).toBe(false);
  });

  it("re-reads when either half of the stamp moved", () => {
    const cache: PyMainCache = { "/a.py": { main: true, size: 10, mtime: 5 } };
    expect(needsMainCheck(cache, { path: "/a.py", size: 11, mtime: 5 })).toBe(true);
    expect(needsMainCheck(cache, { path: "/a.py", size: 10, mtime: 6 })).toBe(true);
  });
});

describe("isMainScriptCached", () => {
  it("is false for a file never read — an unknown file is not yet known to be a script", () => {
    expect(isMainScriptCached(undefined, "/a.py")).toBe(false);
    expect(isMainScriptCached({}, "/a.py")).toBe(false);
  });

  it("ignores the stamp, so ▶ doesn't blink out while a re-check is in flight", () => {
    const cache: PyMainCache = { "/a.py": { main: true, size: 10, mtime: 5 } };
    // The listing now reports a different version; the verdict is stale but is
    // still the best answer available until the re-read lands.
    expect(needsMainCheck(cache, { path: "/a.py", size: 99, mtime: 9 })).toBe(true);
    expect(isMainScriptCached(cache, "/a.py")).toBe(true);
  });
});

describe("checkMainScripts", () => {
  it("tells a script from a library module", async () => {
    const files = [
      { path: "/train.py", size: SCRIPT.length, mtime: 1 },
      { path: "/plot_common.py", size: MODULE.length, mtime: 1 },
    ];
    const out = await checkMainScripts(files, async (p) =>
      p === "/train.py" ? SCRIPT : MODULE,
    );
    expect(out["/train.py"].main).toBe(true);
    expect(out["/plot_common.py"].main).toBe(false);
  });

  it("gives the SAME verdict whatever side the file was listed from", async () => {
    // The bug this replaces: a remote listing skipped the content check entirely
    // and reported every .py as runnable, so one library module offered ▶ on the
    // host and none on the mirror. There is only one code path now, so the two
    // sides cannot answer differently.
    const local = await checkMainScripts(
      [{ path: "/mirror/plot_common.py", size: MODULE.length, mtime: 1 }],
      async () => MODULE,
    );
    const remote = await checkMainScripts(
      [{ path: "/host/plot_common.py", size: MODULE.length, mtime: 1 }],
      async () => MODULE,
    );
    expect(local["/mirror/plot_common.py"].main).toBe(remote["/host/plot_common.py"].main);
    expect(remote["/host/plot_common.py"].main).toBe(false);
  });

  it("stamps the verdict with the version it was computed from", async () => {
    const out = await checkMainScripts(
      [{ path: "/a.py", size: 42, mtime: 7 }],
      async () => SCRIPT,
    );
    expect(out["/a.py"]).toEqual({ main: true, size: 42, mtime: 7 });
  });

  it("records NO verdict for a read that failed, so an outage isn't persisted as 'not a script'", async () => {
    const out = await checkMainScripts(
      [
        { path: "/gone.py", size: 10, mtime: 1 },
        { path: "/null.py", size: 10, mtime: 1 },
        { path: "/ok.py", size: SCRIPT.length, mtime: 1 },
      ],
      async (p) => {
        if (p === "/gone.py") throw new Error("connection reset");
        if (p === "/null.py") return null;
        return SCRIPT;
      },
    );
    expect(out["/gone.py"]).toBeUndefined();
    expect(out["/null.py"]).toBeUndefined();
    expect(out["/ok.py"].main).toBe(true);
  });

  it("assumes an oversized file is runnable without reading it", async () => {
    let reads = 0;
    const out = await checkMainScripts(
      [{ path: "/huge.py", size: PY_MAIN_MAX_BYTES + 1, mtime: 1 }],
      async () => {
        reads += 1;
        return MODULE;
      },
    );
    expect(reads).toBe(0);
    expect(out["/huge.py"].main).toBe(true);
  });

  it("never runs more than `concurrency` reads at once", async () => {
    let live = 0;
    let peak = 0;
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `/f${i}.py`,
      size: SCRIPT.length,
      mtime: 1,
    }));
    await checkMainScripts(
      files,
      async () => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
        return SCRIPT;
      },
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("stops early when cancelled", async () => {
    let reads = 0;
    let cancelled = false;
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `/f${i}.py`,
      size: SCRIPT.length,
      mtime: 1,
    }));
    await checkMainScripts(
      files,
      async () => {
        reads += 1;
        if (reads >= 2) cancelled = true;
        return SCRIPT;
      },
      { concurrency: 1, cancelled: () => cancelled },
    );
    expect(reads).toBeLessThan(files.length);
  });
});

describe("mergeVerdicts", () => {
  it("folds new verdicts over old ones", () => {
    const merged = mergeVerdicts(
      { "/a.py": { main: false, size: 1, mtime: 1 } },
      { "/a.py": { main: true, size: 2, mtime: 2 }, "/b.py": { main: false, size: 3, mtime: 3 } },
    );
    expect(merged["/a.py"]).toEqual({ main: true, size: 2, mtime: 2 });
    expect(merged["/b.py"].size).toBe(3);
  });

  it("prunes the least recently written entries once past the cap", () => {
    const cache: PyMainCache = {};
    for (let i = 0; i < PY_MAIN_MAX_ENTRIES; i += 1) {
      cache[`/old${i}.py`] = { main: false, size: i, mtime: 1 };
    }
    const merged = mergeVerdicts(cache, { "/new.py": { main: true, size: 1, mtime: 1 } });
    expect(Object.keys(merged)).toHaveLength(PY_MAIN_MAX_ENTRIES);
    expect(merged["/new.py"]).toBeDefined();
    expect(merged["/old0.py"]).toBeUndefined();
  });

  it("re-writing a verdict refreshes its recency rather than aging out", () => {
    const cache: PyMainCache = {};
    for (let i = 0; i < PY_MAIN_MAX_ENTRIES; i += 1) {
      cache[`/f${i}.py`] = { main: false, size: i, mtime: 1 };
    }
    const merged = mergeVerdicts(cache, {
      "/f0.py": { main: true, size: 0, mtime: 2 },
      "/new.py": { main: true, size: 1, mtime: 1 },
    });
    expect(merged["/f0.py"]).toEqual({ main: true, size: 0, mtime: 2 });
    expect(merged["/f1.py"]).toBeUndefined();
  });
});

describe("verdictsUnchanged", () => {
  it("is true for an empty batch, so an unchanged folder writes nothing", () => {
    expect(verdictsUnchanged(undefined, {})).toBe(true);
  });

  it("is true when every verdict already matches", () => {
    const cache: PyMainCache = { "/a.py": { main: true, size: 1, mtime: 1 } };
    expect(verdictsUnchanged(cache, { "/a.py": { main: true, size: 1, mtime: 1 } })).toBe(true);
  });

  it("is false when anything at all moved", () => {
    const cache: PyMainCache = { "/a.py": { main: true, size: 1, mtime: 1 } };
    expect(verdictsUnchanged(cache, { "/a.py": { main: false, size: 1, mtime: 1 } })).toBe(false);
    expect(verdictsUnchanged(cache, { "/a.py": { main: true, size: 2, mtime: 1 } })).toBe(false);
    expect(verdictsUnchanged(cache, { "/b.py": { main: true, size: 1, mtime: 1 } })).toBe(false);
  });
});
