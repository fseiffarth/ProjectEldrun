/**
 * Steering's agent keys (`lib/shortcuts/steeringAgent`): which agent tabs take
 * Clear / Plan / Goal, and that Plan / Goal lead the prompt through the
 * terminal's own input path without submitting it.
 */
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leadAgentPrompt, steeringAgentOffer } from "../../lib/shortcuts/steeringAgent";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import type { TabEntry } from "../../stores/tabs";

const tab = (cmd: string, kind: TabEntry["kind"] = "agent"): TabEntry =>
  ({ key: `t-${cmd}`, label: cmd, cmd, kind }) as TabEntry;

describe("steering agent keys", () => {
  const fake = { focus: vi.fn(), input: vi.fn() };
  afterEach(() => {
    unregisterTerminal("p:t-claude", fake as unknown as Terminal);
    unregisterTerminal("p:t-aider", fake as unknown as Terminal);
    vi.clearAllMocks();
  });

  it("offers each key only to the CLIs that take it", () => {
    expect(steeringAgentOffer(tab("claude"))).toEqual({ clear: true, plan: true, goal: true, prompt: true });
    expect(steeringAgentOffer(tab("gemini"))).toEqual({ clear: true, plan: true, goal: false, prompt: true });
    expect(steeringAgentOffer(tab("aider"))).toEqual({ clear: true, plan: false, goal: false, prompt: true });
    expect(steeringAgentOffer(tab("bash", "shell"))).toEqual({ clear: false, plan: false, goal: false, prompt: false });
    expect(steeringAgentOffer(null)).toEqual({ clear: false, plan: false, goal: false, prompt: false });
  });

  it("types the command at the start of the prompt, unsubmitted", () => {
    registerTerminal("p:t-claude", fake as unknown as Terminal);
    expect(leadAgentPrompt("p", tab("claude"), "/goal")).toBe(true);
    expect(fake.focus).toHaveBeenCalled();
    expect(fake.input).toHaveBeenCalledWith("\u0001/goal ", true);
  });

  it("leaves a CLI without the command, or a tab without a terminal, alone", () => {
    registerTerminal("p:t-aider", fake as unknown as Terminal);
    expect(leadAgentPrompt("p", tab("aider"), "/plan")).toBe(false);
    expect(leadAgentPrompt("p", tab("claude"), "/plan")).toBe(false);
    expect(fake.input).not.toHaveBeenCalled();
  });
});
