/**
 * The one general-purpose byte formatter (`lib/formatBytes`) — the ladder
 * seven copies used to drift on, pinned once: whole bytes below a KB, one
 * decimal from KB up, binary steps, TB as the ceiling, and a harmless "0 B"
 * for anything that is not a size.
 */
import { describe, expect, it } from "vitest";

import { formatBytes } from "../../lib/formatBytes";

describe("formatBytes", () => {
  it("prints whole bytes below a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(312)).toBe("312 B");
    expect(formatBytes(311.6)).toBe("312 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up in binary units with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2.3 * 1024 ** 3)).toBe("2.3 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("stays in TB past a terabyte rather than inventing a unit", () => {
    expect(formatBytes(1500 * 1024 ** 4)).toBe("1500.0 TB");
  });

  it("answers 0 B for anything that is not a size", () => {
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });
});
