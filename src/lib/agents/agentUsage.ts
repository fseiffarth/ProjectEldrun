import { invoke } from "@tauri-apps/api/core";

/** Mirrors `commands::agents::AgentUsageReport`. */
export interface AgentUsageReport {
  agent: string;
  label: string;
  supported: boolean;
  raw?: string;
  error?: string;
  cached: boolean;
}

/**
 * Ask one agent CLI what it says about its own usage.
 *
 * Never throws: a failed `invoke` is turned into the same shaped refusal the
 * backend returns for an agent it cannot run, so every caller has one thing to
 * render — the panel, or the reason there is none, always next to the agent it
 * is about. `refresh` means "ask the CLI again" and is still floored on the
 * backend side, so a held-down button cannot become one process per tap.
 */
export function readAgentUsage(agent: string, refresh = false): Promise<AgentUsageReport> {
  return invoke<AgentUsageReport>("agent_usage", { agent, refresh }).catch(
    (cause): AgentUsageReport => ({
      agent,
      label: agent,
      supported: false,
      error: String(cause),
      cached: false,
    }),
  );
}
