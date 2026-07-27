/**
 * #42: the host-side per-pane hit-test for dropping a tab/file from the main
 * window INTO a split popout. The popout reports its pane geometry (client px) and
 * the host resolves the cursor SYNCHRONOUSLY here — so the release docks into the
 * pane actually under the cursor (a body edge splits, a bar merges), never always
 * the first pane, with no cross-window round-trip race.
 */
import { describe, it, expect, vi } from "vitest";

// detachedDropTargets pulls in tauri + the tabs store at import; stub the IPC bits.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: {} }));

import { resolvePaneTarget } from "../components/tabs/detachedDropTargets";
import type { PaneRect } from "../stores/detached";

// Two side-by-side panes: A spans x[0,200), B spans x[200,400); each has a 30px
// bar atop a body. y[0,30)=bar, y[30,300)=body.
const PANES: PaneRect[] = [
  { groupId: "A", bar: { left: 0, top: 0, right: 200, bottom: 30 }, body: { left: 0, top: 30, right: 200, bottom: 300 } },
  { groupId: "B", bar: { left: 200, top: 0, right: 400, bottom: 30 }, body: { left: 200, top: 30, right: 400, bottom: 300 } },
];

describe("resolvePaneTarget — host-side per-pane hit-test", () => {
  it("over pane B's bar → merge into B (center), not the first pane", () => {
    expect(resolvePaneTarget(PANES, 300, 15)).toEqual({ groupId: "B", edge: "center" });
  });

  it("over pane A's bar → merge into A", () => {
    expect(resolvePaneTarget(PANES, 100, 15)).toEqual({ groupId: "A", edge: "center" });
  });

  it("over pane B's body center → merge into B (center)", () => {
    expect(resolvePaneTarget(PANES, 300, 165)).toEqual({ groupId: "B", edge: "center" });
  });

  it("over pane B's right edge → split B to the right", () => {
    const t = resolvePaneTarget(PANES, 395, 165);
    expect(t?.groupId).toBe("B");
    expect(t?.edge).toBe("right");
  });

  it("over pane A's left edge → split A to the left", () => {
    const t = resolvePaneTarget(PANES, 5, 165);
    expect(t?.groupId).toBe("A");
    expect(t?.edge).toBe("left");
  });

  it("over pane A's bottom edge → split A to the bottom", () => {
    const t = resolvePaneTarget(PANES, 100, 295);
    expect(t?.groupId).toBe("A");
    expect(t?.edge).toBe("bottom");
  });

  it("outside every pane → null (host falls back to first-pane append)", () => {
    expect(resolvePaneTarget(PANES, 500, 500)).toBeNull();
  });
});
