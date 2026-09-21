/**
 * Settings → Layout says so when the desktop cannot hide other apps' windows on
 * a project switch (the `null` / `kde-wayland` workspace backends), and says
 * nothing otherwise — including when the backend predates the command, which
 * is routine here (`src/` hot-reloads ahead of `src-tauri/`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { WorkspaceParkingNote } from "../../components/layout/SettingsPanel";

async function mount() {
  const view = render(<WorkspaceParkingNote />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

describe("WorkspaceParkingNote", () => {
  beforeEach(() => {
    cleanup();
    invoke.mockReset();
  });

  it("explains a desktop that cannot park windows", async () => {
    invoke.mockResolvedValue({ backend: "null", can_park: false });
    const { container } = await mount();
    expect(invoke).toHaveBeenCalledWith("workspace_capabilities");
    expect(container.textContent).toContain("can't hide other apps' windows");
  });

  it("says nothing where windows are parked", async () => {
    invoke.mockResolvedValue({ backend: "x11", can_park: true });
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });

  it("says nothing when the backend has no such command", async () => {
    invoke.mockRejectedValue(new Error("command workspace_capabilities not found"));
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });
});
