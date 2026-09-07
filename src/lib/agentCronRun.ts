import { invoke } from "@tauri-apps/api/core";
import { AGENT_CRON_MESSAGE } from "./agentCron";

/**
 * The agent warm-up cron's impure half: actually send the message. The schedule
 * that decides *when* is `lib/agentCron.ts`; the timer that asks is
 * `components/layout/AgentCronHost.tsx`.
 *
 * A run is one backend call, `agent_warmup`, which starts the agent CLI in its
 * own **one-shot print mode** (`claude -p`, `codex exec`, `gemini -p`, …) as a
 * detached background process — no terminal, no tab, no project, no window.
 * The recipe per CLI lives in the backend (`commands::agents::WARMUPS`), next
 * to the registry that knows where the binary is; the frontend never supplies
 * executable text, only the agent's id and the fixed message.
 *
 * It used to type into an agent tab in the Trash project. That worked, but it
 * meant a visible tab per agent per day, a PTY that had to boot a TUI just to
 * be typed at, and a dependency on Trash's sandbox container being up at 06:00.
 * The print mode opens the usage window exactly as a keystroke would — the
 * allowance counts the request, not the terminal — and leaves nothing behind
 * but a session file under `<state_dir>/agent-cron/`.
 */

/** What a run did, for the log line in the scheduler. Not surfaced in the UI:
 *  the panel says when the next run is, and the toggle is greyed for an agent
 *  the backend cannot drive (`AgentInfo.warmup`), so the failures left here are
 *  the ones nobody can act on from a settings panel. */
export type AgentCronOutcome = "started" | "unsupported" | "not_installed" | "failed";

/** The backend's reply: which process it started. */
interface AgentWarmupLaunch {
  pid: number;
  command: string;
  cwd: string;
}

/** Map the backend's refusal text onto an outcome. The messages are the
 *  command's own (`agent_warmup`); anything else is a spawn failure. */
export function classifyWarmupError(error: unknown): AgentCronOutcome {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  if (/no known non-interactive mode|unknown agent/i.test(text)) return "unsupported";
  if (/is not installed/i.test(text)) return "not_installed";
  return "failed";
}

/**
 * Send one warm-up message to `agent` (registry id or binary name) in the
 * background. Resolves once the process is *started*; the answer is never
 * read — the request is what opens the window.
 */
export async function runAgentCronWarmup(
  agent: string,
  message: string = AGENT_CRON_MESSAGE,
): Promise<AgentCronOutcome> {
  try {
    const launch = await invoke<AgentWarmupLaunch>("agent_warmup", { agent, message });
    console.info("agent warm-up started", agent, launch.command, `pid ${launch.pid}`);
    return "started";
  } catch (error) {
    const outcome = classifyWarmupError(error);
    console.error("agent warm-up", outcome, agent, error);
    return outcome;
  }
}
