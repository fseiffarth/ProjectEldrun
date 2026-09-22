import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  DevBuildIndicator,
  buildProgress,
  formatDuration,
} from "../../components/header/DevBuildIndicator";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusStore } from "../../stores/headerStatus";

const invokeMock = vi.mocked(invoke);

const idle = {
  state: "idle",
  phase: null,
  commit: null,
  startedAt: null,
  estimateSecs: 420,
  queued: false,
  failed: null,
  installed: "99e2c74",
  behind: 0,
  relaunch: false,
  adoptable: null,
  canRelaunch: false,
  logPath: "/h/.local/share/eldrun/package-dev-auto.log",
};

function answer(status: unknown) {
  invokeMock.mockImplementation((command: string) =>
    Promise.resolve(command === "dev_build_status" ? status : null),
  );
}

describe("dev-build chip helpers", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75.4)).toBe("1:15");
    expect(formatDuration(-3)).toBe("0:00");
  });

  it("estimates from the last build and never claims to be done", () => {
    expect(buildProgress(60, 240)).toBe(0.25);
    expect(buildProgress(900, 240)).toBe(0.95);
    expect(buildProgress(60, null)).toBeNull();
    expect(buildProgress(60, 0)).toBeNull();
  });
});

describe("DevBuildIndicator", () => {
  beforeEach(() => {
    useHeaderHoverMenuStore.setState({ openId: null });
    useHeaderStatusStore.setState({ reports: {} });
  });

  afterEach(() => {
    // Unmount first: a poll firing between a reset mock and RTL's own cleanup
    // gets `undefined` back instead of a promise.
    cleanup();
    invokeMock.mockReset();
  });

  it("renders nothing and joins no cluster in a release build", async () => {
    answer(null);
    const { container } = render(<DevBuildIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_status"));
    expect(container.innerHTML).toBe("");
    expect(useHeaderStatusStore.getState().reports.devBuild).toBeUndefined();
  });

  it("shows the running step and escalates out of the fold", async () => {
    answer({
      ...idle,
      state: "building",
      phase: "cargo",
      commit: "30ed347",
      startedAt: Math.floor(Date.now() / 1000) - 65,
    });
    render(<DevBuildIndicator />);
    // Loose on the clock and patient on the wait: a loaded full-suite run can
    // take more than the default second to render, and a second or two more
    // on the clock.
    expect(await screen.findByText(/^Compiling 1:\d\d$/, undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("attention"));
    expect(screen.getByLabelText("Dev build: Building 30ed347: Compiling")).toBeTruthy();
  });

  it("reports a failed build as an alert", async () => {
    answer({ ...idle, failed: { commit: "abc1234", status: "1", when: "2026-09-18T10:00:00+02:00" } });
    render(<DevBuildIndicator />);
    expect(await screen.findByText("failed", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("alert"));
  });

  it("is a quiet member when the snapshot is current", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 });
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("ok"));
  });

  it("offers no relaunch unless the backend says one would open something newer", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 }));
    await screen.findByText("Follow build log");
    expect(screen.queryByText("Relaunch now")).toBeNull();
  });

  it("relaunches onto a built snapshot and shows a refusal", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "dev_build_status"
        ? Promise.resolve({ ...idle, adoptable: "30ed347", canRelaunch: true })
        : command === "dev_build_relaunch"
          ? Promise.reject("this window is not the frozen Eldrun (dev) binary")
          : Promise.resolve(null),
    );
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 }));
    expect(await screen.findByText(/A newer snapshot \(30ed347\) is built/)).toBeTruthy();
    fireEvent.click(screen.getByText("Relaunch now"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_relaunch"));
    expect(await screen.findByText("this window is not the frozen Eldrun (dev) binary")).toBeTruthy();
    expect(screen.getByText("Relaunch now")).toBeTruthy();
  });
});
