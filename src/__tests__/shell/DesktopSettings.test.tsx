import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import { SETTINGS_ANCHORS } from "../../components/layout/settingsUi";

beforeEach(() => {
  useSettingsStore.setState({ settings: {} } as never);
});

const nav = () => screen.getByRole("navigation", { name: "Settings categories" });
const links = () => nav().querySelector(".settings-navigation-links") as HTMLElement;
const mainScroll = () => document.querySelector(".settings-panel-content .dialog-scroll") as HTMLElement;

describe("settings category navigation", () => {
  it("opens one page per entry and honors the Mobile deep link", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor={SETTINGS_ANCHORS.mobile} />); });
    // The deep link lands on the Mobile page alone — not a long scroll that
    // happens to contain it.
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeTruthy();
    expect(document.getElementById("settings-anchor-general")).toBeNull();
    expect(within(nav()).getByRole("button", { name: "Mobile" }).getAttribute("aria-current")).toBe("location");

    fireEvent.click(within(nav()).getByRole("button", { name: "Calendar" }));
    expect(document.getElementById("settings-anchor-calendar")).toBeTruthy();
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeNull();
  });

  it("groups the entries by topic and keeps General to its own page", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    const agents = within(nav()).getByRole("group", { name: "Agents" });
    expect(within(agents).getByRole("button", { name: "Manage CLIs" })).toBeTruthy();
    expect(within(agents).getByRole("button", { name: "Root console" })).toBeTruthy();
    const general = within(nav()).getByRole("group", { name: "General" });
    expect(within(general).getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("location");
    // General's page holds the theme picker and nothing from other pages.
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(document.getElementById("settings-anchor-rootConsole")).toBeNull();
    expect(document.getElementById("settings-anchor-experimental")).toBeNull();
  });

  it("restores a page's scroll after a subpanel round trip", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    mainScroll().scrollTop = 480;
    await act(async () => { fireEvent.click(within(nav()).getByRole("button", { name: "Git Hosting" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Back/ })); });
    expect(mainScroll().scrollTop).toBe(480);
  });

  it("opens an existing named subpanel and offers a compact route to the pages", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialPanel="git" />); });
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings categories" }));
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "Mobile" })); });
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("searches the entries by the labels of the settings on their page", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    const search = screen.getByRole("textbox", { name: "Search settings…" });
    fireEvent.change(search, { target: { value: "zoom" } });
    const buttons = within(links()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["LayoutWindow zoom"]);
    // Enter opens the first match.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(document.getElementById("settings-anchor-layout")).toBeTruthy();
    // Escape clears the query before it could close the dialog.
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(within(nav()).getByRole("button", { name: "Calendar" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "no such setting anywhere" } });
    expect(within(links()).queryAllByRole("button")).toEqual([]);
    expect(within(nav()).getByText("No setting matches")).toBeTruthy();
  });
});
