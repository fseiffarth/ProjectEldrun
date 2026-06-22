/**
 * Tests for the code-editor text-size control:
 *  - the persisted per-type `viewer_prefs[type].font_size` drives the editor's
 *    --code-font-size / --code-line-height CSS variables (so the gutter and
 *    overlay layers scale together);
 *  - the A+/A− buttons (and Ctrl +/−) persist a clamped new size via
 *    updateSettings, merging the whole viewer_prefs map.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

// A settings-store mock exposing BOTH the selector call form (used during render)
// and `.getState()` (used by the inc/dec callbacks to read+merge viewer_prefs).
const { mockUpdate, prefsRef } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  prefsRef: { current: {} as Record<string, { font_size?: number }> },
}));
vi.mock("../stores/settings", () => {
  const state = () => ({
    settings: { autosave: false, viewer_prefs: prefsRef.current },
    updateSettings: mockUpdate,
  });
  const hook = (sel: (s: unknown) => unknown) => sel(state());
  (hook as unknown as { getState: typeof state }).getState = state;
  return { useSettingsStore: hook };
});

const SOURCE = "hello\nworld\n";

function setup() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(SOURCE);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    return Promise.resolve(null);
  });
}

async function renderTextView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/notes.txt" projectId="proj" />);
  });
}

async function renderMarkdownView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="markdown" path="/p/notes.md" projectId="proj" />);
  });
}

describe("editor text-size control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsRef.current = {};
    setup();
  });

  it("applies the persisted font_size as the editor CSS variables", async () => {
    prefsRef.current = { text: { font_size: 16 } };
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    const code = document.querySelector(".file-viewer-code") as HTMLElement;
    expect(code.style.getPropertyValue("--code-font-size")).toBe("16px");
    // line-height tracks the font at 1.5x → 24px.
    expect(code.style.getPropertyValue("--code-line-height")).toBe("24px");
    // The level readout doubles as the reset button.
    expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("16");
  });

  it("persists a larger size when A+ is clicked", async () => {
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    });
    expect(mockUpdate).toHaveBeenCalledWith({ viewer_prefs: { text: { font_size: 13 } } });
  });

  it("shrinks on Ctrl+− from the editor", async () => {
    prefsRef.current = { text: { font_size: 14 } };
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "-", ctrlKey: true });
    });
    expect(mockUpdate).toHaveBeenCalledWith({ viewer_prefs: { text: { font_size: 13 } } });
  });

  it("clamps at the minimum size", async () => {
    prefsRef.current = { text: { font_size: 8 } };
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    const dec = screen.getByRole("button", { name: "Decrease text size" }) as HTMLButtonElement;
    expect(dec.disabled).toBe(true);
  });

  it("offers the control in the markdown viewer and persists under the markdown key", async () => {
    await renderMarkdownView();
    // The preview renders the markdown body; the size control sits in the header.
    await waitFor(() => expect(document.querySelector(".markdown-body")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    });
    expect(mockUpdate).toHaveBeenCalledWith({ viewer_prefs: { markdown: { font_size: 13 } } });
  });
});
