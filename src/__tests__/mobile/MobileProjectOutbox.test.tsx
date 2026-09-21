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

import { Project } from "../../../mobile-web/src/screens/Project";

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

  it("reaches the whole gallery from the shelf and from the header, however few files there are", async () => {
    vi.stubGlobal("fetch", hostWith([
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    // Two files fit on the shelf, and the gallery is still one tap away: the
    // whole listing used to be reachable only once the shelf had to cut
    // something off, which left the project screen with no gallery at all.
    fireEvent.click(within(shelf).getByRole("button", { name: "All 2 files" }));
    const shelfGallery = await screen.findByRole("dialog", { name: "Files from the agent" });
    expect(shelfGallery.querySelectorAll(".outbox-entry").length).toBe(2);
    fireEvent.click(within(shelfGallery).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Files from the agent" })).toBeNull());

    // And from the header, where the Focus screen keeps the same button: the
    // shelf sits under however many tab cards the project has.
    const header = document.querySelector("header") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "Files from the agent (2)" }));
    expect((await screen.findByRole("dialog", { name: "Files from the agent" })).querySelectorAll(".outbox-entry").length).toBe(2);
  });

  it("offers Save on every tile, the picture included", async () => {
    vi.stubGlobal("fetch", hostWith([
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    // A thumbnail carries no ⋯, so saving a picture the desktop sent meant
    // opening it full screen first and finding Save in there.
    const save = within(shelf).getByRole("link", { name: "Save plot.png" });
    expect(save.getAttribute("href")).toBe("/api/v1/projects/p1/outbox/plot.png?download=1");
    expect(save.getAttribute("download")).toBe("plot.png");
    expect(within(shelf).getByRole("link", { name: "Save notes.txt" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/outbox/notes.txt?download=1");
  });

  it("deletes a file from its tile, after asking, and drops the tile without waiting for a poll", async () => {
    const calls: string[] = [];
    let files = [
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files }), { status: 200 });
      if (url.startsWith("/api/v1/projects/p1/outbox/")) {
        files = files.filter((file) => !url.endsWith(`/${file.name}`));
        return new Response(JSON.stringify({ removed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        project: { id: "p1", label: "Alpha", status: "active" },
        desktop_available: true,
        agents: [],
        tabs: TABS,
      }), { status: 200 });
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    // One tap does not delete: the 🗑 sits a thumb-width from the tile that
    // opens the picture, and nothing here can be undone.
    fireEvent.click(within(shelf).getByRole("button", { name: "Delete plot.png" }));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(shelf).getByRole("button", { name: "Keep" }));
    expect(within(shelf).getByRole("button", { name: "Delete plot.png" })).toBeTruthy();

    fireEvent.click(within(shelf).getByRole("button", { name: "Delete plot.png" }));
    fireEvent.click(within(within(shelf).getByRole("group", { name: "Delete plot.png?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/v1/projects/p1/outbox/plot.png"));
    // Gone from the shelf at once, and the count with it — the poll is 8 s away.
    await waitFor(() => expect(Array.from(shelf.querySelectorAll(".outbox-entry strong")).map((n) => n.textContent)).toEqual(["notes.txt"]));
    expect(shelf.textContent).toContain("1 file in the project's outbox");
  });

  it("keeps the tile when the sidecar refuses the delete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/projects/p1/outbox") {
        return new Response(JSON.stringify({ files: [picture("plot.png", 1_770_000_000)] }), { status: 200 });
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify({ error: "delete_failed" }), { status: 500 });
      return new Response(JSON.stringify({
        project: { id: "p1", label: "Alpha", status: "active" },
        desktop_available: true,
        agents: [],
        tabs: TABS,
      }), { status: 200 });
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const shelf = await screen.findByRole("region", { name: "Files from the desktop" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Delete plot.png" }));
    fireEvent.click(within(within(shelf).getByRole("group", { name: "Delete plot.png?" })).getByRole("button", { name: "Delete" }));

    // A file that is still there must not read as gone.
    expect((await within(shelf).findByRole("alert")).textContent).toBe("The file could not be deleted.");
    expect(Array.from(shelf.querySelectorAll(".outbox-entry strong")).map((n) => n.textContent)).toEqual(["plot.png"]);
  });

  it("draws no shelf at all when the desktop has sent nothing", async () => {
    vi.stubGlobal("fetch", hostWith([]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    await screen.findByRole("button", { name: "Open Claude" });
    expect(screen.queryByRole("region", { name: "Files from the desktop" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Files from the agent/ })).toBeNull();
  });
});
