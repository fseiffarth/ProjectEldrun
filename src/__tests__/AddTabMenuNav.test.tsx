import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddTabMenuList, type AddMenuGroup } from "../components/tabs/AddTabMenuList";

// jsdom has no layout, so keeping the cursor on screen is a stub here.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const picks = {
  claude: vi.fn(),
  codex: vi.fn(),
  shell: vi.fn(),
  files: vi.fn(),
};

/** Agents (with a disabled row in the middle), Shell, Files — the shape the
 *  real menu has, minus the probes. */
function groups(): AddMenuGroup[] {
  return [
    {
      label: "Agents",
      entries: [
        { key: "claude", label: "Claude", color: "#fff", onPick: picks.claude },
        { key: "gemini", label: "Gemini", color: "#fff", disabled: true, onPick: vi.fn() },
        { key: "codex", label: "Codex", color: "#fff", onPick: picks.codex },
      ],
      compactEntries: [
        { key: "claude", label: "Claude", color: "#fff", onPick: picks.claude },
        { key: "codex", label: "Codex", color: "#fff", onPick: picks.codex },
      ],
      moreLabel: "More agents & CLIs…",
    },
    {
      label: "Shell",
      entries: [{ key: "shell", label: "Shell", color: "#fff", onPick: picks.shell }],
    },
    {
      label: "Files",
      entries: [{ key: "files", label: "Files (Project)", color: "#fff", onPick: picks.files }],
    },
  ];
}

const active = () => document.querySelector(".tab-new-menu-item.enter-target")?.textContent;
const search = () => screen.getByRole("textbox");
const row = (name: RegExp) => screen.getByRole("button", { name });

describe("AddTabMenuList keyboard navigation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("highlights nothing until the user moves, then enters the list at the top", async () => {
    render(<AddTabMenuList groups={groups()} />);
    expect(active()).toBeUndefined();
    await userEvent.type(search(), "{ArrowDown}");
    expect(active()).toContain("Claude");
  });

  it("↑ from nothing enters at the bottom, and both ends wrap", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.type(search(), "{ArrowUp}");
    expect(active()).toContain("Files (Project)");
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toContain("Claude");
  });

  it("steps over a disabled entry", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.type(search(), "{ArrowDown}{ArrowDown}");
    expect(active()).toContain("Codex"); // never the disabled Gemini between them
  });

  it("Enter picks the highlighted entry, not the first one", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.type(search(), "{ArrowDown}{ArrowDown}{Enter}");
    expect(picks.codex).toHaveBeenCalledOnce();
    expect(picks.claude).not.toHaveBeenCalled();
  });

  it("a query highlights its first match, and ↓ walks the filtered results", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.type(search(), "c");
    expect(active()).toContain("Claude");
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toContain("Codex");
    await userEvent.keyboard("{Enter}");
    expect(picks.codex).toHaveBeenCalledOnce();
  });

  it("keeps only quick picks idle, while search exposes every agent", async () => {
    render(<AddTabMenuList groups={groups()} />);
    expect(screen.queryByRole("button", { name: /Gemini/ })).toBeNull();
    await userEvent.type(search(), "gem");
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeTruthy();
  });

  it("opens the remaining agents in a neighbouring More menu", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.click(screen.getByRole("button", { name: /More agents/ }));
    expect(document.querySelector(".tab-new-menu-more")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeTruthy();
  });

  it("editing the query resets the cursor", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.type(search(), "c{ArrowDown}");
    expect(active()).toContain("Codex");
    await userEvent.type(search(), "{Backspace}"); // back to an empty query
    expect(active()).toBeUndefined();
  });

  it("hovering a row moves the same cursor the keys use", async () => {
    render(<AddTabMenuList groups={groups()} />);
    await userEvent.pointer({ target: row(/Shell/), coords: { x: 1, y: 1 } });
    expect(active()).toContain("Shell");
    await userEvent.type(search(), "{ArrowDown}");
    expect(active()).toContain("Files (Project)");
  });
});
