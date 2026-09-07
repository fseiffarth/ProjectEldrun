import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  createSchedule,
  deleteSchedule,
  getSchedules,
  setUnauthorizedHandler,
  updateSchedule,
} from "../../mobile-web/src/api";

function respondWith(body: string, init?: ResponseInit) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

describe("Eldrun Mobile API client", () => {
  it("rejects a malformed body on a 200 instead of handing callers an empty object", async () => {
    // `.catch(() => ({}))` used to turn a truncated response into `{}`, which
    // reached `rows.map` as undefined and white-screened the app for good.
    respondWith("{\"projects\": [", { status: 200, headers: { "content-type": "application/json" } });
    await expect(api("/api/v1/projects")).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("returns a parsed body on success", async () => {
    respondWith(JSON.stringify({ projects: [] }), { status: 200 });
    await expect(api<{ projects: unknown[] }>("/api/v1/projects")).resolves.toEqual({ projects: [] });
  });

  it("surfaces a server error code", async () => {
    respondWith(JSON.stringify({ error: "catalog_unavailable" }), { status: 503 });
    await expect(api("/api/v1/projects")).rejects.toMatchObject({
      status: 503,
      code: "catalog_unavailable",
    });
  });

  it("reports a dropped connection as an ApiError rather than a raw TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const failure = await api("/api/v1/projects").catch((reason) => reason as ApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("offline");
  });

  it("gives up on a request that never settles", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    vi.useFakeTimers();
    const pending = api("/api/v1/projects").catch((reason) => reason as ApiError);
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    expect((await pending as ApiError).code).toBe("timeout");
  });

  it("notifies the app when a session has expired mid-use", async () => {
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    respondWith(JSON.stringify({ error: "authentication_required" }), { status: 401 });
    await expect(api("/api/v1/projects")).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("does not treat the login endpoints' own 401 as an expired session", async () => {
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    respondWith(JSON.stringify({ error: "invalid_challenge" }), { status: 401 });
    await expect(api("/api/v1/auth/session", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
  });

  it("uses the opaque tab schedule CRUD routes with same-origin credentials", async () => {
    const body = { schedules: [], time_zone: "Europe/Berlin", next_runs: {} };
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const schedule = { enabled: true, message: "Review", rule: { type: "daily" as const, time: "09:00" } };

    await getSchedules("tab opaque");
    await createSchedule("tab opaque", schedule);
    await updateSchedule("tab opaque", "schedule/1", schedule);
    await deleteSchedule("tab opaque", "schedule/1");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/v1/tabs/tab%20opaque/schedules", "GET"],
      ["/api/v1/tabs/tab%20opaque/schedules", "POST"],
      ["/api/v1/tabs/tab%20opaque/schedules/schedule%2F1", "PUT"],
      ["/api/v1/tabs/tab%20opaque/schedules/schedule%2F1", "DELETE"],
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init?.credentials).toBe("same-origin");
  });
});
