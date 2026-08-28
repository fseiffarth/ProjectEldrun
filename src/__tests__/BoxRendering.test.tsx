/**
 * Component tests for box rendering in the switcher under the CHIP model
 * (#13/#41, N:M membership): boxes are no longer pills among the projects —
 * one chip beside the root pill names the box being looked at, its dropdown is
 * the only list of boxes, and picking one SLICES the strip to that box's
 * members. Member pills still render individually (with a small box badge), the
 * chip is the assign-to-box drop target, and Alt-drop on a pill boxes the two.
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
import { useTabsStore } from "../stores/tabs";

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
  return [...container.querySelectorAll(".project-pill")].find(
    (el) => el.querySelector(".project-pill-label")?.textContent === name,
  ) as HTMLElement;
}

function pillNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".project-pill .project-pill-label")].map(
    (el) => el.textContent ?? "",
  );
}

function chip(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".box-chip");
}

/** Open the chip's dropdown and hand back its portaled menu. */
async function openChipMenu(container: HTMLElement): Promise<HTMLElement> {
  const main = container.querySelector(".box-chip-main") as HTMLElement;
  await act(async () => {
    fireEvent.click(main);
  });
  return document.querySelector(".box-chip-menu") as HTMLElement;
}

function menuRow(menu: HTMLElement, text: string): HTMLElement {
  return [...menu.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement;
}

beforeEach(() => {
  usePillDragStore.getState().end();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  return container;
}

describe("box chip rendering (slice model)", () => {
  it("renders NO box pill in the strip — one chip beside the root pill instead", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();

    // The strip holds projects and nothing else: no box wears a pill any more.
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
    expect(container.querySelector(".project-pill.is-box")).toBeNull();
    expect(chip(container)).toBeTruthy();

    // The member pill wears the box badge; the non-member doesn't.
    expect(findPill(container, "p1").querySelector(".project-pill-boxdot")).toBeTruthy();
    expect(findPill(container, "p2").querySelector(".project-pill-boxdot")).toBeNull();
  });

  it("costs the header nothing when no box exists", async () => {
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    expect(chip(container)).toBeNull();
  });

  it("the chip lists every box, empty ones included, with member counts", async () => {
    useBoxesStore.setState({ boxes: [box("solo", ["p1"], 5), box("empty", [], 6)] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    expect(menu.textContent).toContain("solo");
    // An empty box survives and is still selectable (dissolve is the editor's
    // explicit action) — it simply costs the strip no width.
    expect(menu.textContent).toContain("empty");
    const counts = [...menu.querySelectorAll(".box-chip-menu-count")].map((el) => el.textContent);
    expect(counts).toEqual(["1", "0"]);
  });

  it("picking a box opens it AND slices the strip to its members", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(pillNames(container)).toEqual(["p1"]);
    expect(chip(container)!.textContent).toContain("boxA");
  });

  it("“All projects” puts the whole strip back", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn().mockResolvedValue(undefined),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
  });

  it("a slice never hides the project in scope, member or not", async () => {
    // The strip that hides the project you are working in is the strip that has
    // lost you — so the scoped project rides along with the slice.
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn().mockResolvedValue(undefined),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      useTabsStore.setState({ scope: "p2" });
    });
    expect(pillNames(container)).toEqual(["p1", "p2"]);
  });

  it("entering a box scope by another door selects that slice", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);

    await act(async () => {
      useTabsStore.setState({ scope: "box:boxA" });
    });
    expect(pillNames(container)).toEqual(["p1"]);
    expect(chip(container)!.className).toContain("active");
  });

  it("a dissolved box takes its slice with it", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn().mockResolvedValue(undefined),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      useBoxesStore.setState({ boxes: [] });
    });
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
    expect(chip(container)).toBeNull();
  });

  it("a pill drag springs the box list open and each row is a drop target", async () => {
    // The strip can be sliced, so the pill being dragged is usually not one of
    // the target box's own members — with the list folded away there would be
    // nothing to aim at. p2 is already in boxB: the drop on boxA is ADDITIVE
    // and must not touch that membership.
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"], 5), box("boxB", ["p2"], 6)],
      addToBox,
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p2Pill = findPill(container, "p2");
    layOut(p2Pill, { left: 0, right: 50, top: 0, bottom: 40 });

    // First move crosses the threshold: the drag begins and the list springs.
    pointer("pointerdown", 10, 10, p2Pill);
    pointer("pointermove", 60, 10, window);
    const row = document.querySelector(
      '.box-chip-menu [data-box-id="boxA"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    layOut(row, { left: 100, right: 260, top: 40, bottom: 68 });

    pointer("pointermove", 180, 50, window);
    pointer("pointerup", 180, 50, window);

    expect(addToBox).toHaveBeenCalledWith("p2", "boxA");
    expect(reorderProjects).not.toHaveBeenCalled();
    // …and the sprung list folds back once the drag is over.
    expect(document.querySelector(".box-chip-menu")).toBeNull();
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
