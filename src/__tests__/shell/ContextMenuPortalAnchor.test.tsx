/**
 * A menu dropped from a button (`keepBelow`) hangs under that button whatever
 * its height: it is never shifted up to fit, it is capped to the room below
 * the anchor, and the overflow scrolls inside it.
 *
 * The tab "+" menu is the case. Its entry list grows with the installed agents,
 * and the plain cursor clamp slid a tall one up until its top sat 8px from the
 * window's top edge — laid over the tab strip it dropped from, no longer
 * reading as that button's menu. Cursor menus keep the old behaviour, so both
 * halves are asserted here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { ContextMenuPortal } from "../../components/common/ContextMenuPortal";

const realRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: realRect,
  });
});

/** jsdom measures everything as 0×0 — give the menu a real height. */
function sizeMenus(height: number) {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (!this.classList.contains("context-menu-portal")) {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
      }
      const top = parseFloat(this.style.top || "0");
      const left = parseFloat(this.style.left || "0");
      return {
        top, left, width: 200, height,
        right: left + 200, bottom: top + height,
      } as DOMRect;
    },
  });
}

const menu = () => document.querySelector<HTMLElement>(".context-menu-portal")!;

describe("ContextMenuPortal anchoring", () => {
  it("keeps a keepBelow menu at its anchor and caps it to the room below", () => {
    sizeMenus(2000); // far taller than the 768px-high test window
    render(
      <ContextMenuPortal x={40} y={64} onClose={() => {}} keepBelow>
        <div />
      </ContextMenuPortal>,
    );
    expect(menu().style.top).toBe("64px");
    expect(menu().style.maxHeight).toBe("calc(100vh - 72px)");
  });

  it("still clamps a keepBelow menu horizontally", () => {
    sizeMenus(100);
    render(
      <ContextMenuPortal x={window.innerWidth - 20} y={64} onClose={() => {}} keepBelow>
        <div />
      </ContextMenuPortal>,
    );
    expect(parseFloat(menu().style.left)).toBe(window.innerWidth - 8 - 200);
    expect(menu().style.top).toBe("64px");
  });

  it("shifts a cursor menu up, as before", () => {
    sizeMenus(400);
    render(
      <ContextMenuPortal x={40} y={window.innerHeight - 50} onClose={() => {}}>
        <div />
      </ContextMenuPortal>,
    );
    expect(parseFloat(menu().style.top)).toBe(window.innerHeight - 8 - 400);
    expect(menu().style.maxHeight).toBe("");
  });
});
