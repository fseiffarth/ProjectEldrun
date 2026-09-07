import { describe, expect, it } from "vitest";
import { sessionStatus, shortenPath } from "../../mobile-web/src/terminal/statusLine";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

describe("Eldrun Mobile session status line", () => {
  it("reads path, branch, model, mode and context from a statusline", () => {
    // The Claude Code shape: input box (already unframed by readableScreen),
    // then the configured statusline below it.
    expect(sessionStatus(lines(
      "● Done.",
      "",
      ">",
      "~/eldrun/projects/projecteldrun (develop) · Opus 4.1 · plan mode on (shift+tab to cycle) · 85% context left",
    ))).toEqual({
      path: "~/eldrun/projects/projecteldrun",
      branch: "develop",
      model: "Opus 4.1",
      mode: "plan",
      context: "85%",
    });
  });

  it("reads the default Claude Code footer without inventing fields", () => {
    const status = sessionStatus(lines("> ", "? for shortcuts · 85% context left"));
    expect(status).toEqual({ context: "85%" });
  });

  it("reads the mode line drawn below the input box", () => {
    expect(sessionStatus(lines("> try it", "⏵⏵ accept edits on (shift+tab to cycle)")))
      .toEqual({ mode: "accept edits" });
    expect(sessionStatus(lines(">", "⏵⏵ bypass permissions on (shift+tab to cycle)")))
      .toEqual({ mode: "bypass permissions" });
  });

  it("reads a Codex-shaped footer", () => {
    expect(sessionStatus(lines(
      "› ",
      "/home/dev/proj (main) · gpt-5-codex · 97% context left",
    ))).toEqual({
      path: "/home/dev/proj",
      branch: "main",
      model: "gpt-5-codex",
      context: "97%",
    });
  });

  it("never mistakes the cycle hint or a count for a branch", () => {
    const status = sessionStatus(lines(">", "~/proj (3) · plan mode on (shift+tab to cycle)"));
    expect(status?.branch).toBeUndefined();
    expect(status?.mode).toBe("plan");
  });

  it("answers null when the bottom of the screen is not an input frame", () => {
    // A markdown quote in ordinary output must not be read as the input box.
    expect(sessionStatus(lines(
      "> a quoted sentence from the answer",
      ...Array.from({ length: 9 }, (_, index) => `prose line ${index}`),
    ))).toBeNull();
    expect(sessionStatus(lines("dev@host:~/proj$ npm test"))).toBeNull();
  });

  it("does not read 'auto-compact' in the context notice as a mode", () => {
    const status = sessionStatus(lines(">", "Context left until auto-compact: 34%"));
    expect(status).toEqual({ context: "34%" });
  });

  it("reads every Qwen Code approval-mode indicator", () => {
    // The exact AutoAcceptIndicator strings qwen-code draws below its input
    // box, cycle hint included (English locale — the CLI's default).
    expect(sessionStatus(lines(">", "⏸ Ask permissions (shift + tab to cycle)"))?.mode)
      .toBe("ask permissions");
    // "auto-accept edits" contains "accept edits", so the earlier, more
    // general pattern reports it — the Qwen family lists that as an alias.
    expect(sessionStatus(lines(">", "auto-accept edits (shift + tab to cycle)"))?.mode)
      .toBe("accept edits");
    expect(sessionStatus(lines(">", "Auto mode (shift + tab to cycle)"))?.mode)
      .toBe("auto");
    expect(sessionStatus(lines(">", "plan mode (shift + tab to cycle)"))?.mode)
      .toBe("plan");
    // YOLO switches the prompt prefix to `*`, so the input line itself changes.
    expect(sessionStatus(lines("* ", "YOLO mode (shift + tab to cycle)"))?.mode)
      .toBe("yolo");
  });

  it("reads a decimal context percentage and Gemini's bare '% used'", () => {
    // Qwen prints "45.2% context used"; the old integer-only match read the
    // trailing "2%" out of it.
    expect(sessionStatus(lines(">", "45.2% context used"))?.context).toBe("45.2%");
    // Gemini's footer column says "25% used" with no word "context" at all.
    expect(sessionStatus(lines(">", "~/proj  main  gemini-2.5-pro  25% used"))).toMatchObject({
      path: "~/proj",
      model: "gemini-2.5-pro",
      context: "25%",
    });
    // A percentage inside a sentence is not a context readout.
    expect(sessionStatus(lines(">", "Downloading 50% done"))?.context).toBeUndefined();
  });

  it("shortens a long path to its last two components", () => {
    expect(shortenPath("~/eldrun/projects/projecteldrun")).toBe("…/projects/projecteldrun");
    expect(shortenPath("~/proj")).toBe("~/proj");
    expect(shortenPath("/home/dev/work/app")).toBe("…/work/app");
  });
});
