/**
 * The metric keys of `usage_stats.json`, and how a tab maps onto them.
 *
 * Mirrors `schema::usage_stats::metric` (src-tauri) — keep the two in step. The
 * key space is namespaced with `.` and deliberately open-ended: the trailing
 * segment of an agent key is the agent's command (`claude`, `codex`) or a local
 * model name (`qwen3:8b`), neither of which is a closed set.
 */

// Type-only, so this stays free of a runtime import cycle: `tabs.ts` imports
// *this* module to count tab opens.
import type { TabKind } from "../stores/tabs";

export const METRIC = {
  /** `agent.tab.<cmd>` — an agent tab was opened. */
  AGENT_TAB: "agent.tab",
  /** `agent.tab.local.<model>` — a local (Ollama-backed) agent tab was opened. */
  AGENT_TAB_LOCAL: "agent.tab.local",
  /** `agent.active.<cmd>` — distinct agent tabs that received ≥1 prompt that day. */
  AGENT_ACTIVE: "agent.active",
  /** `agent.prompt.<cmd>` — prompts submitted to an agent. */
  AGENT_PROMPT: "agent.prompt",
  /** Seconds agent tabs spent actually working. */
  AGENT_WORKED_S: "agent.worked_s",
  /** Times an agent stopped to ask you a decision. */
  AGENT_DECISION: "agent.decision",
  /** Times an agent finished a turn. */
  AGENT_DONE: "agent.done",
  /** Commands run in a shell tab. */
  SHELL_COMMAND: "shell.command",
  FILE_CREATED: "file.created",
  FILE_MODIFIED: "file.modified",
  FILE_DELETED: "file.deleted",
  TAB_OPENED: "tab.opened",
  TAB_CLOSED: "tab.closed",
  APP_LAUNCHED: "app.launched",
} as const;

/** Compose `agent.prompt` + `claude` → `agent.prompt.claude`. */
export function sub(prefix: string, leaf: string): string {
  return `${prefix}.${leaf}`;
}

/**
 * What an agent tab should be counted as: its agent command for a cloud agent
 * (`claude`), or the model name for a local one (`qwen3:8b`).
 *
 * A `local_agent` tab's model is not a field on the tab — it is carried in the
 * env Eldrun sets when spawning it (`ELDRUN_LOCAL_MODEL`, set at both local-model
 * launch routes in `TabBar`/`NewTabMenu`), with `VIBE_ACTIVE_MODEL` as the
 * fallback for the vibe route. Returns `null` for a tab that is not an agent.
 *
 * `kind === "agent"` is itself the test for "this cmd is a known agent" —
 * `cmdToKind` only assigns that kind to a cmd in its `AGENT_CMDS` set — so there
 * is no second registry to keep in step here.
 */
export function agentMetricLeaf(tab: {
  kind: TabKind;
  cmd: string;
  env?: Record<string, string>;
}): { prefix: string; leaf: string } | null {
  if (tab.kind === "local_agent") {
    const model = tab.env?.ELDRUN_LOCAL_MODEL || tab.env?.VIBE_ACTIVE_MODEL;
    // A local agent tab with no recorded model would otherwise be filed under an
    // empty key; count it under its driving command instead of inventing one.
    if (model) return { prefix: METRIC.AGENT_TAB_LOCAL, leaf: model };
    return { prefix: METRIC.AGENT_TAB, leaf: tab.cmd };
  }
  if (tab.kind === "agent" && tab.cmd) {
    return { prefix: METRIC.AGENT_TAB, leaf: tab.cmd };
  }
  return null;
}

/**
 * The leaf an agent tab's *prompts* are counted under — the same identity as
 * {@link agentMetricLeaf}, flattened to a single string so `agent.prompt.<leaf>`
 * and `agent.active.<leaf>` line up with the tab counts. A local model's leaf is
 * prefixed `local.` so it stays distinguishable from a cloud agent of the same
 * name.
 */
export function agentPromptLeaf(tab: {
  kind: TabKind;
  cmd: string;
  env?: Record<string, string>;
}): string | null {
  const id = agentMetricLeaf(tab);
  if (!id) return null;
  return id.prefix === METRIC.AGENT_TAB_LOCAL ? `local.${id.leaf}` : id.leaf;
}

/** Human labels for the well-known agent commands; unknown leaves render as-is. */
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  vibe: "Mistral",
  aider: "Aider",
  opencode: "OpenCode",
  "cursor-agent": "Cursor",
  copilot: "Copilot",
  grok: "Grok",
  qwen: "Qwen",
  openclaw: "OpenClaw",
};

/** Display name for a metric leaf (`claude` → "Claude", `local.qwen3:8b` → "qwen3:8b"). */
export function agentLabel(leaf: string): string {
  if (leaf.startsWith("local.")) return leaf.slice("local.".length);
  return AGENT_LABELS[leaf] ?? leaf;
}
