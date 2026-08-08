/**
 * Remarks on a PDF (#pdf-notes) — the pure model, the annotation read, and the thing
 * the whole feature stands or falls on: that a remark is written into the file as the
 * PDF's OWN `/Text` annotation, so every other reader shows it as a comment.
 *
 * The save assertions therefore go through pdf-lib end to end and read the **saved
 * bytes** back, exactly as `PdfSave.test.ts` does — never the object model we built,
 * which would prove only that we can construct a dictionary.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, PDFString } from "pdf-lib";
import { buildPdf, type PdfSources } from "../components/embed/pdf/pdfDoc";
import {
  noteFromAnnotation,
  noteRectInPdfSpace,
  quadsFromAnnotation,
  quadPointsInPdfSpace,
  highlightRectInPdfSpace,
  NOTE_ICON_PT,
} from "../components/embed/pdf/notes";
import { noteAnchorAt, noteCardLeft, clampNoteAnchor } from "../components/embed/pdf/PdfNoteLayer";
import {
  addNote,
  updateNote,
  removeNote,
  isHighlight,
  quadsAnchor,
  quadsBounds,
  noteCount,
  notedSheetCount,
  newNoteId,
  toPdfDate,
  placedNotes,
  noteIndexOf,
  stepNote,
} from "../lib/viewers/pdfNotes";
import {
  SELF,
  initialPages,
  duplicatePages,
  movePages,
  rotatePages,
  isPristine,
  isPristineExceptNotes,
  type PdfNote,
} from "../lib/viewers/pageModel";

const note = (over: Partial<PdfNote> = {}): PdfNote => ({
  id: newNoteId(),
  x: 100,
  y: 50,
  text: "a remark",
  ...over,
});

/** A PDF whose pages have distinct widths, so a page can be identified after a save. */
async function makePdf(widths: number[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 400]);
  return doc;
}

/** Put a sticky note into a source document by hand — what a PDF that arrives with
 *  comments already in it looks like. */
function addRawTextAnnot(doc: PDFDocument, pageIndex: number, contents: string): void {
  const page = doc.getPages()[pageIndex];
  const annot = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 32, 32],
      Contents: PDFHexString.fromText(contents),
      T: PDFHexString.fromText("Someone Else"),
    }),
  );
  page.node.set(PDFName.of("Annots"), doc.context.obj([annot]));
}

/** Add a link annotation, which a remark write must never touch. */
function addRawLinkAnnot(doc: PDFDocument, pageIndex: number): void {
  const page = doc.getPages()[pageIndex];
  const existing = page.node.Annots();
  const link = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 50, 50],
      A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.org/") },
    }),
  );
  const all = existing ? [...existing.asArray(), link] : [link];
  page.node.set(PDFName.of("Annots"), doc.context.obj(all));
}

/** Every `/Text` annotation on a saved page, as `{ text, author, rect }`. */
async function notesOnPage(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<{ text: string; author?: string; rect: number[] }[]> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[pageIndex];
  const annots = page.node.Annots();
  if (!annots) return [];
  const out: { text: string; author?: string; rect: number[] }[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = doc.context.lookupMaybe(annots.get(i), PDFDict);
    if (!dict || dict.get(PDFName.of("Subtype")) !== PDFName.of("Text")) continue;
    const contents = dict.get(PDFName.of("Contents"));
    const title = dict.get(PDFName.of("T"));
    const rect = doc.context.lookupMaybe(dict.get(PDFName.of("Rect")), PDFArray);
    out.push({
      text: contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : "",
      author:
        title instanceof PDFHexString || title instanceof PDFString ? title.decodeText() : undefined,
      rect: rect ? rect.asArray().map((n) => Number(n.toString())) : [],
    });
  }
  return out;
}

