import { beforeEach, describe, expect, it, vi } from "vitest";
import { detachedWindowVisible } from "../lib/window/detachedVisibility";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const windowState = (visible: boolean, minimized: boolean) => ({
  isVisible: async () => visible,
  isMinimized: async () => minimized,
});

describe("detached window visibility", () => {
  beforeEach(() => { invoke.mockReset(); });

  it("pauses a Wayland popout even when GTK reports visible and not minimized", async () => {
    invoke.mockResolvedValue(true);
    expect(await detachedWindowVisible(windowState(true, false))).toBe(false);
    expect(invoke).toHaveBeenCalledWith("detached_window_is_parked");
    invoke.mockResolvedValue(false);
    expect(await detachedWindowVisible(windowState(true, false))).toBe(true);
  });

  it("keeps hidden and manually minimized windows paused", async () => {
    invoke.mockResolvedValue(false);
    expect(await detachedWindowVisible(windowState(false, false))).toBe(false);
    expect(await detachedWindowVisible(windowState(true, true))).toBe(false);
  });

  it("uses native visibility when hot reload reaches an older backend", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    expect(await detachedWindowVisible(windowState(true, false))).toBe(true);
    expect(await detachedWindowVisible(windowState(false, false))).toBe(false);
  });
});
