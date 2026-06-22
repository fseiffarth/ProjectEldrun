/**
 * #57 — open README.md by default for a project with no tabs to restore.
 *
 * Tests the `openReadmeDefaultTab` helper that CenterPanel's first-visit restore
 * branch calls when a project yields zero restorable tabs:
 *   - README.md present → exactly one in-app markdown viewer embed tab is seeded;
 *   - README.md absent → no tab is created;
 *   - a scope already initialized (visited & emptied, or populated by a
 *     concurrent switch) is never re-seeded;
 *   - the root scope path is the caller's responsibility — here we assert the
 *     helper no-ops with an empty cwd (root has no project dir).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { openReadmeDefaultTab } from "../components/layout/CenterPanel";
import { useTabsStore } from "../stores/tabs";

function reset() {
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  invokeMock.mockReset();
}

const dirWith = (...names: string[]) =>
  names.map((name) => ({ name, is_dir: false }));

describe("#57 README default tab", () => {
  beforeEach(reset);

  it("creates a markdown viewer embed tab when README.md exists", async () => {
    invokeMock.mockResolvedValueOnce(dirWith("README.md", "src", "package.json"));

    await openReadmeDefaultTab("/proj", "p1");

    const tabs = useTabsStore.getState().tabsByScope["p1"];
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    expect(tab.kind).toBe("embed");
    expect(tab.viewer).toBe("markdown");
    expect(tab.label).toBe("README.md");
    expect(tab.embedPath).toBe("/proj/README.md");
    expect(tab.scope).toBe("p1");
    // list_dir was the only backend call (no new command needed).
    expect(invokeMock).toHaveBeenCalledWith("list_dir", { projectDir: "/proj", relPath: "" });
  });

  it("creates no tab when README.md is absent", async () => {
    invokeMock.mockResolvedValueOnce(dirWith("src", "package.json"));

    await openReadmeDefaultTab("/proj", "p1");

    expect(useTabsStore.getState().tabsByScope["p1"]).toBeUndefined();
  });

  it("does not seed a README tab into an already-initialized scope", async () => {
    // Scope p1 was visited and emptied (key present, value []).
    useTabsStore.setState((s) => ({ tabsByScope: { ...s.tabsByScope, p1: [] } }));
    invokeMock.mockResolvedValueOnce(dirWith("README.md"));

    await openReadmeDefaultTab("/proj", "p1");

    expect(useTabsStore.getState().tabsByScope["p1"]).toEqual([]);
  });

  it("does not re-seed when a concurrent switch populates the scope mid-check", async () => {
    invokeMock.mockImplementationOnce(async () => {
      // Simulate switch_project_runtime landing while list_dir is in flight.
      useTabsStore.getState().loadFromLayout(
        [{ key: "s1", label: "bash", cmd: "bash", cwd: "/proj", kind: "shell" as const }],
        "/proj",
        "p1",
      );
      return dirWith("README.md");
    });

    await openReadmeDefaultTab("/proj", "p1");

    // The shell tab from the concurrent switch survives; no README was added.
    const tabs = useTabsStore.getState().tabsByScope["p1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("shell");
  });

  it("no-ops for an empty cwd (root scope has no project dir)", async () => {
    await openReadmeDefaultTab("", "root");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useTabsStore.getState().tabsByScope["root"]).toBeUndefined();
  });
});
