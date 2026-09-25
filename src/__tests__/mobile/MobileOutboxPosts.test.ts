import { describe, expect, it } from "vitest";

import type { OutboxFile, TranscriptEntry } from "../../../mobile-web/src/api";
import { outboxPosts, POST_GAP } from "../../../mobile-web/src/terminal/outboxPosts";

const secs = (iso: string) => Date.parse(iso) / 1000;
const picture = (name: string, iso: string): OutboxFile => ({ name, kind: "image/png", size: 1, modified: secs(iso) });
const names = (posts: ReturnType<typeof outboxPosts>) =>
  Object.fromEntries(Array.from(posts, ([index, list]) => [index, list.map((post) => post.files.map((file) => file.name))]));

const ENTRIES: TranscriptEntry[] = [
  { kind: "prompt", text: "plot it", at: "2026-09-15T05:00:00Z" },
  { kind: "answer", text: "Sending.", at: "2026-09-15T05:02:00.400Z" },
  { kind: "answer", text: "Sent.", at: "2026-09-15T05:04:00Z" },
];

describe("outboxPosts places the agent's files among the session's messages", () => {
  it("puts a file after the last record written at or before it, in the same second included", () => {
    expect(names(outboxPosts(ENTRIES, [picture("a.png", "2026-09-15T05:02:00Z")]))).toEqual({ 1: [["a.png"]] });
    expect(names(outboxPosts(ENTRIES, [picture("b.png", "2026-09-15T05:09:00Z")]))).toEqual({ 2: [["b.png"]] });
  });

  it("makes one post of one send, and a new one after a pause or a record", () => {
    const posts = outboxPosts(ENTRIES, [
      picture("d.png", "2026-09-15T05:04:30Z"),
      picture("c.png", "2026-09-15T05:03:00Z"),
      picture("b.png", `2026-09-15T05:02:${String(10 + POST_GAP).padStart(2, "0")}Z`),
      picture("a.png", "2026-09-15T05:02:10Z"),
      picture("e.png", "2026-09-15T05:04:31Z"),
    ]);
    expect(names(posts)).toEqual({ 1: [["a.png", "b.png"], ["c.png"]], 2: [["d.png", "e.png"]] });
    expect(posts.get(1)?.[0].key).toBe("outbox:a.png");
  });

  it("leaves files older than the first shown record, and every file when no record has a time", () => {
    expect(outboxPosts(ENTRIES, [picture("old.png", "2026-09-15T04:59:59Z")]).size).toBe(0);
    const untimed = ENTRIES.map(({ at: _at, ...entry }) => entry);
    expect(outboxPosts(untimed, [picture("a.png", "2026-09-15T05:03:00Z")]).size).toBe(0);
  });

  it("lets a record without a time stand at the one before it", () => {
    const entries: TranscriptEntry[] = [ENTRIES[0], { kind: "answer", text: "no stamp" }, ENTRIES[2]];
    expect(names(outboxPosts(entries, [picture("a.png", "2026-09-15T05:01:00Z")]))).toEqual({ 1: [["a.png"]] });
  });
});
