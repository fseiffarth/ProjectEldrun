/**
 * Both of the tab bar's own menus — the tab right-click menu and the "+" add
 * menu — close when you click somewhere else.
 *
 * They used to dismiss off a document `mousedown` listener, which never fired
 * for a click that landed inside a pane the document can't see into (a
 * sandboxed viewer/mail/reader <iframe>, or a terminal that swallowed the
 * event) — the menu stayed open over the app. Both now render through
 * `ContextMenuPortal`, whose full-viewport catcher takes the press before any
 * pane does.
 *
 * Proves, for each: the catcher is there and closes the menu, a right-click
 * elsewhere closes it too (no native menu stacking on top), Escape closes it,
 * and a press on the menu itself still leaves it open so its rows can fire.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TabBar } from "../../components/tabs/TabBar";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useDragStore } from "../../stores/drag/drag";

function reset() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useDragStore.setState({ drag: null });
}

function renderBar() {
  useTabsStore.getState().addTab({ label: "shell", cmd: "bash", cwd: "/p", kind: "shell" });
  const groupId = allGroups(useTabsStore.getState().layout)[0].id;
  return render(<TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />);
}

function openTabMenu() {
  const { container } = renderBar();
  fireEvent.contextMenu(container.querySelector(".tab")!);
  const menu = document.querySelector(".tab-new-menu");
  expect(menu).toBeTruthy();
  return { menu: menu as HTMLElement };
}

function openAddMenu() {
  const { container } = renderBar();
  fireEvent.click(container.querySelector(".tab-new-btn")!);
  const menu = document.querySelector(".tab-add-menu");
  expect(menu).toBeTruthy();
  return { menu: menu as HTMLElement };
}

const catcher = () => document.querySelector(".context-menu-catcher") as HTMLElement | null;
const menuGone = () => document.querySelector(".tab-new-menu") === null;

describe.each([
  ["the tab context menu", openTabMenu],
  ["the + add menu", openAddMenu],
])("%s's dismissal", (_name, open) => {
  beforeEach(() => {
    reset();
    cleanup();
  });

  it("covers the viewport with a catcher and closes on a press on it", () => {
    open();
    expect(catcher()).toBeTruthy();
    fireEvent.pointerDown(catcher()!);
    expect(menuGone()).toBe(true);
  });

  it("closes on a right-click elsewhere", () => {
    open();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(catcher()!, event);
    // The native menu is suppressed so it can't stack on top of this one.
    expect(event.defaultPrevented).toBe(true);
    expect(menuGone()).toBe(true);
  });

  it("closes on Escape", () => {
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menuGone()).toBe(true);
  });

  it("stays open for a press on the menu itself", () => {
    const { menu } = open();
    fireEvent.pointerDown(menu);
    expect(menuGone()).toBe(false);
  });
});

describe("the + add menu's search box", () => {
  beforeEach(() => {
    reset();
    cleanup();
    // jsdom has no layout: the menu scrolls its highlighted row into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  // The menu's own Escape contract (AddTabMenuList): the first Escape clears a
  // typed query and stops there; only an empty-query Escape closes the menu.
  // The portal's Escape handler is on the document, so the input's
  // stopPropagation has to keep it from ever getting the key.
  it("eats the first Escape to clear the query, then the next one closes", () => {
    openAddMenu();
    const input = document.querySelector("input.tab-new-menu-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "shel" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(menuGone()).toBe(false);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(menuGone()).toBe(true);
  });
});
