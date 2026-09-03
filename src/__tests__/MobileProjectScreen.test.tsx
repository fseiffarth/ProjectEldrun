/**
 * The project screen's first paint. `!detail?.desktop_available` was also true
 * while the first load was still in flight, so every project opened on a
 * "Desktop unavailable" notice that vanished a moment later — and on a phone
 * that flash reads as the desktop having just dropped.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../mobile-web/src/screens/Project";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — first load", () => {
  it("does not claim the desktop is unavailable before the host has answered", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<Project id="p 1" back={() => {}} terminal={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/Desktop unavailable/)).toBeNull();
    // The opaque id is encoded on the way into the path, like every other route.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/projects/p%201");

    release(new Response(JSON.stringify({
      project: { id: "p 1", label: "Alpha", status: "active", live_sessions: 0 },
      desktop_available: false,
      tabs: [],
      agents: [],
    }), { status: 200 }));
    expect(await screen.findByText(/Desktop unavailable/)).toBeTruthy();
  });
});
