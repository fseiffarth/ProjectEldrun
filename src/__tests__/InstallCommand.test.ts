import { describe, expect, it } from "vitest";
import { installShellCommand } from "../lib/installCommand";

describe("installShellCommand", () => {
  it("selects Bash explicitly for Bash installers", () => {
    expect(installShellCommand("bash")).toBe("/bin/bash");
  });

  it("selects PowerShell explicitly for PowerShell installers", () => {
    expect(installShellCommand("powershell")).toBe("powershell.exe");
  });

  it("leaves shell-neutral commands on the default shell", () => {
    expect(installShellCommand("default")).toBe("");
  });
});
