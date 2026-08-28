import {
  FILES_TAB_CMD,
  RESUMABLE_AGENTS,
  TabEntry,
  TabKind,
} from "../../stores/tabs";
import type { CustomAgent } from "../../types";
import type { AddMenuEntry } from "./AddTabMenuList";
import type { TranslationKey } from "../../lib/i18n";

/**
 * A static entry in the "new tab" add menu. Shared by the main-window `TabBar`
 * and the detached popout's own add menu so both draw from one source of truth.
 */
export interface StaticMenuItem {
  label: string;
  cmd: string;
  kind: TabKind;
  // Launch args, prepended before any session/resume args. Only custom agents
  // set this today; the built-in AGENT_ITEMS take no leading args.
  args?: string[];
  env?: Record<string, string>;
  // For a custom agent whose spec supplied a "continue last session" flag: the
  // args that make the tab restart-resumable (cwd-continue tier). Threaded onto
  // the tab as `resumeArgs`; see buildStaticTabSpec / isResumableAgentTab.
  resumeArgs?: string[];
  // Optional template for a command typed into the agent on launch to name its
  // own session after the project. Only set for agents with a known
  // session-rename command; others are skipped to avoid typing junk into them.
  sessionRename?: (projectName: string) => string;
  // For a generic (non-brand) item — "Shell", "Files" — the key to resolve the
  // displayed/persisted label through. Agent items keep their brand name as a
  // literal `label` and never set this (Claude/Codex/… are proper nouns).
  labelKey?: TranslationKey;
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
  { label: "Google Antigravity", cmd: "agy", kind: "agent" },
  { label: "Google Gemini", cmd: "gemini", kind: "agent", sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Mistral",  cmd: "vibe",         kind: "agent" },
  { label: "Kiro",     cmd: "kiro",         kind: "agent" },
  { label: "Cline",    cmd: "cline",        kind: "agent" },
  { label: "Aider",    cmd: "aider",        kind: "agent" },
  { label: "OpenCode", cmd: "opencode",     kind: "agent" },
  { label: "Cursor",   cmd: "cursor-agent", kind: "agent" },
  { label: "Copilot",  cmd: "copilot",      kind: "agent" },
  { label: "Grok",     cmd: "grok",         kind: "agent" },
  { label: "Qwen",     cmd: "qwen",         kind: "agent" },
  { label: "OpenClaw", cmd: "openclaw",     kind: "agent" },
  { label: "Goose",    cmd: "goose",        kind: "agent" },
  { label: "OpenHands", cmd: "openhands",   kind: "agent" },
  { label: "Pi",       cmd: "pi",           kind: "agent" },
  { label: "Plandex",  cmd: "plandex",      kind: "agent" },
  { label: "SWE-agent", cmd: "sweagent",    kind: "agent" },
  { label: "mini-SWE-agent", cmd: "mini",   kind: "agent" },
  { label: "Mentat",   cmd: "mentat",       kind: "agent" },
  { label: "GPT Engineer", cmd: "gpte",     kind: "agent" },
  { label: "Crush",    cmd: "crush",        kind: "agent" },
  { label: "Amp",      cmd: "amp",          kind: "agent" },
  { label: "Kimi Code", cmd: "kimi",        kind: "agent" },
  { label: "Qoder",    cmd: "qoder",        kind: "agent" },
];

export const SHELL_ITEMS: StaticMenuItem[] = [
  // Empty cmd → backend `default_shell()` picks the OS-appropriate shell
  // (cmd.exe on Windows, zsh on macOS, bash on Linux). Hardcoding "bash" here
  // fails to spawn on Windows where bash isn't on PATH.
  { label: "Shell", labelKey: "newTabMenu.groupShell", cmd: "",              kind: "shell" },
  { label: "Files", labelKey: "newTabMenu.groupFiles", cmd: FILES_TAB_CMD,   kind: "files" },
];

/** Resolve a {@link StaticMenuItem}'s display/persisted label: translated for a
 *  generic item (`labelKey` set), the literal brand name for an agent. */
export function itemLabel(item: StaticMenuItem, t: (key: TranslationKey) => string): string {
  return item.labelKey ? t(item.labelKey) : item.label;
}

/** The pure-frontend file panes kept to one tab per cwd (see TabBar.handleAdd).
 *  "projectfiles" is no longer offered as a standalone new-tab entry (it merely
 *  duplicated the right panel), but the kind still exists — a folder's "Open in
 *  a new tab" action creates one, and persisted ones restore — so it stays in
 *  the dedup predicate. */
export function isFileTabKind(kind: TabKind): boolean {
  return kind === "files" || kind === "projectfiles";
}

// Re-exported so both menus reference the same dot-accent palette.
export const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  local_agent: "var(--warning)",
  shell: "var(--success)",
  files: "var(--text-muted)",
  projectfiles: "var(--text-muted)",
  embed: "var(--info, #4aa3df)",
  projects3d: "var(--accent-secondary)",
  network: "var(--info, #4aa3df)",
  monitor: "var(--success)",
  diskusage: "var(--warning)",
  calendar: "var(--accent)",
  browser: "var(--accent-secondary)",
  printing: "var(--text-muted)",
  skillslibrary: "var(--accent-secondary)",
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
  t: (key: TranslationKey) => string,
): Omit<TabEntry, "key"> {
  const initialInput =
    item.sessionRename && projectName ? item.sessionRename(projectName) : undefined;
  // "Resumable" now spans a built-in in the static table AND a custom agent that
  // brought its own resume flag — both mint a session UUID so they satisfy the
  // tab-persistence gate (isResumableAgentTab requires a sessionId).
  const resumable = item.cmd in RESUMABLE_AGENTS || !!item.resumeArgs?.length;
  const sessionId =
    resumable || item.sessionIdArgs ? crypto.randomUUID() : undefined;
  const args = [
    ...(item.args ?? []),
    ...(sessionId && item.sessionIdArgs ? item.sessionIdArgs(sessionId) : []),
  ];
  const env = {
    ...(item.env ?? {}),
    ...(resumable && sessionId ? { ELDRUN_TAB_UID: sessionId } : {}),
  };
  return {
    label: itemLabel(item, t),
    cmd: item.cmd,
    args,
    env,
    cwd: projectCwd,
    kind: item.kind,
    initialInput,
    sessionId,
    ...(item.resumeArgs?.length ? { resumeArgs: item.resumeArgs } : {}),
  };
}

