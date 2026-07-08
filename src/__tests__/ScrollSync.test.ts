/**
 * Proportional scroll-linking between two side-by-side viewer subwindows. The
 * store holds symmetric links keyed by group id and forwards one pane's scroll
 * ratio to its linked partner's handle, guarding against the feedback bounce the
 * induced scroll would otherwise cause. These tests lock the link matching, the
 * ratio forwarding + suppress guard, and the prune-on-stale behaviour.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { useScrollSyncStore, type ScrollHandle } from "../stores/scrollSync";

function reset() {
  useScrollSyncStore.setState({ links: {}, handles: new Map() });
}

describe("scrollSync links", () => {
  beforeEach(reset);

  it("toggleLink creates a symmetric pair and toggles it off", () => {
    const s = useScrollSyncStore.getState();
    s.toggleLink("a", "b");
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(true);
    expect(useScrollSyncStore.getState().isLinked("b", "a")).toBe(true);

    useScrollSyncStore.getState().toggleLink("a", "b");
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(false);
    expect(useScrollSyncStore.getState().isLinked("b", "a")).toBe(false);
  });

  it("a new link on an already-linked group drops the prior pairing on both sides", () => {
    useScrollSyncStore.getState().toggleLink("a", "b");
    useScrollSyncStore.getState().toggleLink("a", "c");
    const { isLinked } = useScrollSyncStore.getState();
    expect(isLinked("a", "c")).toBe(true);
    expect(isLinked("a", "b")).toBe(false);
    // b is now orphaned, not silently still pointing at a.
    expect(useScrollSyncStore.getState().links["b"]).toBeUndefined();
  });

  it("prune drops any link whose endpoints are no longer both valid", () => {
    useScrollSyncStore.getState().toggleLink("a", "b");
    useScrollSyncStore.getState().prune(new Set(["a"])); // b gone
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(false);
    expect(useScrollSyncStore.getState().links).toEqual({});
  });
});

describe("scrollSync report", () => {
  beforeEach(reset);

  it("forwards the source ratio to the linked partner's handle", () => {
    const applyA = vi.fn();
    const applyB = vi.fn();
    const s = useScrollSyncStore.getState();
    s.register("a", { applyRatio: applyA });
    s.register("b", { applyRatio: applyB });
    s.toggleLink("a", "b");

    useScrollSyncStore.getState().report("a", 0.5);
    expect(applyB).toHaveBeenCalledWith(0.5);
    expect(applyA).not.toHaveBeenCalled();
  });

  it("does nothing for an unlinked group", () => {
    const applyB = vi.fn();
    useScrollSyncStore.getState().register("b", { applyRatio: applyB });
    useScrollSyncStore.getState().report("a", 0.5);
    expect(applyB).not.toHaveBeenCalled();
  });

  it("suppresses the partner's echoed report so the two panes don't fight", () => {
    // Simulate the induced scroll: applying a ratio to the partner fires its own
    // scroll, which reports back. That echo must be swallowed within the tick.
    const applyA = vi.fn();
    const partnerReports: number[] = [];
    const handleB: ScrollHandle = {
      applyRatio: (r) => {
        partnerReports.push(r);
        // The write to B's scrollTop fires B's scroll handler synchronously here.
        useScrollSyncStore.getState().report("b", r);
      },
    };
    const s = useScrollSyncStore.getState();
    s.register("a", { applyRatio: applyA });
    s.register("b", handleB);
    s.toggleLink("a", "b");

    useScrollSyncStore.getState().report("a", 0.5);
    expect(partnerReports).toEqual([0.5]);
    // The echo from B must NOT bounce back into A while suppressed.
    expect(applyA).not.toHaveBeenCalled();
  });
});
