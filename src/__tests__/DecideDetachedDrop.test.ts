/**
 * #42: the UNIFIED cross-window drop decision (`decideDetachedTabDrop` /
 * `decideDetachedGroupDrop`). These pure functions choose ONE destination for a
 * dragged popout tab/group the SAME way regardless of which window the drag began
 * in — the main-window host (`CenterPanel`'s `DETACHED_DRAG_END`) dispatches on
 * their result. Guards the two reported bugs at the decision level:
 *   • Shift over the SOURCE popout must resolve to `newWindow`, not a local no-op
 *     (the old "shift-drop over same popout hangs" bug).
 *   • A tab over a SIBLING popout must resolve to `dockDetached`, not `newWindow`
 *     (the old "popout→popout spawns a stray window" bug).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { decideDetachedTabDrop, decideDetachedGroupDrop } from "../stores/detached";

const base = {
  cancelled: false,
  shift: false,
  inMain: false,
  overPopoutId: null as string | null,
  srcGroupId: "src",
};

describe("decideDetachedTabDrop", () => {
  it("cancelled → local (the source popout already handled it / no-op)", () => {
    expect(decideDetachedTabDrop({ ...base, cancelled: true }).kind).toBe("local");
    // Cancel wins even when shift / inMain / a sibling are also set.
    expect(
      decideDetachedTabDrop({
        ...base,
        cancelled: true,
        shift: true,
        inMain: true,
        overPopoutId: "b",
      }).kind,
    ).toBe("local");
  });

  it("Shift → newWindow, overriding main, sibling, and the source popout", () => {
    expect(decideDetachedTabDrop({ ...base, shift: true }).kind).toBe("newWindow");
    expect(decideDetachedTabDrop({ ...base, shift: true, inMain: true }).kind).toBe("newWindow");
    expect(decideDetachedTabDrop({ ...base, shift: true, overPopoutId: "b" }).kind).toBe(
      "newWindow",
    );
    // Shift over the SOURCE popout itself — the old hang — now resolves cleanly.
    expect(decideDetachedTabDrop({ ...base, shift: true, overPopoutId: "src" }).kind).toBe(
      "newWindow",
    );
  });

  it("over a SIBLING popout → dockDetached into it (wins over inMain)", () => {
    expect(decideDetachedTabDrop({ ...base, overPopoutId: "b" })).toEqual({
      kind: "dockDetached",
      toGroupId: "b",
    });
    // A popout overlapping the main window: the popout wins.
    expect(
      decideDetachedTabDrop({ ...base, overPopoutId: "b", inMain: true }).kind,
    ).toBe("dockDetached");
  });

  it("the SOURCE popout is never a sibling dock target", () => {
    // overPopoutId === source is ignored (a self-drop is committed locally in the
    // popout); with no shift and not inMain it falls through to free-space newWindow.
    expect(decideDetachedTabDrop({ ...base, overPopoutId: "src" }).kind).toBe("newWindow");
    expect(decideDetachedTabDrop({ ...base, overPopoutId: "src", inMain: true }).kind).toBe(
      "dockMain",
    );
  });

  it("over the MAIN window → dockMain; free space → newWindow", () => {
    expect(decideDetachedTabDrop({ ...base, inMain: true }).kind).toBe("dockMain");
    expect(decideDetachedTabDrop({ ...base }).kind).toBe("newWindow");
  });
});

describe("decideDetachedGroupDrop", () => {
  it("Shift / cancelled / free space / sibling popout → float (stays its own window)", () => {
    expect(decideDetachedGroupDrop({ ...base, shift: true }).kind).toBe("float");
    expect(decideDetachedGroupDrop({ ...base, cancelled: true }).kind).toBe("float");
    expect(decideDetachedGroupDrop({ ...base }).kind).toBe("float");
    expect(decideDetachedGroupDrop({ ...base, overPopoutId: "b" }).kind).toBe("float");
  });

  it("over the MAIN window → dockMain, but Shift over main still floats", () => {
    expect(decideDetachedGroupDrop({ ...base, inMain: true }).kind).toBe("dockMain");
    expect(decideDetachedGroupDrop({ ...base, shift: true, inMain: true }).kind).toBe("float");
  });
});
