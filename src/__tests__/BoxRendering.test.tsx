/**
 * Component tests for box rendering in the switcher under the OVERLAY model
 * (#13/#41, N:M membership): member pills always render individually (with a
 * small box badge), each box renders as its own BoxPill placed by the box's
 * `position`, empty/1-member boxes survive and render (dimmed when empty), a
 * project can sit in several boxes at once (listed in each dropdown), dropping
 * a pill on a box is an ADDITIVE add, and Alt-drop on a pill boxes the two.
 *
 * The pill drag is pointer-driven (see ProjectPill's `startPillDrag`), not
 * native HTML5 DnD — jsdom gives every element a zero-sized rect, so the drag's
 * hit-testing is driven by stubbing `getBoundingClientRect`, the same approach
 * `PageStrip.test.tsx`/`DragDropSplit.test.tsx` take for their pointer drags.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";
import { usePillDragStore } from "../stores/pillDrag";

function proj(id: string, position: number): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[], position = 5): ProjectBox {
  return { id, name: id, member_ids: members, position };
}

/** Give an element a fixed layout rect, since jsdom's is always zero-sized. */
function layOut(
  el: HTMLElement,
  r: { left: number; right: number; top: number; bottom: number },
) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    width: r.right - r.left,
    height: r.bottom - r.top,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Dispatch a pointer event the way the existing drag tests do (`PageStrip`,
 *  `DragDropSplit`): jsdom's PointerEvent doesn't carry the fields the pointer
 *  gesture reads, so a plain Event is decorated with them. */
function pointer(
  type: string,
  x: number,
  y: number,
  target: EventTarget,
  opts: { altKey?: boolean } = {},
) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1, altKey: !!opts.altKey });
  act(() => {
    target.dispatchEvent(ev);
  });
}

function findPill(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll(".project-pill:not(.is-box)")].find(
    (el) => el.querySelector(".project-pill-label")?.textContent === name,
  ) as HTMLElement;
}

function boxPillOf(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll(".project-pill.is-box")].find(
    (el) => el.querySelector(".project-pill-label")?.textContent === name,
  ) as HTMLElement;
}

