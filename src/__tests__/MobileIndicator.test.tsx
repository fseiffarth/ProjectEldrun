import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { MobileIndicator } from "../components/header/MobileIndicator";
import { useHeaderHoverMenuStore } from "../stores/headerHoverMenu";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

const invokeMock = vi.mocked(invoke);

const refused = {
  configured: true,
  running: false,
  port: 43173,
  origin: "https://mobile.example.test",
  error: "Connection refused (os error 111)",
  installed_version: null,
  update_available: false,
};

const connected = {
  ...refused,
  running: true,
  error: null,
};

describe("MobileIndicator reconnect", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        eldrun_mobile_host: { enabled: true },
        mobile_indicator: true,
      } as Settings,
      loaded: true,
    });
    useHeaderHoverMenuStore.setState({ openId: null });
  });

  afterEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
    useHeaderHoverMenuStore.setState({ openId: null });
  });

  it("waits through the admin socket hand-off instead of leaving a refused error", async () => {
    let applied = false;
    let restartStatusChecks = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_apply") {
        applied = true;
        return Promise.resolve();
      }
      if (command === "mobile_host_status") {
        if (!applied) return Promise.resolve(refused);
        restartStatusChecks += 1;
        return Promise.resolve(restartStatusChecks === 1 ? refused : connected);
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText("Eldrun Mobile connection unavailable");
    await user.click(screen.getByLabelText("Eldrun Mobile connection unavailable"));
    expect(await screen.findByText("Connection refused (os error 111)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Eldrun Mobile connected")).toBeTruthy();
    });
    expect(restartStatusChecks).toBe(2);
  });

  it("publishes the current Mobile version only while a paired phone is connected", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_status") return Promise.resolve(connected);
      if (command === "mobile_admin") return Promise.resolve({ status: "devices", devices: [{ id: "phone-1" }] });
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText("Eldrun Mobile connected");
    await user.click(screen.getByLabelText("Eldrun Mobile connected"));
    await user.click(screen.getByRole("button", { name: "Upload mobile version" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mobile_host_apply", { enabled: true });
    });
    expect(await screen.findByText(/current Eldrun Mobile version is ready/i)).toBeTruthy();
  });
});
