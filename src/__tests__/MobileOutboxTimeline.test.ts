/**
 * `placeOutbox` (`mobile-web/src/terminal/outboxTimeline.ts`): where a file
 * the agent sent sits among the stored session's turns in the Focus chat.
 */
import { describe, expect, it } from "vitest";
import { oldestFirst, placeOutbox } from "../../mobile-web/src/terminal/outboxTimeline";
import type { OutboxFile, TranscriptEntry } from "../../mobile-web/src/api";

const secs = (iso: string) => Date.parse(iso) / 1000;
const file = (name: string, iso: string): OutboxFile => ({ name, kind: "image/png", size: 10, modified: secs(iso) });
const names = (files: readonly OutboxFile[] | undefined) => (files ?? []).map((f) => f.name);

const ENTRIES: TranscriptEntry[] = [
  { kind: "prompt", text: "plot run 12", at: "2026-09-15T05:00:00Z" },
  { kind: "answer", text: "Here is the plot.", at: "2026-09-15T05:02:00Z" },
  { kind: "prompt", text: "and run 13", at: "2026-09-15T06:00:00Z" },
  { kind: "answer", text: "Done." },
];

describe("Eldrun Mobile places sent files among the stored session's turns", () => {
  it("puts a file after the last turn written at or before it, oldest first", () => {
    const placed = placeOutbox(ENTRIES, [
      file("run13.png", "2026-09-15T06:05:00Z"),
      file("run12.png", "2026-09-15T05:03:00Z"),
      file("run12-zoom.png", "2026-09-15T05:03:00Z"),
    ], false);
    expect(names(placed.before)).toEqual([]);
    expect(names(placed.after.get(1))).toEqual(["run12-zoom.png", "run12.png"]);
    // The untimed last answer stands at its prompt's time, so the later file
    // follows it rather than the prompt.
    expect(names(placed.after.get(3))).toEqual(["run13.png"]);
    expect(placed.after.has(2)).toBe(false);
  });

  it("opens the chat with an older file, or leaves it for an earlier page when truncated", () => {
    const old = [file("yesterday.png", "2026-09-14T12:00:00Z")];
    expect(names(placeOutbox(ENTRIES, old, false).before)).toEqual(["yesterday.png"]);
    const truncated = placeOutbox(ENTRIES, old, true);
    expect(truncated.before).toEqual([]);
    expect(truncated.after.size).toBe(0);
  });

  it("closes the chat when no turn carries a time, and opens an empty one", () => {
    const untimed: TranscriptEntry[] = [{ kind: "prompt", text: "hi" }, { kind: "answer", text: "hello" }];
    expect(names(placeOutbox(untimed, [file("a.png", "2026-09-15T05:00:00Z")], true).after.get(1))).toEqual(["a.png"]);
    expect(names(placeOutbox([], [file("a.png", "2026-09-15T05:00:00Z")], true).before)).toEqual(["a.png"]);
  });

  it("sorts oldest first without touching the listing", () => {
    const listing = [file("b.png", "2026-09-15T06:00:00Z"), file("a.png", "2026-09-15T05:00:00Z")];
    expect(names(oldestFirst(listing))).toEqual(["a.png", "b.png"]);
    expect(names(listing)).toEqual(["b.png", "a.png"]);
  });
});
