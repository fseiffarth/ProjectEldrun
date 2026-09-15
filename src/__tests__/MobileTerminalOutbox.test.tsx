import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../mobile-web/src/screens/Terminal";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const NOW = 1_788_609_600; // 2026-09-04 12:00:00 UTC

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

/** A fetch that answers the outbox listing with whatever `images` holds at
 * the time of the call — the folder the agent fills between polls. */
function outboxFetch(images: () => unknown[]) {
  return vi.fn((url: string) => url.endsWith("/outbox")
    ? Promise.resolve(jsonResponse(200, { files: images() }))
    : Promise.resolve(jsonResponse(404, { error: "not_found" })));
}

describe("Eldrun Mobile Focus shows the pictures the agent left in the project's outbox", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the outbox on open, renders each image from the tab's own route, and opens one full-screen", async () => {
    const fetchMock = outboxFetch(() => [
      { name: "plot.png", kind: "image/png", size: 48_000, modified: NOW - 90 },
      { name: "shot-1.jpg", kind: "image/jpeg", size: 1_300_000, modified: NOW - 7_200 },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/v1/tabs/tab-7/outbox"]);
    const strip = screen.getByRole("region", { name: "Files from the agent" });
    expect(strip.textContent).toContain("From the agent");
    expect(strip.textContent).toContain("2 files");
    // The thumbnails load from the sidecar's own route — same origin, the
    // session cookie is the credential — never from a path.
    const thumbs = Array.from(strip.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(thumbs).toEqual(["/api/v1/tabs/tab-7/outbox/plot.png", "/api/v1/tabs/tab-7/outbox/shot-1.jpg"]);
    expect(strip.textContent).toContain("2 min ago");
    expect(strip.textContent).toContain("2 h ago");

    fireEvent.click(screen.getByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/plot.png");
    expect(viewer.textContent).toContain("47 KB");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the strip on ✕ and shows it again only for a picture that arrived afterwards", async () => {
    const images: unknown[] = [{ name: "plot.png", kind: "image/png", size: 48_000, modified: NOW - 90 }];
    vi.stubGlobal("fetch", outboxFetch(() => images));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("region", { name: "Files from the agent" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide these files" }));
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();

    // Coming back to the page re-reads the folder; the same picture stays
    // hidden, a new one shows on its own.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();

    images.unshift({ name: "diagram.png", kind: "image/png", size: 9_000, modified: NOW - 5 });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    const strip = screen.getByRole("region", { name: "Files from the agent" });
    expect(strip.textContent).toContain("1 file");
    expect(Array.from(strip.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual(["/api/v1/tabs/tab-7/outbox/diagram.png"]);
  });

  it("opens text as inert text, PDFs in a new tab, and binary files as downloads", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
      ? jsonResponse(200, { files: [
        { name: "notes.svg", kind: "text/plain; charset=utf-8", size: 80, modified: NOW },
        { name: "paper.pdf", kind: "application/pdf", size: 400, modified: NOW },
        { name: "data.zip", kind: "application/octet-stream", size: 400, modified: NOW },
      ] }) : new Response("<svg onload='alert(1)'>inert text</svg>"))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open notes.svg" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "notes.svg" });
    expect(dialog.querySelector("pre")?.textContent).toContain("<svg onload=");
    expect(dialog.querySelector("svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open paper.pdf" }));
    expect(open).toHaveBeenCalledWith("/api/v1/tabs/tab-7/outbox/paper.pdf", "_blank", "noopener");
    const link = screen.getByRole("link", { name: "Open data.zip" });
    expect(link.getAttribute("href")).toBe("/api/v1/tabs/tab-7/outbox/data.zip?download=1");
    expect(link.getAttribute("download")).toBe("data.zip");
  });

  it("shares the prepared file from the actions sheet when supported", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    try {
      vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
        ? jsonResponse(200, { files: [{ name: "data.zip", kind: "application/octet-stream", size: 4, modified: NOW }] })
        : new Response(new Uint8Array([80, 75, 0, 1])))));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "File actions for data.zip" }));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Share…" }));
      expect(share).toHaveBeenCalledTimes(1);
      const file = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
      expect(file.name).toBe("data.zip");
      expect(file.type).toBe("application/octet-stream");
      expect(file.size).toBe(4);
    } finally {
      Reflect.deleteProperty(navigator, "canShare");
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("caps the inline text preview and offers the whole file", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
      ? jsonResponse(200, { files: [{ name: "large.log", kind: "text/plain; charset=utf-8", size: 2 * 1024 * 1024, modified: NOW }] })
      : new Response("x".repeat(2 * 1024 * 1024)))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open large.log" }));
    await settle();
    expect(screen.getByRole("dialog").querySelector("pre")?.textContent?.length).toBe(1024 * 1024);
    expect(screen.getByRole("link", { name: "Open the whole file" }).getAttribute("target")).toBe("_blank");
  });

  it("shows nothing for an empty or unreachable outbox", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();
  });
});
