/**
 * The cross-bar drop flourish (`stores/drag/tabLand`): the nonce strictly
 * increases so a repeat landing of the SAME tab re-runs the CSS animation,
 * and a bar clears exactly the play it started — never a newer one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useTabLandStore } from "../../stores/drag/tabLand";

beforeEach(() => {
  useTabLandStore.setState({ landed: null });
});

describe("markLanded / clear", () => {
  it("mints a strictly increasing nonce, even for the same key twice", () => {
    useTabLandStore.getState().markLanded("t1");
    const first = useTabLandStore.getState().landed!;
    useTabLandStore.getState().markLanded("t1");
    const second = useTabLandStore.getState().landed!;
    expect(second.key).toBe("t1");
    expect(second.nonce).toBeGreaterThan(first.nonce);
  });

  it("clears only the landing it was handed", () => {
    useTabLandStore.getState().markLanded("t1");
    const stale = useTabLandStore.getState().landed!.nonce;
    useTabLandStore.getState().markLanded("t2");
    const live = useTabLandStore.getState().landed!;

    useTabLandStore.getState().clear(stale); // the first bar's animation ended late
    expect(useTabLandStore.getState().landed).toBe(live);

    useTabLandStore.getState().clear(live.nonce);
    expect(useTabLandStore.getState().landed).toBeNull();
  });
});
