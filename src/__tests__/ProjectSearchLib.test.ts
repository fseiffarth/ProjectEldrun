/**
 * Pure tests for `lib/projectSearch` — the shared shapes and ranking behind the
 * in-tree project search (`FileTreeSearch`), extracted when the redundant
 * side-panel Search view was folded into the tree's own search box.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_NAME_RESULTS,
  matchParts,
  rankNameMatches,
  type PathEntry,
} from "../lib/projectSearch";

function entries(...paths: string[]): PathEntry[] {
  return paths.map((path) => ({ path, is_dir: false }));
}

describe("matchParts", () => {
  it("splits around a case-insensitive hit by default", () => {
    expect(matchParts("const Reader = 1;", "reader", false)).toEqual({
      before: "const ",
      hit: "Reader",
      after: " = 1;",
    });
  });

  it("honours case sensitivity", () => {
    expect(matchParts("const Reader = 1;", "reader", true)).toBeNull();
    expect(matchParts("const Reader = 1;", "Reader", true)).toEqual({
      before: "const ",
      hit: "Reader",
      after: " = 1;",
    });
  });

  it("returns null for an empty query or a miss", () => {
    expect(matchParts("anything", "", false)).toBeNull();
    expect(matchParts("anything", "zebra", false)).toBeNull();
  });

  it("marks the first occurrence only", () => {
    const parts = matchParts("ab ab", "ab", false);
    expect(parts).toEqual({ before: "", hit: "ab", after: " ab" });
  });
});

describe("rankNameMatches", () => {
  it("ranks basename prefix > basename substring > ancestor-only hit", () => {
    const paths = entries(
      "docs/readme-notes/other.txt", // "readme" only in an ancestor folder
      "src/big-readme-helper.ts", // basename substring
      "readme.md", // basename prefix
    );
    expect(rankNameMatches(paths, "readme", "").map((e) => e.path)).toEqual([
      "readme.md",
      "src/big-readme-helper.ts",
      "docs/readme-notes/other.txt",
    ]);
  });

  it("breaks equal ranks by path length, then locale order", () => {
    const paths = entries("bb/readme.md", "a/readme.md", "cc/readme.md");
    expect(rankNameMatches(paths, "readme", "").map((e) => e.path)).toEqual([
      "a/readme.md",
      "bb/readme.md",
      "cc/readme.md",
    ]);
  });

  it("is case-insensitive on both sides", () => {
    const paths = entries("src/ReadMe.MD");
    expect(rankNameMatches(paths, "readme", "")).toHaveLength(1);
  });

  it("confines results to the scope subtree", () => {
    const paths = entries("readme.md", "sub/readme.md", "subx/readme.md");
    expect(rankNameMatches(paths, "readme", "sub").map((e) => e.path)).toEqual([
      "sub/readme.md",
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(rankNameMatches(entries("readme.md"), "", "")).toEqual([]);
  });

  it("caps the result list", () => {
    const many = entries(
      ...Array.from({ length: MAX_NAME_RESULTS + 50 }, (_, i) => `file-${String(i).padStart(4, "0")}.txt`),
    );
    expect(rankNameMatches(many, "file", "")).toHaveLength(MAX_NAME_RESULTS);
    expect(rankNameMatches(many, "file", "", 10)).toHaveLength(10);
  });
});
