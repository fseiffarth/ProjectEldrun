import { describe, it, expect } from "vitest";
import { translate } from "../lib/i18n";
import { connLabel } from "../components/header/ConnTypeIcon";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("en", key, vars);

describe("connLabel", () => {
  it("names the joined Wi-Fi network", () => {
    expect(connLabel("wlan", true, "Home Network", t)).toBe("WiFi · Home Network");
  });

  it("falls back to the bare kind when nothing could name the network", () => {
    expect(connLabel("wlan", true, null, t)).toBe("WiFi");
    expect(connLabel("wlan", true, undefined, t)).toBe("WiFi");
  });

  // An SSID belongs to a wireless link; carrying one onto Ethernet would show
  // the name of a network the machine is no longer on.
  it("never names an Ethernet link", () => {
    expect(connLabel("lan", true, "Home Network", t)).toBe("Ethernet");
  });

  it("keeps the offline suffix after the network name", () => {
    expect(connLabel("wlan", false, "Home Network", t)).toBe("WiFi · Home Network (offline)");
    expect(connLabel("lan", false, null, t)).toBe("Ethernet (offline)");
  });
});
