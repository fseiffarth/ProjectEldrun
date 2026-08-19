/**
 * The two remark surfaces, driven through the real UI: the marker layer over a page
 * and the panel that walks the document's remarks.
 *
 * What is worth pinning here is the part no pure test can reach — that one press on a
 * marker is either a move or a card, never both, and that the panel's walk and its
 * rows name the same remark. Both are gestures, so both are exercised as gestures.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PdfNoteLayer } from "../components/embed/pdf/PdfNoteLayer";
import { PdfNotesPane } from "../components/embed/pdf/PdfNotesPane";
import { NOTE_ICON_PT } from "../components/embed/pdf/notes";
import type { PlacedNote } from "../lib/viewers/pdfNotes";
import type { PdfNote } from "../lib/viewers/pageModel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const note = (over: Partial<PdfNote> = {}): PdfNote => ({
  id: "n1",
  x: 100,
  y: 50,
  text: "a remark",
  ...over,
});

function renderLayer(over: Partial<Parameters<typeof PdfNoteLayer>[0]> = {}) {
  const onMove = vi.fn();
  const onEdit = vi.fn();
  const onSave = vi.fn();
  const props = {
    notes: [note()],
    scale: 1,
    pageWidth: 600,
    pageHeight: 800,
    menu: null,
    edit: null,
    ready: true,
    author: "",
    autosave: true,
    onMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    onEdit,
    onSave,
    onMove,
    onDelete: vi.fn(),
    ...over,
  };
  render(<PdfNoteLayer {...props} />);
  return {
    onMove,
    onEdit,
    onSave,
    marker: screen.getAllByRole("button", { name: "Remark" })[0],
  };
}

describe("moving a remark's marker", () => {
  it("commits the drag once, in the page's own units", () => {
    const { onMove, onEdit, marker } = renderLayer();

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 80, clientY: 30 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 80, clientY: 30 });

    // One write, not one per frame — a drag is a single undo step.
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("n1", 180, 80);
    // And the click that ends a drag is the drag's: the card must not open.
    fireEvent.click(marker);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("divides the travel by the zoom, so a move means the same at any scale", () => {
    const { onMove, marker } = renderLayer({ scale: 2 });

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 80, clientY: 40 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 80, clientY: 40 });

    expect(onMove).toHaveBeenCalledWith("n1", 140, 70);
  });

  it("keeps the marker on the sheet, icon box and all", () => {
    const { onMove, marker } = renderLayer();

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 5000, clientY: 5000 });

    expect(onMove).toHaveBeenCalledWith("n1", 600 - NOTE_ICON_PT, 800 - NOTE_ICON_PT);
  });

  it("is a click, not a move, when the pointer barely travelled", () => {
    const { onMove, onEdit, marker } = renderLayer();

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 11, clientY: 11 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 11, clientY: 11 });
    fireEvent.click(marker);

    expect(onMove).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith({ noteId: "n1", x: 100, y: 50 });
  });

  it("commits a gesture the engine cancels, rather than snapping back", () => {
    const { onMove, marker } = renderLayer();

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 30, clientY: 0 });
    fireEvent.pointerCancel(marker, { pointerId: 1, clientX: 30, clientY: 0 });

    expect(onMove).toHaveBeenCalledWith("n1", 130, 50);
  });

  it("closes a card whose remark is no longer on the sheet", () => {
    // What an autosave does: the file is written, re-read, and every remark id is
    // minted afresh — so a card left open is addressed at nothing.
    const { onEdit } = renderLayer({ edit: { noteId: "gone", x: 1, y: 2 } });
    expect(onEdit).toHaveBeenCalledWith(null);
  });
});

describe("writing in the card", () => {
  const open = { noteId: "n1", x: 100, y: 50 };
  const write = (text: string) =>
    fireEvent.change(screen.getByLabelText("Remark text"), { target: { value: text } });

  it("saves on Enter and keeps Shift+Enter for a new line", () => {
    const { onSave, onEdit } = renderLayer({ edit: open });
    write("edited");

    fireEvent.keyDown(screen.getByLabelText("Remark text"), { key: "Enter", shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Remark text"), { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith(open, "edited", "");
    expect(onEdit).toHaveBeenCalledWith(null);
  });

  it("keeps what was written when the press lands somewhere else", () => {
    // A stray click may not cost a sentence; Escape is still the way to discard one.
    const { onSave, onEdit } = renderLayer({ edit: open });
    write("edited");

    fireEvent.pointerDown(document.body);
    expect(onSave).toHaveBeenCalledWith(open, "edited", "");
    expect(onEdit).toHaveBeenCalledWith(null);
  });

  it("only closes a card that was merely read", () => {
    // Committing would stamp `modified` and mark the sheet edited — for looking.
    const { onSave, onEdit } = renderLayer({ edit: open });

    fireEvent.pointerDown(document.body);
    expect(onSave).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith(null);
  });

  it("stays open while the press is inside it", () => {
    const { onSave, onEdit } = renderLayer({ edit: open });
    write("edited");

    fireEvent.pointerDown(screen.getByLabelText("Remark text"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("commits the open card when a second marker is pressed, and opens that one", () => {
    // A marker claims its own press, so the window listener never hears it.
    const { onSave, onEdit } = renderLayer({
      notes: [note(), note({ id: "n2", x: 300, y: 200, text: "another" })],
      edit: open,
    });
    write("edited");

    const second = screen.getAllByRole("button", { name: "Remark" })[1];
    fireEvent.click(second);
    expect(onSave).toHaveBeenCalledWith(open, "edited", "");
    expect(onEdit).toHaveBeenCalledWith({ noteId: "n2", x: 300, y: 200 });
  });
});

describe("a highlight on the page", () => {
  const hl = (over: Partial<PdfNote> = {}): PdfNote =>
    note({
      id: "h1",
      x: 100,
      y: 40,
      quads: [
        { x: 100, y: 40, w: 80, h: 12 },
        { x: 20, y: 56, w: 140, h: 12 },
      ],
      quote: "the estimator is unbiased",
      text: "",
      ...over,
    });

  it("draws one box per line, and announces itself once", () => {
    render(
      <PdfNoteLayer
        {...({
          notes: [hl()],
          scale: 2,
          pageWidth: 600,
          pageHeight: 800,
          menu: null,
          edit: null,
          ready: true,
          author: "",
          autosave: true,
          onMenu: vi.fn(),
          onCloseMenu: vi.fn(),
          onEdit: vi.fn(),
          onSave: vi.fn(),
          onMove: vi.fn(),
          onDelete: vi.fn(),
        } as Parameters<typeof PdfNoteLayer>[0])}
      />,
    );
    // A sentence marked across two lines is ONE remark, not two: only the first box
    // carries the label, and the second is out of the accessibility tree entirely.
    const boxes = screen.getAllByRole("button", { hidden: true });
    expect(boxes).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Highlighted text" })).toHaveLength(1);
    // Positioned in CSS pixels — the page's own units multiplied by the zoom.
    expect(boxes[0].style.left).toBe("200px");
    expect(boxes[0].style.width).toBe("160px");
    expect(boxes[1].style.top).toBe("112px");
  });

  it("has no drag: pressing it opens its card rather than moving it", () => {
    const onEdit = vi.fn();
    const onMove = vi.fn();
    render(
      <PdfNoteLayer
        {...({
          notes: [hl()],
          scale: 1,
          pageWidth: 600,
          pageHeight: 800,
          menu: null,
          edit: null,
          ready: true,
          author: "",
          autosave: true,
          onMenu: vi.fn(),
          onCloseMenu: vi.fn(),
          onEdit,
          onSave: vi.fn(),
          onMove,
          onDelete: vi.fn(),
        } as Parameters<typeof PdfNoteLayer>[0])}
      />,
    );
    const box = screen.getByRole("button", { name: "Highlighted text" });
    fireEvent.pointerDown(box, { button: 0, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(box, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(box, { clientX: 300, clientY: 300 });
    fireEvent.click(box);
    // A highlight is pinned to words. There is nowhere to move it to.
    expect(onMove).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith({ noteId: "h1", x: 100, y: 40 });
  });

  it("opens its card UNDER the first line, never over the words", () => {
    render(
      <PdfNoteLayer
        {...({
          notes: [hl()],
          scale: 1,
          pageWidth: 600,
          pageHeight: 800,
          menu: null,
          edit: { noteId: "h1", x: 100, y: 40 },
          ready: true,
          author: "",
          autosave: true,
          onMenu: vi.fn(),
          onCloseMenu: vi.fn(),
          onEdit: vi.fn(),
          onSave: vi.fn(),
          onMove: vi.fn(),
          onDelete: vi.fn(),
        } as Parameters<typeof PdfNoteLayer>[0])}
      />,
    );
    const card = screen.getByRole("group", { name: "Remark" });
    // Below the line it marks (40 + 12 + 6), and flush with where it starts.
    expect(card.style.top).toBe("58px");
    expect(card.style.left).toBe("100px");
    // …and the card quotes what was marked, which is the one thing a card sitting
    // under a line of text cannot otherwise make obvious.
    expect(within(card).getByText("the estimator is unbiased")).toBeTruthy();
    // Deleting one is named for what it is, since clearing the text no longer does it.
    expect(within(card).getByText("Delete highlight")).toBeTruthy();
  });
});

describe("the remarks panel", () => {
  const placed: PlacedNote[] = [
    { entryId: "p1", sheet: 1, note: note({ id: "a", text: "first", author: "Reviewer" }) },
    { entryId: "p2", sheet: 3, note: note({ id: "b", text: "second" }) },
  ];

  function renderPane(over: Partial<Parameters<typeof PdfNotesPane>[0]> = {}) {
    const props = {
      placed,
      currentId: null,
      autosave: true,
      autosavable: true,
      saving: false,
      onSetAutosave: vi.fn(),
      onGo: vi.fn(),
      onStep: vi.fn(),
      onEditNote: vi.fn(),
      onDeleteNote: vi.fn(),
      onClose: vi.fn(),
      ...over,
    };
    render(<PdfNotesPane {...props} />);
    return props;
  }

  it("lists every remark with the sheet it is on, and its whole text", () => {
    renderPane();
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    // The sheet number, which is what the row is addressed by.
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("goes to a remark on a row click and opens it only on ✎", () => {
    const props = renderPane();
    const row = screen.getByText("second").closest(".file-viewer-pdf-notes-row") as HTMLElement;

    fireEvent.click(within(row).getByTitle(/Go to this remark/));
    expect(props.onGo).toHaveBeenCalledWith(placed[1]);
    expect(props.onEditNote).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "Edit remark" }));
    expect(props.onEditNote).toHaveBeenCalledWith(placed[1]);
  });

  it("shows where the walk is parked, and steps from it", () => {
    const props = renderPane({ currentId: "b" });
    expect(screen.getByText("2/2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next remark" }));
    expect(props.onStep).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous remark" }));
    expect(props.onStep).toHaveBeenCalledWith(-1);
  });

  it("says so when autosave is on but cannot run", () => {
    renderPane({ autosavable: false });
    // A switch that is on and quietly doing nothing is worse than one never offered.
    expect(screen.getByText(/Holding/)).toBeTruthy();
  });

  it("says nothing of the sort while it can", () => {
    renderPane();
    expect(screen.queryByText(/Holding/)).toBeNull();
  });
});
