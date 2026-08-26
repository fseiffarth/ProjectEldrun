import { describe, expect, it } from "vitest";
import { MIN_NEW_PIN, nextLockout, validPin } from "../../mobile-web/src/localLock";

describe("Eldrun Mobile local app lock", () => {
  it("accepts only a four to twelve digit PIN", () => {
    expect(validPin("1234")).toBe(true);
    expect(validPin("123456789012")).toBe(true);
    expect(validPin("123")).toBe(false);
    expect(validPin("1234567890123")).toBe(false);
    expect(validPin("12 3456")).toBe(false);
    expect(validPin("abcdef")).toBe(false);
  });

  it("requires a longer PIN for newly configured locks", () => {
    // The verifier lives in the same store as the key it gates, so a 4-digit
    // PIN is ~10,000 offline guesses. Existing records keep working.
    expect(MIN_NEW_PIN).toBeGreaterThanOrEqual(6);
    expect(validPin("1234") && "1234".length >= MIN_NEW_PIN).toBe(false);
    expect(validPin("123456") && "123456".length >= MIN_NEW_PIN).toBe(true);
  });

  it("escalates a lockout only after several misses, and caps it", () => {
    const now = 1_000_000;
    expect(nextLockout(1, now)).toBeUndefined();
    expect(nextLockout(5, now)).toBeUndefined();
    const first = nextLockout(6, now)!;
    const second = nextLockout(7, now)!;
    expect(first).toBeGreaterThan(now);
    expect(second - now).toBe((first - now) * 2);
    // Capped rather than growing without bound.
    expect(nextLockout(99, now)! - now).toBe(15 * 60_000);
  });
});
