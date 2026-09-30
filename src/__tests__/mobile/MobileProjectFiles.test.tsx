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
    { token: "tok-readme", name: "README.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000, created: 1_760_000_000 },
    { token: "tok-plot", name: "plot.png", kind: "image/png", size: 48_000, modified: 1_770_000_000 },
    { token: "tok-paper", name: "paper.pdf", kind: "application/pdf", size: 90_000, modified: 1_770_000_000 },
  ],
  truncated: false,
};
const SRC = {
  entries: [{ token: "tok-main", name: "main.rs", kind: "text/plain; charset=utf-8", size: 13, modified: 1_770_000_000 }],
  truncated: false,
};

function hostWith(files: boolean, tickets = true) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // A mobile host from before the ticket route: the router knows the path
    // only as a static GET, so the POST is 405 with no body.
    if (url === "/api/v1/open-ticket" && !tickets) return new Response(null, { status: 405 });
    if (url === "/api/v1/open-ticket") {
      const { url: target } = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({ url: `${target}&ticket=t1` }), { status: 200 });
    }
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
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    expect(sheet.textContent).toContain("Read-only");
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    expect(Array.from(sheet.querySelectorAll(".option-list strong")).map((row) => row.textContent))
      .toEqual(["📁 src", "📄 README.md", "🖼 plot.png", "📄 paper.pdf"]);
    // Each row says when it was last edited, and created where the desktop's
    // filesystem keeps a birth time (README here, not the folder).
    const meta = Array.from(sheet.querySelectorAll(".option-list small")).map((row) => row.textContent ?? "");
    expect(meta[0]).toContain("Edited ");
    expect(meta[0]).not.toContain("Created");
    expect(meta[1]).toMatch(/^8 B · Created .+ · Edited .+$/);

    // Into a folder, and back by the trail's first crumb (the project's name).
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    const trail = within(sheet).getByRole("navigation", { name: "Folders" });
    expect(within(trail).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Alpha", "src"]);
    fireEvent.click(within(trail).getByRole("button", { name: "Alpha" }));
    await within(sheet).findByRole("button", { name: "Open README.md" });

    // A PDF opens in the viewer first, for its Save and Share (the browser's
    // own PDF viewer has neither), then goes on to the browser by its token,
    // with a ticket: that tab is outside the app, where the strict session
    // cookie does not follow.
    fireEvent.click(within(sheet).getByRole("button", { name: "Open paper.pdf" }));
    const pdf = screen.getByRole("dialog", { name: "paper.pdf" });
    expect(within(pdf).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-paper&download=1");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(pdf).getByRole("button", { name: "Open paper.pdf" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/v1/projects/p1/files/raw?f=tok-paper&ticket=t1", "_blank", "noopener"));
    fireEvent.click(within(pdf).getByRole("button", { name: "Close" }));

    // A picture opens full screen, loaded by its token, with Save beside it.
    fireEvent.click(await screen.findByRole("button", { name: "Open plot.png" }));
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

  it("shares a file straight from its row, without opening it", async () => {
    const files = hostWith(true);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "/api/v1/projects/p1/files/raw?f=tok-plot" ? new Response(new Uint8Array([1, 2, 3, 4])) : files(input, init));
    vi.stubGlobal("fetch", fetch);
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    try {
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      const heading = await screen.findByRole("heading", { name: "Alpha" });
      await waitFor(() => {
        swipe(heading, 100, 300);
        expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
      });
      const sheet = screen.getByRole("dialog", { name: "Files" });
      await within(sheet).findByRole("button", { name: "Share plot.png" });
      // Every file gets one; a folder has nothing to share.
      expect(within(sheet).getAllByRole("button", { name: /^Share / }).map((button) => button.getAttribute("aria-label")))
        .toEqual(["Share README.md", "Share plot.png", "Share paper.pdf"]);

      fireEvent.click(within(sheet).getByRole("button", { name: "Share plot.png" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(sheet).getByRole("button", { name: "Share plot.png" }).hasAttribute("disabled")).toBe(false));
      const sent = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
      expect([sent.name, sent.type, sent.size]).toEqual(["plot.png", "image/png", 4]);
      // The bytes came by the file's token, and no viewer opened over the list.
      expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/raw?f=tok-plot");
      expect(screen.queryByRole("dialog", { name: "plot.png" })).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "canShare");
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("says the mobile host is outdated instead of opening a PDF it cannot ticket", async () => {
    vi.stubGlobal("fetch", hostWith(true, false));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open paper.pdf" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "paper.pdf" })).getByRole("button", { name: "Open paper.pdf" }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining("Reconnect")));
    expect(open).not.toHaveBeenCalled();
  });

  it("opens from the screen's left edge, where a drawer is pulled from", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 4, 200);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
  });

  it("opens from the dropdown under the project's name too", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Project menu" })).getByRole("menuitem", { name: "Project files" }));
    expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Project menu" })).toBeNull();
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
