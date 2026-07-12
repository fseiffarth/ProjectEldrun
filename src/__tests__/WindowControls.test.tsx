import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WindowControls } from "../components/header/WindowControls";

const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockMaximize = vi.fn().mockResolvedValue(undefined);
const mockUnmaximize = vi.fn().mockResolvedValue(undefined);
const mockIsMaximized = vi.fn().mockResolvedValue(false);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    maximize: mockMaximize,
    unmaximize: mockUnmaximize,
    isMaximized: mockIsMaximized,
    close: mockClose,
  }),
  currentMonitor: vi.fn().mockResolvedValue(null),
  LogicalSize: class {},
  LogicalPosition: class {},
}));

describe("WindowControls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("minimize button calls win.minimize()", async () => {
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Minimize"));
    expect(mockMinimize).toHaveBeenCalledOnce();
  });

  it("maximize button maximizes when the window is not maximized", async () => {
    mockIsMaximized.mockResolvedValue(false);
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Maximize"));
    expect(mockMaximize).toHaveBeenCalledOnce();
    expect(mockUnmaximize).not.toHaveBeenCalled();
  });

  it("close button calls win.close()", async () => {
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Close"));
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
