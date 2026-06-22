/**
 * Tests for opt-in local autocomplete (#45, DECISION A):
 *  - Ctrl+Space requests a completion ONLY when the per-type setting is on, after
 *    ensure_ollama_running; the suggestion renders as ghost text and Tab accepts.
 *  - When the setting is OFF, Ctrl+Space never calls out (privacy gate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

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
    if (cmd === "ensure_ollama_running") return Promise.resolve(null);
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
    expect(mockInvoke).not.toHaveBeenCalledWith("ensure_ollama_running");
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

    // It ensures Ollama is up first (privacy/local-only), then completes.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ensure_ollama_running"));
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
});
