/**
 * The popout half of the Wayland retire handshake. Before the backend closes
 * an inactive scope's popout it asks the popout to settle; the popout saves
 * what autosave would save anyway and answers whether anything unsaved is left
 * — which keeps the window (minimized) instead of losing the work with it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup as rtlCleanup, act } from "@testing-library/react";
import { createElement, useState } from "react";

const shared = vi.hoisted(() => ({
  handlers: new Map<string, (ev: { payload: unknown }) => void>(),
  invoke: vi.fn((..._a: unknown[]) => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => shared.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    shared.handlers.set(event, handler);
    return Promise.resolve(() => shared.handlers.delete(event));
  },
}));

import {
  answerRetireRequests,
  registerUnsavedWork,
  retireRequestEvent,
  retireWithdrawnEvent,
  RETIRE_INERT_MS,
  settleUnsavedWork,
  useUnsavedWork,
} from "../../lib/window/unsavedWork";
import { DraftSaver } from "../../components/embed/draftSaver";
import { CompareView } from "../../components/embed/CompareView";

const LABEL = "detached-p-g-1";

async function ask(): Promise<unknown> {
  shared.invoke.mockClear();
  shared.handlers.get(retireRequestEvent(LABEL))?.({ payload: null });
  await vi.waitFor(() => expect(shared.invoke).toHaveBeenCalled());
  const [cmd, args] = shared.invoke.mock.calls[0];
  expect(cmd).toBe("detached_retire_ack");
  return (args as { clean: boolean }).clean;
}

/** A YAML-cell-like inline editor: keeps its value locally, commits on blur. */
function InlineCell({ onCommit }: { onCommit: (v: string) => void }) {
  const [buf, setBuf] = useState("");
  return createElement("input", {
    "data-testid": "cell",
    value: buf,
    onChange: (e: { target: { value: string } }) => setBuf(e.target.value),
    onBlur: () => { if (buf) onCommit(buf); },
  });
}

