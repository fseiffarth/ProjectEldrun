import { describe, expect, it } from "vitest";
import { resolveProjectDirectory, type ProjectEntry } from "../types";

describe("resolveProjectDirectory", () => {
  it("recovers legacy Windows local_file paths", () => {
    const project = {
      local_file: "C:\\Users\\alice\\eldrun\\projects\\demo\\project.json",
    } as ProjectEntry;
    expect(resolveProjectDirectory(project)).toBe(
      "C:\\Users\\alice\\eldrun\\projects\\demo",
    );
  });
});
