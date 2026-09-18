/**
 * The per-tab file-source badge store (`stores/viewers/fileSources`). Pinned: a repeat
 * publish of the same source is an identity no-op (the tab strip subscribes to
 * the map, so a fresh object per viewer render would re-render every tab),
 * clearing an unknown key changes nothing, and the two maps are independent —
 * dropping a tab's switch controls leaves its badge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileSourcesStore } from "../stores/viewers/fileSources";

beforeEach(() => {
  useFileSourcesStore.setState({ byTab: {}, controlsByTab: {} });
});

describe("source badge", () => {
  it("publishes a source and skips a state write for the same one again", () => {
    const s = useFileSourcesStore.getState();
    s.setSource("t1", "remote");
    const after = useFileSourcesStore.getState();
    expect(after.byTab).toEqual({ t1: "remote" });
    s.setSource("t1", "remote");
    expect(useFileSourcesStore.getState()).toBe(after);
    expect(useFileSourcesStore.getState().byTab).toBe(after.byTab);
    s.setSource("t1", "local");
    expect(useFileSourcesStore.getState().byTab).toEqual({ t1: "local" });
  });

  it("clears one tab's badge on unmount and ignores a tab it never had", () => {
    const s = useFileSourcesStore.getState();
    s.setSource("t1", "remote");
    s.setSource("t2", "none");
    const before = useFileSourcesStore.getState();
    s.clearSource("t9");
    expect(useFileSourcesStore.getState()).toBe(before);
    s.clearSource("t1");
    expect(useFileSourcesStore.getState().byTab).toEqual({ t2: "none" });
  });
});

describe("switch controls", () => {
  it("keeps the badge when the controls go, and the controls when the badge goes", () => {
    const s = useFileSourcesStore.getState();
    const controls = { current: "local" as const, set: vi.fn(), remoteDisabled: true };
    s.setSource("t1", "local");
    s.setControls("t1", controls);
    expect(useFileSourcesStore.getState().controlsByTab.t1).toBe(controls);
    s.clearControls("t1");
    expect(useFileSourcesStore.getState().controlsByTab).toEqual({});
    expect(useFileSourcesStore.getState().byTab).toEqual({ t1: "local" });
    s.setControls("t1", controls);
    s.clearSource("t1");
    expect(useFileSourcesStore.getState().controlsByTab.t1).toBe(controls);
    expect(useFileSourcesStore.getState().byTab).toEqual({});
  });

  it("replaces a tab's controls wholesale and ignores clearing an unknown tab", () => {
    const s = useFileSourcesStore.getState();
    const a = { current: "local" as const, set: vi.fn(), remoteDisabled: false };
    const b = { current: "remote" as const, set: vi.fn(), remoteDisabled: false };
    s.setControls("t1", a);
    s.setControls("t1", b);
    expect(useFileSourcesStore.getState().controlsByTab).toEqual({ t1: b });
    const before = useFileSourcesStore.getState();
    s.clearControls("t9");
    expect(useFileSourcesStore.getState()).toBe(before);
  });
});
