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

/** Which built-in Eldrun viewer can render a file in-tab (drag from the right
 *  panel onto a tab bar). Independent of any external default app. */
export type InternalViewer = "pdf" | "image" | "markdown" | "text";

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

// Raster image formats the webview renders natively via a Blob URL. SVG stays
// in TEXT_EXTS so its XML source can be read/edited instead.
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".ico",
  ".avif", ".apng",
]);

// Extensions we treat as plain text for the built-in text viewer. Kept broad but
// explicit so binaries never slip in; extensionless well-known text files are
// handled by TEXT_FILENAMES below.
const TEXT_EXTS = new Set([
  ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".jsonc", ".json5",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".xml", ".svg", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".rs", ".py", ".pyi",
  ".rb", ".go", ".c", ".h", ".cpp", ".cc", ".hpp", ".cxx", ".java", ".kt",
  ".kts", ".swift", ".m", ".mm", ".cs", ".php", ".pl", ".lua", ".r",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".sql", ".graphql", ".gql",
  ".vue", ".svelte", ".astro", ".dart", ".ex", ".exs", ".erl", ".hs", ".elm",
  ".clj", ".scala", ".groovy", ".gradle", ".dockerfile", ".gitignore",
  ".gitattributes", ".editorconfig", ".diff", ".patch", ".rst", ".tex", ".bib",
]);

// Extensionless filenames that are conventionally plain text.
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "license", "licence", "readme", "authors",
  "contributing", "changelog", "notice", "copying", "install", ".gitignore",
  ".gitattributes", ".editorconfig", ".env", ".npmrc", ".nvmrc", ".prettierrc",
  ".eslintrc", ".babelrc",
]);

/**
 * The built-in viewer that should render `entry` in-tab, or null if none.
 *
 * PDFs, markdown, and text files always resolve to a viewer so they can be
 * dragged onto a tab bar regardless of (and independent of) whatever external
 * app is the system default — see TODO Group K #40.
 */
export function internalViewerFor(entry: FileEntry): InternalViewer | null {
  if (entry.is_dir) return null;
  const ext = (entry.extension ?? "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (ext && TEXT_EXTS.has(ext)) return "text";
  if (!ext && TEXT_FILENAMES.has(entry.name.toLowerCase())) return "text";
  return null;
}

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

/**
 * Dotfiles that `visibleEntries` filters out of the inline tree (the `showHidden`
 * step), surfaced so the panel can gather them into a collapsed "hidden" section.
 *
 * Returns the entries hidden *solely* by the dotfile rule — items removed by the
 * other filters (internal, hiddenEndings, hiddenPaths) stay fully hidden, and
 * `.gitignore`, scaffold/standard files, and explicitly-shown paths are excluded
 * because they already render inline or in the scaffold section. When
 * `showHidden` is on, dotfiles appear inline already, so the bucket is empty.
 */
export function hiddenEntries(
  entries: FileEntry[],
  options: {
    showHidden: boolean;
    sortKey?: SortKey;
    descending?: boolean;
    hiddenEndings?: string[];
    relPath?: string;
    hiddenPaths?: string[];
    shownPaths?: string[];
  },
): FileEntry[] {
  if (options.showHidden) return [];
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
      if (!entry.name.startsWith(".") || entry.name === ".gitignore") return false;
      if (INTERNAL_PROJECT_FILES.has(entry.name) || STANDARD_PROJECT_FILES.has(entry.name)) return false;
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      if (shownPaths.has(entryRelPath)) return false; // already shown inline
      if (hiddenPaths.has(entryRelPath)) return false; // user chose to fully hide
      if (hiddenEndings.some((ending) => entry.name.toLowerCase().endsWith(ending))) return false;
      return true;
    })
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
