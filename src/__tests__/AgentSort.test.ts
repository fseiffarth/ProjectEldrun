import { describe, expect, it } from "vitest";
import { isAgentSort, sortAgentTabs } from "../../shared/agentSort";
import { shortModelName } from "../lib/agentModel";

interface Row { id: string; working?: boolean; workingAt?: number; doneAt?: number }
const keys = (row: Row) => ({ working: !!row.working, workingAt: row.workingAt, doneAt: row.doneAt });
const ids = (rows: Row[]) => rows.map((row) => row.id);

describe("agent tab sorting (shared by the desktop and the phone)", () => {
  const rows: Row[] = [
    { id: "quiet" },
    { id: "old", workingAt: 100, doneAt: 900 },
    { id: "busy", working: true, workingAt: 50, doneAt: 10 },
    { id: "recent", workingAt: 500, doneAt: 400 },
    { id: "quiet-2" },
  ];

  it("puts a working tab first, then the most recently working, and the unseen last in their own order", () => {
    expect(ids(sortAgentTabs(rows, "lastWorking", keys))).toEqual(["busy", "recent", "old", "quiet", "quiet-2"]);
  });

  it("orders by the last finished turn, ignoring what is working now", () => {
    expect(ids(sortAgentTabs(rows, "lastDone", keys))).toEqual(["old", "recent", "busy", "quiet", "quiet-2"]);
  });

  it("leaves the native order alone and copies rather than mutating", () => {
    const sorted = sortAgentTabs(rows, "native", keys);
    expect(ids(sorted)).toEqual(ids(rows));
    expect(sorted).not.toBe(rows);
    expect(isAgentSort("lastDone")).toBe(true);
    expect(isAgentSort("newest")).toBe(false);
    expect(isAgentSort(null)).toBe(false);
  });
});

describe("model tag", () => {
  it("drops the vendor prefix and the date, and leaves the rest as it is", () => {
    expect(shortModelName("claude-opus-4-1-20250805")).toBe("opus-4-1");
    expect(shortModelName("claude-fable-5-1")).toBe("fable-5-1");
    expect(shortModelName("gpt-5-codex")).toBe("gpt-5-codex");
    expect(shortModelName("  o3 ")).toBe("o3");
  });
});
