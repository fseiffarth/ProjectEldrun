import { relativePathWithin } from "../paths";

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
  ".git",
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
export type InternalViewer =
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "tex"
  | "table"
  | "notebook"
  | "diff"
  // SSH-sync host-vs-mirror diff. Never auto-selected by extension — only opened
  // explicitly from a diverged (amber) file's diff button; routed to `DiffView`
  // in sync mode (backend `sync_diff`).
  | "syncdiff"
  | "odt"
  | "media"
  | "html"
  | "sqlite";

// Audio/video formats the webview plays natively via <audio>/<video> from a
// Blob URL (Dev D). Kept separate from IMAGE_EXTS so the media viewer wins.
const MEDIA_EXTS = new Set([
  ".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus",
  ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".ogv",
]);

// SQLite database files → the table-browser viewer (Dev C). These are binary, so
// they are deliberately NOT in TEXT_EXTS; the viewer reads them via the backend.
const SQLITE_EXTS = new Set([".db", ".sqlite", ".sqlite3"]);

// Spreadsheet workbooks the table viewer renders via the calamine backend (Dev
// G). Binary, so not in TEXT_EXTS.
const SPREADSHEET_EXTS = new Set([".xlsx", ".xls", ".xlsm"]);

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
export function internalViewerFor(
  entry: FileEntry,
  disabled?: ReadonlySet<InternalViewer>,
): InternalViewer | null {
  const viewer = naturalViewerFor(entry);
  // When the user has opted this type out (#48), return null so the file falls
  // through to the external-app path (commitFileDrop routes it via embedExec).
  if (viewer && disabled?.has(viewer)) return null;
  return viewer;
}

