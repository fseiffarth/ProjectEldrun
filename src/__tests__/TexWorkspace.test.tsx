/**
 * The TeX workspace single-tab contract (Implementer B's slice):
 *  (a) `openTexWorkspace` mints exactly ONE workspace tab keyed on the resolved
 *      build root; opening a child of an already-open workspace focuses + centers
 *      it rather than spawning a second tab.
 *  (b) Clicking a sidebar entry switches the center via `setViewerState`
 *      (texActivePath) — never `addTab`.
 *  (c) A compile docks the PDF in-tab (texPdfOpen) and adds NO PDF tab; the
 *      forward-search reveal targets the docked PDF's path.
 *  (d) A reverse-search click on the docked PDF switches the center to the
 *      producing in-structure child and its `requestJump` reaches it — no new tab.
 *
 * The real `PdfView` pulls pdf.js (which jsdom can't run), so it is stubbed to a
 * marker that captures the `onReverseSource` seam; every other component (the
 * sidebar, the center `TexView`) is the real one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke, capture } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  capture: { reverse: null as null | ((s: unknown, a: string) => void), path: "" },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// Cross-window broadcasts are no-ops in tests. `listen` must resolve to an
// unlisten fn — modules register listeners at import and call `.catch()` on it.
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

// Settings store: callable selector AND a getState (the structure effect reads
// viewer_prefs via getState).
vi.mock("../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {}, debug: false } };
  const useSettingsStore = Object.assign((sel: (s: unknown) => unknown) => sel(state), {
    getState: () => state,
  });
  return { useSettingsStore };
});

// Stub the PDF viewer: jsdom can't run pdf.js. Keep every other export intact so
// the rest of the viewer graph is unaffected, and capture the reverse-search seam.
vi.mock("../components/embed/pdf/PdfViewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/embed/pdf/PdfViewer")>();
  const React = await import("react");
  return {
    ...actual,
    PdfView: (props: { path: string; onReverseSource?: (s: unknown, a: string) => void }) => {
      capture.reverse = props.onReverseSource ?? null;
      capture.path = props.path;
      return React.createElement("div", { "data-testid": "docked-pdf", "data-path": props.path });
    },
  };
});

const MAIN = "/p/main.tex";
const CHILD = "/p/chap.tex";
const MAIN_SRC = "\\documentclass{article}\n\\begin{document}\n\\input{chap}\nHi\n\\end{document}\n";
const CHILD_SRC = "\\section{Chapter}\nchild body\n";

/** Wire the backend mock for a compilable one-child document. */
function setupInvoke(
  syncRects: Array<{ page: number; x: number; y: number; w: number; h: number }> = [],
) {
  const files: Record<string, string> = { [MAIN]: MAIN_SRC, [CHILD]: CHILD_SRC };
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "tex_capability":
        return Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: false, latexmk: false });
      case "read_file_text": {
        const text = files[(args?.path as string) ?? ""];
        return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
      }
      case "write_file_text":
        return Promise.resolve(null);
      case "resolve_tex_root":
        // A child resolves to the main; the main resolves to itself.
        return Promise.resolve((args?.path as string) === CHILD ? MAIN : (args?.path as string));
      case "compile_tex":
        return Promise.resolve({
          success: true,
          pdf_path: "/p/main.pdf",
          engine: "pdflatex",
          log: "ok",
          shell_escape: false,
        });
      case "synctex_view":
        return Promise.resolve(syncRects);
      case "synctex_edit":
        return Promise.resolve(null);
      case "file_mtime":
        return Promise.resolve(1);
      case "list_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

async function resetStores() {
  const { useTabsStore } = await import("../stores/tabs");
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  const { useEditorJumpStore } = await import("../stores/editorJump");
  useEditorJumpStore.setState({ requestsByPath: {} });
  const { usePdfSyncStore } = await import("../stores/pdfSync");
  usePdfSyncStore.setState({ byPath: {} });
}

describe("openTexWorkspace — one tab per document", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setupInvoke();
    await resetStores();
  });

  it("mints exactly one workspace tab keyed on the resolved root", async () => {
    const { openTexWorkspace } = await import("../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../stores/tabs");
    useTabsStore.getState().setScope("p");

    await openTexWorkspace(MAIN);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "embed", viewer: "texworkspace", embedPath: MAIN });

    // Opening the SAME main again just refocuses — no second tab.
    await openTexWorkspace(MAIN);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("opening a child focuses the existing workspace and centers the child (no 2nd tab)", async () => {
    const { openTexWorkspace } = await import("../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../stores/tabs");
    useTabsStore.getState().setScope("p");

    await openTexWorkspace(MAIN);
    const key = useTabsStore.getState().tabs[0].key;

    // A child resolves to the same root → same tab, centered on the child.
    await openTexWorkspace(CHILD);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].key).toBe(key);
    expect(tabs[0].viewerState?.texActivePath).toBe(CHILD);
  });

  it("centers on the root (not undefined) when the main itself is re-opened", async () => {
    const { openTexWorkspace } = await import("../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../stores/tabs");
    useTabsStore.getState().setScope("p");
    await openTexWorkspace(CHILD); // opens the workspace centered on the child
    await openTexWorkspace(MAIN); // re-open on the main
    expect(useTabsStore.getState().tabs[0].viewerState?.texActivePath).toBe(MAIN);
  });
});