/** Every `/Highlight` annotation on a saved page, as what a reader would show. */
async function highlightsOnPage(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<{ text: string; rect: number[]; quads: number[]; hasAppearance: boolean }[]> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[pageIndex];
  const annots = page.node.Annots();
  if (!annots) return [];
  const out: { text: string; rect: number[]; quads: number[]; hasAppearance: boolean }[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = doc.context.lookupMaybe(annots.get(i), PDFDict);
    if (!dict || dict.get(PDFName.of("Subtype")) !== PDFName.of("Highlight")) continue;
    const contents = dict.get(PDFName.of("Contents"));
    const rect = doc.context.lookupMaybe(dict.get(PDFName.of("Rect")), PDFArray);
    const quads = doc.context.lookupMaybe(dict.get(PDFName.of("QuadPoints")), PDFArray);
    const ap = doc.context.lookupMaybe(dict.get(PDFName.of("AP")), PDFDict);
    out.push({
      text:
        contents instanceof PDFHexString || contents instanceof PDFString
          ? contents.decodeText()
          : "",
      rect: rect ? rect.asArray().map((n) => Number(n.toString())) : [],
      quads: quads ? quads.asArray().map((n) => Number(n.toString())) : [],
      hasAppearance: !!ap?.get(PDFName.of("N")),
    });
  }
  return out;
}

/** Put a highlight into a source document by hand — what a PDF that arrives already
 *  marked up (by Zotero, by a colleague, by Acrobat) looks like. */
function addRawHighlightAnnot(doc: PDFDocument, pageIndex: number, contents: string): void {
  const page = doc.getPages()[pageIndex];
  const existing = page.node.Annots();
  const annot = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: [10, 300, 200, 320],
      QuadPoints: [10, 320, 200, 320, 10, 300, 200, 300],
      Contents: PDFHexString.fromText(contents),
    }),
  );
  const all = existing ? [...existing.asArray(), annot] : [annot];
  page.node.set(PDFName.of("Annots"), doc.context.obj(all));
}

/** How many annotations of any kind a saved page carries. */
async function annotCount(bytes: Uint8Array, pageIndex: number): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages()[pageIndex].node.Annots()?.size() ?? 0;
}

const sourcesOf = (entries: Record<string, Uint8Array>): PdfSources =>
  new Map(
    Object.entries(entries).map(([id, bytes]) => [id, { bytes, doc: undefined as never }]),
  );

/** The identity mapping for an upright, unrotated page of height `h` — what the real
 *  pdf.js viewport gives for `rotation: 0`, without needing pdf.js. */
const flatViewport = (h: number) => ({
  convertToPdfPoint: (x: number, y: number) => [x, h - y],
});

describe("the remark model", () => {
  it("adopts the file's own remarks the first time a page is touched", () => {
    const pages = initialPages(2);
    const theirs = [note({ text: "already in the file" })];

    const withMine = addNote(pages, pages[0].id, theirs, note({ text: "mine" }));

    // Both — the page's set is taken over whole, so a save cannot drop what was
    // already in the document.
    expect(withMine[0].notes?.map((n) => n.text)).toEqual(["already in the file", "mine"]);
    // And no other sheet is touched.
    expect(withMine[1].notes).toBeUndefined();
  });

  it("refuses an empty remark", () => {
    const pages = initialPages(1);
    expect(addNote(pages, pages[0].id, [], note({ text: "   " }))).toBe(pages);
  });

  it("edits and deletes, keeping the page owned after the last one goes", () => {
    const pages = initialPages(1);
    const mine = note({ text: "first" });
    const withOne = addNote(pages, pages[0].id, [], mine);

    const edited = updateNote(withOne, pages[0].id, [], mine.id, { text: "second" });
    expect(edited[0].notes?.[0].text).toBe("second");

    const gone = removeNote(edited, pages[0].id, [], mine.id);
    // `[]`, never absent: an emptied page still has to be written out without it.
    expect(gone[0].notes).toEqual([]);
    expect(noteCount(gone)).toBe(0);
    expect(notedSheetCount(gone)).toBe(1);
  });

  it("counts a remarked page as an edit, and undoing it as pristine again", () => {
    const pages = initialPages(1);
    expect(isPristine(pages, 1)).toBe(true);
    expect(isPristine(addNote(pages, pages[0].id, [], note()), 1)).toBe(false);
  });

  it("gives a duplicated sheet its own copy of the remarks", () => {
    const pages = addNote(initialPages(1), initialPages(1)[0].id, [], note());
    const one = addNote(initialPages(1), "", [], note()); // no-op guard, unrelated id
    expect(one[0].notes).toBeUndefined();

    const base = addNote(pages, pages[0].id, [], note({ text: "x" }));
    const twins = duplicatePages(base, [base[0].id]);
    expect(twins).toHaveLength(2);
    expect(twins[1].notes).toEqual(twins[0].notes);
    expect(twins[1].notes).not.toBe(twins[0].notes);
    expect(twins[1].notes?.[0]).not.toBe(twins[0].notes?.[0]);
  });

  it("writes a PDF date the format can be read back from", () => {
    // Local time, offset and all: `D:YYYYMMDDHHmmSS±HH'mm'`.
    expect(toPdfDate(new Date(2026, 0, 15, 10, 30, 0))).toMatch(
      /^D:20260115103000[+-]\d{2}'\d{2}'$/,
    );
  });
});

