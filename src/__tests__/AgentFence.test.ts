import { describe, expect, it } from "vitest";
import {
  AGENT_FENCE_DEFAULT_PATHS,
  agentFenceLabelKey,
  agentFenceReasonKey,
  parseAgentFencePaths,
} from "../lib/agentFence";

describe("agent fence project-pill states", () => {
  it("maps inherit/off/on to their distinct labels", () => {
    expect(agentFenceLabelKey(undefined)).toBe("pill.agentFenceInherit");
    expect(agentFenceLabelKey(false)).toBe("pill.agentFenceOff");
    expect(agentFenceLabelKey(true)).toBe("pill.agentFenceOn");
  });

  it("maps backend status reasons to localized UI keys", () => {
    expect(agentFenceReasonKey("remote host")).toBe("pill.agentFenceReasonRemote");
    expect(agentFenceReasonKey("macOS")).toBe("pill.agentFenceReasonMacos");
    expect(agentFenceReasonKey("bubblewrap unavailable")).toBe(
      "pill.agentFenceReasonBwrap",
    );
    expect(agentFenceReasonKey("enforced")).toBeNull();
  });
});

describe("agent fence settings paths", () => {
  it("round-trips one-path-per-line input and removes blanks/duplicates", () => {
    const saved = parseAgentFencePaths(
      " ~/.cargo\r\n\n~/.local/bin\n~/.cargo\n /opt/team-tools ",
    );
    expect(saved).toEqual(["~/.cargo", "~/.local/bin", "/opt/team-tools"]);
    expect(parseAgentFencePaths(saved.join("\n"))).toEqual(saved);
  });

  it("exposes the documented default read-only tool paths", () => {
    expect(AGENT_FENCE_DEFAULT_PATHS).toEqual([
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
    ]);
  });
});
