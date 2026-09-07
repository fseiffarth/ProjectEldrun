import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { classifyWarmupError, runAgentCronWarmup } from "../lib/agentCronRun";
import { AGENT_CRON_MESSAGE } from "../lib/agentCron";

describe("agent cron — the send", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("is one backend call carrying the agent and the fixed message — no tab, no PTY", async () => {
    invoke.mockResolvedValueOnce({ pid: 4242, command: "/usr/bin/claude -p Test", cwd: "/state/agent-cron" });
    await expect(runAgentCronWarmup("claude")).resolves.toBe("started");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("agent_warmup", { agent: "claude", message: AGENT_CRON_MESSAGE });
  });

  it("reports the backend's refusals by kind, and never throws", async () => {
    invoke.mockRejectedValueOnce("Aider has no known non-interactive mode");
    await expect(runAgentCronWarmup("aider")).resolves.toBe("unsupported");
    invoke.mockRejectedValueOnce("Codex is not installed");
    await expect(runAgentCronWarmup("codex")).resolves.toBe("not_installed");
    invoke.mockRejectedValueOnce(new Error("cannot start /x/claude: EACCES"));
    await expect(runAgentCronWarmup("claude")).resolves.toBe("failed");
  });

  it("classifies unknown agents as unsupported", () => {
    expect(classifyWarmupError("unknown agent: foo")).toBe("unsupported");
    expect(classifyWarmupError(undefined)).toBe("failed");
  });
});