describe("where a remark and its card go", () => {
  it("puts the marker under the pointer, never outside the page", () => {
    expect(noteAnchorAt(100, 200)).toEqual({ x: 100 - NOTE_ICON_PT / 2, y: 200 - NOTE_ICON_PT / 2 });
    // A right-click in the very corner would otherwise anchor a marker off the sheet.
    expect(noteAnchorAt(2, 3)).toEqual({ x: 0, y: 0 });
  });

  it("keeps a dragged marker on the sheet, icon box and all", () => {
    // Ordinary move: through untouched.
    expect(clampNoteAnchor(120, 60, 600, 800)).toEqual({ x: 120, y: 60 });
    // Past the top-left corner.
    expect(clampNoteAnchor(-40, -5, 600, 800)).toEqual({ x: 0, y: 0 });
    // Past the far edges: clamped by the ICON's box, not by the anchor, so the whole
    // marker stays on the page and its `/Rect` inside the media box.
    expect(clampNoteAnchor(9999, 9999, 600, 800)).toEqual({
      x: 600 - NOTE_ICON_PT,
      y: 800 - NOTE_ICON_PT,
    });
    // A page whose size is not known yet clamps only at the origin — a guess about
    // the far edge would move the remark somewhere nobody dropped it.
    expect(clampNoteAnchor(9999, 9999)).toEqual({ x: 9999, y: 9999 });
  });

  it("opens the card to the left when the right margin has no room for it", () => {
    // Plenty of page to the right: the ordinary side.
    expect(noteCardLeft(100, 1, 600)).toBe(126);
    // A remark in the right margin — where remarks are usually written — flips.
    expect(noteCardLeft(560, 1, 600)).toBeLessThan(560);
    // Never off the left edge either, however narrow the sheet.
    expect(noteCardLeft(10, 1, 100)).toBe(0);
    // With no width known, the plain side stands rather than guessing.
    expect(noteCardLeft(560, 1)).toBe(586);
  });
});

