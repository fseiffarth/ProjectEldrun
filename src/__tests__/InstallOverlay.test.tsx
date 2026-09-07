/**
 * One-click installs now surface as a centered overlay terminal instead of only
 * a toast pointing at the root scope: `runInstallInTab` still opens the root
 * tab that owns the PTY (the install must keep running when the overlay goes),
 * and additionally opens `InstallOverlayHost`, whose TerminalView is attach-only
 * on that same PTY. These tests lock the wiring: the overlay names the exact
 * PTY the root tab spawns, closing it hands off with a toast rather than
 * killing anything, and a root tab closed out from under it takes the overlay
 * down silently.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The overlay never spawns — assert the props instead of mounting xterm.
const terminalProps: Array<Record<string, unknown>> = [];
vi.mock("../components/terminal/TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    terminalProps.push(props);
    return null;
  },
}));

import { runInstallInTab } from "../lib/installCommand";
import { useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import { useInstallOverlayStore } from "../stores/installOverlay";
import { InstallOverlayHost } from "../components/layout/InstallOverlay";

beforeEach(() => {
  cleanup();
  terminalProps.length = 0;
  useTabsStore.setState({ tabsByScope: {} });
  useProjectsStore.setState({ rootDir: "/home/u/eldrun/root", activeId: "p1", switchToast: null });
  useInstallOverlayStore.setState({ ptyId: null, label: "" });
});

describe("runInstallInTab", () => {
  it("opens the root tab AND the overlay on that tab's PTY", () => {
    runInstallInTab("Install LaTeX", "sudo apt-get install -y texlive", "bash");

    // The root tab is unchanged behavior: it owns the PTY and the command.
    const root = useTabsStore.getState().tabsByScope["root"] ?? [];
    expect(root).toHaveLength(1);
    expect(root[0].cmd).toBe("/bin/bash");
    expect(root[0].initialInput).toBe("sudo apt-get install -y texlive");
    // The active project stays put — the overlay is what surfaces the install.
    expect(useProjectsStore.getState().activeId).toBe("p1");

    // The overlay mirrors exactly that tab's PTY (scope-qualified, TabPane's rule).
    const overlay = useInstallOverlayStore.getState();
    expect(overlay.ptyId).toBe(`root:${root[0].key}`);
    expect(overlay.label).toBe("Install LaTeX");
  });
});

describe("InstallOverlayHost", () => {
  function openInstall(label = "Install LaTeX") {
    runInstallInTab(label, "echo hi", "default");
    return (useTabsStore.getState().tabsByScope["root"] ?? [])[0];
  }

  it("renders an attach-only terminal on the install PTY", () => {
    const tab = openInstall();
    render(<InstallOverlayHost />);

    expect(screen.getByRole("dialog", { name: "Install LaTeX" })).toBeTruthy();
    expect(terminalProps).toHaveLength(1);
    // Attach-only + no initialInput: the root pane owns spawn and command —
    // the overlay must never re-type or respawn.
    expect(terminalProps[0].id).toBe(`root:${tab.key}`);
    expect(terminalProps[0].attachOnly).toBe(true);
    expect(terminalProps[0].initialInput).toBeUndefined();
    expect(terminalProps[0].visible).toBe(true);
  });

  it("close is a hand-off: overlay gone, tab kept, toast points at root", () => {
    openInstall();
    render(<InstallOverlayHost />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useInstallOverlayStore.getState().ptyId).toBeNull();
    // The install keeps running — the root tab is untouched.
    expect(useTabsStore.getState().tabsByScope["root"] ?? []).toHaveLength(1);
    expect(useProjectsStore.getState().switchToast).toMatch(/root terminal/i);
  });

  it("closes silently when the root tab it mirrors is closed", () => {
    openInstall();
    render(<InstallOverlayHost />);
    expect(screen.queryByRole("dialog")).toBeTruthy();

    // The tab is closed from the root scope's own strip; its PTY dies with it.
    act(() => {
      useTabsStore.setState({ tabsByScope: { root: [] } });
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useInstallOverlayStore.getState().ptyId).toBeNull();
    // No "still running" toast — it is not still running.
    expect(useProjectsStore.getState().switchToast).toBeNull();
  });
});
