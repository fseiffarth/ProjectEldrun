/**
 * The phone's project list offers a ◷ beside every agent tab in addition to
 * the live terminal's Schedule chip. Opening the list shortcut must not attach
 * to the session, and a shell tab has no schedules to offer.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../mobile-web/src/screens/Project";

const detail = {
  project: { id: "p1", label: "Alpha", status: "active" },
  desktop_available: true,
  tabs: [
    { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  ],
  agents: [],
};

describe("Mobile project tab list — scheduled prompts", () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ schedules: [], time_zone: "Europe/Berlin", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify(detail), { status: 200 });
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("offers a schedule control on the agent tab only, and opens the sheet without attaching", async () => {
    const terminal = vi.fn();
    render(<Project id="p1" back={() => {}} terminal={terminal} />);
    const control = await screen.findByRole("button", { name: "Scheduled prompts for Claude" });
    expect(screen.queryByRole("button", { name: "Scheduled prompts for Shell" })).toBeNull();

    fireEvent.click(control);
    expect(await screen.findByRole("dialog", { name: "Scheduled prompts for Claude" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No prompts are scheduled for this tab.")).toBeTruthy());
    expect(terminal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v1/tabs/t-agent/schedules")).toBe(true);
  });
});
