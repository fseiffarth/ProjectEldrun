import { describe, expect, it } from "vitest";
import {
  networkKey,
  networkLabel,
  printerToApply,
  type NetworkIdentity,
} from "../../lib/window/printerNetworkDefaults";

const id = (over: Partial<NetworkIdentity>): NetworkIdentity => ({
  kind: "disconnected",
  ssid: "",
  gateway_ip: "",
  gateway_id: "",
  ...over,
});

describe("per-network default printer", () => {
  it("keys Wi-Fi by SSID and wired by the hashed gateway", () => {
    expect(networkKey(id({ kind: "wlan", ssid: " Office " }))).toBe("wlan:Office");
    expect(networkKey(id({ kind: "lan", gateway_id: "0123abcd0123abcd" }))).toBe(
      "lan:0123abcd0123abcd",
    );
    expect(networkKey(id({ kind: "lan" }))).toBe("lan");
  });

  it("gives no key to a network it cannot tell apart", () => {
    expect(networkKey(null)).toBeNull();
    expect(networkKey(id({ kind: "disconnected" }))).toBeNull();
    expect(networkKey(id({ kind: "wlan", ssid: "  " }))).toBeNull();
  });

  it("labels wired links by gateway IP when known", () => {
    const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;
    expect(networkLabel(id({ kind: "wlan", ssid: "Home" }), t)).toBe("Home");
    expect(networkLabel(id({ kind: "lan", gateway_ip: "192.0.2.1" }), t)).toBe(
      'printing.networkWiredVia{"gateway":"192.0.2.1"}',
    );
    expect(networkLabel(id({ kind: "lan" }), t)).toBe("printing.networkWired");
  });

  it("applies only a saved printer for the current key", () => {
    const saved = { "wlan:Office": { printer: "Floor2", label: "Office" } };
    expect(printerToApply(saved, "wlan:Office")).toBe("Floor2");
    expect(printerToApply(saved, "wlan:Home")).toBeNull();
    expect(printerToApply(saved, null)).toBeNull();
    expect(printerToApply(undefined, "wlan:Office")).toBeNull();
  });
});
