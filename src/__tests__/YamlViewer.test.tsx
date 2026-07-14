/**
 * The YAML viewer (#yaml), driven through the real UI: a `.yaml` file opens in the
 * structure tree, and every tree action writes back into the SAME draft the Source
 * tab edits and Ctrl+S saves.
 *
 * The load-bearing property these tests pin is that the tree edits the file's text
 * rather than a model of it: an edit made in the tree leaves the file's comments,
 * quoting and untouched lines byte-identical, and lands in the editor as an
 * ordinary (dirty, undoable, saveable) change. A tree that re-serialized a parsed
 * model would pass none of this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
const { settingsState } = vi.hoisted(() => ({
  // Autosave off, so a save is an explicit click the test can point at.
  settingsState: { settings: { autosave: false, viewer_prefs: {} } as Record<string, unknown> },
}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}));
vi.mock("../stores/projects", () => {
  const state = {
    projects: [{ id: "proj", directory: "/p", local_file: "/p/project.json" }],
    activeId: "proj",
  };
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});
vi.mock("../stores/tabs", () => {
  const state = {
    tabs: [] as Record<string, unknown>[],
    layout: null,
    addTabToScope: vi.fn(),
    addTab: vi.fn(),
    setActive: vi.fn(),
    removeTab: vi.fn(),
    setViewerState: vi.fn(),
    splitWithNewTab: vi.fn(() => null),
  };
  const useTabsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useTabsStore, findGroupOfTab: () => null, getDetachedViewerState: () => undefined };
});

const CONFIG = `# Server configuration
server:
  host: 0.0.0.0   # bind address
  port: 8080
  tags:
    - web
    - prod
debug: false
`;

let onDisk = CONFIG;

function setup() {
  onDisk = CONFIG;
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "read_file_text") return Promise.resolve(onDisk);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "write_file_text") {
      onDisk = args.content as string;
      return Promise.resolve(null);
    }
    // check_syntax: the file is valid, so no validation banner.
    return Promise.resolve(null);
  });
}

async function renderYaml() {
  vi.resetModules();
  const { FileViewerPane } = await import("../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />);
  });
  await screen.findByRole("button", { name: "Collapse server" });
}

/** Save, and return the text that reached the disk. */
async function saveAndRead(): Promise<string> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Save"));
  });
  await waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith("write_file_text", expect.anything()),
  );
  return onDisk;
}