/** Stable empty custom-agent array, so a settings selector's `?? …` fallback
 *  keeps a constant reference (a fresh `[]` each render would loop the probe
 *  effect that depends on it). */
export const EMPTY_CUSTOM_AGENTS: CustomAgent[] = [];

/** The useful first-launch shortlist. Once the user touches a 🧠 "+ tab" chip,
 *  their persisted list (including an intentional empty one) takes over. */
export const DEFAULT_COMPACT_AGENT_IDS = ["claude", "codex", "gemini"];

/** Keep only the selected built-in agents in the menu's idle compact view, but
 * always retain the management row. Searching still receives the full list. */
export function compactAgentMenuEntries(
  entries: AddMenuEntry[],
  compactBins: ReadonlySet<string>,
): AddMenuEntry[] {
  return entries.filter(
    (entry) => compactBins.has(entry.key) || entry.key === "__add_custom_agent__",
  );
}

/** The installed built-in commands from the backend's agent registry. Agent
 * ids are not necessarily executable names (Google Antigravity is
 * `antigravity` / `agy`), while menu items launch by executable name. */
export interface BuiltInAgentStatus {
  bin: string;
  installed: boolean;
}

export function installedAgentBins(agents: readonly BuiltInAgentStatus[]): Set<string> {
  return new Set(agents.filter((agent) => agent.installed).map((agent) => agent.bin));
}

/** Apply Manage Agents' persisted registry ids to the executable-name set used
 * by tab launchers. Most ids equal their command, but this must also cover
 * entries such as `antigravity`/`agy` and `swe-agent`/`sweagent`. */
export function enabledInstalledAgentBins(
  agents: readonly (BuiltInAgentStatus & { id: string })[],
  disabledIds: readonly string[] | undefined,
): Set<string> {
  if (!disabledIds?.length) return installedAgentBins(agents);
  const disabled = new Set(disabledIds);
  for (const agent of agents) {
    if (disabled.has(agent.id)) disabled.add(agent.bin);
  }
  return new Set([...installedAgentBins(agents)].filter((bin) => !disabled.has(bin)));
}

/** Adapt a persisted {@link CustomAgent} into a menu item so it launches through
 *  the same `buildStaticTabSpec` path as the built-in agents. */
export function customAgentToItem(ca: CustomAgent): StaticMenuItem {
  return {
    label: ca.label,
    cmd: ca.cmd,
    kind: "agent",
    args: ca.args,
    env: ca.env,
    resumeArgs: ca.resumeArgs,
  };
}

/**
 * Build the "Agents" group's rows for the add-tab menu, shared by the main-window
 * `TabBar` and the popout's `NewTabMenu` so both list agents identically:
 *   1. built-in agents whose binary is installed (`installedBuiltins`),
 *   2. every custom agent — greyed with a "(not found)" suffix when its command
 *      is known-missing (`installedCmds` resolved and lacking it), since the user
 *      added it deliberately and silently dropping it would be baffling,
 *   3. the "＋ Add agent…" row that opens the manage-agents dialog.
 *
 * `installedBuiltins`/`installedCmds` are `null` until their probes resolve, so
 * built-ins render nothing (no flash of all agents) while custom agents — which
 * the user typed themselves — render enabled until a probe proves one missing.
 */
export function agentMenuEntries(opts: {
  installedBuiltins: Set<string> | null;
  installedCmds: Set<string> | null;
  customAgents: CustomAgent[];
  /** Strict built-in-only surfaces (Trash) must not offer arbitrary commands. */
  allowCustom?: boolean;
  pick: (item: StaticMenuItem) => void;
  onAddCustom: () => void;
  t: (key: TranslationKey) => string;
}): AddMenuEntry[] {
  const builtins = AGENT_ITEMS.filter((item) =>
    opts.installedBuiltins?.has(item.cmd),
  ).map((item) => ({
    key: item.cmd,
    label: item.label,
    color: TAB_ACCENT[item.kind],
    onPick: () => opts.pick(item),
  }));
  const custom = (opts.allowCustom !== false ? opts.customAgents : []).map((ca) => {
    const missing = opts.installedCmds != null && !opts.installedCmds.has(ca.cmd);
    return {
      key: `custom:${ca.id}`,
      label: missing ? `${ca.label} (${opts.t("globalApps.notFoundPlaceholder")})` : ca.label,
      color: TAB_ACCENT.agent,
      disabled: missing,
      onPick: () => opts.pick(customAgentToItem(ca)),
    };
  });
  return [
    ...builtins,
    ...custom,
    ...(opts.allowCustom !== false
      ? [{
          key: "__add_custom_agent__",
          label: opts.t("newTabMenu.addAgent"),
          dot: "＋",
          color: "var(--text-muted)",
          onPick: opts.onAddCustom,
        }]
      : []),
  ];
}
