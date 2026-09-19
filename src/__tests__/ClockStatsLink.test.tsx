import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { Clock } from "../components/header/Clock";
import { OPEN_STATS_EVENT } from "../components/stats/StatsRecapHost";
import { useHeaderHoverMenuStore } from "../stores/headerHoverMenu";

describe("Clock → usage recap", () => {
  const opened = vi.fn();

  beforeEach(() => {
    useHeaderHoverMenuStore.setState({ openId: null });
    window.addEventListener(OPEN_STATS_EVENT, opened);
  });

  afterEach(() => {
    cleanup();
    window.removeEventListener(OPEN_STATS_EVENT, opened);
    opened.mockReset();
  });

  it("clicking the clock opens the recap and closes the hover menu", () => {
    render(<Clock />);
    const btn = screen.getByRole("button", { expanded: false });
    fireEvent.focus(btn);
    expect(useHeaderHoverMenuStore.getState().openId).toBe("clock");
    fireEvent.click(btn);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
  });

  it("clicking the Today's stats heading opens the recap", () => {
    render(<Clock />);
    fireEvent.focus(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Today's stats" }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
  });
});
