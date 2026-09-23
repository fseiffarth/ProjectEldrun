// The slash commands the composer offers as the reader types a `/`.
//
// A phone composer is not the CLI's own input line: nothing reaches the
// session until Send, so the menu a TUI opens under a typed `/` never shows up
// on the phone. The composer draws its own instead, from two sources:
//
//   - the commands the reader has sent to this CLI from the phone before, kept
//     here per CLI — newest first, with their arguments, because `/model opus`
//     is the line worth repeating, not `/model`;
//   - a short built-in list per CLI of the commands it documents, so a CLI the
//     phone has never talked to still offers something.
//
// Keyed by CLI, never by tab: a command belongs to the CLI that understands it,
// and Codex's `/new` offered to a Claude Code session is a command that CLI
// does not have. Kept beside the drafts (`drafts.ts`) and like them never sent
// across the bridge.

const KEY = "eldrun.mobile.slashCommands";

/** Lines kept per CLI; past it the oldest goes. */
const MAX_PER_CLI = 30;
/** CLIs kept; past it the one used longest ago goes, with its lines. */
const MAX_CLIS = 20;
/** The longest line kept. A slash command with a paragraph after it is a
 * prompt, not a command worth offering again. */
const MAX_LINE = 200;
/** Rows the menu shows at once. */
export const MAX_SUGGESTIONS = 8;

type SlashStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredLine {
  line: string;
  at: number;
}

interface CatalogEntry {
  /** The command, slash included. */
  command: string;
  description: string;
  /** The command reads an argument, so picking it leaves a space after it. */
  args?: boolean;
}

export interface SlashSuggestion {
  /** What picking it puts in the composer (before any trailing space). */
  line: string;
  description?: string;
  /** Sent from this phone before — the row can be forgotten. */
  used: boolean;
  /** Picking it leaves the cursor after a space, for the argument. */
  args: boolean;
}

/** Which CLI a tab runs, as the store keys it. The families are matched on the
 * tab's agent label the way the rest of the composer matches them; any other
 * label keys by its first word, so a CLI with no catalog here still keeps its
 * own commands apart from every other one's. */
const FAMILIES: [RegExp, string][] = [
  [/claude/iu, "claude"],
  [/codex/iu, "codex"],
  [/gemini/iu, "gemini"],
  [/qwen/iu, "qwen"],
  [/opencode/iu, "opencode"],
  [/aider/iu, "aider"],
  [/kimi/iu, "kimi"],
  [/copilot/iu, "copilot"],
  [/cursor/iu, "cursor"],
  [/antigravity/iu, "antigravity"],
];

export function slashCli(agentLabel: string): string {
  for (const [pattern, key] of FAMILIES) if (pattern.test(agentLabel)) return key;
  const word = agentLabel.trim().toLowerCase().split(/\s+/u)[0]?.replace(/[^\p{L}\p{N}_-]/gu, "");
  return word || "agent";
}

/** Only commands each CLI documents; anything unsure is left for the reader's
 * own history to supply — an invented command typed into an agent is worse
 * than no row at all. */
