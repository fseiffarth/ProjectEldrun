import { beforeEach, describe, expect, it } from "vitest";
import {
  claimInitialInput,
  clearClaimedInitialInputsForTest,
  initialInputForPty,
  isTerminalIdentityResponse,
} from "../lib/terminalControl";

describe("terminal control helpers", () => {
  beforeEach(() => {
    clearClaimedInitialInputsForTest();
  });

  it("detects xterm identity replies that must not become shell input", () => {
    expect(isTerminalIdentityResponse("\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalIdentityResponse("\x1b[?1;2c")).toBe(true);
    expect(isTerminalIdentityResponse("\x1b[>0;276;0c\x1b[?1;2c")).toBe(true);
  });

  it("does not classify ordinary command text as a terminal identity reply", () => {
    expect(isTerminalIdentityResponse("PATH=/usr/bin:$PATH bash 'install.sh'")).toBe(false);
    expect(isTerminalIdentityResponse("0;276;0cPATH=/usr/bin:$PATH bash 'install.sh'")).toBe(false);
  });

  it("clears shell readline before auto-typing commands", () => {
    expect(initialInputForPty("bash 'install.sh'", "shell")).toBe("\x15bash 'install.sh'");
    expect(initialInputForPty("/hooks", "agent")).toBe("/hooks");
  });

  it("claims a given initial input only once per PTY id", () => {
    expect(claimInitialInput("p:shell-1", "bash 'install.sh'")).toBe(true);
    expect(claimInitialInput("p:shell-1", "bash 'install.sh'")).toBe(false);
    expect(claimInitialInput("p:shell-2", "bash 'install.sh'")).toBe(true);
    expect(claimInitialInput("p:shell-1", "bash 'other.sh'")).toBe(true);
  });
});
