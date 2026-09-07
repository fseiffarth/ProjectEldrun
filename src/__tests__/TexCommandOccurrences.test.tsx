/**
 * Double-click a control sequence in a LaTeX file and every OTHER use of it in
 * the same file is marked (#tex-command-occurrences). The gesture also widens
 * the selection over the backslash — the browser's word rules stop at it and
 * hand back the letters alone, which is not the command the reader pointed at.
 *
 * The pure halves (`texCommandAt`, `texCommandOccurrences`) are covered in
 * TexDelimiterMatch.test.ts; this is the wiring: the overlay layer, what it
 * leaves unmarked, and when it goes away. jsdom implements no click→selection
 * behaviour, so each test sets the selection the way a double-click would and
 * then dispatches the event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ settings: { autosave: false, viewer_prefs: {} } }),
    { getState: () => ({ settings: { viewer_prefs: {} } }) },
  ),
}));

// Three uses of `\emph`, one `\emphasis` (a longer command that merely starts
// with it), and one escaped `\\emph` (a line break followed by the word).
const TEXT = "\\emph{a}\n\\emphasis{b}\n\\emph{c}\nline\\\\emph\n";

async function renderTexSource(path = "/p/doc.tex") {
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path={path} projectId="proj" />);
  });
  const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe(TEXT));
  return textarea;
}

/** Double-click as the browser would leave it: the word's letters selected. */
async function doubleClickWord(textarea: HTMLTextAreaElement, word: string, from = 0) {
  const at = textarea.value.indexOf(word, from);
  textarea.focus();
  textarea.setSelectionRange(at, at + word.length);
  await act(async () => {
    fireEvent.doubleClick(textarea);
  });
}

const marks = () => document.querySelectorAll(".file-viewer-occurrence-match");

describe("double-click marks a command's other uses (#tex-command-occurrences)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_text") return Promise.resolve(TEXT);
      if (cmd === "file_mtime") return Promise.resolve(1000);
      return Promise.resolve(null);
    });
  });

  it("marks the other whole-token uses, and neither the clicked one nor a longer command", async () => {
    const textarea = await renderTexSource();
    // The letters of the FIRST \emph — what a double-click hands back.
    await doubleClickWord(textarea, "emph");

    await waitFor(() => expect(marks().length).toBe(1));
    // The one mark is the third line's \emph: not the clicked one (the selection
    // already shows it), not \emphasis, not the escaped \\emph.
    expect(marks()[0].textContent).toBe("\\emph");
    expect(document.querySelector(".file-viewer-occurrence-layer")?.textContent).toContain(
      "emphasis",
    );
  });

  it("widens the selection over the backslash so the whole command is selected", async () => {
    const textarea = await renderTexSource();
    await doubleClickWord(textarea, "emph");
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("\\emph");
  });

  it("marks nothing for a double-click on prose, and drops what was marked", async () => {
    const textarea = await renderTexSource();
    await doubleClickWord(textarea, "emph");
    await waitFor(() => expect(marks().length).toBe(1));

    await doubleClickWord(textarea, "line");
    await waitFor(() => expect(marks().length).toBe(0));
  });

  it("drops the marks on the next keystroke, but not on a bare modifier", async () => {
    const textarea = await renderTexSource();
    await doubleClickWord(textarea, "emph");
    await waitFor(() => expect(marks().length).toBe(1));

    // Holding Ctrl to copy the fresh selection must not wipe them.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Control", ctrlKey: true });
    });
    expect(marks().length).toBe(1);

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "ArrowRight" });
    });
    await waitFor(() => expect(marks().length).toBe(0));
  });

  it("stays out of the way in a non-LaTeX file", async () => {
    const textarea = await renderTexSource("/p/notes.txt");
    await doubleClickWord(textarea, "emph");
    expect(marks().length).toBe(0);
  });
});
