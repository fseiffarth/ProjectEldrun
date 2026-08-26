import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalTouchScroll } from "../../mobile-web/src/terminal/touchScroll";

describe("Eldrun Mobile terminal touch scrolling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scrolls xterm history from a captured phone pointer drag", () => {
    vi.stubGlobal("PointerEvent", class PointerEvent {});
    const host = document.createElement("div");
    const scrollLines = vi.fn();
    const remove = installTerminalTouchScroll(host, { scrollLines });

    // jsdom's Event does not carry PointerEvent coordinates, so send the
    // browser fields the handler receives on a real phone.
    const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
    Object.assign(down, { pointerId: 7, pointerType: "touch", clientY: 200 });
    host.dispatchEvent(down);
    const move = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(move, { pointerId: 7, pointerType: "touch", clientY: 144 });
    host.dispatchEvent(move);

    expect(scrollLines).toHaveBeenCalledWith(4);
    expect(move.defaultPrevented).toBe(true);

    const up = new Event("pointerup", { bubbles: true }) as PointerEvent;
    Object.assign(up, { pointerId: 7, pointerType: "touch", clientY: 144 });
    host.dispatchEvent(up);
    const afterUp = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(afterUp, { pointerId: 7, pointerType: "touch", clientY: 88 });
    host.dispatchEvent(afterUp);
    expect(scrollLines).toHaveBeenCalledTimes(1);

    remove();
  });

  it("leaves mouse pointers alone", () => {
    vi.stubGlobal("PointerEvent", class PointerEvent {});
    const host = document.createElement("div");
    const scrollLines = vi.fn();
    installTerminalTouchScroll(host, { scrollLines });
    const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
    Object.assign(down, { pointerId: 1, pointerType: "mouse", clientY: 200 });
    host.dispatchEvent(down);
    const move = new Event("pointermove", { bubbles: true }) as PointerEvent;
    Object.assign(move, { pointerId: 1, pointerType: "mouse", clientY: 100 });
    host.dispatchEvent(move);
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
