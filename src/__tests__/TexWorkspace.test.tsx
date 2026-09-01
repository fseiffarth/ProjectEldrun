/**
 * The TeX workspace single-tab contract (Implementer B's slice):
 *  (a) `openTexWorkspace` mints exactly ONE workspace tab keyed on the resolved
 *      build root; opening a child of an already-open workspace focuses + centers
 *      it rather than spawning a second tab.
 *  (b) Clicking a sidebar entry switches the center via `setViewerState`
 *      (texActivePath) — never `addTab`.
 *  (c) A compile opens the PDF as its OWN tab (not docked) beside the workspace;
 *      the forward-search reveal targets that PDF's path.
 *  (d) A reverse-search from the (standalone) PDF routes back INTO the workspace,
 *      switching the center to the producing in-structure child and reaching it
 *      via `requestJump` — no scattered standalone source tab.
 *
 * The real `PdfView` pulls pdf.js (which jsdom can't run), so it is stubbed to a
 * bare marker; every other component (the sidebar, the center `TexView`) is the
 * real one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
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
// the rest of the viewer graph is unaffected.
vi.mock("../components/embed/pdf/PdfViewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/embed/pdf/PdfViewer")>();
  const React = await import("react");
  return {
    ...actual,
    PdfView: (props: { path: string }) =>
      React.createElement("div", { "data-testid": "pdf-view", "data-path": props.path }),
  };
});

const MAIN = "/p/main.tex";
const CHILD = "/p/chap.tex";
const MAIN_SRC = "\\documentclass{article}\n\\begin{document}\n\\input{chap}\nHi\n\\end{document}\n";
const CHILD_SRC = "\\section{Chapter}\nchild body\n";

/** Wire the backend mock for a compilable one-child document. */
function setupInvoke(
  syncRects: Array<{ page: number; x: number; y: number; w: number; h: number }> = [],
  engines: string[] = ["pdflatex"],
) {
  const files: Record<string, string> = { [MAIN]: MAIN_SRC, [CHILD]: CHILD_SRC };
  mockInvoke.mockImplementation((
    cmd: string,
    args?: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => {
    switch (cmd) {
      case "tex_capability":
        return Promise.resolve({ available: true, engines, bibtex: false, latexmk: false });
      case "read_file_text": {
        const text = files[(args?.path as string) ?? ""];
        return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
      }
      case "write_file_text": {
        // Recorded, so the ＋ (new file) test can assert the spliced \input.
        files[(args?.path as string) ?? ""] = (args?.content as string) ?? "";
        return Promise.resolve(null);
      }
      case "write_file_bytes": {
        // Bytes ride as the raw body; the path is a header (see fileAccess.ts).
        const p = decodeURIComponent(opts?.headers?.["x-eldrun-path"] ?? "");
        files[p] = "";
        return Promise.resolve(null);
      }
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
      case "file_mtime": {
        // Answers only for files that exist — texPathExists reads a failed stat
        // as absence, which is what lets the ＋ create a missing child.
        const p = (args?.path as string) ?? "";
        return files[p] != null ? Promise.resolve(1) : Promise.reject(new Error("missing"));
      }
      case "list_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
  return files;
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

describe("TeX workspace — center switching + SyncTeX", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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

  it("(c) a compile opens the PDF as its own tab (not docked)", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { useTabsStore } = await renderWorkspace();

    // Only the workspace tab before a build.
    await screen.findByRole("button", { name: /compile/i });
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // A second tab — the compiled PDF — opened beside the workspace (deduped, so
    // the double open/refocus from the compile still yields exactly one).
    await waitFor(() =>
      expect(
        useTabsStore
          .getState()
          .tabs.find((t) => t.kind === "embed" && t.viewer === "pdf" && t.embedPath === "/p/main.pdf"),
      ).toBeTruthy(),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(2);

    // Forward search revealed the caret's box in that PDF (path-keyed store).
    const { usePdfSyncStore } = await import("../stores/pdfSync");
    await waitFor(() =>
      expect(usePdfSyncStore.getState().byPath["/p/main.pdf"]).toMatchObject({
        rect: { page: 1, x: 10, y: 20, w: 100, h: 12 },
      }),
    );
  });

  it("(i) the engine chosen on the main file compiles every file in the structure", async () => {
    // Two engines, so the selector is offered at all (one installed ⇒ hidden).
    setupInvoke([], ["pdflatex", "lualatex"]);
    await renderWorkspace();

    // Choose lualatex on the main file — the only pane mounted so far.
    const trigger = await screen.findByTitle(/LaTeX engine/i);
    await act(async () => {
      await userEvent.click(trigger);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("option", { name: "lualatex" }));
    });

    // Center the child and build from THERE. A child compiles its root, so the
    // engine it builds with is the document's, not the backend's default.
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    await act(async () => {
      await userEvent.click(childRow);
    });
    const childCompile = await screen.findByRole("button", { name: /compile main\.tex/i });
    await act(async () => {
      await userEvent.click(childCompile);
    });

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find((c) => c[0] === "compile_tex");
      expect(call?.[1]).toMatchObject({ path: MAIN, engine: "lualatex" });
    });
    // And the child's own toolbar says so: one choice, shown by every pane.
    for (const el of screen.getAllByTitle(/LaTeX engine/i))
      expect(el.textContent).toContain("lualatex");
  });

  it("(d) reverse search routes back into the workspace, switching the center", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /compile/i });

    // Watch the jump channel: the child editor mounted by the center switch
    // consumes the request almost immediately, so spy rather than race the value.
    const { useEditorJumpStore } = await import("../stores/editorJump");
    const jumpSpy = vi.spyOn(useEditorJumpStore.getState(), "requestJump");

    // A standalone PDF tab's reverse-click calls the module `jumpToSource`; for a
    // `.tex` source owned by an open workspace it focuses that workspace and
    // switches its center to the source instead of opening a scattered tab.
    const { jumpToSource } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      jumpToSource(CHILD, 2, 1, MAIN);
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

  it("(h) the structure sidebar folds to a rail and comes back, persisted per tab", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /chap\.tex/i });

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /hide the structure/i }));
    });

    // Folded: the tree is gone, the persisted flag is set, and the rail still
    // offers the way back (a fold must never be a one-way door).
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texSidebarHidden,
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /chap\.tex/i })).toBeNull();

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /show the structure/i }));
    });
    await screen.findByRole("button", { name: /chap\.tex/i });
    expect(
      useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texSidebarHidden,
    ).toBe(false);
  });

  it("(i) back returns the center to the previously centered file", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    const vsOf = () => useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState;

    // Nothing centered yet ⇒ nothing to go back to: the button is present (it is
    // the only navigation this tab has) but inert.
    const backBefore = await screen.findByRole("button", { name: /nothing to go back to/i });
    expect((backBefore as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /chap\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /back to main\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(MAIN));
    // One step back is the whole stack — the button goes inert again.
    const backAfter = await screen.findByRole("button", { name: /nothing to go back to/i });
    expect((backAfter as HTMLButtonElement).disabled).toBe(true);
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

  it("(g) in a detached popout a compile streams the PDF tab via the file-drop controller", async () => {
    // A popout's tabs aren't in the main store, so `openLinkedFile` there would add
    // the PDF tab to a window that never renders it (the reported bug). With a
    // `FileDropController` in context the workspace must route the PDF through
    // `openTab` — the same seam the Python ▶ Run uses — so it lands in the popout.
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
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
    const { FileDropContext } = await import("../components/files/fileDropContext");
    const openTab = vi.fn();
    const controller = { resolveTarget: vi.fn(), commit: vi.fn(), openTab };
    await act(async () => {
      render(
        <FileDropContext.Provider value={controller}>
          <FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tab.key} />
        </FileDropContext.Provider>,
      );
    });

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // The PDF was streamed into the popout via the controller — never added to the
    // main store, which still holds only the workspace tab.
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "embed", viewer: "pdf", embedPath: "/p/main.pdf" }),
      ),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(j) the sidebar's ＋ creates a child file, \\inputs it, and centers it", async () => {
    const files = setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /chap\.tex/i });

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /new file/i }));
    });
    const input = await screen.findByRole("textbox", { name: /file name/i });
    await act(async () => {
      await userEvent.type(input, "notes{enter}");
    });

    // The file exists, the main document gained its \input above \end{document},
    // and the re-gathered structure lists + centers the new child.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe("/p/notes.tex"),
    );
    expect(files["/p/notes.tex"]).toBe("");
    expect(files[MAIN]).toMatch(/\\input\{notes\}\n\\end\{document\}/);
    await screen.findByRole("button", { name: /notes\.tex/i });
  });
});
