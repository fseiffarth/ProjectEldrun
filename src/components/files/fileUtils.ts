export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_secs?: number | null;
  created_secs?: number | null;
  extension: string | null;
  mime: string | null;
}

export const STANDARD_PROJECT_FILES = new Set([
  "README.md",
  "ROADMAP.md",
  "TODO.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "STATUS.md",
  "DOCUMENTATION.md",
  ".gitignore",
  ".claude",
]);

export const INTERNAL_PROJECT_FILES = new Set([
  "open_apps.json",
  "project.json",
  "project_default_apps.json",
  ".eldrun_colors.json",
]);

export type SortKey = "name" | "type" | "size" | "created" | "modified";

export function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function parentRel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function relFromAbs(projectDir: string, absPath: string): string {
  const root = projectDir.replace(/\/+$/, "");
  if (absPath === root) return "";
  if (!absPath.startsWith(`${root}/`)) return "";
  return absPath.slice(root.length + 1);
}

export function visibleEntries(
  entries: FileEntry[],
  options: {
    showHidden: boolean;
    showStandardFiles: boolean;
    query?: string;
    sortKey?: SortKey;
    descending?: boolean;
    hiddenEndings?: string[];
    relPath?: string;
    hiddenPaths?: string[];
    shownPaths?: string[];
  },
): FileEntry[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const sortKey = options.sortKey ?? "name";
  const descending = options.descending ?? false;
  const relPath = (options.relPath ?? "").replace(/^\/+|\/+$/g, "");
  const hiddenEndings = (options.hiddenEndings ?? [])
    .map((ending) => ending.trim().toLowerCase())
    .filter(Boolean);
  const hiddenPaths = new Set((options.hiddenPaths ?? []).map(normalizeRulePath));
  const shownPaths = new Set((options.shownPaths ?? []).map(normalizeRulePath));

  return entries
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      const explicitlyShown = shownPaths.has(entryRelPath);
      if (hiddenPaths.has(entryRelPath) && !explicitlyShown) return false;
      if (explicitlyShown) return true;
      return !INTERNAL_PROJECT_FILES.has(entry.name);
    })
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      if (shownPaths.has(entryRelPath)) return true;
      return !hiddenEndings.some((ending) => entry.name.toLowerCase().endsWith(ending));
    })
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      // `.gitignore` stays visible by default so it can be opened directly; the
      // hiddenPaths / hiddenEndings filters above still apply to it.
      if (entry.name === ".gitignore") return true;
      return shownPaths.has(entryRelPath) || options.showHidden || !entry.name.startsWith(".");
    })
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      return shownPaths.has(entryRelPath) || options.showStandardFiles || !STANDARD_PROJECT_FILES.has(entry.name);
    })
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .sort((a, b) => compareEntries(a, b, sortKey, descending));
}

function normalizeRulePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

function compareEntries(a: FileEntry, b: FileEntry, sortKey: SortKey, descending: boolean): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

  let result = 0;
  if (sortKey === "type") {
    result = (a.extension ?? "").localeCompare(b.extension ?? "");
  } else if (sortKey === "size") {
    result = a.size - b.size;
  } else if (sortKey === "created") {
    result = (a.created_secs ?? 0) - (b.created_secs ?? 0);
  } else if (sortKey === "modified") {
    result = (a.modified_secs ?? 0) - (b.modified_secs ?? 0);
  }
  if (result === 0) {
    result = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  }
  return descending ? -result : result;
}

export function fileIcon(ext: string | null): string {
  switch (ext) {
    case ".py": return "🐍";
    case ".rs": return "🦀";
    case ".ts":
    case ".tsx": return "⟨⟩";
    case ".js":
    case ".jsx": return "⚡";
    case ".md": return "📝";
    case ".json": return "{}";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".svg": return "🖼";
    case ".sh": return "⚙";
    default: return "📄";
  }
}

export function folderIcon(): string {
  return "📁";
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fmtModified(seconds?: number | null): string {
  if (!seconds) return "";
  const ageMs = Date.now() - seconds * 1000;
  const ageH = ageMs / 3_600_000;
  if (ageH < 1) {
    const mins = Math.floor(ageMs / 60_000);
    return mins <= 1 ? "just now" : `${mins} min ago`;
  }
  if (ageH < 24) {
    const h = Math.floor(ageH);
    return `${h} h ago`;
  }
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