describe("retire handshake (popout side)", () => {
  const cleanup: Array<() => void> = [];
  beforeEach(async () => {
    rtlCleanup();
    for (const fn of cleanup.splice(0)) fn();
    document.body.removeAttribute("inert");
    shared.handlers.clear();
    shared.invoke.mockClear();
    cleanup.push(await answerRetireRequests(LABEL));
    // Drop any input block an earlier case left held (module state).
    shared.handlers.get(retireWithdrawnEvent(LABEL))?.({ payload: null });
    shared.invoke.mockImplementation(() => Promise.resolve(true));
  });

  it("a popout announces it can answer once its listener is attached", async () => {
    await vi.waitFor(() =>
      expect(shared.invoke.mock.calls.map((c) => c[0])).toContain("detached_retire_ready"),
    );
    expect(shared.handlers.has(retireRequestEvent(LABEL))).toBe(true);
  });

  it("a clean answer blocks input until the backend says the window stays", async () => {
    expect(await ask()).toBe(true);
    await vi.waitFor(() => expect(document.body.hasAttribute("inert")).toBe(true));
    shared.handlers.get(retireWithdrawnEvent(LABEL))?.({ payload: null });
    expect(document.body.hasAttribute("inert")).toBe(false);
  });

  it("an answer nobody was waiting for lifts the block at once", async () => {
    // The scope came back first: the backend's ack reports no live request.
    shared.invoke.mockImplementation(() => Promise.resolve(false));
    expect(await ask()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // The backend said it was not waiting: nothing is left blocking input.
    expect(document.body.hasAttribute("inert")).toBe(false);
  });

  it("the backstop lifts only its own hold, never a newer one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      expect(await ask()).toBe(true); // hold 1
      await vi.waitFor(() => expect(document.body.hasAttribute("inert")).toBe(true));
      vi.advanceTimersByTime(RETIRE_INERT_MS / 2);
      expect(await ask()).toBe(true); // hold 2, taken halfway through hold 1
      vi.advanceTimersByTime(RETIRE_INERT_MS / 2 + 10);
      // Hold 1's backstop fired; hold 2 still stands.
      expect(document.body.hasAttribute("inert")).toBe(true);
      vi.advanceTimersByTime(RETIRE_INERT_MS / 2);
      expect(document.body.hasAttribute("inert")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dirty answer leaves the page usable", async () => {
    const un = registerUnsavedWork({ dirty: () => true });
    expect(await ask()).toBe(false);
    expect(document.body.hasAttribute("inert")).toBe(false);
    un();
  });

  it("a half-typed inline edit is committed by a blur before the sample", async () => {
    let draft = "";
    const saved: string[] = [];
    // The file's draft: dirty until autosave flushes it.
    const un = registerUnsavedWork({
      dirty: () => draft !== (saved[saved.length - 1] ?? ""),
      flush: async () => {
        if (draft) saved.push(draft);
      },
    });
    const view = render(createElement(InlineCell, { onCommit: (v: string) => { draft = v; } }));
    const cell = view.getByTestId("cell") as HTMLInputElement;
    cell.focus();
    fireEvent.change(cell, { target: { value: "new value" } });
    expect(document.activeElement).toBe(cell);
    expect(await settleUnsavedWork(200)).toBe(true);
    // Without the blur the cell's value never reached the draft or the disk.
    expect(saved).toEqual(["new value"]);
    un();
  });

  it("an autosaving view passes its own flush and live flag (the deck)", async () => {
    const state = { dirty: true };
    const flush = vi.fn(async () => {
      state.dirty = false; // written; the rendered flag lags a render behind
    });
    function Deck() {
      useUnsavedWork(true, flush, () => state.dirty);
      return null;
    }
    render(createElement(Deck));
    expect(await settleUnsavedWork(200)).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("a merge with picks not yet applied keeps the popout; a plain diff does not", async () => {
    const props = {
      path: "/p/a.txt",
      left: { text: "one\ntwo\n", title: "Local" },
      rightText: "one\nTWO\n",
      onClose: () => {},
    };
    const diff = render(createElement(CompareView, props));
    expect(await settleUnsavedWork(50)).toBe(true);
    diff.unmount();

    const merge = render(createElement(CompareView, { ...props, onApply: () => {} }));
    expect(await settleUnsavedWork(50)).toBe(true); // nothing picked yet
    await act(async () => {
      fireEvent.click(merge.getByTitle("Take the local (mirror) side for every change"));
    });
    expect(await settleUnsavedWork(50)).toBe(false);
    merge.unmount();
    expect(await settleUnsavedWork(50)).toBe(true);
  });

  it("a popout with nothing unsaved answers clean", async () => {
    expect(await ask()).toBe(true);
  });

  it("autosave's pending write is flushed first, then the popout is clean", async () => {
    const written: string[] = [];
    const saver = new DraftSaver(async (t) => {
      written.push(t);
    });
    saver.update("edited", "on disk", true, true);
    cleanup.push(
      registerUnsavedWork({ dirty: () => saver.dirty, flush: () => saver.flushIfAutosave() }),
    );
    expect(await ask()).toBe(true);
    expect(written).toEqual(["edited"]);
    saver.dispose();
  });

  it("with autosave off nothing is written and the popout stays (not clean)", async () => {
    const write = vi.fn(() => Promise.resolve());
    const saver = new DraftSaver(write);
    saver.update("edited", "on disk", true, false);
    cleanup.push(
      registerUnsavedWork({ dirty: () => saver.dirty, flush: () => saver.flushIfAutosave() }),
    );
    expect(await ask()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("a failed save leaves the popout unclean", async () => {
    const saver = new DraftSaver(() => Promise.reject(new Error("disk full")));
    saver.update("edited", "on disk", true, true);
    cleanup.push(
      registerUnsavedWork({ dirty: () => saver.dirty, flush: () => saver.flushIfAutosave() }),
    );
    expect(await ask()).toBe(false);
    saver.dispose();
  });

  it("a source that cannot flush (a rearranged PDF) keeps the window", async () => {
    let dirty = true;
    const un = registerUnsavedWork({ dirty: () => dirty });
    expect(await settleUnsavedWork(50)).toBe(false);
    dirty = false;
    expect(await settleUnsavedWork(50)).toBe(true);
    un();
  });

  it("a flush that never finishes is bounded and counts as unsaved", async () => {
    const un = registerUnsavedWork({ dirty: () => true, flush: () => new Promise(() => {}) });
    expect(await settleUnsavedWork(20)).toBe(false);
    un();
  });
});
