/**
 * Tags on collected prompts and the library search over them — pure, so what
 * is tested is what a typed line becomes and what a filter means.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_LIBRARY_FILTER,
  MAX_TAGS,
  filterCollectedPrompts,
  formatTags,
  isLibraryFilterActive,
  normalizeTag,
  parseTags,
  tagCounts,
} from "../lib/agentPromptTags";
import type { ProjectAgentPrompt } from "../stores/agentPrompts";

function prompt(id: string, message: string, tags?: string[]): ProjectAgentPrompt {
  return { id, message, created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z", tags };
}

describe("parseTags", () => {
  it("normalizes the way the backend does: lowercase tokens, no #, no whitespace", () => {
    expect(normalizeTag(" #Refactor ")).toBe("refactor");
    expect(normalizeTag("Unit   Tests")).toBe("unit-tests");
    expect(normalizeTag("##")).toBe("");
    expect(parseTags("#Refactor, tests,,paper\nTESTS  writing")).toEqual([
      "refactor",
      "tests",
      "paper",
      "tests-writing",
    ]);
    // A `#` starts a new tag even without a comma; a plain space does not.
    expect(parseTags("#a #b c")).toEqual(["a", "b-c"]);
  });

  it("caps the list and the tag length rather than failing the save", () => {
    const many = Array.from({ length: MAX_TAGS + 4 }, (_, i) => `t${i}`).join(", ");
    expect(parseTags(many)).toHaveLength(MAX_TAGS);
    expect(parseTags("x".repeat(80))[0]).toHaveLength(32);
  });

  it("round-trips through the editor's line", () => {
    const tags = parseTags("paper, tex");
    expect(formatTags(tags)).toBe("paper, tex");
    expect(parseTags(formatTags(tags))).toEqual(tags);
    expect(formatTags(undefined)).toBe("");
  });
});

describe("filterCollectedPrompts", () => {
  const prompts = [
    prompt("a", "Tighten the abstract", ["paper", "writing"]),
    prompt("b", "Split the parser", ["refactor"]),
    prompt("c", "Write more tests"),
  ];

  it("offers the tags in use, most used first", () => {
    expect(tagCounts([...prompts, prompt("d", "x", ["refactor"])])).toEqual([
      { tag: "refactor", count: 2 },
      { tag: "paper", count: 1 },
      { tag: "writing", count: 1 },
    ]);
  });

  it("keeps everything with an empty filter", () => {
    expect(filterCollectedPrompts(prompts, EMPTY_LIBRARY_FILTER)).toHaveLength(3);
    expect(isLibraryFilterActive(EMPTY_LIBRARY_FILTER)).toBe(false);
    expect(isLibraryFilterActive({ text: " ", tag: "" })).toBe(false);
    expect(isLibraryFilterActive({ text: "", tag: "paper" })).toBe(true);
  });

  it("narrows by a tag chip, and by text over the prompt or its tags", () => {
    expect(filterCollectedPrompts(prompts, { text: "", tag: "paper" }).map((p) => p.id)).toEqual(["a"]);
    expect(filterCollectedPrompts(prompts, { text: "TESTS", tag: "" }).map((p) => p.id)).toEqual(["c"]);
    expect(filterCollectedPrompts(prompts, { text: "writ", tag: "" }).map((p) => p.id)).toEqual(["a", "c"]);
    // `#` restricts the search to tags: "Write more tests" has none.
    expect(filterCollectedPrompts(prompts, { text: "#writ", tag: "" }).map((p) => p.id)).toEqual(["a"]);
    expect(filterCollectedPrompts(prompts, { text: "parser", tag: "paper" })).toEqual([]);
  });
});