describe("yaml tree viewer (#yaml)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("opens a .yaml file in the tree, not in the editor", async () => {
    await renderYaml();
    // Structure, not source: keys are rows, values are inputs.
    expect(screen.getByRole("button", { name: "Collapse server" })).toBeTruthy();
    expect((screen.getByLabelText("Value of port") as HTMLInputElement).value).toBe("8080");
    expect((screen.getByLabelText("Value of host") as HTMLInputElement).value).toBe("0.0.0.0");
    // The list renders its items, indexed.
    expect((screen.getByLabelText("Value of item 0") as HTMLInputElement).value).toBe("web");
  });

  it("edits a value and saves it, leaving the comments and the rest of the file alone", async () => {
    await renderYaml();
    const port = screen.getByLabelText("Value of port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    expect(await saveAndRead()).toBe(CONFIG.replace("port: 8080", "port: 9090"));
  });

  it("adds a key with the type the user picked", async () => {
    await renderYaml();
    // "+ key" on the `server` mapping (the other one is the document's own, at
    // the foot of the tree).
    await act(async () => {
      fireEvent.click(screen.getAllByTitle("Add a key under this entry")[0]);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New key"), { target: { value: "workers" } });
      fireEvent.change(screen.getByLabelText("Value type"), { target: { value: "number" } });
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "4" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    const saved = await saveAndRead();
    expect(saved).toContain("    - prod\n  workers: 4\ndebug: false");
    expect(saved).toContain("# Server configuration");
  });

  it("adds a list item", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add an item to this list"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "eu-west" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toContain("    - prod\n    - eu-west\n");
  });

  it("renames a key without touching its value or its comment", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^host/ }));
    });
    const input = screen.getByLabelText("Rename key host") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "bind" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(await saveAndRead()).toContain("  bind: 0.0.0.0   # bind address");
  });

  it("shows a key's comment on the key, and writes an edited one back", async () => {
    await renderYaml();
    // Hovering the key is what surfaces it — on the key itself, both ways round: the
    // comment behind `host`, and the one written above `server`.
    expect(screen.getByRole("button", { name: /^host/ }).title).toBe("# bind address");
    expect(screen.getByRole("button", { name: /^server/ }).title).toBe("# Server configuration");
    // `port` has none, so it keeps the rename hint.
    expect(screen.getByRole("button", { name: /^port/ }).title).toBe("Click to rename this key");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Comment on port"));
    });
    const input = screen.getByLabelText("Comment on port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "the port to listen on" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const saved = await saveAndRead();
    expect(saved).toContain("  port: 8080  # the port to listen on\n");
    // Written behind the value, so nothing else on the file moved.
    expect(saved).toContain("  host: 0.0.0.0   # bind address\n");
  });

  it("adds a mapping item when a list is given a key", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add an item that is a mapping (- key: value)"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New key"), { target: { value: "name" } });
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "eu" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toContain("    - prod\n    - name: eu\ndebug: false");
  });

  it("reorders siblings by dragging one onto another", async () => {
    await renderYaml();
    // Drag `item 0` (web) down onto `item 1` (prod). The rows report no geometry in
    // jsdom, so the drop lands on the last row whose top the pointer has passed —
    // which with every rect at 0 is the last sibling, i.e. exactly this move.
    const grip = screen.getByLabelText("Reorder item 0");
    await act(async () => {
      fireEvent.pointerDown(grip, { pointerId: 1 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 200 });
      fireEvent.pointerUp(grip, { pointerId: 1 });
    });

    expect(await saveAndRead()).toContain("  tags:\n    - prod\n    - web\n");
  });

  it("deletes an entry with everything under it, comment included", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete server"));
    });

    // "# Server configuration" is `server`'s comment — left behind, it would end up
    // sitting above `debug` and describing that instead.
    expect(await saveAndRead()).toBe("debug: false\n");
  });

  it("reorders list items", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Move item 1 up"));
    });

    expect(await saveAndRead()).toContain("  tags:\n    - prod\n    - web\n");
  });

  it("shows the same text in Source, and a tree edit is an ordinary undo step", async () => {
    await renderYaml();
    const port = screen.getByLabelText("Value of port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    // Source shows the tree's edit — one draft, two views.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
    });
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("port: 9090");

    // And the edit undoes like a typed one.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Undo"));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("port: 8080");
  });

  it("renders a JSON-formatted .yml as a tree, not as one opaque `{` row", async () => {
    // The regression this whole flow layer exists for: a flow collection spread
    // over lines used to parse as a single un-editable scalar whose text was the
    // opening brace.
    onDisk = "# app\nservice: {\n  name: api,\n  port: 8080\n}\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/flow.yaml" projectId="proj" />);
    });

    const port = (await screen.findByLabelText("Value of port")) as HTMLInputElement;
    expect(port.value).toBe("8080");
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    // The edit lands inside the flow collection; the layout and comment survive.
    expect(await saveAndRead()).toBe("# app\nservice: {\n  name: api,\n  port: 9090\n}\n");
  });

  it("edits a .json file in the same tree, writing the strict dialect", async () => {
    onDisk = '{\n  "name": "app",\n  "keywords": []\n}\n';
    vi.resetModules();
    const { FileViewerPane } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/package.json" projectId="proj" />);
    });

    // A list item added to a JSON file comes out quoted — JSON has no plain scalars.
    await act(async () => {
      fireEvent.click(await screen.findByTitle("Add an item to this list"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "cli" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toBe('{\n  "name": "app",\n  "keywords": ["cli"]\n}\n');
  });

  it("keeps a construct it cannot rewrite out of reach instead of offering a bad edit", async () => {
    onDisk = "base: &base\n  a: 1\nchild:\n  <<: *base\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/anchors.yaml" projectId="proj" />);
    });

    // The anchored mapping and the merge key both render, but as text with no
    // input behind them.
    expect(await screen.findAllByText("source only")).toHaveLength(2);
    expect(screen.queryByLabelText("Value of <<")).toBeNull();
  });
});
