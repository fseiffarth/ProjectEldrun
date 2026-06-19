import { describe, it, expect } from "vitest";
import { internalViewerFor, type FileEntry } from "../components/files/fileUtils";

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

  it("returns null for non-viewable binaries and directories", () => {
    expect(internalViewerFor(file("app.bin", ".bin"))).toBeNull();
    expect(internalViewerFor(file("lib.so", ".so"))).toBeNull();
    expect(internalViewerFor({ ...file("src", null), is_dir: true })).toBeNull();
  });
});
