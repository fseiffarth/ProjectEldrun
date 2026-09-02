/**
 * Tests for the LaTeX viewer's cross-file reference following (Ctrl/Cmd+Click an
 * `\input{…}` etc. to open the referenced file in a new tab):
 *  - findTexRefAt locates the reference the caret sits on and picks the right
 *    comma-separated token.
 *  - resolveTexRef applies the per-command default extension, resolves relative
 *    paths (including `..`) against the .tex file, and maps to a built-in viewer.
 *  - resolveTexRefAsync probes the directory for a bare \includegraphics.
 *  - texRefCreation / texPathExists / createTexRefFile: the offer to create a
 *    referenced file that isn't there yet (#tex-create-ref), including the
 *    re-check that keeps the create from overwriting a file that was there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  findTexRefAt,
  resolveTexRef,
  resolveTexRefAsync,
  texRefRanges,
  texRefCreation,
  texPathExists,
  createTexRefFile,
  insertTexInputLine,
  addTexChildFile,
} from "../lib/viewers/tex";

const MAIN = "/home/u/proj/paper.tex";

describe("findTexRefAt", () => {
  it("finds an \\input under the caret and returns its token", () => {
    const src = "intro\n\\input{chapters/intro}\nmore";
    const caret = src.indexOf("chapters");
    expect(findTexRefAt(src, caret)).toEqual({ command: "input", token: "chapters/intro" });
  });

  it("treats a click anywhere on the command (e.g. the backslash) as on the ref", () => {
    const src = "\\include{body}";
    expect(findTexRefAt(src, 0)).toEqual({ command: "include", token: "body" });
  });

  it("returns null when the caret is outside any reference", () => {
    const src = "plain \\input{a.tex} text";
    expect(findTexRefAt(src, src.length - 1)).toBeNull();
  });

  it("ignores a commented-out \\input (a % line is not a link to follow)", () => {
    const src = "% \\input{chapters/old}\n\\input{chapters/intro}\n";
    // Caret on the commented reference resolves to nothing…
    expect(findTexRefAt(src, src.indexOf("chapters/old"))).toBeNull();
    // …while the live one below it is still found at its real offset.
    expect(findTexRefAt(src, src.indexOf("chapters/intro"))).toEqual({
      command: "input",
      token: "chapters/intro",
    });
  });

  it("still follows an \\input after an escaped \\% on the same line", () => {
    const src = "50\\% done \\input{body}";
    expect(findTexRefAt(src, src.indexOf("body"))).toEqual({ command: "input", token: "body" });
  });

  it("skips an optional bracket group (\\includegraphics[width=...]{fig})", () => {
    const src = "\\includegraphics[width=0.5\\textwidth]{figs/plot}";
    const caret = src.indexOf("plot");
    expect(findTexRefAt(src, caret)).toEqual({ command: "includegraphics", token: "figs/plot" });
  });

  it("picks the comma-separated token under the caret (\\bibliography{a,b})", () => {
    const src = "\\bibliography{refs,extra}";
    const onExtra = src.indexOf("extra") + 1;
    expect(findTexRefAt(src, onExtra)).toEqual({ command: "bibliography", token: "extra" });
    const onRefs = src.indexOf("refs") + 1;
    expect(findTexRefAt(src, onRefs)).toEqual({ command: "bibliography", token: "refs" });
  });
});

describe("texRefRanges (#49 clickable-link decoration)", () => {
  it("returns the argument range of an \\input so it can be underlined", () => {
    const src = "before \\input{chapters/intro} after";
    const ranges = texRefRanges(src);
    expect(ranges).toHaveLength(1);
    const { start, end } = ranges[0];
    expect(src.slice(start, end)).toBe("chapters/intro");
  });

  it("emits one range per comma-separated token (\\bibliography{a,b})", () => {
    const src = "\\bibliography{refs, extra}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["refs", "extra"]);
  });

  it("skips the optional bracket group of \\includegraphics", () => {
    const src = "\\includegraphics[width=0.5\\textwidth]{figs/plot}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["figs/plot"]);
  });

  it("finds multiple references across the document", () => {
    const src = "\\input{a}\ntext\n\\include{b}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["a", "b"]);
  });

  it("returns nothing for source with no references", () => {
    expect(texRefRanges("just \\section{Title} text")).toEqual([]);
  });

  it("does not underline a commented-out reference", () => {
    const src = "% \\input{old}\n\\input{live}\n";
    const ranges = texRefRanges(src);
    // Only the live \input is decorated, and at its real source offset.
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["live"]);
  });
});

describe("resolveTexRef", () => {
  it("appends .tex for \\input and resolves relative to the file", () => {
    expect(resolveTexRef(MAIN, { command: "input", token: "chapters/intro" })).toEqual({
      path: "/home/u/proj/chapters/intro.tex",
      viewer: "tex",
      label: "intro.tex",
    });
  });

  it("keeps an explicit extension and picks the matching viewer", () => {
    expect(resolveTexRef(MAIN, { command: "includegraphics", token: "figs/plot.png" })).toEqual({
      path: "/home/u/proj/figs/plot.png",
      viewer: "image",
      label: "plot.png",
    });
  });

  it("appends .bib for \\bibliography and opens it in the bibliography card view", () => {
    expect(resolveTexRef(MAIN, { command: "bibliography", token: "refs" })).toEqual({
      path: "/home/u/proj/refs.bib",
      viewer: "bib",
      label: "refs.bib",
    });
  });

  it("collapses .. segments", () => {
    expect(resolveTexRef(MAIN, { command: "input", token: "../shared/defs" })?.path).toBe(
      "/home/u/shared/defs.tex",
    );
  });

  it("returns null for a bare \\includegraphics (extension unknown without probing)", () => {
    expect(resolveTexRef(MAIN, { command: "includegraphics", token: "figs/plot" })).toBeNull();
  });

  it("resolves a token against a native Windows .tex path, joining with backslashes", () => {
    const win = "C:\\Users\\u\\proj\\paper.tex";
    expect(resolveTexRef(win, { command: "input", token: "chapters/intro" })).toEqual({
      path: "C:\\Users\\u\\proj\\chapters\\intro.tex",
      viewer: "tex",
      label: "intro.tex",
    });
    // `..` segments collapse against the Windows directory too.
    expect(resolveTexRef(win, { command: "input", token: "../shared/defs" })?.path).toBe(
      "C:\\Users\\u\\shared\\defs.tex",
    );
  });
});

describe("resolveTexRefAsync (\\includegraphics directory probe)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the target directory and picks the stem match by extension preference", async () => {
    mockInvoke.mockResolvedValueOnce([
      { name: "plot.tex", path: "/home/u/proj/figs/plot.tex", is_dir: false, size: 0, extension: ".tex", mime: null },
      { name: "plot.png", path: "/home/u/proj/figs/plot.png", is_dir: false, size: 0, extension: ".png", mime: null },
      { name: "plot.pdf", path: "/home/u/proj/figs/plot.pdf", is_dir: false, size: 0, extension: ".pdf", mime: null },
    ]);

    const res = await resolveTexRefAsync(MAIN, { command: "includegraphics", token: "figs/plot" });
    // .pdf outranks .png in the graphics preference order; the .tex is ignored.
    expect(res).toEqual({ path: "/home/u/proj/figs/plot.pdf", viewer: "pdf", label: "plot.pdf" });
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { projectDir: "/home/u/proj/figs", relPath: "" });
  });

  it("returns null when no graphics file shares the stem", async () => {
    mockInvoke.mockResolvedValueOnce([
      { name: "other.png", path: "/home/u/proj/other.png", is_dir: false, size: 0, extension: ".png", mime: null },
    ]);
    expect(await resolveTexRefAsync(MAIN, { command: "includegraphics", token: "plot" })).toBeNull();
  });

  it("does not probe for commands with a deterministic extension", async () => {
    const res = await resolveTexRefAsync(MAIN, { command: "input", token: "intro" });
    expect(res?.path).toBe("/home/u/proj/intro.tex");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("texRefCreation (#tex-create-ref — what a missing reference would create)", () => {
  it("offers the .tex an \\input names, with the folder it needs", () => {
    expect(texRefCreation(MAIN, { command: "input", token: "chapters/intro" })).toEqual({
      path: "/home/u/proj/chapters/intro.tex",
      label: "intro.tex",
      viewer: "tex",
      rel: "chapters/intro.tex",
      folder: { dir: "/home/u/proj", rel: "chapters" },
    });
  });

  it("names no folder for a sibling reference", () => {
    expect(texRefCreation(MAIN, { command: "input", token: "intro" })?.folder).toBeNull();
  });

  it("offers the .bib a \\bibliography names", () => {
    const c = texRefCreation(MAIN, { command: "bibliography", token: "refs" });
    expect(c?.path).toBe("/home/u/proj/refs.bib");
    expect(c?.viewer).toBe("bib");
  });

  it("keeps an explicit extension that matches the command's own", () => {
    expect(texRefCreation(MAIN, { command: "input", token: "intro.tex" })?.rel).toBe("intro.tex");
  });

  it("declines a \\includegraphics — there is no format to invent", () => {
    expect(texRefCreation(MAIN, { command: "includegraphics", token: "figs/plot" })).toBeNull();
    expect(texRefCreation(MAIN, { command: "includegraphics", token: "figs/plot.png" })).toBeNull();
  });

  it("declines an extension the command never assumes (a mistake, not a new file)", () => {
    expect(texRefCreation(MAIN, { command: "input", token: "fig.png" })).toBeNull();
  });

  it("declines an absolute token (outside the document's own folder)", () => {
    expect(texRefCreation(MAIN, { command: "input", token: "/elsewhere/intro" })).toBeNull();
  });

  it("creates no folder for a reference that climbs out of the document's folder", () => {
    const c = texRefCreation(MAIN, { command: "input", token: "../shared/defs" });
    expect(c?.path).toBe("/home/u/shared/defs.tex");
    expect(c?.folder).toBeNull();
  });
});

describe("texPathExists / createTexRefFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stats the path through the scope-confined file_mtime (so a remote project answers too)", async () => {
    mockInvoke.mockResolvedValueOnce(1_700_000_000);
    expect(await texPathExists("/home/u/proj/intro.tex", "proj")).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("file_mtime", {
      path: "/home/u/proj/intro.tex",
      projectId: "proj",
    });
  });

  it("reads a stat that does not answer as absent", async () => {
    mockInvoke.mockRejectedValueOnce("No such file or directory");
    expect(await texPathExists("/home/u/proj/intro.tex", "proj")).toBe(false);
  });

  it("creates an empty file beside the document", async () => {
    mockInvoke.mockRejectedValueOnce("missing"); // the re-check
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_bytes
    const creation = texRefCreation(MAIN, { command: "input", token: "intro" })!;
    expect(await createTexRefFile(creation, "proj")).toBe(true);
    expect(mockInvoke.mock.calls[1][0]).toBe("write_file_bytes");
    expect(mockInvoke.mock.calls[1][1]).toEqual(new Uint8Array());
  });

  it("creates the folder first when the reference named one that isn't there", async () => {
    mockInvoke.mockRejectedValueOnce("missing"); // the file
    mockInvoke.mockRejectedValueOnce("missing"); // its folder
    mockInvoke.mockResolvedValueOnce(undefined); // create_dir
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_bytes
    const creation = texRefCreation(MAIN, { command: "input", token: "chapters/intro" })!;
    await createTexRefFile(creation, "proj");
    expect(mockInvoke.mock.calls[2]).toEqual([
      "create_dir",
      { projectDir: "/home/u/proj", relPath: "chapters" },
    ]);
    expect(mockInvoke.mock.calls[3][0]).toBe("write_file_bytes");
  });

  it("leaves an existing folder alone", async () => {
    mockInvoke.mockRejectedValueOnce("missing"); // the file
    mockInvoke.mockResolvedValueOnce(1_700_000_000); // its folder is there
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_bytes
    const creation = texRefCreation(MAIN, { command: "input", token: "chapters/intro" })!;
    await createTexRefFile(creation, "proj");
    expect(mockInvoke.mock.calls.map((c) => c[0])).toEqual([
      "file_mtime",
      "file_mtime",
      "write_file_bytes",
    ]);
  });

  it("writes nothing when the file turned out to be there (the write overwrites)", async () => {
    mockInvoke.mockResolvedValueOnce(1_700_000_000);
    const creation = texRefCreation(MAIN, { command: "input", token: "intro" })!;
    expect(await createTexRefFile(creation, "proj")).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("insertTexInputLine (#tex-structure-newfile — where the reference lands)", () => {
  it("inserts directly above \\end{document}", () => {
    const src = "\\begin{document}\nbody\n\\end{document}\n";
    const { text, line } = insertTexInputLine(src, "chapters/intro");
    expect(text).toBe("\\begin{document}\nbody\n\\input{chapters/intro}\n\\end{document}\n");
    expect(line).toBe(3);
  });

  it("ignores a commented-out \\end{document} (it is not the document's end)", () => {
    const src = "body\n% \\end{document}\n";
    expect(insertTexInputLine(src, "a").text).toBe("body\n% \\end{document}\n\\input{a}\n");
  });

  it("appends to a fragment with no \\end{document}, adding the missing newline", () => {
    expect(insertTexInputLine("line one", "a")).toEqual({ text: "line one\n\\input{a}\n", line: 2 });
  });

  it("handles an empty parent", () => {
    expect(insertTexInputLine("", "a")).toEqual({ text: "\\input{a}\n", line: 1 });
  });
});

describe("addTexChildFile (#tex-structure-newfile — the sidebar's ＋)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the file and splices an \\input above \\end{document}", async () => {
    mockInvoke.mockRejectedValueOnce("missing"); // the child's stat
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_bytes (create)
    mockInvoke.mockResolvedValueOnce("\\begin{document}\nHi\n\\end{document}\n"); // parent read
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_text (splice)
    const res = await addTexChildFile(MAIN, "intro", "proj");
    expect(res).toMatchObject({ path: "/home/u/proj/intro.tex", created: true, inserted: true });
    expect(mockInvoke.mock.calls[3][0]).toBe("write_file_text");
    expect(mockInvoke.mock.calls[3][1]).toEqual({
      path: MAIN,
      content: "\\begin{document}\nHi\n\\input{intro}\n\\end{document}\n",
      projectId: "proj",
    });
  });

  it("adopts an already-referenced existing file without writing anything", async () => {
    mockInvoke.mockResolvedValueOnce(1); // the child exists
    mockInvoke.mockResolvedValueOnce("\\input{intro}\nbody\n"); // parent read
    const res = await addTexChildFile(MAIN, "intro", "proj");
    expect(res).toMatchObject({ created: false, inserted: false });
    expect(mockInvoke.mock.calls.map((c) => c[0])).toEqual(["file_mtime", "read_file_text"]);
  });

  it("matches an existing reference however the token was spelled (intro.tex ≡ intro)", async () => {
    mockInvoke.mockResolvedValueOnce(1); // the child exists
    mockInvoke.mockResolvedValueOnce("\\include{intro.tex}\n"); // spelled differently
    const res = await addTexChildFile(MAIN, "intro", "proj");
    expect(res).toMatchObject({ created: false, inserted: false });
  });

  it("still inserts the reference when the file existed but was unreferenced", async () => {
    mockInvoke.mockResolvedValueOnce(1); // the child exists
    mockInvoke.mockResolvedValueOnce("body\n"); // no reference yet
    mockInvoke.mockResolvedValueOnce(undefined); // write_file_text
    const res = await addTexChildFile(MAIN, "intro", "proj");
    expect(res).toMatchObject({ created: false, inserted: true });
    expect(mockInvoke.mock.calls[2][0]).toBe("write_file_text");
  });

  it("returns null for a token \\input could not honestly create, touching nothing", async () => {
    expect(await addTexChildFile(MAIN, "/elsewhere/intro", "proj")).toBeNull();
    expect(await addTexChildFile(MAIN, "fig.png", "proj")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
