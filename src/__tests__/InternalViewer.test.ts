import { describe, it, expect } from "vitest";
import {
  internalViewerFor,
  disabledViewers,
  isDeferredOfficeFile,
  type FileEntry,
} from "../lib/viewers/fileUtils";

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

  it("maps .html/.htm/.svg to the rendered-preview viewer (wins over text)", () => {
    expect(internalViewerFor(file("page.html", ".html"))).toBe("html");
    expect(internalViewerFor(file("page.htm", ".htm"))).toBe("html");
    expect(internalViewerFor(file("icon.svg", ".svg"))).toBe("html");
    // Opting the viewer out (#48) falls through (SVG XML stays openable
    // externally rather than as the in-app preview).
    expect(internalViewerFor(file("icon.svg", ".svg"), new Set(["html"]))).toBeNull();
  });

  it("maps audio/video to the media player", () => {
    expect(internalViewerFor(file("song.mp3", ".mp3"))).toBe("media");
    expect(internalViewerFor(file("clip.mp4", ".mp4"))).toBe("media");
    expect(internalViewerFor(file("clip.webm", ".webm"))).toBe("media");
  });

  it("maps SQLite databases to the sqlite browser", () => {
    expect(internalViewerFor(file("app.db", ".db"))).toBe("sqlite");
    expect(internalViewerFor(file("app.sqlite", ".sqlite"))).toBe("sqlite");
    expect(internalViewerFor(file("app.sqlite3", ".sqlite3"))).toBe("sqlite");
  });

  it("maps spreadsheets to the table viewer (no longer deferred)", () => {
    expect(internalViewerFor(file("book.xlsx", ".xlsx"))).toBe("table");
    expect(internalViewerFor(file("book.xls", ".xls"))).toBe("table");
  });

  it("maps .tex to the dedicated LaTeX viewer, but .bib stays text", () => {
    expect(internalViewerFor(file("paper.tex", ".tex"))).toBe("tex");
    expect(internalViewerFor(file("refs.bib", ".bib"))).toBe("text");
  });

  it("maps .csv/.tsv to the table viewer (wins over generic text)", () => {
    expect(internalViewerFor(file("data.csv", ".csv"))).toBe("table");
    expect(internalViewerFor(file("data.tsv", ".tsv"))).toBe("table");
  });

  it("maps .ipynb to the notebook viewer", () => {
    expect(internalViewerFor(file("nb.ipynb", ".ipynb"))).toBe("notebook");
  });

  it("maps .diff/.patch to the diff viewer (wins over generic text)", () => {
    expect(internalViewerFor(file("change.diff", ".diff"))).toBe("diff");
    expect(internalViewerFor(file("change.patch", ".patch"))).toBe("diff");
  });

  it("returns null for non-viewable binaries and directories", () => {
    expect(internalViewerFor(file("app.bin", ".bin"))).toBeNull();
    expect(internalViewerFor(file("lib.so", ".so"))).toBeNull();
    expect(internalViewerFor({ ...file("src", null), is_dir: true })).toBeNull();
  });

  it("maps .odt to the OpenDocument Text viewer (#51 lightweight)", () => {
    expect(internalViewerFor(file("report.odt", ".odt"))).toBe("odt");
    // Opting the viewer out (#48) falls through to the external-app path.
    expect(internalViewerFor(file("report.odt", ".odt"), new Set(["odt"]))).toBeNull();
  });

  it("DEFERRED (#51): remaining word-processing/presentation formats open externally", () => {
    // DECISION B: .docx/.pptx/.ods/.odp rendering is still deferred; these resolve
    // to null so they fall through to the external-app path.
    expect(internalViewerFor(file("doc.docx", ".docx"))).toBeNull();
    expect(internalViewerFor(file("slides.pptx", ".pptx"))).toBeNull();
    expect(internalViewerFor(file("sheet.ods", ".ods"))).toBeNull();
    // …and they are recognised as deferred office files, not generic binaries.
    expect(isDeferredOfficeFile(file("doc.docx", ".docx"))).toBe(true);
    expect(isDeferredOfficeFile(file("sheet.ods", ".ods"))).toBe(true);
    expect(isDeferredOfficeFile(file("main.rs", ".rs"))).toBe(false);
  });
});

describe("internalViewerFor opt-out (#48)", () => {
  it("returns null for a type the user disabled so it opens externally", () => {
    const disabled = new Set(["pdf" as const]);
    expect(internalViewerFor(file("doc.pdf", ".pdf"), disabled)).toBeNull();
    // other types are unaffected by a pdf-only opt-out
    expect(internalViewerFor(file("main.rs", ".rs"), disabled)).toBe("text");
  });

  it("renders normally when the disabled set is empty or omitted", () => {
    expect(internalViewerFor(file("doc.pdf", ".pdf"), new Set())).toBe("pdf");
    expect(internalViewerFor(file("doc.pdf", ".pdf"))).toBe("pdf");
  });
});

describe("disabledViewers (#48)", () => {
  it("treats absent/true prefs as enabled and false as disabled", () => {
    expect(disabledViewers(undefined).size).toBe(0);
    expect(disabledViewers({}).size).toBe(0);
    expect(disabledViewers({ pdf: {} }).size).toBe(0);
    expect(disabledViewers({ pdf: { enabled: true } }).size).toBe(0);
    const off = disabledViewers({ pdf: { enabled: false }, tex: { enabled: false } });
    expect(off.has("pdf")).toBe(true);
    expect(off.has("tex")).toBe(true);
    expect(off.has("text")).toBe(false);
  });

  it("supports opting out the new table/notebook/diff viewers", () => {
    // A disabled type returns null so the file opens externally instead.
    const disabled = disabledViewers({
      table: { enabled: false },
      notebook: { enabled: false },
      diff: { enabled: false },
    });
    expect(disabled.has("table")).toBe(true);
    expect(disabled.has("notebook")).toBe(true);
    expect(disabled.has("diff")).toBe(true);
    expect(internalViewerFor(file("data.csv", ".csv"), disabled)).toBeNull();
    // .ipynb is not in TEXT_EXTS, so opting the notebook viewer out opens it
    // externally rather than falling back to raw text.
    expect(internalViewerFor(file("nb.ipynb", ".ipynb"), disabled)).toBeNull();
    expect(internalViewerFor(file("change.diff", ".diff"), disabled)).toBeNull();
  });
});
