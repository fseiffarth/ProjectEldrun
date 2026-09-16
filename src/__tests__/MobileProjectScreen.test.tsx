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

describe("Mobile project screen — tab order", () => {
  it("lists a question, then working tabs, then the rest by last finished turn", async () => {
    const row = (id: string, extra: Record<string, unknown>) => ({ id, label: id, kind: "agent", available: true, viewer_busy: false, ...extra });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      project: { id: "p", label: "Alpha", status: "active", live_sessions: 5 },
      desktop_available: true,
      tabs: [
        { id: "shell", label: "shell", kind: "shell", available: true, viewer_busy: false },
        row("old-done", { agent_status: "done", done_at: 1_000 }),
        row("working", { agent_status: "working", done_at: 500 }),
        row("new-done", { done_at: 3_000 }),
        row("asking", { agent_status: "question" }),
      ],
      agents: [],
    }), { status: 200 }));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("asking");
    const order = [...container.querySelectorAll(".tab-card strong")].map((node) => node.textContent);
    expect(order).toEqual(["asking", "working", "new-done", "old-done", "shell"]);
  });
});
