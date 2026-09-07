/**
 * Narrowing the Agents view's Sent prompts list, and the list arithmetic behind
 * a dragged collected prompt. Both are pure, so what gets tested is the meaning
 * of a filter and of a drop rather than a rendered list.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_SENT_FILTER,
  filterSentPrompts,
  isSentFilterActive,
  sentAgents,
  sentTags,
} from "../lib/agentPromptFilter";
import { dropSlot, reorderedIds } from "../lib/listReorder";
import type { SentAgentPrompt } from "../stores/agentPrompts";

const now = new Date("2026-09-02T12:00:00");

function entry(over: Partial<SentAgentPrompt> & { id: string }): SentAgentPrompt {
  return {
    message: "do the thing",
    created_at: "2026-09-01T09:00:00",
    sent_at: now.toISOString(),
    tab_label: "Claude",
    ...over,
  };
}

const history: SentAgentPrompt[] = [
  entry({
    id: "old-codex",
    message: "Rewrite the parser",
    agent: "codex",
    tab_label: "Codex",
    result: "failed",
    // Five days back: inside a week, outside today.
    sent_at: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
  }),
  entry({
    id: "today-claude",
    message: "Summarise the diff",
    agent: "claude",
    result: "delivered",
    session_id: "session-abcdef",
    sent_at: new Date(now.getTime() - 3 * 3_600_000).toISOString(),
  }),
  entry({ id: "queued-claude", message: "Waiting one", agent: "claude" }),
];

describe("filterSentPrompts", () => {
  it("keeps everything with an empty filter, and says so", () => {
    expect(filterSentPrompts(history, EMPTY_SENT_FILTER, now)).toHaveLength(3);
    expect(isSentFilterActive(EMPTY_SENT_FILTER)).toBe(false);
    expect(isSentFilterActive({ ...EMPTY_SENT_FILTER, window: "today" })).toBe(true);
    expect(isSentFilterActive({ ...EMPTY_SENT_FILTER, text: "  " })).toBe(false);
  });

  it("filters by the agent the tab ran", () => {
    const codex = filterSentPrompts(history, { ...EMPTY_SENT_FILTER, agent: "codex" }, now);
    expect(codex.map((e) => e.id)).toEqual(["old-codex"]);
    expect(sentAgents(history)).toEqual(["claude", "codex"]);
  });

  it("treats a prompt with no result as queued, which is a filter of its own", () => {
    expect(
      filterSentPrompts(history, { ...EMPTY_SENT_FILTER, result: "queued" }, now).map((e) => e.id),
    ).toEqual(["queued-claude"]);
    expect(
      filterSentPrompts(history, { ...EMPTY_SENT_FILTER, result: "failed" }, now).map((e) => e.id),
    ).toEqual(["old-codex"]);
  });

  it("counts `today` as the calendar day and the rest as rolling windows", () => {
    expect(filterSentPrompts(history, { ...EMPTY_SENT_FILTER, window: "today" }, now).map((e) => e.id))
      .toEqual(["today-claude", "queued-claude"]);
    expect(filterSentPrompts(history, { ...EMPTY_SENT_FILTER, window: "hour" }, now).map((e) => e.id))
      .toEqual(["queued-claude"]);
    expect(filterSentPrompts(history, { ...EMPTY_SENT_FILTER, window: "week" }, now)).toHaveLength(3);
  });

  it("searches the prompt, the tab, the agent and the session id", () => {
    const byMessage = filterSentPrompts(history, { ...EMPTY_SENT_FILTER, text: "PARSER" }, now);
    expect(byMessage.map((e) => e.id)).toEqual(["old-codex"]);
    expect(
      filterSentPrompts(history, { ...EMPTY_SENT_FILTER, text: "session-abc" }, now).map((e) => e.id),
    ).toEqual(["today-claude"]);
    expect(
      filterSentPrompts(history, { ...EMPTY_SENT_FILTER, text: "codex" }, now).map((e) => e.id),
    ).toEqual(["old-codex"]);
  });

  it("composes the facets", () => {
    expect(
      filterSentPrompts(
        history,
        { text: "diff", tag: "", agent: "claude", result: "delivered", window: "today" },
        now,
      ).map((e) => e.id),
    ).toEqual(["today-claude"]);
    expect(
      filterSentPrompts(history, { ...EMPTY_SENT_FILTER, agent: "codex", window: "today" }, now),
    ).toEqual([]);
  });

  /** The library facets: a tag of its own, `#tag` in the text, and — the
   *  prompt blame — a file name finding the prompts that touched it. */
  it("filters by tag, by #tag in the text, and by a touched file", () => {
    const tagged = [
      entry({ id: "paper", message: "Tighten the abstract", tags: ["paper", "writing"] }),
      entry({
        id: "refactor",
        message: "Split the parser",
        tags: ["refactor"],
        commit: "d5d74e2abcdef",
        branch: "develop",
        files: ["src/lib/parser.ts", "src/__tests__/parser.test.ts"],
        files_at: now.toISOString(),
      }),
      entry({ id: "plain", message: "Untagged" }),
    ];
    expect(sentTags(tagged)).toEqual(["paper", "refactor", "writing"]);
    expect(filterSentPrompts(tagged, { ...EMPTY_SENT_FILTER, tag: "paper" }, now).map((e) => e.id))
      .toEqual(["paper"]);
    // `#re` matches tags only — "Split the parser" has no "re" tag but "refactor" does.
    expect(filterSentPrompts(tagged, { ...EMPTY_SENT_FILTER, text: "#re" }, now).map((e) => e.id))
      .toEqual(["refactor"]);
    // A bare word still searches the text, and the tags too.
    expect(filterSentPrompts(tagged, { ...EMPTY_SENT_FILTER, text: "writing" }, now).map((e) => e.id))
      .toEqual(["paper"]);
    // A file name is the prompt blame: which prompts touched it.
    expect(filterSentPrompts(tagged, { ...EMPTY_SENT_FILTER, text: "parser.test" }, now).map((e) => e.id))
      .toEqual(["refactor"]);
    // So is a commit or a branch.
    expect(filterSentPrompts(tagged, { ...EMPTY_SENT_FILTER, text: "d5d74e2" }, now).map((e) => e.id))
      .toEqual(["refactor"]);
    expect(isSentFilterActive({ ...EMPTY_SENT_FILTER, tag: "paper" })).toBe(true);
  });

  /** A record must not hide a row it cannot date. */
  it("keeps an entry whose send time cannot be read", () => {
    const broken = [entry({ id: "broken", sent_at: "not a date" })];
    expect(filterSentPrompts(broken, { ...EMPTY_SENT_FILTER, window: "hour" }, now)).toHaveLength(1);
  });
});

describe("reorderedIds", () => {
  it("moves an id to a slot counted without it", () => {
    expect(reorderedIds(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(reorderedIds(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("returns the very same array when nothing moves, so a stray drop is not a write", () => {
    const ids = ["a", "b", "c"];
    expect(reorderedIds(ids, "b", 1)).toBe(ids);
    expect(reorderedIds(ids, "missing", 0)).toBe(ids);
  });

  it("clamps a drop past the end to last", () => {
    expect(reorderedIds(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(reorderedIds(["a", "b", "c"], "c", -4)).toEqual(["c", "a", "b"]);
  });
});

describe("dropSlot", () => {
  const rects = [
    { id: "a", top: 0, height: 20 },
    { id: "b", top: 20, height: 20 },
    { id: "c", top: 40, height: 20 },
  ];

  it("counts the other rows whose midpoint the pointer has passed", () => {
    expect(dropSlot(rects, "b", 5)).toBe(0);
    expect(dropSlot(rects, "b", 15)).toBe(1);
    expect(dropSlot(rects, "b", 55)).toBe(2);
  });
});