/** The viewer a file *type* maps to, ignoring any user opt-out. */
function naturalViewerFor(entry: FileEntry): InternalViewer | null {
  if (entry.is_dir) return null;
  const ext = (entry.extension ?? "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  // .tex gets the dedicated LaTeX viewer (compile to a PDF tab when a TeX engine
  // is installed; otherwise it degrades to the plain code editor). .bib stays
  // plain text via the generic TEXT_EXTS check below. This early return must win
  // even though .tex is also in TEXT_EXTS.
  if (ext === ".tex") return "tex";
  // .csv/.tsv get the table viewer, .ipynb the notebook viewer, .diff/.patch the
  // diff viewer. .csv/.tsv/.diff/.patch are also in TEXT_EXTS, so these specific
  // returns must win — exactly like .tex above. .ipynb is intentionally NOT in
  // TEXT_EXTS so that, when the notebook viewer is opted out (#48), it opens
  // externally rather than as raw JSON.
  if (ext === ".csv" || ext === ".tsv") return "table";
  if (ext === ".ipynb") return "notebook";
  if (ext === ".diff" || ext === ".patch") return "diff";
  // .odt gets the lightweight OpenDocument Text viewer: it unzips the archive and
  // renders content.xml to a readable HTML subset (headings/lists/tables/images).
  // The faithful path stays "Open externally"; opting the viewer out (#48) routes
  // it there. The remaining office/spreadsheet formats are still deferred below.
  if (ext === ".odt") return "odt";
  // Audio/video → the native media player (Dev D).
  if (MEDIA_EXTS.has(ext)) return "media";
  // SQLite databases → the table-browser viewer (Dev C).
  if (SQLITE_EXTS.has(ext)) return "sqlite";
  // Spreadsheets → the CSV/TSV table viewer, which loads them via the backend
  // (Dev G). Retires the .xlsx part of the deferred #51 office gap.
  if (SPREADSHEET_EXTS.has(ext)) return "table";
  // .html/.htm/.svg get the rendered-preview viewer with a Preview/Source toggle
  // (Dev E). These are also in TEXT_EXTS, so this specific return must win — like
  // .tex above. Opting it out (#48) falls back to the plain text editor.
  if (ext === ".html" || ext === ".htm" || ext === ".svg") return "html";
  if (ext && TEXT_EXTS.has(ext)) return "text";
  if (!ext && TEXT_FILENAMES.has(entry.name.toLowerCase())) return "text";
  // DEFERRED (#51, DECISION B): the remaining OpenDocument / spreadsheet formats
  // (.ods/.xlsx/.docx and siblings) do NOT get a native in-app renderer yet —
  // faithful rendering needs a heavy dependency (e.g. calamine + a table/layout
  // renderer). We return null and let them fall through to the external-app path
  // (the "Open externally" affordance). Revisit per-format as lightweight
  // renderers land (.odt already has one above).
  return null;
}

/**
 * The set of native viewers the user has opted out of (#48), derived from
 * `settings.viewer_prefs[id].enabled === false`. Absent/true means enabled, so
 * an empty/missing prefs map yields an empty set (all viewers on). Pass the
 * result to `internalViewerFor` at file-open sites to honour the opt-out.
 */
export function disabledViewers(
  viewerPrefs?: Record<string, { enabled?: boolean }>,
): Set<InternalViewer> {
  const out = new Set<InternalViewer>();
  if (!viewerPrefs) return out;
  for (const t of VIEWER_PREF_TYPES) {
    if (viewerPrefs[t.id]?.enabled === false) out.add(t.id);
  }
  return out;
}

/**
 * Office/spreadsheet formats whose in-app rendering is deferred (#51): they have
 * no native viewer and open in the external app. Exported so the file tree / drop
 * code can recognise them explicitly rather than treating them as generic "no
 * viewer" binaries.
 */
export const DEFERRED_OFFICE_EXTS = new Set([
  ".ods", ".odp", ".docx", ".doc", ".pptx", ".ppt",
]);

/** True when a file is a deferred office/spreadsheet type (#51). */
export function isDeferredOfficeFile(entry: FileEntry): boolean {
  return DEFERRED_OFFICE_EXTS.has((entry.extension ?? "").toLowerCase());
}

/**
 * Native-viewer types surfaced in the per-type settings UI (#48), keyed by the
 * `InternalViewer` id. `autocomplete` marks editable types that support the
 * opt-in local completion (#45). Documented in README under "Native viewers".
 */
export interface ViewerTypeMeta {
  /** Stable key used in `settings.viewer_prefs` and as the React key. */
  id: InternalViewer;
  /** Human label for the settings UI. */
  label: string;
  /** Representative extensions, for the settings UI description. */
  extensions: string[];
  /** Whether opt-in local autocomplete applies (#45 — editable text types). */
  autocomplete: boolean;
}

export const VIEWER_PREF_TYPES: ViewerTypeMeta[] = [
  {
    id: "text",
    label: "Text / code",
    extensions: [".txt", ".json", ".py", ".rs", ".ts", ".svg", ".bib", "…"],
    autocomplete: true,
  },
  {
    id: "tex",
    label: "LaTeX",
    extensions: [".tex"],
    autocomplete: true,
  },
  {
    id: "markdown",
    label: "Markdown",
    extensions: [".md", ".markdown", ".mdx"],
    autocomplete: true,
  },
  {
    id: "image",
    label: "Images",
    extensions: [".png", ".jpg", ".gif", ".webp", "…"],
    autocomplete: false,
  },
  { id: "pdf", label: "PDF", extensions: [".pdf"], autocomplete: false },
  {
    id: "table",
    label: "Table / spreadsheet",
    extensions: [".csv", ".tsv", ".xlsx", ".xls"],
    autocomplete: false,
  },
  {
    id: "notebook",
    label: "Jupyter notebook",
    extensions: [".ipynb"],
    autocomplete: false,
  },
  {
    id: "diff",
    label: "Diff / patch",
    extensions: [".diff", ".patch"],
    autocomplete: false,
  },
  {
    id: "odt",
    label: "OpenDocument Text",
    extensions: [".odt"],
    autocomplete: false,
  },
  {
    id: "media",
    label: "Audio / video",
    extensions: [".mp3", ".mp4", ".webm", ".wav", "…"],
    autocomplete: false,
  },
  {
    id: "html",
    label: "HTML / SVG preview",
    extensions: [".html", ".htm", ".svg"],
    autocomplete: false,
  },
  {
    id: "sqlite",
    label: "SQLite database",
    extensions: [".db", ".sqlite", ".sqlite3"],
    autocomplete: false,
  },
];

export function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function parentRel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function relFromAbs(projectDir: string, absPath: string): string {
  return relativePathWithin(projectDir, absPath) ?? "";
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

/**
 * Structural equality for two directory listings, field-by-field. Used by the
 * FileTree fs-watch refresh to decide whether a re-fetch actually changed the
 * listing before swapping React state (Eff #1) — replacing a double
 * `JSON.stringify` of the full arrays on every fs-change tick, which is O(n) in
 * both serialization and allocation under an actively-writing agent.
 */
export function fileEntriesEqual(a: FileEntry[], b: FileEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.path !== y.path ||
      x.is_dir !== y.is_dir ||
      x.size !== y.size ||
      x.modified_secs !== y.modified_secs ||
      x.created_secs !== y.created_secs ||
      x.extension !== y.extension ||
      x.mime !== y.mime
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality for two `string → string` maps (e.g. git status maps),
 * avoiding a `JSON.stringify` round-trip on every fs-change tick (Eff #1).
 */
export function stringMapsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
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
