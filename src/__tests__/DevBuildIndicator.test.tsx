import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  DevBuildIndicator,
  buildProgress,
  formatDuration,
} from "../components/header/DevBuildIndicator";
import { useHeaderHoverMenuStore } from "../stores/headerHoverMenu";
import { useHeaderStatusStore } from "../stores/headerStatus";

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
    expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("attention");
    expect(screen.getByLabelText("Dev build: Building 30ed347: Compiling")).toBeTruthy();
  });

  it("reports a failed build as an alert", async () => {
    answer({ ...idle, failed: { commit: "abc1234", status: "1", when: "2026-09-18T10:00:00+02:00" } });
    render(<DevBuildIndicator />);
    expect(await screen.findByText("failed", undefined, { timeout: 5000 })).toBeTruthy();
    expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("alert");
  });

  it("is a quiet member when the snapshot is current", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 });
    expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("ok");
  });
});