const CATALOG: Record<string, CatalogEntry[]> = {
  claude: [
    { command: "/clear", description: "Start a new conversation" },
    { command: "/compact", description: "Summarize the conversation to free context", args: true },
    { command: "/context", description: "Show what fills the context window" },
    { command: "/model", description: "Choose the model", args: true },
    { command: "/usage", description: "Plan usage and limits" },
    { command: "/cost", description: "Tokens and cost of this session" },
    { command: "/resume", description: "Resume an earlier conversation" },
    { command: "/rewind", description: "Go back to an earlier point" },
    { command: "/review", description: "Review a pull request", args: true },
    { command: "/init", description: "Write a CLAUDE.md for this project" },
    { command: "/memory", description: "Edit the memory files" },
    { command: "/mcp", description: "MCP servers" },
    { command: "/agents", description: "Subagents" },
    { command: "/permissions", description: "Tool permission rules" },
    { command: "/status", description: "Version, model, account" },
    { command: "/config", description: "Settings" },
    { command: "/export", description: "Export the conversation", args: true },
    { command: "/add-dir", description: "Add a working directory", args: true },
    { command: "/doctor", description: "Check the installation" },
    { command: "/help", description: "List the commands" },
  ],
  codex: [
    { command: "/new", description: "Start a new conversation" },
    { command: "/compact", description: "Summarize the conversation to free context" },
    { command: "/model", description: "Choose the model and reasoning effort" },
    { command: "/approvals", description: "What runs without asking" },
    { command: "/review", description: "Review the working tree" },
    { command: "/diff", description: "Show the git diff" },
    { command: "/status", description: "Session configuration and token usage" },
    { command: "/mention", description: "Mention a file", args: true },
    { command: "/resume", description: "Resume an earlier conversation" },
    { command: "/init", description: "Write an AGENTS.md for this project" },
    { command: "/mcp", description: "MCP tools" },
    { command: "/quit", description: "Exit Codex" },
  ],
  gemini: [
    { command: "/clear", description: "Clear the screen and conversation" },
    { command: "/compress", description: "Summarize the conversation to free context" },
    { command: "/model", description: "Choose the model" },
    { command: "/stats", description: "Session statistics" },
    { command: "/memory", description: "Show, add or refresh memory", args: true },
    { command: "/chat", description: "Save, resume or list conversations", args: true },
    { command: "/restore", description: "Restore files to a checkpoint", args: true },
    { command: "/tools", description: "Available tools" },
    { command: "/mcp", description: "MCP servers" },
    { command: "/directory", description: "Workspace directories", args: true },
    { command: "/init", description: "Write a GEMINI.md for this project" },
    { command: "/settings", description: "Settings" },
    { command: "/help", description: "List the commands" },
    { command: "/quit", description: "Exit Gemini CLI" },
  ],
  qwen: [
    { command: "/clear", description: "Clear the screen and conversation" },
    { command: "/compress", description: "Summarize the conversation to free context" },
    { command: "/stats", description: "Session statistics" },
    { command: "/memory", description: "Show, add or refresh memory", args: true },
    { command: "/tools", description: "Available tools" },
    { command: "/mcp", description: "MCP servers" },
    { command: "/init", description: "Write a QWEN.md for this project" },
    { command: "/help", description: "List the commands" },
    { command: "/quit", description: "Exit Qwen Code" },
  ],
  opencode: [
    { command: "/new", description: "Start a new session" },
    { command: "/compact", description: "Summarize the session to free context" },
    { command: "/models", description: "Choose the model" },
    { command: "/sessions", description: "Switch session" },
    { command: "/undo", description: "Undo the last message and its changes" },
    { command: "/redo", description: "Redo what was undone" },
    { command: "/share", description: "Share the session" },
    { command: "/init", description: "Write an AGENTS.md for this project" },
    { command: "/help", description: "List the commands" },
    { command: "/exit", description: "Exit OpenCode" },
  ],
  aider: [
    { command: "/add", description: "Add files to the chat", args: true },
    { command: "/drop", description: "Drop files from the chat", args: true },
    { command: "/ls", description: "Files in the chat and the repo" },
    { command: "/ask", description: "Ask without editing", args: true },
    { command: "/code", description: "Ask for edits", args: true },
    { command: "/architect", description: "Plan with the architect model", args: true },
    { command: "/run", description: "Run a shell command", args: true },
    { command: "/test", description: "Run a test command", args: true },
    { command: "/undo", description: "Undo the last aider commit" },
    { command: "/diff", description: "Diff since the last message" },
    { command: "/commit", description: "Commit edits made outside aider", args: true },
    { command: "/model", description: "Switch the main model", args: true },
    { command: "/tokens", description: "Context token usage" },
    { command: "/clear", description: "Clear the chat history" },
    { command: "/reset", description: "Drop all files and clear the history" },
    { command: "/help", description: "List the commands" },
  ],
};

/** The built-in list for a CLI, empty for one without. */
export function slashCatalog(cli: string): readonly CatalogEntry[] {
  return CATALOG[cli] ?? [];
}

/**
 * The whole store, or `{}`. Anything not written in this shape is read as
 * absent: a stored line is text the composer offers to send to an agent, so a
 * bad value must mean "nothing was kept", never an odd line in the menu.
 */
