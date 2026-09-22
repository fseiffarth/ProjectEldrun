/**
 * The header status cluster's fold-and-summary contract (`stores/headerStatus`).
 *
 * The cluster reads one store and must (a) not re-render the whole header on
 * every poll tick when nothing changed — reports are identity-stable, (b) treat
 * a widget that reports `null` as a non-member, and (c) show the WORST thing any
 * member says as the collapsed lamp, grey when nobody has anything to say.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  isEscalated,
  summaryLamp,
  useHeaderStatusReport,
  useHeaderStatusStore,
  type HeaderStatusReport,
} from "../../stores/headerStatus";

beforeEach(() => {
  useHeaderStatusStore.setState({ reports: {} });
});

describe("report()", () => {
  it("keeps the same reports object when the tone and label did not change", () => {
    const { report } = useHeaderStatusStore.getState();
    report("vpn", { tone: "ok", label: "Tunnel up" });
    const before = useHeaderStatusStore.getState().reports;
    report("vpn", { tone: "ok", label: "Tunnel up" });
    expect(useHeaderStatusStore.getState().reports).toBe(before);
  });

  it("publishes a new object only for a new fact", () => {
    const { report } = useHeaderStatusStore.getState();
    report("vpn", { tone: "ok", label: "Tunnel up" });
    const before = useHeaderStatusStore.getState().reports;
    report("vpn", { tone: "attention", label: "Connecting…" });
    const after = useHeaderStatusStore.getState().reports;
    expect(after).not.toBe(before);
    expect(after.vpn).toEqual({ tone: "attention", label: "Connecting…" });
  });

  it("removes a member on null, and is a no-op for a member that never reported", () => {
    const { report } = useHeaderStatusStore.getState();
    report("battery", { tone: "alert", label: "4%" });
    report("battery", null);
    expect(useHeaderStatusStore.getState().reports).toEqual({});

    const before = useHeaderStatusStore.getState().reports;
    report("mobile", null);
    expect(useHeaderStatusStore.getState().reports).toBe(before);
  });
});

describe("summaryLamp / isEscalated", () => {
  it("is grey with no members and with only dormant ones — never a claimed connection", () => {
    expect(summaryLamp({})).toBe("off");
    expect(summaryLamp({ vpn: { tone: "off", label: "" }, machines: { tone: "off", label: "" } })).toBe(
      "off",
    );
  });

  it("picks the worst tone across members", () => {
    expect(summaryLamp({ vpn: { tone: "ok", label: "" }, conn: { tone: "off", label: "" } })).toBe(
      "connected",
    );
    expect(
      summaryLamp({ vpn: { tone: "attention", label: "" }, conn: { tone: "ok", label: "" } }),
    ).toBe("connecting");
    expect(
      summaryLamp({
        vpn: { tone: "attention", label: "" },
        battery: { tone: "alert", label: "" },
        conn: { tone: "ok", label: "" },
      }),
    ).toBe("error");
  });

  it("escalates only attention and alert out of the fold", () => {
    expect(isEscalated("off")).toBe(false);
    expect(isEscalated("ok")).toBe(false);
    expect(isEscalated("attention")).toBe(true);
    expect(isEscalated("alert")).toBe(true);
  });
});

describe("useHeaderStatusReport", () => {
  it("publishes on mount, follows changes, and withdraws on null and on unmount", () => {
    type Props = { report: HeaderStatusReport | null };
    const { rerender, unmount } = renderHook(
      ({ report }: Props) => useHeaderStatusReport("machines", report),
      { initialProps: { report: { tone: "ok", label: "3 connected" } } as Props },
    );
    expect(useHeaderStatusStore.getState().reports.machines).toEqual({
      tone: "ok",
      label: "3 connected",
    });

    rerender({ report: { tone: "alert", label: "1 erroring" } });
    expect(useHeaderStatusStore.getState().reports.machines?.tone).toBe("alert");

    // A widget that switched itself off is not a member.
    rerender({ report: null });
    expect(useHeaderStatusStore.getState().reports.machines).toBeUndefined();

    rerender({ report: { tone: "ok", label: "back" } });
    expect(useHeaderStatusStore.getState().reports.machines?.label).toBe("back");
    unmount();
    expect(useHeaderStatusStore.getState().reports.machines).toBeUndefined();
  });

  it("does not disturb other members' entries", () => {
    useHeaderStatusStore.getState().report("vpn", { tone: "ok", label: "up" });
    const { unmount } = renderHook(() =>
      useHeaderStatusReport("battery", { tone: "alert", label: "4%" }),
    );
    unmount();
    expect(useHeaderStatusStore.getState().reports).toEqual({ vpn: { tone: "ok", label: "up" } });
  });
});
