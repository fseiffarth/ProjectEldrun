import { describe, it, expect } from "vitest";
import { buildTree, type FileChange } from "../components/files/GitChangeTree";

const c = (path: string, added: number, deleted: number, binary = false): FileChange => ({
  path,
  added,
  deleted,
  binary,
});

describe("buildTree", () => {
  it("nests files under their folders", () => {
    const root = buildTree([c("src/a.ts", 1, 0), c("src/sub/b.ts", 2, 0), c("top.ts", 5, 0)]);
    const names = root.children.map((n) => n.name);
    // Folders sort before files.
    expect(names).toEqual(["src", "top.ts"]);
    const src = root.children.find((n) => n.name === "src")!;
    expect(src.isDir).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["sub", "a.ts"]);
  });

  it("aggregates +/- line stats up into directories", () => {
    const root = buildTree([c("src/a.ts", 10, 3), c("src/sub/b.ts", 4, 1)]);
    const src = root.children.find((n) => n.name === "src")!;
    expect(src.added).toBe(14);
    expect(src.deleted).toBe(4);
  });

  it("marks a directory binary only when every file under it is binary", () => {
    const allBin = buildTree([c("a/x.png", 0, 0, true), c("a/y.jpg", 0, 0, true)]);
    expect(allBin.children[0].binary).toBe(true);

    const mixed = buildTree([c("a/x.png", 0, 0, true), c("a/y.ts", 3, 0, false)]);
    expect(mixed.children[0].binary).toBe(false);
  });
});
