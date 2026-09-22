import { describe, expect, it } from "vitest";
import { formatBuildStamp } from "../../../mobile-web/src/buildInfo";

describe("Eldrun Mobile build stamp", () => {
  it("formats as dd-mm hh:mm in local time", () => {
    const local = new Date(2026, 8, 6, 7, 5).toISOString();
    expect(formatBuildStamp(local)).toBe("06-09 07:05");
  });

  it("is empty when the stamp is missing or unreadable", () => {
    expect(formatBuildStamp(undefined)).toBe("");
    expect(formatBuildStamp("not a date")).toBe("");
  });
});
