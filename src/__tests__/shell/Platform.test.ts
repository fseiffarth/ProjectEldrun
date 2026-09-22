/**
 * OS detection (`lib/platform`), the bottom of the import graph. Pinned:
 * `navigator.platform` is authoritative when present; the UA string is only
 * consulted for Windows when the platform is blank; Linux is the fallback; and
 * the three flags plus `PLATFORM` always agree.
 *
 * The flags are computed at import, so each case takes a fresh module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function detect(platform: string, userAgent = "") {
  vi.resetModules();
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
  return import("../../lib/platform");
}

afterEach(() => {
  // Drop the instance shadows so jsdom's own getters answer again.
  delete (navigator as unknown as Record<string, unknown>).platform;
  delete (navigator as unknown as Record<string, unknown>).userAgent;
});

describe("platform detection", () => {
  it("reads macOS and iOS from navigator.platform", async () => {
    const m = await detect("MacIntel");
    expect([m.IS_MAC, m.IS_WINDOWS, m.IS_LINUX, m.PLATFORM]).toEqual([true, false, false, "macos"]);
    expect((await detect("iPad")).PLATFORM).toBe("macos");
  });

  it("reads Windows from navigator.platform, case-insensitively", async () => {
    const m = await detect("Win32");
    expect([m.IS_MAC, m.IS_WINDOWS, m.IS_LINUX, m.PLATFORM]).toEqual([false, true, false, "windows"]);
    expect((await detect("win64")).IS_WINDOWS).toBe(true);
  });

  it("falls back to Linux for anything else", async () => {
    const m = await detect("Linux x86_64");
    expect([m.IS_MAC, m.IS_WINDOWS, m.IS_LINUX, m.PLATFORM]).toEqual([false, false, true, "linux"]);
  });

  it("consults the UA only for Windows, and only when the platform is blank", async () => {
    expect((await detect("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).PLATFORM).toBe("windows");
    // A present platform outranks a Windows UA.
    expect((await detect("Linux x86_64", "Mozilla/5.0 (Windows NT 10.0)")).PLATFORM).toBe("linux");
    // No UA path for macOS: a blank platform with a Mac UA is still the Linux fallback.
    expect((await detect("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).PLATFORM).toBe("linux");
    expect((await detect("", "")).PLATFORM).toBe("linux");
  });
});
