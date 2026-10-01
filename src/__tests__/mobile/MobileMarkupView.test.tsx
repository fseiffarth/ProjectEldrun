/**
 * The markup view's Submit (`MarkupView`): each marked page's layer goes up
 * through the inbox first, then the marks to `/markup`, and only the prompt
 * the desktop answers goes into the chat — a step that fails sends nothing
 * and keeps the layer. And the viewer offers Mark up only where there is a
 * chat to send to.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark } from "../../../mobile-web/src/markup/layer";

const store = vi.hoisted(() => ({
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
  clearLayer: vi.fn(async () => true),
}));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  ...store,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["layer"], { type: "image/png" })),
  composedPng: vi.fn(async () => new Blob(["composed"], { type: "image/png" })),
}));

import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const LAYER = addMark(EMPTY_LAYER, 1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] });

type Call = { url: string; method: string; body?: BodyInit | null };

function desktop(failUpload = false) {
  const calls: Call[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/inbox?name=")) {
      if (failUpload) return new Response(JSON.stringify({ error: "inbox_full" }), { status: 507 });
      uploads += 1;
      const name = decodeURIComponent(url.split("name=")[1]);
      return new Response(JSON.stringify({ attachment: { name, reference: `.eldrun/inbox/2026-${uploads}-${name}`, size: 6 } }), { status: 201 });
    }
    if (url.endsWith("/markup")) return new Response(JSON.stringify({ prompt: "Apply the changes I marked by hand on `plot.png`.", marked: null }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }));
  return calls;
}

function showPicture() {
  const image = screen.getByAltText("plot.png") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { value: 800 });
  Object.defineProperty(image, "naturalHeight", { value: 600 });
  fireEvent.load(image);
}

beforeEach(() => {
  store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
  store.clearLayer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkupView", () => {
  it("uploads the layer and the marked picture, then sends the desktop's prompt", async () => {
    const calls = desktop();
    const onSend = vi.fn(() => true);
    const onClose = vi.fn();
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={onClose} />);
    showPicture();
    const submit = await screen.findByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Apply the changes I marked by hand on `plot.png`."));
    const posts = calls.filter((call) => call.method === "POST").map((call) => call.url);
    expect(posts).toEqual([
      "/api/v1/tabs/t1/inbox?name=plot-p1-layer.png",
      "/api/v1/tabs/t1/inbox?name=plot-marked.png",
      "/api/v1/tabs/t1/markup",
    ]);
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith("/markup"))!.body));
    expect(body).toEqual({
      source: { outbox: PICTURE.name },
      pages: [{ n: 1, size: [800, 600], marks: LAYER.pages[1].marks, layer: ".eldrun/inbox/2026-1-plot-p1-layer.png" }],
      picture: ".eldrun/inbox/2026-2-plot-marked.png",
    });
    await waitFor(() => expect(store.clearLayer).toHaveBeenCalledWith("p1:outbox:20261001-120000-plot.png"));
    expect(onClose).toHaveBeenCalled();
  });

  it("sends nothing and keeps the layer when an upload fails", async () => {
    const calls = desktop(true);
    const onSend = vi.fn(() => true);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={() => {}} />);
    showPicture();
    const submit = await screen.findByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText(/page 1 could not be uploaded \(the project's inbox is full\)/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith("/markup"))).toBe(false);
    expect(store.clearLayer).not.toHaveBeenCalled();
  });

  it("keeps Submit off while nothing is marked", async () => {
    desktop();
    store.loadLayer.mockResolvedValue(null);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => true} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("OutboxViewer · Mark up", () => {
  const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
  const TEXT = { name: "notes.md", kind: "text/plain; charset=utf-8", size: 9, modified: 1_790_000_000 };

  it("offers Mark up on a PDF or picture only where a chat can take it", () => {
    desktop();
    const markup = { tabId: "t1", projectId: "p1", onSend: () => true };
    const { rerender } = render(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={() => {}} markup={markup} />);
    expect(screen.getByRole("button", { name: "Mark up paper.pdf" })).toBeTruthy();
    rerender(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Mark up paper.pdf" })).toBeNull();
    rerender(<OutboxViewer scope={{ tab: "t1" }} file={TEXT} onClose={() => {}} markup={markup} />);
    expect(screen.queryByRole("button", { name: /Mark up/ })).toBeNull();
  });
});
