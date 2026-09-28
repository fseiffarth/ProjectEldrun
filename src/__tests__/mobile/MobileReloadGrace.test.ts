import { beforeEach, describe, expect, it } from "vitest";
import { noteUnlockedLeave, RELOAD_GRACE_MS, takeReloadGrace } from "../../../mobile-web/src/reloadGrace";

const T = 1_000_000;

describe("Eldrun Mobile reload grace", () => {
  beforeEach(() => sessionStorage.clear());

  it("lets a reload moments after an unlocked page was left skip the lock, once", () => {
    noteUnlockedLeave(T, sessionStorage);
    expect(takeReloadGrace(T + 1_500, sessionStorage, "reload", false)).toBe(true);
    expect(takeReloadGrace(T + 1_600, sessionStorage, "reload", false)).toBe(false);
  });

  it("asks on a launch, a history return, or a page the browser discarded", () => {
    for (const [type, discarded] of [["navigate", false], ["back_forward", false], [undefined, false], ["reload", true]] as const) {
      noteUnlockedLeave(T, sessionStorage);
      expect(takeReloadGrace(T + 1_000, sessionStorage, type, discarded)).toBe(false);
      // Consumed even when refused, so a later reload cannot reuse it.
      expect(takeReloadGrace(T + 1_100, sessionStorage, "reload", false)).toBe(false);
    }
  });

  it("asks once the page has been gone longer than the grace", () => {
    noteUnlockedLeave(T, sessionStorage);
    expect(takeReloadGrace(T + RELOAD_GRACE_MS + 1, sessionStorage, "reload", false)).toBe(false);
  });

  it("asks without a stamp, with a malformed one, or one from the future", () => {
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    sessionStorage.setItem("eldrun.mobile.reloadGrace", "1");
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    sessionStorage.setItem("eldrun.mobile.reloadGrace", "yes");
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    noteUnlockedLeave(T + 5_000, sessionStorage);
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
  });
});
