/**
 * Tests for opt-in local autocomplete (#45, DECISION A):
 *  - Ctrl+Space requests a completion ONLY when the per-type setting is on, after
 *    ensure_ollama_running; the suggestion renders as ghost text and Tab accepts.
 *  - When the setting is OFF, Ctrl+Space never calls out (privacy gate).
 *  - Partial accept: → (Right) inserts only the next word and keeps the rest
 *    ghosted; a later plain Tab finishes it.
 *  - Completion-length modes: requests carry the active `mode`, and Shift+Tab
 *    toggles it (sentence → block → scope) then re-requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// The file at /p/foo.py belongs to a project rooted at /p, so the context-file
// picker (#45) lists that project's files.
vi.mock("../stores/projects", () => {
  const state = {
    projects: [{ id: "proj", directory: "/p", local_file: "/p/project.json" }],
    activeId: "proj",
  };
  // Callable like a real zustand hook (selector) AND exposes getState(), since
  // FileViewerPane reads it both ways (subscribes for the disconnected gate,
  // reads getState() in handlers).
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});

const SOURCE = "def foo():\n    ";

// The settings the mocked store returns — toggled per test via this ref.
let autocompleteOn = false;
vi.mock("../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({
      settings: {
        autosave: false,
        viewer_prefs: { text: { autocomplete: autocompleteOn } },
      },
    }),
}));

function setup() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(SOURCE);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "list_project_paths")
      return Promise.resolve([{ path: "helper.py", is_dir: false }]);
    if (cmd === "ensure_ollama_running") return Promise.resolve(null);
    // Completion runs against whichever model is currently loaded in memory.
    if (cmd === "list_ollama_models_detailed")
      return Promise.resolve([{ name: "llama3.2:3b", running: true }]);
    if (cmd === "complete_text") return Promise.resolve("return 42");
    return Promise.resolve(null);
  });
}

async function renderTextView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/foo.py" projectId="proj" />);
  });
}

describe("local autocomplete (#45)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("does NOT call out on Ctrl+Space when the per-type setting is OFF", async () => {
    autocompleteOn = false;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("list_ollama_models_detailed");
    expect(mockInvoke).not.toHaveBeenCalledWith("complete_text", expect.anything());
  });

  it("requests + shows a ghost suggestion on Ctrl+Space when enabled, Tab accepts", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    // Caret at end.
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });

    // It resolves the currently-loaded local model first (local-only), then
    // completes against it.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("list_ollama_models_detailed"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "complete_text",
        expect.objectContaining({ prefix: SOURCE, suffix: "", language: "python" }),
      ),
    );
    // Ghost text appears.
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Tab accepts → inserted into the buffer.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return 42"),
    );
  });

  it("→ (Right) accepts only the next word, keeping the rest ghosted; Tab finishes it", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    // Suggestion is the two-word "return 42".
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Right inserts just "return", leaving " 42" ghosted.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "ArrowRight" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return"),
    );
    await waitFor(() => expect(screen.getByText("42")).toBeTruthy());

    // Plain Tab now accepts the remaining " 42".
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return 42"),
    );
  });

  it("Shift+Tab toggles to Block mode and re-requests in it", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    // First request defaults to "sentence" mode; its suggestion must be showing
    // for Shift+Tab to toggle (vs. its normal outdent role).
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ mode: "sentence" })),
    );
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Shift+Tab advances sentence → block and re-requests.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ mode: "block" })),
    );
  });

  it("attaches a project file as context and forwards it to complete_text (#45)", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    // Open the context-file picker and pick the project's helper file.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add a project file as autocomplete context"));
    });
    const row = await screen.findByText("helper.py");
    await act(async () => {
      fireEvent.mouseDown(row);
    });
    // The chip for the attached file shows in the context bar.
    await waitFor(() => expect(screen.getByTitle("helper.py")).toBeTruthy());

    // Requesting a completion now carries the attached file as context.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "complete_text",
        expect.objectContaining({
          context: [{ name: "helper.py", content: SOURCE }],
        }),
      ),
    );
  });

  it("auto-suggests after an idle pause once typing (no Ctrl+Space needed)", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));

    // Focus + type a char: the focused editor auto-requests after the debounce.
    textarea.focus();
    const typed = SOURCE + "r";
    await act(async () => {
      fireEvent.change(textarea, { target: { value: typed } });
    });
    textarea.selectionStart = textarea.selectionEnd = typed.length;

    await waitFor(
      () => expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.anything()),
      { timeout: 2000 },
    );
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());
  });
});
