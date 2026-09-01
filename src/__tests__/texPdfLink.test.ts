import { describe, it, expect } from "vitest";
import { texPdfPartner } from "../lib/texPdfLink";
import type { TabEntry } from "../stores/tabs";

/** A minimal viewer tab; only the fields the coupling reads are meaningful. */
function viewerTab(key: string, viewer: string, embedPath: string): TabEntry {
  return {
    key,
    label: embedPath.slice(embedPath.lastIndexOf("/") + 1),
    cmd: "",
    cwd: "/p",
    kind: "embed",
    viewer: viewer as TabEntry["viewer"],
    embedPath,
  };
}

describe("texPdfPartner", () => {
  const ws = viewerTab("a", "texworkspace", "/p/paper.tex");
  const pdf = viewerTab("b", "pdf", "/p/paper.pdf");

  it("couples a workspace to the PDF built beside it, both ways", () => {
    expect(texPdfPartner([ws, pdf], ws)).toBe(pdf);
    expect(texPdfPartner([ws, pdf], pdf)).toBe(ws);
  });

  it("couples a standalone .tex editor tab too", () => {
    const tex = viewerTab("c", "tex", "/p/paper.tex");
    expect(texPdfPartner([tex, pdf], pdf)).toBe(tex);
  });

  it("is null when only one half is open", () => {
    expect(texPdfPartner([ws], ws)).toBeNull();
    expect(texPdfPartner([pdf], pdf)).toBeNull();
  });

  it("does not couple across directories or stems", () => {
    const other = viewerTab("d", "pdf", "/p/sub/paper.pdf");
    const notes = viewerTab("e", "pdf", "/p/notes.pdf");
    expect(texPdfPartner([ws, other, notes], ws)).toBeNull();
  });

  it("ignores non-viewer tabs and other viewers", () => {
    const shell = { ...viewerTab("f", "pdf", "/p/paper.pdf"), kind: "shell" as const };
    const md = viewerTab("g", "markdown", "/p/paper.tex");
    expect(texPdfPartner([ws, shell], ws)).toBeNull();
    expect(texPdfPartner([md, pdf], pdf)).toBeNull();
  });

  it("matches case-insensitively, so Paper.tex pairs with paper.pdf", () => {
    const upper = viewerTab("h", "texworkspace", "/p/Paper.tex");
    expect(texPdfPartner([upper, pdf], pdf)).toBe(upper);
  });

  it("never returns the tab itself", () => {
    expect(texPdfPartner([ws], ws)).toBeNull();
  });
});
