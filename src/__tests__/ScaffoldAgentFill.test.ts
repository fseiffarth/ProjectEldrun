import { describe, expect, it } from "vitest";
import {
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
} from "../components/layout/BottomBar";

describe("scaffold agent fill guidance", () => {
  it("resolves agent choice to the configured default agent", () => {
    expect(agentForScaffoldFillMode("agent_choice", "codex")).toBe("codex");
    expect(agentForScaffoldFillMode("gemini", "codex")).toBe("gemini");
  });

  it("groups only missing scaffold files selected for agent filling", () => {
    const fills = collectScaffoldAgentFills(
      [
        { path: "AGENTS.md", exists: false, kind: "file" },
        { path: "TODO.md", exists: false, kind: "file" },
        { path: "README.md", exists: false, kind: "file" },
        { path: "CLAUDE.md", exists: true, kind: "file" },
        { path: ".git", exists: false, kind: "directory" },
      ],
      {
        "AGENTS.md": "agent_choice",
        "TODO.md": "codex",
        "README.md": "manual",
        "CLAUDE.md": "claude",
        ".git": "codex",
      },
      "claude",
    );

    expect([...fills.entries()]).toEqual([
      ["claude", ["AGENTS.md"]],
      ["codex", ["TODO.md"]],
    ]);
  });

  it("builds a concrete prompt with the selected scaffold files", () => {
    const prompt = buildScaffoldFillPrompt(["AGENTS.md", "TODO.md"]);

    expect(prompt).toContain("Inspect the project first");
    expect(prompt).toContain("- AGENTS.md");
    expect(prompt).toContain("- TODO.md");
  });

  it("builds a concrete prompt for agent-filled project descriptions", () => {
    const prompt = buildDescriptionFillPrompt("Example");

    expect(prompt).toContain("Example");
    expect(prompt).toContain("top-level description field");
    expect(prompt).toContain("project switcher hover popup");
  });
});
