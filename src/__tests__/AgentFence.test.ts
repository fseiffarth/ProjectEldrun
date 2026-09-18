import { describe, expect, it } from "vitest";
import {
  AGENT_FENCE_DEFAULT_PATHS,
  agentFenceInstallCommand,
  agentFenceLabelKey,
  agentFenceReasonKey,
  parseAgentFencePaths,
} from "../lib/agents/agentFence";

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
    expect(agentFenceReasonKey("sandbox-exec unavailable")).toBe("pill.agentFenceReasonSeatbelt");
  });
});

describe("agent fence install button", () => {
  const base = { enforced: false, reason: "bubblewrap unavailable", roots: [] };

  it("uses the backend's distro command when the tool is missing", () => {
    expect(
      agentFenceInstallCommand({
        ...base,
        bwrap_available: false,
        install_cmd: "sudo dnf install -y bubblewrap",
      }),
    ).toBe("sudo dnf install -y bubblewrap");
  });

  it("offers nothing for an unknown distribution or an older backend", () => {
    expect(agentFenceInstallCommand({ ...base, bwrap_available: false, install_cmd: null })).toBeNull();
    expect(agentFenceInstallCommand({ ...base, bwrap_available: false })).toBeNull();
  });

  it("offers nothing while the tool works", () => {
    expect(
      agentFenceInstallCommand({ ...base, bwrap_available: true, install_cmd: "sudo apt install -y bubblewrap" }),
    ).toBeNull();
    expect(agentFenceInstallCommand(null)).toBeNull();
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
