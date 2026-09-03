/**
 * The project list's loading and empty states. Both used to draw nothing
 * under the "Projects" heading — a first open with no active project looked
 * broken, and there was no way to tell it from a list still on its way.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../mobile-web/src/screens/Home";

const fetchMock = vi.fn();

function answer(projects: unknown[]) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ projects }), { status: 200 });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const noop = () => {};

describe("Mobile home — project list states", () => {
  it("says it is loading until the first list arrives", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation((input: string | URL | Request) => String(input).startsWith("/api/v1/alerts")
      ? Promise.resolve(new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 }))
      : new Promise<Response>((resolve) => { release = resolve; }));
    render(<Home open={noop} todo={noop} mail={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Loading projects");
    // The list request is issued from a timer, so wait for it to be in flight.
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/projects"))).toBe(true));
    release(new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 }));
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText(/Loading projects/)).toBeNull();
  });

  it("explains an empty active list and points at search", async () => {
    answer([]);
    render(<Home open={noop} todo={noop} mail={noop} />);
    expect((await screen.findByText(/No project is active right now/)).textContent).toContain("Search");
  });

  it("distinguishes an empty search from one not yet typed", async () => {
    answer([]);
    render(<Home open={noop} todo={noop} mail={noop} />);
    await screen.findByText(/No project is active right now/);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/Type a project's name/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "zeta" } });
    expect(await screen.findByText(/No project by that name/)).toBeTruthy();
  });

  it("keeps the last list, and no empty-state copy, when the host drops", async () => {
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }]);
    render(<Home open={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/Showing the last list this session loaded/)).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText(/No project/)).toBeNull();
  });
});
