import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/platform", () => ({ IS_LINUX: true }));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: vi.fn(() => ({
    innerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    outerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    outerSize: vi.fn(() => Promise.resolve({ width: 800, height: 600 })),
    scaleFactor: vi.fn(() => Promise.resolve(1)),
  })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it("refuses Wayland's successful dummy cursor and frame before hit testing", async () => {
  vi.mocked(invoke).mockResolvedValue(false);
  const { desktopCursor, snapshotFrame } = await import("../../lib/window/coords");
  await expect(desktopCursor()).rejects.toThrow("Desktop coordinates unavailable");
  const win = getCurrentWindow();
  await expect(snapshotFrame(win)).rejects.toThrow("Desktop coordinates unavailable");
  expect(cursorPosition).not.toHaveBeenCalled();
  expect(win.innerPosition).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_coordinates_supported");
});

it("allows a real desktop origin of zero on X11", async () => {
  vi.mocked(invoke).mockResolvedValue(true);
  const { desktopCursor, snapshotFrame } = await import("../../lib/window/coords");
  await expect(desktopCursor()).resolves.toEqual({ x: 0, y: 0 });
  await expect(snapshotFrame()).resolves.toMatchObject({ innerPhys: { x: 0, y: 0 }, scale: 1 });
  expect(cursorPosition).toHaveBeenCalledOnce();
});

it("declines global hit tests when an older backend cannot report support", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("unknown command"));
  const { desktopCoordinatesSupported } = await import("../../lib/window/coords");
  await expect(desktopCoordinatesSupported()).resolves.toBe(false);
});
