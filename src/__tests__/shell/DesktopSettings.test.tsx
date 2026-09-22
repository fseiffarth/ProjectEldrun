import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import { SETTINGS_ANCHORS } from "../../components/layout/settingsUi";

const scroll = vi.fn();
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = scroll;
  scroll.mockClear();
  useSettingsStore.setState({ settings: {} } as never);
});

describe("settings category navigation", () => {
  it("honors the Mobile deep link once and restores the user's subsequent scroll after a subpanel", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor={SETTINGS_ANCHORS.mobile} />); });
    expect(scroll.mock.instances).toContain(document.getElementById(SETTINGS_ANCHORS.mobile));
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    const main = document.querySelector(".settings-panel-content .dialog-scroll")!;
    main.scrollTop = 480;
    await act(async () => { fireEvent.click(within(nav).getByRole("button", { name: "Git Hosting" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Back/ })); });
    expect(document.querySelector(".settings-panel-content .dialog-scroll")!.scrollTop).toBe(480);
    fireEvent.click(within(nav).getByRole("button", { name: "Calendar" }));
    expect(scroll.mock.instances).toContain(document.getElementById("settings-anchor-calendar"));
  });

  it("opens an existing named subpanel and offers a compact route to the main sections", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialPanel="git" />); });
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings categories" }));
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "Mobile" })); });
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });
});
