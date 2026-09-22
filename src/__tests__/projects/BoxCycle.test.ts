/**
 * The box cycle chord (`cycleBox` in hooks/useKeyboard): walks the boxes in
 * row order and opens the next / previous one, and is also the way INTO the
 * boxes from a project or the root scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { cycleBox } from "../../hooks/useKeyboard";
import { useBoxesStore } from "../../stores/boxes";
import { useTabsStore } from "../../stores/tabs";
import { SHORTCUT_DEFS, findConflicts } from "../../lib/shortcuts/shortcuts";
import type { ProjectBox } from "../../types";

function box(id: string, position: number): ProjectBox {
  return { id, name: id, member_ids: [], position };
}

describe("cycleBox", () => {
  const openBox = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    openBox.mockClear();
    // Row order is by position, not array order.
    useBoxesStore.setState({ boxes: [box("c", 3), box("a", 1), box("b", 2)], openBox });
    useTabsStore.setState({ scope: "root" });
  });

  it("steps into the first box from outside any box, and into the last walking back", () => {
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("a");
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("c");
  });

  it("walks the ring in row order and wraps", () => {
    useTabsStore.setState({ scope: "box:b" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("c");
    useTabsStore.setState({ scope: "box:c" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("a");
    useTabsStore.setState({ scope: "box:a" });
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("c");
  });

  it("does nothing without boxes, or on a ring of one already in scope", () => {
    useBoxesStore.setState({ boxes: [] });
    cycleBox(1);
    expect(openBox).not.toHaveBeenCalled();
    useBoxesStore.setState({ boxes: [box("only", 1)] });
    useTabsStore.setState({ scope: "box:only" });
    cycleBox(1);
    expect(openBox).not.toHaveBeenCalled();
  });

  it("has a rebindable chord each way that collides with no other default", () => {
    const actions = SHORTCUT_DEFS.map((s) => s.action);
    expect(actions).toContain("cycleBox");
    expect(actions).toContain("cycleBoxBack");
    expect(findConflicts({}).size).toBe(0);
  });
});
