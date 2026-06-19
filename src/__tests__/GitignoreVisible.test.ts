/**
 * Tests for ".gitignore stays visible in the tree" (#6, Group D.2). Even though
 * .gitignore is a dotfile, visibleEntries special-cases it so it shows inline by
 * default (showHidden off) while other dotfiles are hidden — yet the explicit
 * hiddenPaths / hiddenEndings filters still apply to it.
 */
import { describe, it, expect } from "vitest";
import { visibleEntries, type FileEntry } from "../components/files/fileUtils";

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/proj/${name}`,
    is_dir: false,
    size: 0,
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".")) : null,
    mime: null,
    ...over,
  };
}

const base = { showHidden: false, showStandardFiles: true } as const;

describe("visibleEntries — .gitignore", () => {
  it("keeps .gitignore visible while hiding other dotfiles", () => {
    const names = visibleEntries(
      [entry("src", { is_dir: true }), entry(".gitignore"), entry(".env")],
      base,
    ).map((e) => e.name);
    expect(names).toContain(".gitignore");
    expect(names).not.toContain(".env");
  });

  it("still honors an explicit hiddenPaths rule on .gitignore", () => {
    const names = visibleEntries([entry(".gitignore")], {
      ...base,
      hiddenPaths: [".gitignore"],
    }).map((e) => e.name);
    expect(names).not.toContain(".gitignore");
  });
});