describe("going through the remarks", () => {
  // Two sheets: the first has the file's own remarks (nothing edited), the second has
  // been taken over by the arrangement.
  const build = () => {
    const pages = initialPages(2);
    const mine = note({ text: "mine", x: 50, y: 400 });
    const edited = addNote(pages, pages[1].id, [], mine);
    const theirs = [
      note({ text: "lower", x: 30, y: 300 }),
      note({ text: "upper right", x: 400, y: 100 }),
      note({ text: "upper left", x: 60, y: 104 }),
    ];
    return { pages: edited, theirs, mine };
  };

  it("walks the document in reading order, not in the file's annotation order", () => {
    const { pages, theirs } = build();
    const placed = placedNotes(pages, [theirs, undefined]);

    expect(placed.map((p) => p.note.text)).toEqual([
      // Down the page first…
      "upper left",
      // …then across it: the two top remarks are within a line of each other, so the
      // left one comes first however the producer happened to order the array.
      "upper right",
      "lower",
      // And only then the next sheet.
      "mine",
    ]);
    expect(placed.map((p) => p.sheet)).toEqual([1, 1, 1, 2]);
  });

  it("shows the arrangement's own set for a sheet it has taken over", () => {
    const { pages, theirs, mine } = build();
    // The file's remarks for sheet 2 are handed in as well; the edited set wins, so
    // the panel and the page cannot disagree about what is on a sheet.
    const placed = placedNotes(pages, [theirs, [note({ text: "stale" })]]);
    expect(placed.filter((p) => p.sheet === 2).map((p) => p.note.id)).toEqual([mine.id]);
  });

  it("says nothing about a sheet whose remarks have not been read", () => {
    const pages = initialPages(2);
    expect(placedNotes(pages, [])).toEqual([]);
    expect(placedNotes(pages)).toEqual([]);
  });

  it("addresses each remark by the entry it sits on, so a reorder follows it", () => {
    const { pages, mine } = build();
    const moved = movePages(pages, [pages[1].id], 0);
    const placed = placedNotes(moved, [undefined, undefined]);
    expect(placed).toHaveLength(1);
    expect(placed[0].note.id).toBe(mine.id);
    // The sheet number is the position on screen; the entry id is what an edit is
    // addressed by, and it is the same entry it always was.
    expect(placed[0].sheet).toBe(1);
    expect(placed[0].entryId).toBe(pages[1].id);
  });

  it("steps through the remarks as a ring, from nowhere in particular too", () => {
    const { pages, theirs } = build();
    const placed = placedNotes(pages, [theirs, undefined]);
    const first = placed[0].note.id;
    const last = placed[placed.length - 1].note.id;

    // Nothing selected yet: Next opens on the first, Previous on the last.
    expect(stepNote(placed, null, 1)?.note.id).toBe(first);
    expect(stepNote(placed, null, -1)?.note.id).toBe(last);
    // Off the end and back round — which is how a reader checks they have seen them
    // all rather than falling off a list.
    expect(stepNote(placed, last, 1)?.note.id).toBe(first);
    expect(stepNote(placed, first, -1)?.note.id).toBe(last);
    // An id that is not in the walk (a remark just deleted) is not an error.
    expect(stepNote(placed, "gone", 1)?.note.id).toBe(first);
    expect(stepNote([], null, 1)).toBeNull();

    expect(noteIndexOf(placed, last)).toBe(placed.length - 1);
    expect(noteIndexOf(placed, "gone")).toBe(-1);
    expect(noteIndexOf(placed, null)).toBe(-1);
  });
});

describe("what an autosaved remark may carry along", () => {
  it("writes remarks on their own, and nothing else with them", () => {
    const pages = initialPages(2);
    const remarked = addNote(pages, pages[0].id, [], note());

    // A remark alone: safe to write without asking.
    expect(isPristineExceptNotes(remarked, 2)).toBe(true);
    // …while the ordinary pristine test still calls it an edit, which is what keeps
    // the Save button lit and the dirty marker honest.
    expect(isPristine(remarked, 2)).toBe(false);

    // A page move, a turn, a blackout, a deletion or a merged-in sheet is something
    // else — and a blackout in particular is the one irreversible edit here, so an
    // autosave must never be the thing that commits it.
    expect(isPristineExceptNotes(movePages(remarked, [remarked[1].id], 0), 2)).toBe(false);
    expect(isPristineExceptNotes(rotatePages(remarked, [remarked[0].id]), 2)).toBe(false);
    expect(
      isPristineExceptNotes(
        remarked.map((r, i) => (i === 0 ? { ...r, marks: [{ id: "m", x: 0, y: 0, w: 4, h: 4 }] } : r)),
        2,
      ),
    ).toBe(false);
    expect(isPristineExceptNotes(remarked.slice(0, 1), 2)).toBe(false);
    expect(
      isPristineExceptNotes([...remarked, { ...remarked[0], id: "x", src: "src1" }], 3),
    ).toBe(false);
  });

  it("carries a moved marker, which is a remark edit like any other", () => {
    // Dragging a marker goes through the same `updateNote` a rewritten sentence does,
    // so the sheet adopts its remarks and the arrangement stays writable on its own —
    // the anchor a reader corrected is written without a Save, exactly as the text is.
    const pages = initialPages(2);
    const theirs = [note({ id: "a", x: 10, y: 10 })];
    const moved = updateNote(pages, pages[0].id, theirs, "a", { x: 120, y: 300 });

    expect(moved[0].notes).toEqual([note({ id: "a", x: 120, y: 300 })]);
    expect(isPristineExceptNotes(moved, 2)).toBe(true);
    expect(isPristine(moved, 2)).toBe(false);
  });
});

