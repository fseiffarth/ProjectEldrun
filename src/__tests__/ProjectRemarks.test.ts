import { describe, expect, it } from "vitest";
import {
  REMARKS_TEMPLATE, addRemark, editRemarkText, formatRemarkBullet, parseRemarks,
  remarkCountsByFile, removeRemark, resolveRemarkAbsPath, setRemarkDone,
} from "../lib/projectRemarks";
import { isLocalHref, splitLineHint } from "../lib/viewers/markdown";

const SPEC = `# Remarks\n\n## src/foo.ts\n\n- [ ] [src/foo.ts:123](./src/foo.ts:123) — Why is this cast safe?\n  More context.\n- [x] [src/foo.ts](./src/foo.ts) — Rename this module.\n`;

describe("project remarks", () => {
  it("parses the documented format and counts only open valid remarks", () => {
    const remarks = parseRemarks(SPEC);
    expect(remarks.map(({ file, line, text, done }) => ({ file, line, text, done }))).toEqual([
      { file: "src/foo.ts", line: 123, text: "Why is this cast safe?\nMore context.", done: false },
      { file: "src/foo.ts", line: null, text: "Rename this module.", done: true },
    ]);
    expect(remarkCountsByFile(remarks)).toEqual({ "src/foo.ts": 1 });
  });

  it("parks nonconforming prose and bullets and leaves a no-op byte-identical", () => {
    const src = "preamble\r\n* [ ] [x](./x) — parked\r\n" + SPEC.replace(/\n/g, "\r\n");
    const remark = parseRemarks(src)[0];
    expect(setRemarkDone(src, remark, false)).toBe(src);
    const edited = editRemarkText(src, remark, "Changed");
    expect(edited).toContain("preamble\r\n* [ ] [x](./x) — parked\r\n");
    expect(edited).toContain(" — Changed\r\n");
  });

  it("adds below existing and new headings, preserving unrelated bytes", () => {
    const existing = addRemark(SPEC + "## other\nkeep\n", "src/foo.ts", 9, "New\nline");
    expect(existing.indexOf("src/foo.ts:9")).toBeLessThan(existing.indexOf("## other"));
    expect(existing).toContain("  line");
    const fresh = addRemark(REMARKS_TEMPLATE, "docs/a b.md", null, "Read me");
    expect(fresh).toContain("## docs/a b.md");
    expect(fresh).toContain("(./docs/a%20b.md)");
  });

  it("handles column hints, encoded paths, traversal, removal, and formatting controls", () => {
    const src = "- [ ] [a](./docs/a%20b.md:12:5) - Hi\u202e\n- [ ] [bad](./../outside:2) — no\n";
    const [ok, bad] = parseRemarks(src);
    expect(ok).toMatchObject({ file: "docs/a b.md", line: 12, text: "Hi", invalidPath: false });
    expect(bad.invalidPath).toBe(true);
    expect(removeRemark(src, ok)).not.toContain("a%20b");
    expect(formatRemarkBullet("x.ts", 2, "a\u202eb")).toContain(" — ab");
    expect(resolveRemarkAbsPath("/project", "../outside")).toBeNull();
    expect(resolveRemarkAbsPath("/project", "src/x.ts")).toBe("/project/src/x.ts");
  });
});

describe("markdown line hints", () => {
  it("recognises local line links without confusing drives", () => {
    expect(isLocalHref("./src/foo.ts:123")).toBe(true);
    expect(splitLineHint("./src/foo.ts:123")).toEqual({ href: "./src/foo.ts", line: 123 });
    expect(splitLineHint("./src/foo.ts:123:5#x")).toEqual({ href: "./src/foo.ts#x", line: 123 });
    expect(splitLineHint("C:\\work\\x.ts")).toEqual({ href: "C:\\work\\x.ts", line: null });
  });
});
