import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLastTab, readLastTab, rememberLastTab, restoreLastTab } from "../../mobile-web/src/lastTab";

describe("Eldrun Mobile last-tab persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("stores only the opaque route needed to restore the current terminal", () => {
    rememberLastTab("project-opaque", "tab-opaque");

    expect(readLastTab()).toEqual({ projectId: "project-opaque", tabId: "tab-opaque" });
    expect(localStorage.getItem("eldrun.mobile.lastTab")).toBe(
      JSON.stringify({ projectId: "project-opaque", tabId: "tab-opaque" }),
    );
  });

  it("ignores malformed or incomplete saved routes", () => {
    localStorage.setItem("eldrun.mobile.lastTab", "{broken");
    expect(readLastTab()).toBeNull();

    localStorage.setItem("eldrun.mobile.lastTab", JSON.stringify({ projectId: "project-opaque" }));
    expect(readLastTab()).toBeNull();
  });

  it("clears the route when the user leaves the terminal", () => {
    rememberLastTab("project-opaque", "tab-opaque");
    forgetLastTab();
    expect(readLastTab()).toBeNull();
  });

  it("re-fetches the current tab instead of restoring its details from storage", async () => {
    rememberLastTab("project-opaque", "tab-opaque");
    const tab = { id: "tab-opaque", label: "Fresh host label", kind: "shell" as const, available: true, viewer_busy: false };
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tab }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(restoreLastTab()).resolves.toEqual({ projectId: "project-opaque", tab });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/tabs/tab-opaque");
  });

  it("forgets a tab the host says no longer exists", async () => {
    rememberLastTab("project-opaque", "tab-opaque");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "tab_not_found" }),
    }));

    await expect(restoreLastTab()).resolves.toBeNull();
    expect(readLastTab()).toBeNull();
  });
});
