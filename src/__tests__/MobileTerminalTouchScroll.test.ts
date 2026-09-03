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

  it("pans the rows hidden below the fold before it scrolls history", () => {
    vi.stubGlobal("PointerEvent", class PointerEvent {});
    // The emulator carries the desktop window's row count, so its screen is
    // taller than the phone's box: 300px of it are out of sight.
    const host = document.createElement("div");
    Object.defineProperty(host, "clientHeight", { get: () => 340 });
    Object.defineProperty(host, "scrollHeight", { get: () => 640 });
    host.scrollTop = 300;
    const scrollLines = vi.fn();
    installTerminalTouchScroll(host, { scrollLines });

    const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
    Object.assign(down, { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 100 });
    host.dispatchEvent(down);

    // Dragging down asks for older output: the box walks back over the hidden
    // rows first, and the buffer stays where it is.
    const up = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(up, { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 380 });
    host.dispatchEvent(up);
    expect(host.scrollTop).toBe(20);
    expect(scrollLines).not.toHaveBeenCalled();

    // Past the top of the screen the same drag continues into the scrollback.
    const further = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(further, { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 464 });
    host.dispatchEvent(further);
    expect(host.scrollTop).toBe(0);
    expect(scrollLines).toHaveBeenCalledWith(-4);
  });

  it("leaves a sideways drag to the browser's horizontal pan", () => {
    vi.stubGlobal("PointerEvent", class PointerEvent {});
    const host = document.createElement("div");
    const scrollLines = vi.fn();
    installTerminalTouchScroll(host, { scrollLines });

    const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
    Object.assign(down, { pointerId: 3, pointerType: "touch", clientX: 300, clientY: 200 });
    host.dispatchEvent(down);
    const move = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(move, { pointerId: 3, pointerType: "touch", clientX: 210, clientY: 186 });
    host.dispatchEvent(move);

    // The wide session pans instead: no history scroll, and the gesture is left
    // for the scroll container rather than swallowed.
    expect(scrollLines).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);

    // The rest of that drag stays the browser's, even where it turns vertical.
    const further = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(further, { pointerId: 3, pointerType: "touch", clientX: 208, clientY: 60 });
    host.dispatchEvent(further);
    expect(scrollLines).not.toHaveBeenCalled();

    // A new drag decides afresh.
    const again = new Event("pointerup", { bubbles: true }) as PointerEvent;
    Object.assign(again, { pointerId: 3, pointerType: "touch", clientX: 208, clientY: 60 });
    host.dispatchEvent(again);
    const nextDown = new Event("pointerdown", { bubbles: true }) as PointerEvent;
    Object.assign(nextDown, { pointerId: 4, pointerType: "touch", clientX: 208, clientY: 300 });
    host.dispatchEvent(nextDown);
    const nextMove = new Event("pointermove", { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(nextMove, { pointerId: 4, pointerType: "touch", clientX: 204, clientY: 244 });
    host.dispatchEvent(nextMove);
    expect(scrollLines).toHaveBeenCalledWith(4);
  });

  it("keeps the same drag's touch events away from xterm's own touch scrolling", () => {
    // A phone fires Touch Events alongside Pointer Events. xterm listens for
    // them on its element inside the host and scrolls its viewport by the raw
    // delta, so the pointer path alone scrolled every drag twice.
    vi.stubGlobal("PointerEvent", class PointerEvent {});
    const host = document.createElement("div");
    const xtermElement = document.createElement("div");
    host.appendChild(xtermElement);
    const reachedXterm = vi.fn();
    xtermElement.addEventListener("touchstart", reachedXterm);
    xtermElement.addEventListener("touchmove", reachedXterm);
    const remove = installTerminalTouchScroll(host, { scrollLines: vi.fn() });

    const start = new Event("touchstart", { bubbles: true, cancelable: true });
    xtermElement.dispatchEvent(start);
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    xtermElement.dispatchEvent(move);
    expect(reachedXterm).not.toHaveBeenCalled();
    // Only the propagation is stopped: what the browser does with the gesture
    // (the host's `touch-action`) is untouched.
    expect(move.defaultPrevented).toBe(false);

    remove();
    xtermElement.dispatchEvent(new Event("touchmove", { bubbles: true }));
    expect(reachedXterm).toHaveBeenCalledTimes(1);
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
