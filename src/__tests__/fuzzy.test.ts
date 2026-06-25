import { describe, it, expect } from "vitest";
import { fuzzyMatch, fuzzyRank } from "../lib/fuzzy";

describe("fuzzyMatch — subsequence", () => {
  it("matches an in-order subsequence", () => {
    const m = fuzzyMatch("ab", "xaxb");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([1, 3]);
  });

  it("rejects out-of-order characters", () => {
    expect(fuzzyMatch("ba", "xaxb")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("AB", "xaxb")).not.toBeNull();
    expect(fuzzyMatch("ab", "XAXB")).not.toBeNull();
  });

  it("rejects when a query char is absent", () => {
    expect(fuzzyMatch("abc", "ab")).toBeNull();
  });

  it("matches an empty query trivially", () => {
    const m = fuzzyMatch("", "anything");
    expect(m).toEqual({ score: 0, positions: [] });
  });

  it("scores a consecutive run higher than a scattered match", () => {
    const tight = fuzzyMatch("abc", "abcxxxx");
    const loose = fuzzyMatch("abc", "axbxcxx");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!.score).toBeGreaterThan(loose!.score);
  });
});

describe("fuzzyRank", () => {
  it("ranks an exact basename above a scattered path match", () => {
    const items = [
      "src/components/scattered/m_a_i_n.ts", // 'main' scattered across the path
      "src/main.ts", // exact basename "main"
    ];
    const ranked = fuzzyRank("main", items, (s) => s);
    expect(ranked[0]).toBe("src/main.ts");
  });

  it("ranks a consecutive-run match above a spread-out one", () => {
    const items = ["a_x_b_x_c.txt", "abc.txt"];
    const ranked = fuzzyRank("abc", items, (s) => s);
    expect(ranked[0]).toBe("abc.txt");
  });

  it("filters out non-matches", () => {
    const items = ["alpha.ts", "beta.ts", "gamma.ts"];
    const ranked = fuzzyRank("eta", items, (s) => s);
    expect(ranked).toEqual(["beta.ts"]);
  });

  it("is a no-op for an empty query", () => {
    const items = ["c.ts", "a.ts", "b.ts"];
    const ranked = fuzzyRank("", items, (s) => s);
    expect(ranked).toBe(items);
    expect(ranked).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("is a no-op for a whitespace-only query", () => {
    const items = ["c.ts", "a.ts"];
    expect(fuzzyRank("   ", items, (s) => s)).toBe(items);
  });

  it("tie-breaks equal scores by shorter text then localeCompare", () => {
    // Both are exact-prefix basename matches; the shorter one should win.
    const items = ["xyz.ts", "xy.ts"];
    const ranked = fuzzyRank("xy", items, (s) => s);
    expect(ranked[0]).toBe("xy.ts");
  });
});
