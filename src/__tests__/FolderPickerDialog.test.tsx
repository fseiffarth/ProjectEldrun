import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { FolderPickerDialog } from "../components/common/FolderPickerDialog";

const dirs: Record<string, string[]> = { "/proj": ["src"], "/proj/src": [] };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string, args: Record<string, string>) => {
    if (cmd === "list_dirs") {
      const path = args.path || "/proj";
      const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
      return Promise.resolve({
        path,
        parent,
        entries: (dirs[path] ?? []).map((name) => ({ name, path: `${path}/${name}` })),
      });
    }
    if (cmd === "create_dir") {
      const full = `${args.projectDir}/${args.relPath}`;
      dirs[full] = [];
      dirs[args.projectDir] = [...(dirs[args.projectDir] ?? []), args.relPath];
      return Promise.resolve();
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
});

describe("FolderPickerDialog — New folder", () => {
  it("is absent unless allowCreateFolder is set", async () => {
    render(<FolderPickerDialog initialPath="/proj" title="Pick" confirmLabel="Use" onConfirm={() => {}} onClose={() => {}} />);
    await screen.findByText("src");
    expect(screen.queryByText(/New folder/)).toBeNull();
  });

  it("creates a sub-folder of the browsed folder and enters it", async () => {
    const onConfirm = vi.fn();
    render(
      <FolderPickerDialog
        initialPath="/proj"
        boundPath="/proj"
        title="Pick"
        confirmLabel="Use"
        allowCreateFolder
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await screen.findByText("src");
    fireEvent.click(screen.getByText(/New folder/));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "build" } });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_dir", { projectDir: "/proj", relPath: "build" }));
    await waitFor(() => expect(screen.getByTitle("/proj/build")).toBeTruthy());
    fireEvent.click(screen.getByText("Use"));
    expect(onConfirm).toHaveBeenCalledWith("/proj/build", undefined);
  });

  it("refuses a name with a slash without calling the backend", async () => {
    render(
      <FolderPickerDialog initialPath="/proj" title="Pick" confirmLabel="Use" allowCreateFolder onConfirm={() => {}} onClose={() => {}} />,
    );
    await screen.findByText("src");
    fireEvent.click(screen.getByText(/New folder/));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "../out" } });
    expect(screen.getByText(/single folder name/)).toBeTruthy();
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("create_dir", expect.anything());
  });
});
