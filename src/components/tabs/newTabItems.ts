import { FILES_TAB_CMD, RESUMABLE_AGENTS, TabEntry, TabKind } from "../../stores/tabs";

/**
 * A static entry in the "new tab" add menu. Shared by the main-window `TabBar`
 * and the detached popout's own add menu so both draw from one source of truth.
 */
export interface StaticMenuItem {
  label: string;
  cmd: string;
  kind: TabKind;
  env?: Record<string, string>;
  // Optional template for a command typed into the agent on launch to name its
  // own session after the project. Only set for agents with a known
  // session-rename command; others are skipped to avoid typing junk into them.
  sessionRename?: (projectName: string) => string;
  // When set, Eldrun mints a UUID at launch and passes it to the agent so it
  // owns a deterministic session id (e.g. Claude's `--session-id <uuid>`). The
  // returned strings are appended to the spawn args. Lets us surface the
  // session id on hover and later resume the session.
  sessionIdArgs?: (uuid: string) => string[];
}

// Only Claude and Gemini accept a caller-supplied session UUID at launch
// (both via `--session-id <uuid>`), so only those get `sessionIdArgs`. Codex
// (`codex resume <id>`) and Mistral/vibe (`--resume [id]`) mint their own ids
// and only accept one when resuming, so there's no deterministic id to capture
// up front — passing `--session-id` would just error and break the tab.
export const AGENT_ITEMS: StaticMenuItem[] = [
  { label: "Claude",   cmd: "claude",       kind: "agent", sessionRename: (n) => `/rename ${n}`, sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Codex",    cmd: "codex",        kind: "agent" },
  { label: "Gemini",   cmd: "gemini",       kind: "agent", sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Mistral",  cmd: "vibe",         kind: "agent" },
  { label: "Aider",    cmd: "aider",        kind: "agent" },
  { label: "OpenCode", cmd: "opencode",     kind: "agent" },
  { label: "Cursor",   cmd: "cursor-agent", kind: "agent" },
  { label: "Copilot",  cmd: "copilot",      kind: "agent" },
  { label: "Grok",     cmd: "grok",         kind: "agent" },
  { label: "Qwen",     cmd: "qwen",         kind: "agent" },
  { label: "OpenClaw", cmd: "openclaw",     kind: "agent" },
];

export const SHELL_ITEMS: StaticMenuItem[] = [
  // Empty cmd → backend `default_shell()` picks the OS-appropriate shell
  // (cmd.exe on Windows, zsh on macOS, bash on Linux). Hardcoding "bash" here
  // fails to spawn on Windows where bash isn't on PATH.
  { label: "Shell", cmd: "",              kind: "shell" },
  { label: "Files", cmd: FILES_TAB_CMD,   kind: "files" },
];

// Re-exported so both menus reference the same dot-accent palette.
export const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  local_agent: "var(--warning)",
  shell: "var(--success)",
  files: "var(--text-muted)",
  embed: "var(--info, #4aa3df)",
  projects3d: "var(--accent-secondary)",
  network: "var(--info, #4aa3df)",
  monitor: "var(--success, #3fb950)",
  calendar: "var(--accent)",
};

/**
 * Build the full tab payload (minus the store-minted `key`) for a static
 * agent/shell menu item. Mirrors the main-window `TabBar.handleAdd`: for
 * resumable agents it mints a session UUID + `ELDRUN_TAB_UID`, threads
 * `sessionIdArgs` into the launch args, and derives the session-rename input.
 * Pure aside from `crypto.randomUUID`, so both the main and detached add menus
 * produce identical specs.
 */
export function buildStaticTabSpec(
  item: StaticMenuItem,
  projectCwd: string,
  projectName: string,
): Omit<TabEntry, "key"> {
  const initialInput =
    item.sessionRename && projectName ? item.sessionRename(projectName) : undefined;
  const tracked = item.cmd in RESUMABLE_AGENTS;
  const sessionId = tracked || item.sessionIdArgs ? crypto.randomUUID() : undefined;
  const args = sessionId && item.sessionIdArgs ? item.sessionIdArgs(sessionId) : [];
  const env = {
    ...(item.env ?? {}),
    ...(tracked && sessionId ? { ELDRUN_TAB_UID: sessionId } : {}),
  };
  return {
    label: item.label,
    cmd: item.cmd,
    args,
    env,
    cwd: projectCwd,
    kind: item.kind,
    initialInput,
    sessionId,
  };
}
