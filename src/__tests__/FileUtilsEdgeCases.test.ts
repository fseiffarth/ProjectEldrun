/**
 * Edge cases for `lib/viewers/fileUtils.ts` beyond the viewer-mapping and
 * selection tests: the relative-path helpers on odd inputs, `visibleEntries`'
 * rule normalisation (trim, case, stray slashes) and precedence (shownPaths
 * beats every hide), the hidden-by-ending bucketing the tree relies on, the
 * sort's directory-first and tie-break rules on unicode names, the single-step
 * opt-out fallback chain, and the structural-equality and age helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disabledViewers,
  fileEntriesEqual,
  fmtModified,
  internalViewerFor,
  isDeckFile,
  isDeferredOfficeFile,
  isHiddenByEnding,
  joinRel,
  parentRel,
  relFromAbs,
  stringMapsEqual,
  visibleEntries,
  type FileEntry,
} from "../lib/viewers/fileUtils";

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  const dot = name.lastIndexOf(".");
  return {
    name,
    path: `/p/${name}`,
    is_dir: false,
    size: 0,
    extension: dot > 0 ? name.slice(dot) : null,
    mime: null,
    ...over,
  };
}

const names = (entries: FileEntry[]) => entries.map((e) => e.name);
const shown = { showHidden: false, showStandardFiles: false };

describe("relative-path helpers", () => {
  it("joinRel skips the separator for an empty base", () => {
    expect(joinRel("", "a")).toBe("a");
    expect(joinRel("a/b", "c")).toBe("a/b/c");
  });

  it("parentRel drops the last segment and normalises stray slashes", () => {
    expect(parentRel("a/b/c")).toBe("a/b");
    expect(parentRel("a")).toBe("");
    expect(parentRel("")).toBe("");
    expect(parentRel("/a//b/")).toBe("a");
  });

  it("relFromAbs is empty for the root itself and for anything outside it", () => {
    expect(relFromAbs("/home/u/proj", "/home/u/proj/src/x.ts")).toBe("src/x.ts");
    expect(relFromAbs("/home/u/proj/", "/home/u/proj/src/x.ts")).toBe("src/x.ts");
    expect(relFromAbs("/home/u/proj", "/home/u/proj")).toBe("");
    expect(relFromAbs("/home/u/proj", "/home/u/other/x.ts")).toBe("");
    // A sibling that merely shares the prefix is outside, not "2/x.ts".
    expect(relFromAbs("/home/u/proj", "/home/u/proj2/x.ts")).toBe("");
  });
});

describe("visibleEntries — rule normalisation and precedence", () => {
  it("trims and case-folds the query", () => {
    const out = visibleEntries([entry("A.ts"), entry("b.ts")], { ...shown, query: " a.T " });
    expect(names(out)).toEqual(["A.ts"]);
  });

  it("trims and case-folds hidden endings, ignoring blank ones", () => {
    const out = visibleEntries([entry("x.log"), entry("y.LOG"), entry("z.txt")], {
      ...shown, hiddenEndings: [" .LOG ", "", "  "],
    });
    expect(names(out)).toEqual(["z.txt"]);
  });

  it("an explicit shownPaths rule beats every kind of hide", () => {
    const entries = [entry("project.json"), entry(".env"), entry("README.md"), entry("x.log"), entry("secret.txt")];
    const out = visibleEntries(entries, {
      ...shown,
      hiddenEndings: [".log"],
      hiddenPaths: ["secret.txt"],
      shownPaths: ["project.json", "/.ENV/", "readme.md", "X.LOG", "Secret.txt"],
    });
    expect(names(out)).toEqual(["project.json", "README.md", "secret.txt", "x.log", ".env"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("without the override, internal files, dotfiles and standard files are hidden", () => {
    const entries = [entry("project.json"), entry(".env"), entry("README.md"), entry("main.rs")];
    expect(names(visibleEntries(entries, shown))).toEqual(["main.rs"]);
    expect(names(visibleEntries(entries, { showHidden: true, showStandardFiles: true }))).toEqual([".env", "main.rs", "README.md"]);
  });

  it("hiddenPaths match the folder-relative path, whatever the slashes and case", () => {
    const out = visibleEntries([entry("Main.ts"), entry("other.ts")], {
      ...shown, relPath: "/src/", hiddenPaths: ["/SRC/main.TS/"],
    });
    expect(names(out)).toEqual(["other.ts"]);
    // The same rule does not hide a same-named file in another folder.
    expect(names(visibleEntries([entry("Main.ts")], { ...shown, relPath: "lib", hiddenPaths: ["src/main.ts"] }))).toEqual(["Main.ts"]);
  });

  it("keepHiddenEndings keeps the entries and isHiddenByEnding buckets them back out", () => {
    const entries = [entry("x.log"), entry("y.txt"), entry("keep.log")];
    const out = visibleEntries(entries, { ...shown, hiddenEndings: [".log"], keepHiddenEndings: true });
    expect(names(out)).toEqual(["keep.log", "x.log", "y.txt"]);
    expect(isHiddenByEnding(entry("x.log"), [" .LOG "], "/src/", [])).toBe(true);
    expect(isHiddenByEnding(entry("keep.log"), [".log"], "src", ["/SRC/keep.log"])).toBe(false);
    expect(isHiddenByEnding(entry("y.txt"), [".log"], "", [])).toBe(false);
    expect(isHiddenByEnding(entry("x.log"), ["", " "], "", [])).toBe(false);
  });

  it("returns nothing for nothing", () => {
    expect(visibleEntries([], shown)).toEqual([]);
  });
});

describe("visibleEntries — ordering", () => {
  it("keeps directories first even when descending", () => {
    const entries = [entry("a.ts"), entry("b", { is_dir: true }), entry("c.ts")];
    expect(names(visibleEntries(entries, { ...shown, descending: true }))).toEqual(["b", "c.ts", "a.ts"]);
  });

  it("breaks a size tie by name, and descending flips the tie-break too", () => {
    const entries = [entry("b.ts", { size: 5 }), entry("a.ts", { size: 5 }), entry("c.ts", { size: 1 })];
    expect(names(visibleEntries(entries, { ...shown, sortKey: "size" }))).toEqual(["c.ts", "a.ts", "b.ts"]);
    expect(names(visibleEntries(entries, { ...shown, sortKey: "size", descending: true }))).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("orders unicode names by locale, not code point", () => {
    const entries = [entry("b.md"), entry("ä.md"), entry("a.md"), entry("Z.md")];
    expect(names(visibleEntries(entries, shown))).toEqual(["a.md", "ä.md", "b.md", "Z.md"]);
  });

  it("treats a missing timestamp as zero when sorting by modified", () => {
    const entries = [entry("new.ts", { modified_secs: 10 }), entry("none.ts"), entry("old.ts", { modified_secs: 5 })];
    expect(names(visibleEntries(entries, { ...shown, sortKey: "modified" }))).toEqual(["none.ts", "old.ts", "new.ts"]);
  });
});

describe("viewer mapping at the edges", () => {
  it("is case-insensitive on the extension and never maps a directory", () => {
    expect(internalViewerFor(entry("A.PDF", { extension: ".PDF" }))).toBe("pdf");
    expect(internalViewerFor(entry("x.pdf", { is_dir: true }))).toBeNull();
    expect(internalViewerFor(entry("Makefile"))).toBe("text");
    expect(internalViewerFor(entry("MAKEFILE"))).toBe("text");
  });

  it("the opt-out fallback is a single step, never a chain", () => {
    expect(internalViewerFor(entry("a.gif"), new Set(["gif"]))).toBe("image");
    expect(internalViewerFor(entry("a.gif"), new Set(["gif", "image"]))).toBeNull();
    expect(internalViewerFor(entry("t.eldeck.json"), new Set(["eldeck"]))).toBe("yaml");
    // yaml would fall back to text, but the deck's fallback stops at yaml.
    expect(internalViewerFor(entry("t.eldeck.json"), new Set(["eldeck", "yaml"]))).toBeNull();
    expect(internalViewerFor(entry("r.bib"), new Set(["bib", "text"]))).toBeNull();
  });

  it("a deck needs a stem, matches any case, and must END with the suffix", () => {
    expect(isDeckFile(".eldeck.json")).toBe(false);
    expect(isDeckFile("Talk.ELDECK.JSON")).toBe(true);
    expect(isDeckFile("dir/talk.eldeck.json")).toBe(true);
    expect(isDeckFile("talk.eldeck.json.bak")).toBe(false);
    expect(isDeckFile("")).toBe(false);
  });

  it("deferred office types are recognised whatever the case; unknown prefs are ignored", () => {
    expect(isDeferredOfficeFile(entry("a.DOCX", { extension: ".DOCX" }))).toBe(true);
    expect(isDeferredOfficeFile(entry("a.odt"))).toBe(false);
    expect([...disabledViewers({ nosuch: { enabled: false }, pdf: {}, gif: { enabled: false } })]).toEqual(["gif"]);
    expect(disabledViewers(undefined).size).toBe(0);
  });
});

describe("structural equality", () => {
  const a = entry("a.ts", { size: 1, modified_secs: 5, mime: "text/plain" });

  it("compares every field, not identity", () => {
    expect(fileEntriesEqual([a], [{ ...a }])).toBe(true);
    expect(fileEntriesEqual([a], [{ ...a, mime: "text/x" }])).toBe(false);
    expect(fileEntriesEqual([a], [{ ...a, modified_secs: 6 }])).toBe(false);
    expect(fileEntriesEqual([a], [a, a])).toBe(false);
    expect(fileEntriesEqual([], [])).toBe(true);
  });

  it("string maps differ on a changed value or a different key of the same count", () => {
    expect(stringMapsEqual({ a: "M" }, { a: "M" })).toBe(true);
    expect(stringMapsEqual({ a: "M" }, { a: "D" })).toBe(false);
    expect(stringMapsEqual({ a: "M" }, { b: "M" })).toBe(false);
    expect(stringMapsEqual({}, {})).toBe(true);
    expect(stringMapsEqual({ a: "M" }, {})).toBe(false);
  });
});

describe("fmtModified", () => {
  afterEach(() => vi.useRealTimers());

  it("is blank for a missing stamp and rounds recent ages the way the tree shows them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
    const now = Date.UTC(2026, 6, 8, 12) / 1000;
    expect(fmtModified(undefined)).toBe("");
    expect(fmtModified(null)).toBe("");
    expect(fmtModified(0)).toBe("");
    expect(fmtModified(now - 30)).toBe("just now");
    expect(fmtModified(now - 60)).toBe("just now");
    expect(fmtModified(now - 5 * 60)).toBe("5 min ago");
    expect(fmtModified(now - 59 * 60)).toBe("59 min ago");
    expect(fmtModified(now - 3 * 3600)).toBe("3 h ago");
    expect(fmtModified(now - 23 * 3600 - 59 * 60)).toBe("23 h ago");
    expect(fmtModified(now - 48 * 3600)).toContain("2026");
  });
});
