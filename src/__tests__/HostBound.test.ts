/**
 * The host-bound marker a local-model tab mints (`lib/remote/hostBound`). Pinned: the
 * root scope registers nothing, the uid is a marker-filename-safe string the
 * backend records under the project, a refused registration yields no uid (so
 * the tab runs inside the container — the safe direction), and the crypto-less
 * fallback still mints a well-formed name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { registerHostBoundTab } from "../lib/remote/hostBound";

const invokeMock = vi.mocked(invoke);
const MARKER = /^[A-Za-z0-9_-]{1,64}$/;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerHostBoundTab", () => {
  it("registers nothing for the root scope or an empty one", async () => {
    await expect(registerHostBoundTab("root")).resolves.toBeUndefined();
    await expect(registerHostBoundTab("")).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("mints a marker-safe uid, records it under the project, and returns the same uid", async () => {
    const uid = await registerHostBoundTab("p1");
    expect(uid).toMatch(MARKER);
    expect(invokeMock).toHaveBeenCalledWith("register_host_bound_tab", { projectId: "p1", uid });
    const again = await registerHostBoundTab("p1");
    expect(again).not.toBe(uid);
  });

  it("yields no uid when the backend refuses — the tab then stays contained", async () => {
    invokeMock.mockRejectedValue("state dir unwritable");
    await expect(registerHostBoundTab("p1")).resolves.toBeUndefined();
  });

  it("still mints a well-formed name without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    const uid = await registerHostBoundTab("p1");
    expect(uid).toMatch(/^hb-/);
    expect(uid).toMatch(MARKER);
    expect(await registerHostBoundTab("p1")).not.toBe(uid);
  });
});
