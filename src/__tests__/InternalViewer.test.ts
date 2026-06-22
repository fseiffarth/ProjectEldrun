import { describe, it, expect } from "vitest";
import {
  internalViewerFor,
  isDeferredOfficeFile,
  type FileEntry,
} from "../components/files/fileUtils";

function file(name: string, extension: string | null): FileEntry {
  return { name, path: `/p/${name}`, is_dir: false, size: 1, extension, mime: null };
}

describe("internalViewerFor", () => {
  it("maps PDFs to the pdf viewer", () => {
    expect(internalViewerFor(file("doc.pdf", ".pdf"))).toBe("pdf");
  });

  it("maps markdown extensions to the markdown viewer", () => {
    expect(internalViewerFor(file("README.md", ".md"))).toBe("markdown");
    expect(internalViewerFor(file("notes.markdown", ".markdown"))).toBe("markdown");
  });

  it("maps common text/code extensions to the text viewer", () => {
    expect(internalViewerFor(file("main.rs", ".rs"))).toBe("text");
    expect(internalViewerFor(file("data.json", ".json"))).toBe("text");
    expect(internalViewerFor(file("notes.txt", ".txt"))).toBe("text");
  });

  it("maps well-known extensionless filenames to the text viewer", () => {
    expect(internalViewerFor(file("Dockerfile", null))).toBe("text");
    expect(internalViewerFor(file("LICENSE", null))).toBe("text");
  });

  it("maps raster images to the image viewer", () => {
    expect(internalViewerFor(file("photo.png", ".png"))).toBe("image");
    expect(internalViewerFor(file("photo.jpg", ".jpg"))).toBe("image");
    expect(internalViewerFor(file("photo.jpeg", ".jpeg"))).toBe("image");
    expect(internalViewerFor(file("anim.gif", ".gif"))).toBe("image");
  });

  it("keeps SVG as text (editable XML), not image", () => {
    expect(internalViewerFor(file("icon.svg", ".svg"))).toBe("text");
  });

  it("maps .tex to the dedicated LaTeX viewer, but .bib stays text", () => {
    expect(internalViewerFor(file("paper.tex", ".tex"))).toBe("tex");
    expect(internalViewerFor(file("refs.bib", ".bib"))).toBe("text");
  });

  it("returns null for non-viewable binaries and directories", () => {
    expect(internalViewerFor(file("app.bin", ".bin"))).toBeNull();
    expect(internalViewerFor(file("lib.so", ".so"))).toBeNull();
    expect(internalViewerFor({ ...file("src", null), is_dir: true })).toBeNull();
  });

  it("DEFERRED (#51): .odt/.xlsx have no native viewer (open externally)", () => {
    // DECISION B: office/spreadsheet rendering is deferred; these resolve to null
    // so they fall through to the external-app path.
    expect(internalViewerFor(file("report.odt", ".odt"))).toBeNull();
    expect(internalViewerFor(file("data.xlsx", ".xlsx"))).toBeNull();
    expect(internalViewerFor(file("slides.pptx", ".pptx"))).toBeNull();
    // …and they are recognised as deferred office files, not generic binaries.
    expect(isDeferredOfficeFile(file("report.odt", ".odt"))).toBe(true);
    expect(isDeferredOfficeFile(file("data.xlsx", ".xlsx"))).toBe(true);
    expect(isDeferredOfficeFile(file("main.rs", ".rs"))).toBe(false);
  });
});
