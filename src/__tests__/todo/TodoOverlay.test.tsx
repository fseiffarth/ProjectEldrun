// The to-do window (`todo/TodoOverlay`) wears mail's root-console chrome: mark,
// a single fixed Board tab, the controls' ×. Escape and a backdrop press close
// it; a press inside the frame does not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The board is its own subject (and a heavy one); only the chrome is under test.
vi.mock("../../components/todo/TodoPane", () => ({
  TodoPane: () => <div data-testid="todo-pane" />,
}));
vi.mock("../../components/layout/OverlayApprovals", () => ({ OverlayApprovals: () => null }));

import { TodoOverlayHost } from "../../components/todo/TodoOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: { todo_board: true }, loaded: true } as never);
  useTodoStore.setState({ overlayOpen: true });
});
afterEach(cleanup);

describe("the to-do window", () => {
  it("has mail's bar: mark, one active Board tab, and the subwindow ×", () => {
    render(<TodoOverlayHost />);
    const frame = screen.getByRole("dialog", { name: "To-do board" });
    expect(frame.classList.contains("root-overlay")).toBe(true);
    expect(frame.querySelector(".root-overlay-bar .app-overlay-label")?.textContent).toBe("To-do");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toBe("Board");
    expect(tabs[0].classList.contains("active")).toBe(true);
    // Never closable: no × on the tab itself.
    expect(tabs[0].querySelector("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useTodoStore.getState().overlayOpen).toBe(false);
  });

  it("closes on Escape and on a backdrop press, not on a press inside", () => {
    render(<TodoOverlayHost />);
    fireEvent.mouseDown(screen.getByTestId("todo-pane"));
    expect(useTodoStore.getState().overlayOpen).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTodoStore.getState().overlayOpen).toBe(false);

    act(() => useTodoStore.getState().openOverlay());
    const backdrop = document.querySelector(".app-overlay-backdrop")!;
    fireEvent.mouseDown(backdrop);
    expect(useTodoStore.getState().overlayOpen).toBe(false);
  });

  it("renders nothing while the board is switched off", () => {
    useSettingsStore.setState({ settings: { todo_board: false } } as never);
    render(<TodoOverlayHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
