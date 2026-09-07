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
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../stores/boxes";
import { usePillDragStore } from "../stores/pillDrag";
import { useTabsStore } from "../stores/tabs";
import { TRASH_PROJECT_ID } from "../lib/trashProject";
import { useActivityStore } from "../stores/activity";

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

/** The built-in Trash workspace, as the store holds it. */
function trashProj(): ProjectEntry {
  return { ...proj(TRASH_PROJECT_ID, 0), name: "Trash" };
}

/** What the real `openBox` does that these tests depend on: it moves the tab
 *  scope into the box. The chip names the scope it is in, so a mock that only
 *  resolved left it naming root. */
async function openBoxScope(boxId: string) {
  useTabsStore.setState({ scope: `${BOX_SCOPE_PREFIX}${boxId}` });
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
  // The selected box's pill wears the chip's own box (`.box-chip`), so the chip
  // proper is the one that is NOT it.
  return container.querySelector(".box-chip:not(.box-scope-pill)");
}

/** The selected box's own pill, right of the chip (null when no box is selected). */
function boxPill(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".box-scope-pill");
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

/** The store's own `setActive`, so a test that swaps in a spy cannot leak it
 *  into the next one. */
const realSetActive = useProjectsStore.getState().setActive;

beforeEach(() => {
  usePillDragStore.getState().end();
  useProjectsStore.setState({
    projects: [],
    activeId: null,
    loaded: true,
    setActive: realSetActive,
  });
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

  it("is the row's whole leading segment: no root or Trash pill beside it", async () => {
    // The chip used to render nothing at all until a box existed, when root and
    // Trash each had a pinned pill of their own. Both fold into it now, so it is
    // always there — and it is the ONLY thing between the header's edge and the
    // scrolling projects.
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    expect(chip(container)).toBeTruthy();
    expect(container.querySelector(".root-pill")).toBeNull();
    expect(container.querySelector(".trash-project-pill")).toBeNull();
    // Naming the scope it is in: root, with the app's own mark.
    expect(chip(container)!.querySelector(".box-chip-star")).toBeTruthy();
    expect(chip(container)!.textContent).toContain("Root");
  });

  it("lists root and Trash in the dropdown, ahead of the boxes", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), trashProj()],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    const rows = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(rows[0]).toContain("Root terminal");
    expect(rows[1]).toContain("Trash");
    expect(rows.findIndex((r) => r.includes("boxA"))).toBeGreaterThan(1);
    // Neither is a box, so neither is a drop target for a pill drag.
    expect(menu.querySelectorAll("[data-box-id]").length).toBe(1);
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
    const openBox = vi.fn(openBoxScope);
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
    // The box is named by its OWN pill beside the chip, not on the chip's face.
    expect(boxPill(container)!.textContent).toContain("boxA");
    expect(chip(container)!.textContent).not.toContain("boxA");
  });

  it("“All projects” puts the whole strip back", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
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

  it("“All projects” hands the scope back to the project the strip was on", async () => {
    // Entering a box takes the scope with it; leaving must give it back, or the
    // strip shows every project while the tabs below are still the box's.
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(useTabsStore.getState().scope).toBe("box:boxA");

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    // Re-activated even though `activeId` never changed — that is what moves
    // CenterPanel's scope back out of the box.
    expect(setActive).toHaveBeenCalledWith("p2");
    expect(useTabsStore.getState().scope).toBe("p2");
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
  });

  it("a member opened from inside the slice is not what “All projects” returns to", async () => {
    // p2 was current in the whole-strip view; p1 was current in the BOX's view.
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    // Hop to a member, as clicking its pill does.
    await act(async () => {
      fireEvent.click(findPill(container, "p1").querySelector(".pill-main") as HTMLElement);
    });
    setActive.mockClear();

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    // Strip and tabs already agree on p1 — no second runtime switch.
    expect(setActive).not.toHaveBeenCalled();
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("“All projects” falls back to root when the remembered project is closed", async () => {
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    await act(async () => {
      useProjectsStore.setState({
        projects: [proj("p1", 10), { ...proj("p2", 20), status: "inactive" }],
      });
    });

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    expect(setActive).toHaveBeenCalledWith(null);
    expect(useTabsStore.getState().scope).toBe("root");
  });

  it("gives the selected box a pill of its own, and none before one is picked", async () => {
    // The dropdown is kept as the list; the pill is the destination (user,
    // 2026-09-04). Nothing on the row stands for a box until one is selected.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    expect(boxPill(container)).toBeNull();

    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    const pill = boxPill(container)!;
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("boxA");
    // Its member count, as the chip used to carry it.
    expect(pill.querySelector(".project-box-member-count")?.textContent).toBe("1");
    // Still ONE box on the row: the per-box pills are not back.
    expect(container.querySelectorAll(".box-scope-pill")).toHaveLength(1);
  });

  it("clicking the box pill re-enters the box scope without a menu", async () => {
    const openBox = vi.fn(openBoxScope);
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
    // Leave the box scope for one of its members, the way clicking a member pill does.
    await act(async () => {
      useTabsStore.setState({ scope: "p1" });
    });
    expect(boxPill(container)!.className).not.toContain("active");
    openBox.mockClear();

    await act(async () => {
      fireEvent.click(boxPill(container)!.querySelector(".box-chip-main") as HTMLElement);
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(boxPill(container)!.className).toContain("active");
    // The click opened no dropdown — the pill is a destination, not a picker.
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("the box pill carries the box's own menu and drop target", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox: vi.fn(openBoxScope) });
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

    // "Into the box I am looking at" is a drop on the pill now, not the chip.
    expect(boxPill(container)!.getAttribute("data-box-id")).toBe("boxA");
    expect(chip(container)!.getAttribute("data-box-id")).toBeNull();

    await act(async () => {
      fireEvent.contextMenu(boxPill(container)!);
    });
    const ctx = document.querySelector(".context-menu") as HTMLElement;
    expect(ctx).toBeTruthy();
    expect(ctx.textContent).toContain("Rename");
    expect(ctx.textContent).toContain("Delete box");
  });

  it("a slice never hides the project in scope, member or not", async () => {
    // The strip that hides the project you are working in is the strip that has
    // lost you — so the scoped project rides along with the slice.
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
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
    // The box's scope is the current one, so ITS pill wears the active
    // treatment — the chip only lights up for root and Trash now.
    expect(boxPill(container)!.className).toContain("active");
    expect(chip(container)!.className).not.toContain("active");
  });

  it("a dissolved box takes its slice with it", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
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
    // The chip itself stays — it is root's and Trash's home too — it just names
    // no box any more.
    expect(chip(container)).toBeTruthy();
    expect(chip(container)!.textContent).not.toContain("boxA");
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

/**
 * Where a box's working / waiting / finished bars are drawn. A `box:<id>` scope
 * holds ordinary tabs running the same agents a project's do, so a box must be
 * able to say it wants something — but NOT from the picker chip (user,
 * 2026-09-07): that control is too short for a strip. The two surfaces with the
 * room carry it instead — the selected box's own pill, and the dropdown rows,
 * which are the only enumeration of the boxes.
 */
describe("box chip status bars", () => {
  /** A box scope with one agent tab, in the state the strip should draw. */
  function seedBoxTab(boxId: string, key: string, state: "working" | "needs-decision" | "finished") {
    useTabsStore.setState((s) => ({
      tabsByScope: {
        ...s.tabsByScope,
        [`box:${boxId}`]: [{ key, label: key, cmd: "claude", cwd: "/b", kind: "agent" }],
      },
    }));
    useActivityStore.setState((s) => ({
      statusTabsByScope: { ...s.statusTabsByScope, [`box:${boxId}`]: [{ key, state }] },
    }));
  }

  function bars(container: HTMLElement): HTMLElement[] {
    return [
      ...container.querySelectorAll(".box-chip:not(.box-scope-pill) .pill-status-bar"),
    ] as HTMLElement[];
  }

  function pillBars(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll(".box-scope-pill .pill-status-bar")] as HTMLElement[];
  }

  beforeEach(() => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
    useActivityStore.setState({ statusTabsByScope: {}, statusCountsByScope: {} });
  });

  it("keeps the picker chip itself bare", async () => {
    // The chip is an icon, a word and a caret — no room for a band of bars
    // across its bottom edge, however many boxes it could speak for.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");
    seedBoxTab("boxB", "agent-2", "working");

    const container = await renderSwitcher();
    expect(bars(container)).toHaveLength(0);
    // Not lost, only moved: the list is one hover away and names both boxes.
    const menu = await openChipMenu(container);
    expect([...menu.querySelectorAll(".pill-status-bar")].map((b) => b.className)).toEqual([
      "pill-status-bar needs-decision static",
      "pill-status-bar working static",
    ]);
  });

  it("a bar on the box pill opens its own box's tab", async () => {
    const openBox = vi.fn(openBoxScope);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    // The slice is a view, not the scope: the pill keeps naming boxA while the
    // user works in one of its projects, which is exactly when a bar has
    // somewhere to take them.
    await act(async () => {
      useTabsStore.setState({ scope: "p1" });
    });
    openBox.mockClear();

    await act(async () => {
      fireEvent.click(pillBars(container)[0]);
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
  });

  it("the selected box reports on its own pill, and nowhere twice", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"]), box("boxB", [])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");
    seedBoxTab("boxB", "agent-2", "working");

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    // boxA has a pill of its own, so its strip is there — unprefixed, because
    // the pill names the box — while the chip beside it stays bare.
    const drawn = pillBars(container);
    expect(drawn.map((b) => b.className)).toEqual(["pill-status-bar needs-decision"]);
    expect(drawn[0].getAttribute("aria-label")).toContain("agent-1");
    expect(drawn[0].getAttribute("aria-label")).not.toContain("boxA ·");
    expect(bars(container)).toHaveLength(0);
  });

  it("gives each dropdown row its own inert strip", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "finished");

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    const rowA = menuRow(menu, "boxA");
    const rowB = menuRow(menu, "boxB");
    const rowBars = [...rowA.querySelectorAll(".pill-status-bar")];
    expect(rowBars).toHaveLength(1);
    // Spans, not buttons: the row IS a button, and a button inside one is
    // invalid markup.
    expect(rowBars[0].tagName).toBe("SPAN");
    expect(rowBars[0].className).toContain("finished");
    // A box with nothing running draws no strip at all.
    expect(rowB.querySelector(".pill-status-bars")).toBeNull();
  });
});
