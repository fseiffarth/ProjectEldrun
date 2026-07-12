import { describe, expect, it } from "vitest";
import {
  describeScaffoldRepair,
  scaffoldRepairIsEmpty,
  summarizeScaffoldRepair,
  type ProjectScaffoldRepair,
} from "../components/projects/scaffold";

describe("scaffold repair summaries", () => {
  it("reports an empty report as already up to date", () => {
    const report = { createdFiles: [], gitignoreLinesAdded: [], gitInitialized: false };
    expect(scaffoldRepairIsEmpty(report)).toBe(true);
    expect(summarizeScaffoldRepair(report)).toBe("already up to date");
  });

  it("summarizes created files, gitignore lines, and git init together", () => {
    const report = {
      createdFiles: ["DOCUMENTATION.md", ".claude/settings.json"],
      gitignoreLinesAdded: ["project.json"],
      gitInitialized: true,
    };
    expect(scaffoldRepairIsEmpty(report)).toBe(false);
    expect(summarizeScaffoldRepair(report)).toBe(
      "added DOCUMENTATION.md, .claude/settings.json; .gitignore +project.json; git init",
    );
  });

  it("prefixes the project name for a multi-project toast", () => {
    const repair: ProjectScaffoldRepair = {
      projectId: "abc",
      name: "MyProject",
      targetDir: "/home/u/eldrun/projects/myproject",
      report: { createdFiles: ["TODO.md"], gitignoreLinesAdded: [], gitInitialized: false },
    };
    expect(describeScaffoldRepair(repair)).toBe("MyProject: added TODO.md");
  });
});
