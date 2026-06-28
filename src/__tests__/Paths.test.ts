import { describe, it, expect } from "vitest";
import {
  basename,
  dirname,
  isAbsolute,
  normalizePath,
  resolvePath,
  toFileUri,
  fromFileUri,
} from "../lib/paths";

// The helpers must accept BOTH separator styles: absolute paths reach the UI with
// native separators (backslashes + drive letter on Windows), while backend "rel"
// paths are always forward-slash. These cases pin both, so the same component code
// is correct on Windows and Unix — the bug behind blank SVG/PNG in the markdown
// viewer on Windows.

describe("basename", () => {
  it("handles POSIX and Windows absolute paths", () => {
    expect(basename("/home/u/pics/cat.png")).toBe("cat.png");
    expect(basename("C:\\Users\\u\\pics\\cat.png")).toBe("cat.png");
    expect(basename("C:/Users/u/pics/cat.png")).toBe("cat.png");
  });
  it("handles forward-slash rel paths unchanged", () => {
    expect(basename("docs/img/logo.svg")).toBe("logo.svg");
  });
  it("ignores trailing separators and bare roots", () => {
    expect(basename("/home/u/dir/")).toBe("dir");
    expect(basename("C:\\")).toBe("");
    expect(basename("/")).toBe("");
  });
});

describe("dirname", () => {
  it("returns the containing directory in the input's style", () => {
    expect(dirname("/home/u/readme.md")).toBe("/home/u");
    expect(dirname("C:\\Users\\u\\readme.md")).toBe("C:\\Users\\u");
  });
  it("preserves the root", () => {
    expect(dirname("/a")).toBe("/");
    expect(dirname("C:\\a")).toBe("C:\\");
  });
});

describe("isAbsolute", () => {
  it("recognises POSIX, Windows drive, and UNC paths", () => {
    expect(isAbsolute("/home/u")).toBe(true);
    expect(isAbsolute("C:\\Users")).toBe(true);
    expect(isAbsolute("C:/Users")).toBe(true);
    expect(isAbsolute("\\\\server\\share")).toBe(true);
    expect(isAbsolute("docs/img.png")).toBe(false);
    expect(isAbsolute("img.png")).toBe(false);
  });
});

describe("normalizePath", () => {
  it("resolves . and .. preserving root and style", () => {
    expect(normalizePath("/home/u/../v/./x")).toBe("/home/v/x");
    expect(normalizePath("C:\\Users\\u\\..\\v\\.\\x")).toBe("C:\\Users\\v\\x");
  });
});

describe("resolvePath", () => {
  it("joins a relative target onto a directory, per OS", () => {
    expect(resolvePath("/home/u/docs", "img/p.png")).toBe("/home/u/docs/img/p.png");
    expect(resolvePath("C:\\Users\\u\\docs", "img/p.png")).toBe(
      "C:\\Users\\u\\docs\\img\\p.png",
    );
  });
  it("returns an absolute target as-is (normalised)", () => {
    expect(resolvePath("/anywhere", "/etc/host")).toBe("/etc/host");
    expect(resolvePath("C:\\anywhere", "D:\\data\\x.png")).toBe("D:\\data\\x.png");
  });
});

describe("toFileUri / fromFileUri round-trip", () => {
  it("encodes POSIX paths", () => {
    expect(toFileUri("/home/u/my pics/a b.png")).toBe(
      "file:///home/u/my%20pics/a%20b.png",
    );
  });
  it("encodes Windows drive paths with the extra slash", () => {
    expect(toFileUri("C:\\Users\\u\\a b.png")).toBe("file:///C:/Users/u/a%20b.png");
  });
  it("decodes back, stripping the Windows leading slash", () => {
    expect(fromFileUri("file:///home/u/a%20b.png")).toBe("/home/u/a b.png");
    expect(fromFileUri("file:///C:/Users/u/a%20b.png")).toBe("C:/Users/u/a b.png");
    expect(fromFileUri("https://example.com")).toBeNull();
  });
});