beforeEach(() => {
  usePillDragStore.getState().end();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  return container;
}

describe("box pill rendering (overlay model)", () => {
  it("renders every member as its OWN pill (with a box badge) beside the box pill", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();

    const boxPill = container.querySelector(".project-pill.is-box");
    expect(boxPill).toBeTruthy();
    expect(boxPill!.querySelector(".project-box-member-count")?.textContent).toBe("1");

    // OVERLAY: the member p1 keeps its own inline pill — nothing is folded away.
    const labels = [...container.querySelectorAll(".project-pill .project-pill-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toContain("boxA");
    expect(labels).toContain("p1");
    expect(labels).toContain("p2");

    // The member pill wears the box badge; the non-member doesn't.
    expect(findPill(container, "p1").querySelector(".project-pill-boxdot")).toBeTruthy();
    expect(findPill(container, "p2").querySelector(".project-pill-boxdot")).toBeNull();
  });

  it("a project in two boxes is listed in BOTH dropdowns", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], 5), box("boxB", ["p1"], 6)] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    for (const name of ["boxA", "boxB"]) {
      const pill = boxPillOf(container, name);
      await act(async () => {
        fireEvent.mouseEnter(pill);
      });
      const dropdown = document.querySelector(".project-box-dropdown");
      expect(dropdown?.textContent).toContain("p1");
      await act(async () => {
        fireEvent.mouseLeave(pill);
        await new Promise((r) => setTimeout(r, 200));
      });
    }
  });

  it("a 1-member box survives and renders; an empty box renders dimmed", async () => {
    useBoxesStore.setState({ boxes: [box("solo", ["p1"], 5), box("empty", [], 6)] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    const solo = boxPillOf(container, "solo");
    const empty = boxPillOf(container, "empty");
    expect(solo).toBeTruthy();
    expect(solo.classList.contains("is-empty")).toBe(false);
    expect(empty).toBeTruthy();
    expect(empty.classList.contains("is-empty")).toBe(true);
  });

  it("hovering the box pill lists members; clicking one switches to that project", async () => {
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      setActive,
    });

    const container = await renderSwitcher();
    const boxPill = container.querySelector(".project-pill.is-box") as HTMLElement;

    await act(async () => {
      fireEvent.mouseEnter(boxPill);
    });
    const dropdown = document.querySelector(".project-box-dropdown");
    expect(dropdown).toBeTruthy();
    const memberBtn = dropdown!.querySelector(".project-box-member-open") as HTMLElement;
    expect(memberBtn.textContent).toContain("p1");

    await act(async () => {
      fireEvent.click(memberBtn);
    });
    expect(setActive).toHaveBeenCalledWith("p1");
  });

  it("clicking the box pill opens the box", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    const main = container.querySelector(".project-pill.is-box .pill-main") as HTMLElement;
    await act(async () => {
      fireEvent.click(main);
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
  });

  it("the member remove (×) button removes it from THAT box only", async () => {
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])], removeFromBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const boxPill = container.querySelector(".project-pill.is-box") as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(boxPill);
    });
    const removeBtn = document.querySelector(".project-box-member-remove") as HTMLElement;
    await act(async () => {
      fireEvent.click(removeBtn);
    });
    expect(removeFromBox).toHaveBeenCalledWith("p1", "boxA");
  });

  it("dropping a pill onto a box pill ADDS it (addToBox) and keeps other memberships", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    // p2 is already in boxB — the drop on boxA must not touch that membership.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], 5), box("boxB", ["p2"], 6)], addToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const boxPill = boxPillOf(container, "boxA");
    const p2Pill = findPill(container, "p2");
    layOut(p2Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(boxPill, { left: 100, right: 160, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p2Pill);
      pointer("pointermove", 130, 10, window);
      pointer("pointerup", 130, 10, window);
    });

    expect(addToBox).toHaveBeenCalledWith("p2", "boxA");
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("alt-dropping a pill onto another boxes the two via boxProjects", async () => {
    const boxProjects = vi.fn().mockResolvedValue(box("newBox", ["p2", "p1"]));
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [], boxProjects });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      pointer("pointermove", 120, 10, window, { altKey: true });
      pointer("pointerup", 120, 10, window, { altKey: true });
    });

    expect(boxProjects).toHaveBeenCalledWith(["p2", "p1"], { name: "New Box" });
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("a plain (no-alt) drop onto a pill still reorders, not box", async () => {
    const boxProjects = vi.fn().mockResolvedValue(null);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [], boxProjects });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      // Past p2's midpoint (125): with only these two pills, p1 landing
      // "after" p2 is the only real move available (it's already right
      // before p2), so the cursor must clear the midpoint to signal it.
      pointer("pointermove", 140, 10, window);
      pointer("pointerup", 140, 10, window);
    });

    expect(reorderProjects).toHaveBeenCalledWith("p1", "p2");
    expect(boxProjects).not.toHaveBeenCalled();
  });

  it("dropping into the gap between two OTHER pills lands there, not one further right", async () => {
    // Regression: landing "before OTHERS[k]" by targeting OTHERS[k] directly
    // is only correct when OTHERS[k] sat to the LEFT of the dragged pill's
    // start position; when it sat to the right, `onReorder` lands the pill
    // AFTER that target, one slot further than intended — the reported bug.
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20), proj("p3", 30)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    const p3Pill = findPill(container, "p3");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });
    layOut(p3Pill, { left: 200, right: 250, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      // Past p2's midpoint (125) but well before p3's (225) — the gap
      // between p2 and p3, not "onto" either.
      pointer("pointermove", 180, 10, window);
      pointer("pointerup", 180, 10, window);
    });

    // p1 lands between p2 and p3 — i.e. immediately AFTER p2 — not after p3.
    expect(reorderProjects).toHaveBeenCalledWith("p1", "p2");
  });
});
