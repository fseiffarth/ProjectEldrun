/** Pure frontend helpers for the agent-fence settings and project-pill states. */

export interface AgentFenceStatus {
  enforced: boolean;
  reason: string;
  roots: string[];
  bwrap_available: boolean;
}

export const AGENT_FENCE_DEFAULT_PATHS = [
  "~/.local/bin",
  "~/.local/share/claude",
  "~/.local/share/pnpm",
  "~/.nvm",
  "~/.cargo",
  "~/.rustup",
  "~/anaconda3",
  "~/miniconda3",
  "~/.pyenv",
  "~/.bun",
  "~/go",
  "~/.gitconfig",
  "~/.config/git",
] as const;

export function parseAgentFencePaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path, index, all) => path !== "" && all.indexOf(path) === index);
}

export type AgentFenceLabelKey =
  | "pill.agentFenceInherit"
  | "pill.agentFenceOn"
  | "pill.agentFenceOff";

export function agentFenceLabelKey(value: boolean | undefined): AgentFenceLabelKey {
  return value === undefined
    ? "pill.agentFenceInherit"
    : value
      ? "pill.agentFenceOn"
      : "pill.agentFenceOff";
}

export type AgentFenceReasonKey =
  | "pill.agentFenceReasonRemote"
  | "pill.agentFenceReasonMacos"
  | "pill.agentFenceReasonWindows"
  | "pill.agentFenceReasonPlatform"
  | "pill.agentFenceReasonContainer"
  | "pill.agentFenceReasonOff"
  | "pill.agentFenceReasonBwrap"
  | "pill.agentFenceReasonUnknown";

export function agentFenceReasonKey(reason: string): AgentFenceReasonKey | null {
  const keys: Record<string, AgentFenceReasonKey> = {
    "remote host": "pill.agentFenceReasonRemote",
    macOS: "pill.agentFenceReasonMacos",
    Windows: "pill.agentFenceReasonWindows",
    "this platform": "pill.agentFenceReasonPlatform",
    container: "pill.agentFenceReasonContainer",
    off: "pill.agentFenceReasonOff",
    "bubblewrap unavailable": "pill.agentFenceReasonBwrap",
    "unknown project or box": "pill.agentFenceReasonUnknown",
  };
  return keys[reason] ?? null;
}
