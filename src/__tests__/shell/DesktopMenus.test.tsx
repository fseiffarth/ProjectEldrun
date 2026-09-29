import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsMenu } from "../../components/header/SettingsMenu";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderMenu } from "../../hooks/useHeaderMenu";

function ExampleMenu() {
  const menu = useHeaderMenu("test");
  return <><div ref={menu.ref} onKeyDown={menu.onKeyDown} onBlur={menu.onBlur} onMouseLeave={menu.scheduleClose}>
    <button onClick={menu.reveal}>Launcher</button>
    {menu.open && <div><button>First</button><button disabled>Disabled</button><button>Last</button></div>}
  </div><button>Outside</button></>;
}
beforeEach(() => useHeaderHoverMenuStore.setState({ openId: null }));
afterEach(() => vi.useRealTimers());
describe("header menu keyboard behavior", () => {
  it("opens Settings with Arrow Down, traverses actions, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Settings" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Check for updates" }));
    await user.keyboard("{Home}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Feature Guide" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("supports Space and Enter, skips disabled actions, and lets Tab exit", async () => {
    const user = userEvent.setup();
    render(<ExampleMenu />);
    screen.getByRole("button", { name: "Launcher" }).focus();
    await user.keyboard(" ");
    expect(document.activeElement).toBe(screen.getByText("First"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByText("Last"));
    await user.keyboard("{Home}");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByText("Outside"));
    expect(screen.queryByText("First")).toBeNull();
    screen.getByRole("button", { name: "Launcher" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByText("First"));
  });

  it("keeps a menu open past the pointer grace while keyboard focus is inside", () => {
    vi.useFakeTimers();
    const { container } = render(<ExampleMenu />);
    fireEvent.click(screen.getByText("Launcher"));
    screen.getByText("Last").focus();
    fireEvent.mouseLeave(container.querySelector("div")!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("First")).toBeTruthy();
  });
});
