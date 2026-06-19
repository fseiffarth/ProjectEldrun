/**
 * Tests for the right-panel "hidden files" section data source (#29, Group N):
 * - hiddenEntries surfaces dotfiles that visibleEntries drops from the inline tree
 * - standard/scaffold, internal, .gitignore, and user-hidden items stay out of it
 * - the two functions never overlap, so an entry shows in exactly one place
 */
import { describe, it, expect } from "vitest";
import { visibleEntries, hiddenEntries, type FileEntry } from "../components/files/fileUtils";

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

describe("hiddenEntries", () => {
  it("collects dotfiles that the inline tree hides", () => {
    const entries = [entry("src", { is_dir: true }), entry(".env"), entry(".cache", { is_dir: true })];
    const hidden = hiddenEntries(entries, { showHidden: false });
    expect(hidden.map((e) => e.name)).toEqual([".cache", ".env"]);
  });

  it("keeps .gitignore, scaffold, and internal files out of the bucket", () => {
    const entries = [entry(".gitignore"), entry(".claude", { is_dir: true }), entry("project.json")];
    expect(hiddenEntries(entries, { showHidden: false })).toEqual([]);
  });

  it("respects hiddenPaths and hiddenEndings (those stay fully hidden)", () => {
    const entries = [entry(".env"), entry(".secret"), entry(".tmp")];
    const hidden = hiddenEntries(entries, {
      showHidden: false,
      hiddenPaths: [".secret"],
      hiddenEndings: [".tmp"],
    });
    expect(hidden.map((e) => e.name)).toEqual([".env"]);
  });

  it("is empty when showHidden is on (dotfiles render inline instead)", () => {
    const entries = [entry(".env"), entry(".cache", { is_dir: true })];
    expect(hiddenEntries(entries, { showHidden: true })).toEqual([]);
  });

  it("never overlaps with the inline visible set", () => {
    const entries = [entry("src", { is_dir: true }), entry(".env"), entry(".gitignore")];
    const visible = new Set(visibleEntries(entries, base).map((e) => e.name));
    const hidden = new Set(hiddenEntries(entries, base).map((e) => e.name));
    for (const name of hidden) expect(visible.has(name)).toBe(false);
    expect(hidden.has(".env")).toBe(true);
  });
});
