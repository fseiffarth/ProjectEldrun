import { describe, expect, it } from "vitest";
import { agentPromptAutoTags } from "../lib/agentPromptAutoTags";

describe("agentPromptAutoTags", () => {
  it("derives agent, preface, blame, result, state and language tags", () => {
    expect(agentPromptAutoTags({
      message: "```ts\nconst x = 1\n```",
      agent: "Codex",
      preface: ["/clear", "/model gpt-5"],
      files: ["src/lib/x.ts", "README.md"],
      result: "failed",
      recurring: true,
      queued: true,
      chained: true,
    })).toEqual([
      "agent:codex", "model:gpt-5", "cmd:clear", "file:x.ts", "dir:src",
      "file:readme.md", "result:failed", "recurring", "queued", "chained", "lang:ts",
    ]);
  });

  it("marks a message longer than 2 KiB", () => {
    expect(agentPromptAutoTags({ message: "é".repeat(1_025) })).toContain("long");
  });
});
