/**
 * Tests for cross-viewer / cross-window PDF page dragging (`stores/pdfDrag`).
 *
 * The two things that MUST hold, because getting either wrong loses a page:
 *
 *  1. **Exactly one window claims a drop.** Every window receives the same broadcast
 *     END; only the one whose outer rect actually contains the released cursor may
 *     take the pages and acknowledge. A window the cursor is nowhere near must stay
 *     silent — otherwise the pages land in two documents at once.
 *
 *  2. **A Shift-drag (a MOVE) deletes from the source only once the drop is
 *     acknowledged.** Released over empty desktop, or over a window that refuses it,
 *     the pages must survive.
 *
 * Tauri's event bus and window geometry are mocked, so the whole protocol runs in
 * jsdom without a real second window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Tauri mocks ──────────────────────────────────────────────────────────────
/** Every event emitted by the code under test, in order. */
const emitted: { event: string; payload: unknown }[] = [];
/** Handlers registered via `listen`, by event name. */
const handlers = new Map<string, ((ev: { payload: unknown }) => void)[]>();

/** Deliver an event to this window's listeners, as the Tauri bus would. */
function deliver(event: string, payload: unknown) {
  for (const h of handlers.get(event) ?? []) h({ payload });
}

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return Promise.resolve(() => {
      const cur = handlers.get(event) ?? [];
      handlers.set(
        event,
        cur.filter((h) => h !== handler),
      );
    });
  },
}));

// This window sits at physical (1000,1000), 800x600, scale 1. So desktop point
// (1100,1100) is inside it (client 100,100), and (50,50) is far outside.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    innerPosition: () => Promise.resolve({ x: 1000, y: 1000 }),
    outerPosition: () => Promise.resolve({ x: 1000, y: 1000 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
  }),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

import {
  registerPageStrip,
  resolveDropTarget,
  listenForeignPageDrags,
  awaitDropAck,
  PDF_DRAG_START,
  PDF_DRAG_END,
  PDF_DROP_ACK,
  type PageTransfer,
} from "../stores/pdfDrag";

/** A strip occupying client rect (0,0)-(200,400), which imports into `landed`. */
function mountStrip(id: string, landed: { transfer: PageTransfer; index: number }[]) {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 }) as DOMRect;
  document.body.appendChild(el);
  return registerPageStrip(id, {
    el,
    indexAt: () => 3, // a fixed insertion point; the geometry itself is tested elsewhere
    onImport: (transfer, index) => landed.push({ transfer, index }),
    setCaret: () => {},
  });
}

/** Let the mocked promises (snapshotFrame, listen registration) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("cross-window page drops", () => {
  let unlisten: (() => void) | null = null;

  beforeEach(() => {
    emitted.length = 0;
    handlers.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    unlisten?.();
    unlisten = null;
  });

  it("claims a drop released over THIS window, and acknowledges it", async () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    unlisten = await listenForeignPageDrags();

    // A drag starts in another window; we snapshot our own frame.
    deliver(PDF_DRAG_START, { originLabel: "detached_1", count: 2 });
    await settle();

    // ...and is released at desktop (1100,1100) — inside us, over the strip.
    deliver(PDF_DRAG_END, {
      originLabel: "detached_1",
      token: "clip1",
      count: 2,
      physX: 1100,
      physY: 1100,
      shift: false,
      cancelled: false,
    });

    expect(landed).toEqual([{ transfer: { token: "clip1", count: 2 }, index: 3 }]);
    expect(emitted).toContainEqual({
      event: PDF_DROP_ACK,
      payload: { token: "clip1", accepted: true },
    });
    unmount();
  });

  it("ignores a drop released over a DIFFERENT window, and does not acknowledge it", async () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    unlisten = await listenForeignPageDrags();

    deliver(PDF_DRAG_START, { originLabel: "detached_1", count: 1 });
    await settle();

    // Released at desktop (50,50): nowhere near us. Were we to claim it, the pages
    // would be inserted in two documents at once.
    deliver(PDF_DRAG_END, {
      originLabel: "detached_1",
      token: "clip9",
      count: 1,
      physX: 50,
      physY: 50,
      shift: true,
      cancelled: false,
    });

    expect(landed).toEqual([]);
    expect(emitted.filter((e) => e.event === PDF_DROP_ACK)).toEqual([]);
    unmount();
  });

  it("ignores the drag it emitted itself (the bus echoes to the sender)", async () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    unlisten = await listenForeignPageDrags();

    // Same label as this window: our OWN drag, already handled through the DOM.
    // Acting on it as well would import the pages a second time.
    deliver(PDF_DRAG_START, { originLabel: "main", count: 1 });
    await settle();
    deliver(PDF_DRAG_END, {
      originLabel: "main",
      token: "clip2",
      count: 1,
      physX: 1100,
      physY: 1100,
      shift: false,
      cancelled: false,
    });

    expect(landed).toEqual([]);
    expect(emitted.filter((e) => e.event === PDF_DROP_ACK)).toEqual([]);
    unmount();
  });

  it("does not claim a cancelled drag", async () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    unlisten = await listenForeignPageDrags();

    deliver(PDF_DRAG_START, { originLabel: "detached_1", count: 1 });
    await settle();
    deliver(PDF_DRAG_END, {
      originLabel: "detached_1",
      token: "clip3",
      count: 1,
      physX: 1100,
      physY: 1100,
      shift: false,
      cancelled: true,
    });

    expect(landed).toEqual([]);
    unmount();
  });
});

describe("the move (Shift) handshake", () => {
  beforeEach(() => {
    emitted.length = 0;
    handlers.clear();
  });

  it("reports the drop as taken once a window acknowledges it", async () => {
    const pending = awaitDropAck("clip1", 1000);
    await settle();
    deliver(PDF_DROP_ACK, { token: "clip1", accepted: true });
    await expect(pending).resolves.toBe(true);
  });

  it("does NOT report a drop as taken when it was refused", async () => {
    const pending = awaitDropAck("clip1", 1000);
    await settle();
    deliver(PDF_DROP_ACK, { token: "clip1", accepted: false });
    await expect(pending).resolves.toBe(false);
  });

  it("ignores an acknowledgement for a DIFFERENT transfer", async () => {
    const pending = awaitDropAck("clip1", 60);
    await settle();
    deliver(PDF_DROP_ACK, { token: "someone-elses", accepted: true });
    // Nobody acknowledged OUR pages, so a Shift-drag must not delete them.
    await expect(pending).resolves.toBe(false);
  });

  it("gives up when nobody claims the drop, so a move never destroys the pages", async () => {
    // Released over empty desktop: no window takes them. The source keeps them.
    await expect(awaitDropAck("clip1", 60)).resolves.toBe(false);
  });
});

describe("resolveDropTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds the strip under the point, and where in it the pages land", () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    expect(resolveDropTarget({ x: 100, y: 100 })).toEqual({ stripId: "rail-a", index: 3 });
    expect(resolveDropTarget({ x: 900, y: 900 })).toBeNull(); // outside every strip
    unmount();
  });

  it("skips the strip the drag came from — that is a reorder, not a transfer", () => {
    const landed: { transfer: PageTransfer; index: number }[] = [];
    const unmount = mountStrip("rail-a", landed);
    expect(resolveDropTarget({ x: 100, y: 100 }, "rail-a")).toBeNull();
    unmount();
  });
});