describe("TeX workspace — center switching + docked SyncTeX", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capture.reverse = null;
    capture.path = "";
    await resetStores();
  });

  /** Add a workspace tab to the store and render the pane bound to it. */
  async function renderWorkspace() {
    vi.resetModules();
    const { useTabsStore } = await import("../stores/tabs");
    useTabsStore.getState().setScope("p");
    const tab = useTabsStore.getState().addTab({
      label: "main.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: MAIN,
      viewer: "texworkspace",
    });
    const { FileViewerPane } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tab.key} />);
    });
    return { tabKey: tab.key, useTabsStore };
  }

  it("(b) clicking a sidebar entry switches the center via setViewerState, no new tab", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();

    // The sidebar lists the child once the structure is gathered.
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    await act(async () => {
      await userEvent.click(childRow);
    });

    // The center switched by patching texActivePath — and NO tab was added.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe(CHILD),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(c) a compile docks the PDF in-tab and adds no PDF tab", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { tabKey, useTabsStore } = await renderWorkspace();

    // No docked PDF until a build.
    expect(screen.queryByTestId("docked-pdf")).toBeNull();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // The docked PDF appears (texPdfOpen flips) — mounted at the compile's output.
    const docked = await screen.findByTestId("docked-pdf");
    expect(docked.getAttribute("data-path")).toBe("/p/main.pdf");
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texPdfOpen,
      ).toBe(true),
    );
    // Exactly one tab — the PDF did NOT open as its own tab.
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    // Forward search revealed the caret's box in the docked PDF (path-keyed store).
    const { usePdfSyncStore } = await import("../stores/pdfSync");
    expect(usePdfSyncStore.getState().byPath["/p/main.pdf"]).toMatchObject({
      rect: { page: 1, x: 10, y: 20, w: 100, h: 12 },
    });
  });

  it("(d) a reverse-search click on the docked PDF centers the producing child, no new tab", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { tabKey, useTabsStore } = await renderWorkspace();

    // Compile to reveal the docked pane and capture its onReverseSource seam.
    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });
    await screen.findByTestId("docked-pdf");
    expect(capture.reverse).toBeTruthy();

    // Watch the jump channel: the child editor mounted by the center switch
    // consumes the request almost immediately, so spy on the emit rather than
    // race its retained value.
    const { useEditorJumpStore } = await import("../stores/editorJump");
    const jumpSpy = vi.spyOn(useEditorJumpStore.getState(), "requestJump");

    // Simulate the PDF resolving a Ctrl-click to a line in the in-structure child.
    await act(async () => {
      capture.reverse!({ input: CHILD, line: 2, column: 1 }, MAIN);
    });

    // The center switched to the child and a jump request reached it — no new tab.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe(CHILD),
    );
    expect(jumpSpy).toHaveBeenCalledWith(CHILD, 2, 1);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(e) a commented-out \\input is not listed in the sidebar", async () => {
    // A document whose live \input{chap} is followed by a commented one. The
    // sidebar must list only the live child. (The editor's follow behaviour for
    // a commented reference is locked at the unit level in TexLinks.test.ts —
    // jsdom gives every link span a zero rect, so the coordinate-based Ctrl+click
    // path can't be exercised here.)
    const commentedMain =
      "\\documentclass{article}\n\\begin{document}\n" +
      "\\input{chap}\n" +
      "% \\input{oldstuff}\n" +
      "\\end{document}\n";
    const files: Record<string, string> = { [MAIN]: commentedMain, [CHILD]: CHILD_SRC };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "tex_capability":
          return Promise.resolve({ available: false });
        case "read_file_text": {
          const text = files[(args?.path as string) ?? ""];
          return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
        }
        case "resolve_tex_root":
          return Promise.resolve((args?.path as string) === CHILD ? MAIN : (args?.path as string));
        case "file_mtime":
          return Promise.resolve(1);
        case "list_dir":
          return Promise.resolve([]);
        // A Ctrl+click that finds no reference falls through to forward-sync.
        case "synctex_view":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });
    await renderWorkspace();

    // Only the live child appears — never "oldstuff.tex".
    await screen.findByRole("button", { name: /chap\.tex/i });
    expect(screen.queryByRole("button", { name: /oldstuff\.tex/i })).toBeNull();
  });

  it("(f) switches the center in a detached popout (tab absent from the store)", async () => {
    // A detached popout renders its tabs from a Tauri seed into LOCAL React state,
    // so the layout store has NO entry for this tab: a store read is undefined and
    // a store write is a no-op. The workspace must fall back to a local mirror, or
    // the center stays pinned to the main file (the reported popout bug).
    setupInvoke();
    vi.resetModules();
    const { useTabsStore } = await import("../stores/tabs");
    useTabsStore.getState().setScope("p");
    // Deliberately do NOT addTab — mimic the popout's empty store for this key.
    const { FileViewerPane } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey="detached-tex" visible />);
    });

    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    expect(useTabsStore.getState().tabs.find((t) => t.key === "detached-tex")).toBeUndefined();

    await act(async () => {
      await userEvent.click(childRow);
    });

    // The center switched to the child (its body renders) even though the store
    // never gained an entry — the local mirror drove it.
    await waitFor(() => expect(screen.getByDisplayValue(/child body/)).toBeTruthy());
    expect(useTabsStore.getState().tabs.find((t) => t.key === "detached-tex")).toBeUndefined();
  });
});