describe("reading the file's own remarks", () => {
  it("reads a sticky note's text, author, dates and colour", () => {
    const read = noteFromAnnotation(
      {
        subtype: "Text",
        rect: [10, 100, 32, 122],
        contentsObj: { str: "check this" },
        titleObj: { str: "A Reviewer" },
        creationDate: "D:20260101120000Z",
        modificationDate: "D:20260102120000Z",
        name: "Comment",
        color: new Uint8ClampedArray([255, 0, 0]),
      },
      { convertToViewportRectangle: (r) => [r[0], 400 - r[3], r[2], 400 - r[1]] },
    );

    expect(read).toMatchObject({
      x: 10,
      y: 278,
      text: "check this",
      author: "A Reviewer",
      created: "D:20260101120000Z",
      icon: "Comment",
      color: [1, 0, 0],
    });
  });

  it("reads only the two subtypes a remark can be", () => {
    const vp = { convertToViewportRectangle: (r: number[]) => r };
    // A link is the sibling module's business; an underline, a stamp or an ink
    // scribble is the page render's, and a save must not rewrite what it cannot edit.
    expect(noteFromAnnotation({ subtype: "Link", rect: [0, 0, 10, 10] }, vp)).toBeNull();
    expect(noteFromAnnotation({ subtype: "Underline", rect: [0, 0, 10, 10] }, vp)).toBeNull();
    expect(noteFromAnnotation({ subtype: "Text" }, vp)).toBeNull();
    // A highlight with no quads is nothing but the words it covers, so it is not
    // returned at all — a save handed one would write an annotation with no shape.
    expect(noteFromAnnotation({ subtype: "Highlight", rect: [0, 0, 10, 10] }, vp)).toBeNull();
  });

  it("keeps an empty remark, because it is in the file and has to be deletable", () => {
    const vp = { convertToViewportRectangle: (r: number[]) => r };
    expect(noteFromAnnotation({ subtype: "Text", rect: [0, 0, 22, 22] }, vp)?.text).toBe("");
  });

  it("puts the icon box on the right side of the anchor whatever the page's turn", () => {
    // Upright: y flips, x does not.
    expect(noteRectInPdfSpace({ x: 100, y: 50 }, flatViewport(400))).toEqual([
      100,
      350 - NOTE_ICON_PT,
      100 + NOTE_ICON_PT,
      350,
    ]);
    // A quarter turn swaps the axes; the rect still comes back normalised
    // (lower-left, then upper-right) rather than inside out.
    const turned = { convertToPdfPoint: (x: number, y: number) => [y, x] };
    const [x1, y1, x2, y2] = noteRectInPdfSpace({ x: 100, y: 50 }, turned);
    expect(x1).toBeLessThan(x2);
    expect(y1).toBeLessThan(y2);
  });
});

