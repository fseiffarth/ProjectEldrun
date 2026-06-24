/**
 * Tests for the in-tab LaTeX viewer (`TexView` in FileViewerPane):
 *  - No TeX engine on PATH → degrades to exactly the plain code editor: a
 *    textarea, a Save button, and NO Compile button.
 *  - Engine available → a Compile button appears; clicking it saves the source
 *    (write_file_text) and then invokes `compile_tex`. A successful compile opens
 *    the PDF in its own tab (there is no inline preview pane).
 *
 * `getTexCapability()` caches its probe at module scope, so each test resets the
 * module registry and re-imports FileViewerPane to get a fresh probe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// The viewer's external-open button reaches into the windows store; stub it so
// the component renders without the real store.
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// Settings store: no viewer prefs (preview default OFF — #44), autosave off.
vi.mock("../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { autosave: false, viewer_prefs: {} } }),
}));

const TEX_SOURCE = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";

function setupInvoke(
  available: boolean,
  engines: string[] = ["pdflatex"],
  // Override what `resolve_tex_root` returns (defaults to the file itself, i.e.
  // not a child). Lets a test exercise the subtex→parent redirect.
  resolveRoot?: (path: string) => string,
) {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "tex_capability") {
      return Promise.resolve({ available, engines, bibtex: false, latexmk: false });
    }
    if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
    if (cmd === "write_file_text") return Promise.resolve(null);
    if (cmd === "resolve_tex_root") {
      const p = (args?.path as string) ?? "";
      return Promise.resolve(resolveRoot ? resolveRoot(p) : p);
    }
    if (cmd === "compile_tex") {
      return Promise.resolve({
        success: true,
        pdf_path: "/p/paper.pdf",
        engine: "pdflatex",
        log: "ok",
        shell_escape: false,
      });
    }
    if (cmd === "synctex_view") return Promise.resolve([]); // no records → forward-search miss
    if (cmd === "synctex_edit") return Promise.resolve(null);
    if (cmd === "file_mtime") return Promise.reject(new Error("no synctex"));
    if (cmd === "read_file_bytes") return Promise.resolve([37, 80, 68, 70]); // %PDF
    return Promise.resolve(null);
  });
}

async function renderTexView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="tex" path="/p/paper.tex" projectId="proj" />);
  });
}

describe("TexView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("degrades to the plain editor with no Compile button when no engine is installed", async () => {
    setupInvoke(false);
    await renderTexView();

    // Source still loads into an editable textarea with a Save button.
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(TEX_SOURCE),
    );
    expect(screen.getByRole("button", { name: /save/i })).toBeTruthy();
    // No compile affordance.
    expect(screen.queryByRole("button", { name: /compile/i })).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());
  });

  it("shows a Compile button when an engine is available, and saving+compiling on click", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // A single engine → no engine selector, backend default is used.
    expect(screen.queryByTitle("LaTeX engine")).toBeNull();

    // Edit the source so it's dirty — compile must persist edits first.
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    await act(async () => {
      await userEvent.type(textarea, "%edit");
    });

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    await waitFor(() => {
      // #54 added compiler options to the call; with none set they pass null.
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex", {
        path: "/p/paper.tex",
        engine: null,
        outDir: null,
        extraFlags: null,
      });
    });
    // The dirty source is saved before compiling.
    expect(mockInvoke).toHaveBeenCalledWith("write_file_text", expect.objectContaining({ path: "/p/paper.tex" }));
  });

  it("renders an engine selector when more than one engine is available", async () => {
    setupInvoke(true, ["pdflatex", "xelatex"]);
    await renderTexView();

    await screen.findByRole("button", { name: /compile/i });
    // Custom themed dropdown (not a native <select>); its trigger shows the
    // default engine's name rather than the literal word "Default".
    const engine = screen.getByTitle("LaTeX engine");
    expect(engine).toBeTruthy();
    expect(engine.textContent).toContain("pdflatex (default)");
  });

  it("#54: passes compiler options and offers Open PDF after a successful compile", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // No PDF yet → no Open-PDF affordance.
    expect(screen.queryByRole("button", { name: /open pdf/i })).toBeNull();

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // compile_tex is called with the new outDir/extraFlags args (null when unset).
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/paper.tex", outDir: null, extraFlags: null }),
      ),
    );
    // After a successful compile the "Open PDF" tab action appears.
    await screen.findByRole("button", { name: /open pdf/i });
  });

  it("shows a forward-search miss notice when SyncTeX can't locate the cursor", async () => {
    // setupInvoke's synctex_view resolves [] → forward search finds no spot.
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // No notice before compiling.
    expect(screen.queryByText(/couldn't locate the cursor/i)).toBeNull();

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // A successful compile whose forward search returns null surfaces the notice.
    await screen.findByText(/couldn't locate the cursor/i);
  });

  it("#56: a child file compiles its resolved parent and labels the button", async () => {
    // resolve_tex_root redirects the child to its main document.
    setupInvoke(true, ["pdflatex"], () => "/p/main.tex");
    await renderTexView();

    // The button advertises the parent it will build.
    const compileBtn = await screen.findByRole("button", { name: /compile main\.tex/i });

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // compile_tex builds the resolved parent, not the edited child.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/main.tex" }),
      ),
    );
  });

  it("#56: runs SyncTeX forward search against the edited file after a compile", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // Forward search uses the edited file as the SyncTeX input and the compiled
    // PDF as the output, from the (initial) caret at line/column 1.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "synctex_view",
        expect.objectContaining({ pdf: "/p/paper.pdf", input: "/p/paper.tex" }),
      ),
    );
  });
});
