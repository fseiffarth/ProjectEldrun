import { describe, expect, it, vi } from "vitest";
import { completionContext, completionImports } from "../lib/viewers/completion/completionContext";
import { CompletionCache, completionLineLength, modelLookupCache } from "../lib/viewers/completion/autocomplete";

describe("completion references", () => {
  it("resolves local imports and TeX inputs without escaping the project", () => {
    expect(completionImports("import x from './helper'; import y from '../../private.ts';", "/p/src/a.ts", "/p"))
      .toEqual(["/p/src/helper.ts", "/p/src/helper.tsx", "/p/src/helper.js", "/p/src/helper/index.ts"]);
    expect(completionImports("from .helper import x\nimport package.module", "/p/src/a.py", "/p"))
      .toContain("/p/src/helper.py");
    expect(completionImports("\\input{chapter} \\bibliography{one,two} \\input{../../secret}", "/p/a.tex", "/p"))
      .toEqual(["/p/chapter.tex", "/p/one.bib", "/p/two.bib"]);
  });

  it("prioritizes manual references, caps UTF-8 bytes and never reads outside the project", async () => {
    const read = vi.fn().mockResolvedValue("😀".repeat(3000));
    const result = await completionContext({
      path: "/p/a.ts", root: "/p", draft: "", signal: new AbortController().signal,
      manual: [{ name: "manual", content: "ü".repeat(4000) }],
      openPaths: ["/elsewhere/private", "/p/a.ts", "/p/b.ts", "/p/b.ts", "/p/c.ts", "/p/d.ts", "/p/e.ts"], read,
    });
    expect(result[0].name).toBe("manual");
    expect(result.map((f) => new TextEncoder().encode(f.content).length)).toEqual([6000, 6000, 6000, 6000]);
    expect(result.every((f) => !f.content.includes("�"))).toBe(true);
    expect(read.mock.calls.flat()).toEqual(["/p/b.ts", "/p/c.ts", "/p/d.ts"]);
  });

  it("adds current labels and bib keys, tolerates unreadable inputs, and stops after cancellation", async () => {
    const controller = new AbortController();
    const read = vi.fn(async (path: string) => {
      if (path.endsWith("missing.tex")) throw new Error("missing");
      return "@article{key2026, title={Long title}}";
    });
    const opts = {
      path: "/p/a.tex", root: "/p", draft: "\\input{missing} \\bibliography{refs}",
      signal: controller.signal, manual: [], openPaths: [], keys: "sec:intro", read,
    };
    expect(await completionContext(opts)).toEqual([
      { name: "LaTeX label / bibliography keys", content: "sec:intro" },
      { name: "refs.bib", content: "key2026" },
    ]);
    controller.abort();
    read.mockClear();
    await completionContext(opts);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("completion caches", () => {
  it("deduplicates model queries, expires loaded state and retries failures", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const lookup = vi.fn().mockResolvedValue([{ name: "coder", running: true }]);
      const cached = modelLookupCache();
      await Promise.all([cached("local", lookup), cached("local", lookup)]);
      expect(lookup).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6001);
      await cached("local", lookup);
      expect(lookup).toHaveBeenCalledTimes(2);
      lookup.mockRejectedValueOnce(new Error("offline"));
      await expect(cached("other", lookup)).rejects.toThrow("offline");
      await cached("other", lookup);
      expect(lookup).toHaveBeenCalledTimes(4);
    } finally { now.mockRestore(); }
  });

  it("bounds completion memory and expires old suggestions", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const cache = new CompletionCache();
      for (let i = 0; i < 24; i++) cache.set(String(i), "result");
      expect(cache.get("0")).toBe("result");
      cache.set("24", "next");
      expect(cache.get("1")).toBeUndefined();
      expect(cache.get("0")).toBe("result");
      now.mockReturnValue(60_001);
      expect(cache.get("0")).toBeUndefined();
    } finally { now.mockRestore(); }
  });

  it("accepts whole lines including leading/trailing line breaks", () => {
    for (const [text, chunk] of [["first\nsecond", "first\n"], ["\n  first\nsecond", "\n  first\n"], ["\r\n  first\r\nsecond", "\r\n  first\r\n"], ["last", "last"]]) {
      expect(text.slice(0, completionLineLength(text))).toBe(chunk);
    }
  });
});