function load(storage: SlashStorage): Record<string, StoredLine[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const kept: Record<string, StoredLine[]> = {};
    for (const [cli, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const lines = value.filter((entry): entry is StoredLine => !!entry && typeof entry === "object"
        && typeof (entry as StoredLine).line === "string" && isSlashLine((entry as StoredLine).line)
        && typeof (entry as StoredLine).at === "number" && Number.isFinite((entry as StoredLine).at));
      if (lines.length > 0) kept[cli] = lines;
    }
    return kept;
  } catch {
    // A private browser can refuse the store; the menu then offers the
    // built-in list alone.
    return {};
  }
}

function save(storage: SlashStorage, store: Record<string, StoredLine[]>): void {
  const kept = Object.entries(store)
    .filter(([, lines]) => lines.length > 0)
    .sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
    .slice(0, MAX_CLIS);
  if (kept.length === 0) storage.removeItem(KEY);
  else storage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** A line the store keeps: one line, a slash, a command name right after it. */
function isSlashLine(line: string): boolean {
  return /^\/[^\s/]/u.test(line) && !/[\r\n]/u.test(line) && line.length <= MAX_LINE;
}

/** The lines sent to this CLI from the phone, newest first. */
export function readSlashCommands(cli: string, storage?: SlashStorage): string[] {
  return (load(storage ?? localStorage)[cli] ?? []).map((entry) => entry.line);
}

/** Keep a slash command the reader just sent to this CLI. Anything that is not
 * a one-line slash command is ignored, so the caller can hand over any draft. */
export function rememberSlashCommand(cli: string, draft: string, storage?: SlashStorage, now: number = Date.now()): void {
  const line = draft.trim().replace(/\s+/gu, " ");
  if (!isSlashLine(line) || /[\r\n]/u.test(draft.trim())) return;
  const store = storage ?? localStorage;
  try {
    const all = load(store);
    const lines = (all[cli] ?? []).filter((entry) => entry.line !== line);
    all[cli] = [{ line, at: now }, ...lines].slice(0, MAX_PER_CLI);
    save(store, all);
  } catch {
    // A full or blocked store costs the menu a row, not the message.
  }
}

/** Drop one kept line — the menu's ✕ on a row the reader no longer wants. */
export function forgetSlashCommand(cli: string, line: string, storage?: SlashStorage): void {
  const store = storage ?? localStorage;
  try {
    const all = load(store);
    if (!all[cli]) return;
    all[cli] = all[cli].filter((entry) => entry.line !== line);
    save(store, all);
  } catch {
    // See rememberSlashCommand.
  }
}

/**
 * What the menu offers for this draft: nothing unless the draft is one line
 * that starts with `/`; then the reader's own lines that continue it, newest
 * first, followed by the built-in commands that do — first those whose name
 * starts with what was typed, then those that merely contain it. The line the
 * draft already is exactly is not offered again.
 */
export function slashSuggestions(draft: string, cli: string, used: readonly string[], limit = MAX_SUGGESTIONS): SlashSuggestion[] {
  const typed = draft.trimStart();
  if (!typed.startsWith("/") || /[\r\n]/u.test(typed)) return [];
  const query = typed.toLowerCase();
  const exact = typed.trimEnd().toLowerCase();
  const catalog = slashCatalog(cli);
  const describe = (line: string) => {
    const command = line.split(" ")[0].toLowerCase();
    return catalog.find((entry) => entry.command === command)?.description;
  };
  const out: SlashSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: SlashSuggestion) => {
    const key = suggestion.line.toLowerCase();
    if (seen.has(key) || key === exact) return;
    seen.add(key);
    out.push(suggestion);
  };
  for (const line of used) {
    if (line.toLowerCase().startsWith(query)) add({ line, description: describe(line), used: true, args: false });
  }
  for (const entry of catalog) {
    if (entry.command.startsWith(query)) add({ line: entry.command, description: entry.description, used: false, args: !!entry.args });
  }
  // One letter inside a name matches half the list; the fallback waits for two.
  const bare = query.slice(1);
  if (bare.length >= 2 && !/\s/u.test(bare)) {
    for (const entry of catalog) {
      if (entry.command.includes(bare)) add({ line: entry.command, description: entry.description, used: false, args: !!entry.args });
    }
  }
  return out.slice(0, limit);
}
