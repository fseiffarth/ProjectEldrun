import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WindowControls } from "../components/header/WindowControls";

const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
  }),
}));

describe("WindowControls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("minimize button calls win.minimize()", async () => {
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Minimize"));
    expect(mockMinimize).toHaveBeenCalledOnce();
  });

  it("maximize button calls win.toggleMaximize()", async () => {
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Maximize"));
    expect(mockToggleMaximize).toHaveBeenCalledOnce();
  });

  it("close button calls win.close()", async () => {
    render(<WindowControls />);
    await userEvent.click(screen.getByTitle("Close"));
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
