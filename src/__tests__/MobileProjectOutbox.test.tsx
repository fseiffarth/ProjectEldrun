/**
 * The shelf under the project screen's tab cards: what the desktop sent this
 * project with `eldrun-send` (`.eldrun/outbox/`).
 *
 * The files belong to the project, not to one of its sessions, so this screen
 * reads them by the project id — a file sent from a tab that has since been
 * closed is still on the shelf — and shows the newest few, with the rest one
 * tap behind the same gallery sheet the Focus screen opens.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../mobile-web/src/screens/Project";

const TABS = [
  { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
];

function hostWith(files: unknown[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") {
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: TABS,
    }), { status: 200 });
  });
}

const picture = (name: string, modified: number) => ({ name, kind: "image/png", size: 48_000, modified });

describe("Mobile project — the files the desktop sent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stands under the tab cards and loads its thumbnails by the project, not by a tab", async () => {
    vi.stubGlobal("fetch", hostWith([
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    // Below the agent tabs, which is the whole point of the placement.
    expect(shelf.previousElementSibling?.className).toBe("cards");
    expect(within(shelf).getByRole("heading", { name: "From the desktop" })).toBeTruthy();
    expect(shelf.textContent).toContain("2 files in the project's outbox");
    expect(Array.from(shelf.querySelectorAll(".outbox-entry strong")).map((name) => name.textContent))
      .toEqual(["plot.png", "notes.txt"]);
    expect(shelf.querySelector("img")?.getAttribute("src")).toBe("/api/v1/projects/p1/outbox/plot.png");

    // The picture opens full screen, from the same project-scoped URL.
    fireEvent.click(within(shelf).getByRole("button", { name: "Open plot.png" }));
    expect(screen.getByRole("dialog", { name: "plot.png" }).querySelector("img")?.getAttribute("src"))
      .toBe("/api/v1/projects/p1/outbox/plot.png");
  });

  it("opens a PDF in the browser's own viewer and keeps the shelf short, with the rest in the gallery", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", hostWith([
      { name: "paper.pdf", kind: "application/pdf", size: 4_000, modified: 1_770_000_009 },
      ...Array.from({ length: 7 }, (_, i) => picture(`shot-${i}.png`, 1_770_000_000 - i)),
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    // Six of the eight here; the count says how many there are in all.
    expect(shelf.querySelectorAll(".outbox-entry").length).toBe(6);
    expect(shelf.textContent).toContain("8 files in the project's outbox");

    fireEvent.click(within(shelf).getByRole("button", { name: "Open paper.pdf" }));
    expect(open).toHaveBeenCalledWith("/api/v1/projects/p1/outbox/paper.pdf", "_blank", "noopener");

    fireEvent.click(within(shelf).getByRole("button", { name: "All 8 files" }));
    const gallery = await screen.findByRole("dialog", { name: "Files from the agent" });
    expect(gallery.querySelectorAll(".outbox-entry").length).toBe(8);
    fireEvent.click(within(gallery).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Files from the agent" })).toBeNull());
  });

  it("draws no shelf at all when the desktop has sent nothing", async () => {
    vi.stubGlobal("fetch", hostWith([]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    await screen.findByRole("button", { name: "Open Claude" });
    expect(screen.queryByRole("region", { name: "Files from the desktop" })).toBeNull();
  });
});
