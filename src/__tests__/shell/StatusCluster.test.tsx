/**
 * `StatusCluster`'s fold: collapsed hides EVERY member, failing ones included —
 * the summary lamp carries the worst tone instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("none")) }));
vi.mock("../../components/header/AlertsToggle", () => ({ AlertsToggle: () => <i data-testid="alerts" /> }));
vi.mock("../../components/header/MobileIndicator", () => ({ MobileIndicator: () => <i data-testid="mobile" /> }));
vi.mock("../../components/header/VpnIndicator", () => ({ VpnIndicator: () => <i data-testid="vpn" /> }));
vi.mock("../../components/header/MachinesIndicator", () => ({
  MachinesIndicator: () => <i data-testid="machines" />,
}));
vi.mock("../../components/header/AppResourceDisplay", () => ({
  AppResourceDisplay: () => <i data-testid="resources" />,
}));
vi.mock("../../components/header/DevBuildIndicator", () => ({
  DevBuildIndicator: () => <i data-testid="devBuild" />,
}));

import { StatusCluster } from "../../components/header/StatusCluster";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";

const updateSettings = vi.fn(() => Promise.resolve());

function folded(testId: string): string | null {
  return screen.getByTestId(testId).parentElement!.getAttribute("data-folded");
}

beforeEach(() => {
  usePowerStore.setState({ supported: false });
  useHeaderStatusStore.setState({
    reports: {
      vpn: { tone: "alert", label: "VPN failed" },
      machines: { tone: "attention", label: "Machines connecting" },
      resources: { tone: "ok", label: "CPU 3%" },
    },
  });
  useSettingsStore.setState({
    settings: { header_status_expanded: false } as never,
    updateSettings,
  } as never);
});

afterEach(() => {
  cleanup();
  updateSettings.mockClear();
});

describe("StatusCluster", () => {
  it("folds failing members too while collapsed, and says so on the summary lamp", () => {
    render(<StatusCluster />);
    for (const id of ["vpn", "machines", "resources"]) expect(folded(id)).toBe("true");
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.getAttribute("title")).toContain("VPN failed");
    expect(toggle.querySelector("[aria-label]")).toBeTruthy();
  });

  it("shows every member once expanded", () => {
    useSettingsStore.setState({ settings: { header_status_expanded: true } as never } as never);
    render(<StatusCluster />);
    for (const id of ["vpn", "machines", "resources"]) expect(folded(id)).toBe("false");
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(updateSettings).toHaveBeenCalledWith({ header_status_expanded: false });
  });
});
