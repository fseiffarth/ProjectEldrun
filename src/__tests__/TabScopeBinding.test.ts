/**
 * #55 — tab→project mapping leak regression tests.
 *
 * Tabs are bound to their owning scope (project id or "root") by an EXPLICIT
 * `scope` field stamped in writeScope, plus a layout-key invariant: a scope's
 * layout tree may only reference tab keys whose payloads are owned by that
 * scope. These tests assert that:
 *   - the same saved key loaded into two scopes yields two independent,
 *     scope-stamped payloads that never cross-reference;
 *   - a corrupt state (a layout key whose payload lives in another scope) is
 *     repaired on the next mutating action (the orphan key is dropped);
 *   - a late loadFromLayout(targetScope=A) never touches the current scope B.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore, findGroupOfTab, allGroups } from "../stores/tabs";

function reset(scope: string) {
  useTabsStore.setState({
    scope,
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

describe("#55 tab→scope binding", () => {
  beforeEach(() => reset("A"));

  it("same saved key in two scopes → distinct, scope-stamped payloads", () => {
    const saved = [
      { key: "agent-1", label: "TODO.md", cmd: "bash", cwd: "/x", kind: "shell" as const },
    ];
    useTabsStore.getState().loadFromLayout(saved, "/a", "A");
    useTabsStore.getState().loadFromLayout(saved, "/b", "B");

    const a = useTabsStore.getState().tabsByScope["A"];
    const b = useTabsStore.getState().tabsByScope["B"];
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // Distinct keys (PTY-id collision guard) AND each stamped with its own scope.
    expect(a[0].key).not.toBe(b[0].key);
    expect(a[0].scope).toBe("A");
    expect(b[0].scope).toBe("B");
    // Scope A's layout only references A's tab key.
    const aLayout = useTabsStore.getState().layoutByScope["A"];
    const aKeys = allGroups(aLayout ?? null).flatMap((g) => g.tabKeys);
    expect(aKeys).toEqual([a[0].key]);
    expect(aKeys).not.toContain(b[0].key);
  });

  it("orphan layout key (payload owned by another scope) is dropped on next mutation", () => {
    // Populate A and B independently.
    useTabsStore.getState().loadFromLayout(
      [{ key: "s1", label: "a", cmd: "bash", cwd: "/a", kind: "shell" as const }],
      "/a",
      "A",
    );
    useTabsStore.getState().loadFromLayout(
      [{ key: "s2", label: "b", cmd: "bash", cwd: "/b", kind: "shell" as const }],
      "/b",
      "B",
    );
    const aKey = useTabsStore.getState().tabsByScope["A"][0].key;
    const bKey = useTabsStore.getState().tabsByScope["B"][0].key;

    // Corrupt A's layout: inject B's key into A's group (a leak).
    useTabsStore.setState((s) => {
      const aLayout = s.layoutByScope["A"];
      if (!aLayout || aLayout.type !== "group") return {};
      return {
        layoutByScope: {
          ...s.layoutByScope,
          A: { ...aLayout, tabKeys: [...aLayout.tabKeys, bKey] },
        },
      };
    });

    // Any mutating action on A re-runs writeScope → orphan bKey is pruned.
    useTabsStore.getState().setScope("A");
    useTabsStore.getState().focusGroup(
      allGroups(useTabsStore.getState().layoutByScope["A"] ?? null)[0]!.id,
    );

    const aLayout = useTabsStore.getState().layoutByScope["A"];
    const aKeys = allGroups(aLayout ?? null).flatMap((g) => g.tabKeys);
    expect(aKeys).toEqual([aKey]);
    expect(aKeys).not.toContain(bKey);
    // B is untouched.
    expect(findGroupOfTab(useTabsStore.getState().layoutByScope["B"] ?? null, bKey)).not.toBeNull();
  });

  it("a tab carrying a foreign scope is dropped when written under another scope", () => {
    useTabsStore.getState().loadFromLayout(
      [{ key: "s1", label: "a", cmd: "bash", cwd: "/a", kind: "shell" as const }],
      "/a",
      "A",
    );
    const aTab = useTabsStore.getState().tabsByScope["A"][0];
    expect(aTab.scope).toBe("A");

    // Forge a tab stamped for scope B and try to add it to scope A's flat list.
    useTabsStore.getState().setScope("A");
    useTabsStore.setState((s) => ({
      tabsByScope: {
        ...s.tabsByScope,
        A: [...s.tabsByScope["A"], { ...aTab, key: "foreign", scope: "B" }],
      },
    }));
    // Re-run writeScope via a no-op-ish mutation.
    useTabsStore.getState().focusGroup(
      allGroups(useTabsStore.getState().layoutByScope["A"] ?? null)[0]!.id,
    );

    const aTabs = useTabsStore.getState().tabsByScope["A"];
    expect(aTabs.find((t) => t.key === "foreign")).toBeUndefined();
    expect(aTabs.every((t) => t.scope === "A")).toBe(true);
  });

  it("late loadFromLayout(targetScope=A) never disturbs the current scope B", () => {
    useTabsStore.getState().loadFromLayout(
      [{ key: "s1", label: "a", cmd: "bash", cwd: "/a", kind: "shell" as const }],
      "/a",
      "A",
    );
    useTabsStore.getState().loadFromLayout(
      [{ key: "s2", label: "b", cmd: "bash", cwd: "/b", kind: "shell" as const }],
      "/b",
      "B",
    );
    // Make B current.
    useTabsStore.getState().setScope("B");
    const bFlatBefore = useTabsStore.getState().tabs.map((t) => t.key);
    const bActiveBefore = useTabsStore.getState().activeKey;

    // A late async resolve writes A again (different cwd) while B is current.
    useTabsStore.getState().loadFromLayout(
      [{ key: "s1", label: "a", cmd: "bash", cwd: "/a2", kind: "shell" as const }],
      "/a2",
      "A",
    );

    // B's flat mirror + active are untouched.
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual(bFlatBefore);
    expect(useTabsStore.getState().activeKey).toBe(bActiveBefore);
    // A still holds only A's tab, stamped A.
    const a = useTabsStore.getState().tabsByScope["A"];
    expect(a).toHaveLength(1);
    expect(a[0].scope).toBe("A");
  });
});
