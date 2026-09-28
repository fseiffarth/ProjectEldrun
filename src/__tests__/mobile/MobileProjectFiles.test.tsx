/**
 * The project screen's read-only file browser (#31bo, `ProjectFiles`): a drawer
 * a left→right swipe opens while the desktop's "Project files on the phone" switch is on,
 * folders walked by the sealed tokens the sidecar hands out — never a path —
 * and files opened in the outbox's viewer, fetched by their token.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const ROOT = {
  entries: [
    { token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 },
    { token: "tok-readme", name: "README.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000 },
    { token: "tok-plot", name: "plot.png", kind: "image/png", size: 48_000, modified: 1_770_000_000 },
    { token: "tok-paper", name: "paper.pdf", kind: "application/pdf", size: 90_000, modified: 1_770_000_000 },
  ],
  truncated: false,
};
const SRC = {
  entries: [{ token: "tok-main", name: "main.rs", kind: "text/plain; charset=utf-8", size: 13, modified: 1_770_000_000 }],
  truncated: false,
};

function hostWith(files: boolean) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (url === "/api/v1/projects/p1/files") return new Response(JSON.stringify(ROOT), { status: 200 });
    if (url === "/api/v1/projects/p1/files?dir=tok-src") return new Response(JSON.stringify(SRC), { status: 200 });
    if (url === "/api/v1/projects/p1/files/raw?f=tok-readme") return new Response("# Hello\n", { status: 200 });
    if (url.startsWith("/api/v1/projects/p1/files")) return new Response(JSON.stringify({ error: "file_not_found" }), { status: 404 });
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [],
      files,
    }), { status: 200 });
  });
}

/** A one-finger flick from `from` to `to`, dispatched the way `focusSwipe`
 * listens: touch pointer events where the engine has them, touch events
 * otherwise. */
function swipe(target: Element, from: number, to: number) {
  act(() => {
    if ("PointerEvent" in window) {
      const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true, clientY: 300 };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to }));
    } else {
      const touchEvent = (type: string, clientX: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touch = { identifier: 7, target, clientX, clientY: 300 };
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [touch] });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        return event;
      };
      target.dispatchEvent(touchEvent("touchstart", from));
      target.dispatchEvent(touchEvent("touchend", to));
    }
  });
}

describe("Mobile project — read-only file browser", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens nothing on a swipe while the desktop's switch is off", async () => {
    const fetch = hostWith(false);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1", expect.anything()));
    swipe(await screen.findByRole("heading", { name: "Alpha" }), 100, 300);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files"))).toBe(false);
  });

  it("walks folders by token, back along the trail, and opens files by token", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const heading = await screen.findByRole("heading", { name: "Alpha" });
    // The header has no button for it: the drawer is the swipe's alone.
    expect(screen.queryByRole("button", { name: "Project files" })).toBeNull();
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    expect(sheet.textContent).toContain("Read-only");
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    expect(Array.from(sheet.querySelectorAll(".option-list strong")).map((row) => row.textContent))
      .toEqual(["📁 src", "📄 README.md", "🖼 plot.png", "📄 paper.pdf"]);

    // Into a folder, and back by the trail's first crumb (the project's name).
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    const trail = within(sheet).getByRole("navigation", { name: "Folders" });
    expect(within(trail).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Alpha", "src"]);
    fireEvent.click(within(trail).getByRole("button", { name: "Alpha" }));
    await within(sheet).findByRole("button", { name: "Open README.md" });

    // A PDF goes to the browser's viewer by its token.
    fireEvent.click(within(sheet).getByRole("button", { name: "Open paper.pdf" }));
    expect(open).toHaveBeenCalledWith("/api/v1/projects/p1/files/raw?f=tok-paper", "_blank", "noopener");

    // A picture opens full screen, loaded by its token, with Save beside it.
    fireEvent.click(within(sheet).getByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("/api/v1/projects/p1/files/raw?f=tok-plot");
    expect(within(viewer).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-plot&download=1");

    // Closing the viewer comes back to the same folder; a text reads inline.
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
    const text = screen.getByRole("dialog", { name: "README.md" });
    await waitFor(() => expect(text.querySelector("pre")?.textContent).toBe("# Hello\n"));
  });

  it("puts the drawer away on a right-to-left swipe over it", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const drawer = screen.getByRole("dialog", { name: "Files" });
    await within(drawer).findByRole("button", { name: "Open the folder src" });
    swipe(drawer, 300, 100);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
  });
});