describe("a highlight is a remark over words", () => {
  const quads = [
    { x: 100, y: 40, w: 80, h: 12 },
    { x: 20, y: 56, w: 140, h: 12 },
  ];
  const hl = (over: Partial<PdfNote> = {}): PdfNote => ({
    id: newNoteId(),
    ...quadsAnchor(quads),
    quads,
    text: "",
    ...over,
  });

  it("is told from a sticky note by its quads and nothing else", () => {
    expect(isHighlight(hl())).toBe(true);
    expect(isHighlight(note())).toBe(false);
    // An empty quad list is a highlight covering nothing, which is not one.
    expect(isHighlight({ ...note(), quads: [] })).toBe(false);
  });

  it("anchors at the START of the sentence, not at the first box in the array", () => {
    // The second line is higher up the array but lower on the page; a selection
    // dragged bottom-to-top hands its rects back in either order, so `quads[0]` would
    // put a quarter of all cards at the wrong end of the sentence.
    expect(quadsAnchor(quads)).toEqual({ x: 100, y: 40 });
    expect(quadsAnchor([...quads].reverse())).toEqual({ x: 100, y: 40 });
    // Two boxes on ONE line: leftmost wins, since they are the same sentence.
    expect(quadsAnchor([{ x: 200, y: 40, w: 10, h: 12 }, { x: 100, y: 44, w: 10, h: 12 }]))
      .toEqual({ x: 100, y: 44 });
    expect(quadsBounds(quads)).toEqual({ x: 20, y: 40, w: 160, h: 28 });
    expect(quadsBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("is kept with no remark on it, unlike a sticky note", () => {
    const pages = initialPages(1);
    // Marking a sentence is a complete act; writing about it is the optional half.
    expect(addNote(pages, pages[0].id, [], hl())[0].notes).toHaveLength(1);
    // A sticky note with nothing in it is still refused.
    expect(addNote(pages, pages[0].id, [], note({ text: "  " }))).toBe(pages);
  });

  it("counts as an edit, and rides the same autosave gate remarks do", () => {
    const pages = initialPages(2);
    const marked = addNote(pages, pages[0].id, [], hl());
    expect(isPristine(marked, 2)).toBe(false);
    expect(isPristineExceptNotes(marked, 2)).toBe(true);
  });

  it("gives a duplicated sheet its own quads, not the twin's array", () => {
    const pages = addNote(initialPages(1), initialPages(1)[0].id, [], hl());
    const base = addNote(pages, pages[0].id, [], hl({ text: "x" }));
    const twins = duplicatePages(base, [base[0].id]);
    expect(twins[1].notes?.[0].quads).toEqual(twins[0].notes?.[0].quads);
    expect(twins[1].notes?.[0].quads).not.toBe(twins[0].notes?.[0].quads);
  });
});

describe("reading the file's own highlights", () => {
  // A page 400 tall: pdf.js's viewport flips y and leaves x alone.
  const vp = { convertToViewportRectangle: (r: number[]) => [r[0], 400 - r[3], r[2], 400 - r[1]] };

  it("turns each quad into a box in the sheet's own space", () => {
    // pdf.js normalises the corners to TL, TR, BL, BR before we ever see them.
    const boxes = quadsFromAnnotation(
      new Float32Array([10, 320, 200, 320, 10, 300, 200, 300]),
      vp,
    );
    expect(boxes).toEqual([{ x: 10, y: 80, w: 190, h: 20 }]);
  });

  it("drops a quad with no area, which some producers pad the array with", () => {
    expect(quadsFromAnnotation([10, 300, 10, 300, 10, 300, 10, 300], vp)).toEqual([]);
    // A trailing partial group is ignored rather than read past the end.
    expect(quadsFromAnnotation([10, 320, 200, 320, 10], vp)).toEqual([]);
  });

  it("reads the remark, the colour and the annotation id it must suppress", () => {
    const read = noteFromAnnotation(
      {
        id: "42R",
        subtype: "Highlight",
        rect: [10, 300, 200, 320],
        quadPoints: new Float32Array([10, 320, 200, 320, 10, 300, 200, 300]),
        contentsObj: { str: "but only for i.i.d. samples" },
        color: new Uint8ClampedArray([255, 235, 59]),
      },
      vp,
    );
    expect(read).toMatchObject({
      x: 10,
      y: 80,
      text: "but only for i.i.d. samples",
      // Kept for exactly one thing: telling the page render to stop painting the
      // file's own copy underneath the one the viewer draws.
      srcId: "42R",
    });
    expect(read?.quads).toHaveLength(1);
    // A marked sentence nobody wrote about is the ordinary case and is still read.
    expect(
      noteFromAnnotation(
        { subtype: "Highlight", quadPoints: [10, 320, 200, 320, 10, 300, 200, 300] },
        vp,
      )?.text,
    ).toBe("");
  });
});

describe("where a highlight lands in the file", () => {
  it("writes the corner order every real producer and reader uses", () => {
    // TL, TR, BL, BR — not the spec's counter-clockwise-from-lower-left wording,
    // which half the readers in existence draw as a bow tie.
    expect(quadPointsInPdfSpace([{ x: 10, y: 80, w: 190, h: 20 }], flatViewport(400)))
      .toEqual([10, 320, 200, 320, 10, 300, 200, 300]);
  });

  it("boxes every quad into one /Rect", () => {
    expect(
      highlightRectInPdfSpace(
        [
          { x: 100, y: 40, w: 80, h: 12 },
          { x: 20, y: 56, w: 140, h: 12 },
        ],
        flatViewport(400),
      ),
    ).toEqual([20, 332, 180, 360]);
    expect(highlightRectInPdfSpace([], flatViewport(400))).toEqual([0, 0, 0, 0]);
  });

  it("survives a quarter turn with its box still normalised", () => {
    const turned = { convertToPdfPoint: (x: number, y: number) => [y, x] };
    const [x1, y1, x2, y2] = highlightRectInPdfSpace([{ x: 10, y: 20, w: 30, h: 8 }], turned);
    expect(x1).toBeLessThan(x2);
    expect(y1).toBeLessThan(y2);
  });
});

describe("saving remarks into the PDF itself", () => {
  it("writes a remark as the page's own /Text annotation", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });
    const pages = initialPages(1);
    const edited = addNote(pages, pages[0].id, [], note({ text: "über the graph", author: "Me" }));

    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    // Read back out of the saved bytes: this is what another reader sees.
    expect(await notesOnPage(bytes, 0)).toEqual([
      // Non-ASCII survives, which is what the hex/UTF-16 string is for.
      { text: "über the graph", author: "Me", rect: [100, 328, 122, 350] },
    ]);
  });

  it("leaves an untouched page's own comments exactly where they were", async () => {
    const src = await makePdf([300, 400]);
    addRawTextAnnot(src, 1, "a colleague's comment");
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(2);
    // Only the FIRST sheet is remarked on; the second is never taken over.
    const edited = addNote(pages, pages[0].id, [], note({ text: "mine" }));

    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    expect((await notesOnPage(bytes, 0)).map((n) => n.text)).toEqual(["mine"]);
    expect((await notesOnPage(bytes, 1)).map((n) => n.text)).toEqual(["a colleague's comment"]);
  });

  it("replaces a touched page's comments rather than doubling them", async () => {
    const src = await makePdf([300]);
    addRawTextAnnot(src, 0, "theirs");
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    // The baseline is what the page canvas read out of the file, so an edit carries
    // the foreign remark forward instead of dropping it.
    const theirs = note({ text: "theirs", x: 10, y: 368, author: "Someone Else" });
    const edited = addNote(pages, pages[0].id, [theirs], note({ text: "mine", x: 200, y: 100 }));

    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    expect((await notesOnPage(bytes, 0)).map((n) => n.text)).toEqual(["theirs", "mine"]);
  });

  it("deletes a comment out of the file when the last remark is removed", async () => {
    const src = await makePdf([300]);
    addRawTextAnnot(src, 0, "theirs");
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    const theirs = note({ text: "theirs" });
    const cleared = removeNote(
      addNote(pages, pages[0].id, [theirs], note({ text: "mine" })),
      pages[0].id,
      [],
      theirs.id,
    );
    const gone = removeNote(cleared, pages[0].id, [], cleared[0].notes![0].id);

    const bytes = await buildPdf(gone, sources, { noteViewport: async () => flatViewport(400) });
    expect(await notesOnPage(bytes, 0)).toEqual([]);
  });

  it("never touches the page's other annotations", async () => {
    const src = await makePdf([300]);
    addRawTextAnnot(src, 0, "theirs");
    addRawLinkAnnot(src, 0);
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    const edited = addNote(pages, pages[0].id, [], note({ text: "mine" }));
    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    // The link survived; only the sticky note was rewritten.
    expect(await annotCount(bytes, 0)).toBe(2);
    expect((await notesOnPage(bytes, 0)).map((n) => n.text)).toEqual(["mine"]);
  });

  it("keeps a duplicated sheet's remarks apart", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    const twins = duplicatePages(pages, [pages[0].id]);
    const first = addNote(twins, twins[0].id, [], note({ text: "on the first copy" }));
    const both = addNote(first, first[1].id, [], note({ text: "on the second" }));

    const bytes = await buildPdf(both, sources, { noteViewport: async () => flatViewport(400) });

    // The copied pages share one `/Annots` array until it is rebuilt — this is the
    // assertion that the rebuild happens.
    expect((await notesOnPage(bytes, 0)).map((n) => n.text)).toEqual(["on the first copy"]);
    expect((await notesOnPage(bytes, 1)).map((n) => n.text)).toEqual(["on the second"]);
  });

  it("writes a highlight as the page's own /Highlight, quads and appearance and all", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });
    const pages = initialPages(1);
    const marked = addNote(pages, pages[0].id, [], {
      id: newNoteId(),
      x: 10,
      y: 80,
      quads: [{ x: 10, y: 80, w: 190, h: 20 }],
      quote: "the estimator is unbiased",
      text: "but only for i.i.d. samples",
    });

    const bytes = await buildPdf(marked, sources, { noteViewport: async () => flatViewport(400) });

    expect(await highlightsOnPage(bytes, 0)).toEqual([
      {
        text: "but only for i.i.d. samples",
        rect: [10, 300, 200, 320],
        quads: [10, 320, 200, 320, 10, 300, 200, 300],
        // Optional in the format and written anyway, for the readers that do not
        // synthesise one: a printer's rasteriser, a thumbnail service, an old viewer.
        hasAppearance: true,
      },
    ]);
  });

  it("writes a marked sentence nobody remarked on, and no empty sticky note", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });
    const pages = initialPages(1);
    // A highlight with no remark IS the mark; an empty sticky note is not a comment.
    const both = addNote(
      addNote(pages, pages[0].id, [], {
        id: newNoteId(),
        x: 10,
        y: 80,
        quads: [{ x: 10, y: 80, w: 190, h: 20 }],
        text: "",
      }),
      pages[0].id,
      [],
      note({ text: "kept" }),
    );
    const emptied = updateNote(both, pages[0].id, [], both[0].notes![1].id, { text: "" });

    const bytes = await buildPdf(emptied, sources, { noteViewport: async () => flatViewport(400) });
    expect(await highlightsOnPage(bytes, 0)).toHaveLength(1);
    expect(await notesOnPage(bytes, 0)).toEqual([]);
  });

  it("does not put the quoted words into the file", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });
    const pages = initialPages(1);
    const marked = addNote(pages, pages[0].id, [], {
      id: newNoteId(),
      x: 10,
      y: 80,
      quads: [{ x: 10, y: 80, w: 190, h: 20 }],
      // Display only: the words are already on the page, and a copy of them in the
      // annotation is a second version of the sentence that stops being true the
      // moment the document is edited.
      quote: "SECRETQUOTEMARKER",
      text: "",
    });

    const bytes = await buildPdf(marked, sources, { noteViewport: async () => flatViewport(400) });
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("SECRETQUOTEMARKER");
  });

  it("carries a colleague's highlight forward when the page is touched", async () => {
    const src = await makePdf([300]);
    addRawHighlightAnnot(src, 0, "theirs");
    addRawLinkAnnot(src, 0);
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    // The baseline is what the page canvas read out of the file — the same
    // all-or-nothing rule sticky notes follow, now covering both subtypes.
    const theirs: PdfNote = {
      id: newNoteId(),
      x: 10,
      y: 80,
      quads: [{ x: 10, y: 80, w: 190, h: 20 }],
      text: "theirs",
    };
    const edited = addNote(pages, pages[0].id, [theirs], {
      id: newNoteId(),
      x: 30,
      y: 200,
      quads: [{ x: 30, y: 200, w: 50, h: 10 }],
      text: "mine",
    });

    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });
    expect((await highlightsOnPage(bytes, 0)).map((h) => h.text)).toEqual(["theirs", "mine"]);
    // …and the link the document was compiled with is untouched.
    expect(await annotCount(bytes, 0)).toBe(3);
  });

  it("leaves an untouched page's own highlights exactly as they were", async () => {
    const src = await makePdf([300, 400]);
    addRawHighlightAnnot(src, 1, "a colleague's mark");
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(2);
    const edited = addNote(pages, pages[0].id, [], note({ text: "mine" }));
    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    expect((await highlightsOnPage(bytes, 1)).map((h) => h.text)).toEqual(["a colleague's mark"]);
  });

  it("carries a remark onto a blacked-out sheet, which keeps nothing else", async () => {
    const src = await makePdf([300]);
    const sources = sourcesOf({ [SELF]: await src.save() });

    const pages = initialPages(1);
    const marked: typeof pages = [
      { ...pages[0], marks: [{ id: "m1", x: 0, y: 0, w: 50, h: 20 }] },
    ];
    const edited = addNote(marked, pages[0].id, [], note({ text: "why this went", x: 10, y: 10 }));

    const bytes = await buildPdf(edited, sources, {
      // The raster is stubbed: what matters here is that the flattened page still
      // carries the remark, not what the pixels look like.
      rasterize: async () => ({
        bytes: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
          0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49,
          0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0,
          0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]),
        mime: "image/png",
        widthPt: 300,
        heightPt: 400,
      }),
    });

    expect((await notesOnPage(bytes, 0)).map((n) => n.text)).toEqual(["why this went"]);
  });
});
