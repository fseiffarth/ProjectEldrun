import { describe, expect, it } from "vitest";
import { readSelectPrompt, selectKeys } from "../../mobile-web/src/terminal/selectPrompt";
import { currentMode, modeChoices } from "../../mobile-web/src/terminal/agentModes";
import { inputFrameStart, sessionStatus } from "../../mobile-web/src/terminal/statusLine";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const ESC = String.fromCharCode(27);

describe("Eldrun Mobile select dialog", () => {
  it("reads the rows of a model picker, with the highlighted one", () => {
    // The Claude Code shape, after readableScreen stripped the box frame.
    const prompt = readSelectPrompt(lines(
      "Select Model",
      "Switch between Claude models. Applies to this session.",
      "",
      "  1. Default (recommended)   Opus for up to 50% of usage, then Sonnet",
      "❯ 2. Opus                    For complex tasks",
      "  3. Sonnet                  Most efficient for everyday tasks",
      "",
      "Esc to cancel",
    ));
    expect(prompt).toEqual({
      current: 1,
      options: [
        { index: 0, number: 1, label: "Default (recommended)", description: "Opus for up to 50% of usage, then Sonnet" },
        { index: 1, number: 2, label: "Opus", description: "For complex tasks" },
        { index: 2, number: 3, label: "Sonnet", description: "Most efficient for everyday tasks" },
      ],
    });
  });

  it("reads a picker whose rows carry no second column", () => {
    const prompt = readSelectPrompt(lines("› 1. gpt-5-codex", "  2. gpt-5"));
    expect(prompt?.current).toBe(0);
    expect(prompt?.options.map((option) => option.label)).toEqual(["gpt-5-codex", "gpt-5"]);
    expect(prompt?.options[0].description).toBeUndefined();
  });

  it("refuses a numbered list that is not a dialog", () => {
    // An agent answering with a numbered list is exactly what the removed
    // semantic parser used to turn into buttons. No highlight, no list.
    expect(readSelectPrompt(lines(
      "Here is the plan:",
      "1. Read the file",
      "2. Change the function",
      "3. Run the tests",
    ))).toBeNull();
  });

  it("refuses rows that are not one contiguous run", () => {
    expect(readSelectPrompt(lines("❯ 1. Opus", "", "  2. Sonnet"))).toBeNull();
    expect(readSelectPrompt(lines("❯ 1. Opus", "some output", "  2. Sonnet"))).toBeNull();
    expect(readSelectPrompt(lines("❯ 1. Opus"))).toBeNull();
  });

  it("refuses a run with more than one highlight", () => {
    expect(readSelectPrompt(lines("❯ 1. Opus", "❯ 2. Sonnet"))).toBeNull();
  });

  it("takes the live dialog when an earlier one is still on screen", () => {
    const prompt = readSelectPrompt(lines(
      "❯ 1. Opus",
      "  2. Sonnet",
      "output in between",
      "  1. Opus",
      "  2. Sonnet",
      "❯ 3. Haiku",
    ));
    expect(prompt?.current).toBe(2);
  });

  it("moves the highlight the way the arrow row does", () => {
    expect(selectKeys(1, 3)).toEqual([`${ESC}[B`, `${ESC}[B`, "\r"]);
    expect(selectKeys(2, 0)).toEqual([`${ESC}[A`, `${ESC}[A`, "\r"]);
    expect(selectKeys(1, 1)).toEqual(["\r"]);
  });
});

describe("Eldrun Mobile permission modes", () => {
  it("offers the family of the mode the session is showing", () => {
    expect(modeChoices("plan").map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "bypass permissions"]);
    expect(modeChoices("full access").map((choice) => choice.value))
      .toEqual(["working", "plan", "read only", "auto", "full access"]);
    expect(modeChoices("yolo").map((choice) => choice.value))
      .toEqual(["ask permissions", "plan", "auto-accept", "auto", "yolo"]);
  });

  it("offers nothing for a session whose mode no family claims", () => {
    expect(modeChoices(undefined)).toEqual([]);
    expect(modeChoices("something else")).toEqual([]);
    expect(modeChoices("something else", "Claude")).toEqual([]);
  });

  it("lets the agent label break a tie between families sharing a mode", () => {
    // "plan" is a mode of both Claude Code and Qwen Code; only the tab's
    // label says which session this is.
    expect(modeChoices("plan", "Qwen").map((choice) => choice.value))
      .toEqual(["ask permissions", "plan", "auto-accept", "auto", "yolo"]);
    expect(modeChoices("plan", "Claude 2").map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "bypass permissions"]);
    // "auto" is Codex's without a label and Qwen's with one.
    expect(modeChoices("auto", "Qwen")[0].value).toBe("ask permissions");
    expect(modeChoices("auto")[0].value).toBe("working");
    // "plan" is Codex's too since 0.151 — the label is again the only tie-break,
    // and without it Claude Code's list wins by declaration order.
    expect(modeChoices("plan mode", "Codex").map((choice) => choice.value))
      .toEqual(["working", "plan", "read only", "auto", "full access"]);
  });

  it("never hands a labelled tab another family's list for a mode its own does not know", () => {
    // Claude Code drawing "auto mode": bare "auto" is claimed by Codex and Qwen,
    // and the sheet used to walk the Claude session through Codex's choices.
    // The label names the family; a mode it does not list earns no list.
    expect(modeChoices("auto", "Claude")).toEqual([]);
    expect(modeChoices("read only", "Qwen")).toEqual([]);
    // Unlabelled, the first claimant still wins, as before.
    expect(modeChoices("auto")[0].value).toBe("working");
  });

  it("reads a frame without mode text as a silent-mode family's default", () => {
    // Claude Code prints nothing while in default mode, so the label alone
    // earns the list — but only for a family that has a silent mode.
    const claude = modeChoices(undefined, "Claude");
    expect(claude.map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "bypass permissions"]);
    expect(currentMode(claude, undefined, true)).toBe("default");
    // With no input frame on screen, absence of text says nothing.
    expect(currentMode(claude, undefined, false)).toBeUndefined();
    // Codex draws no mode line while it is working (verified against
    // codex-cli 0.151.0), so a framed Codex tab with no mode text reads the
    // same way a Claude one does.
    const codex = modeChoices(undefined, "Codex");
    expect(codex.map((choice) => choice.value)).toEqual(["working", "plan", "read only", "auto", "full access"]);
    expect(currentMode(codex, undefined, true)).toBe("working");
    // Qwen draws one for every mode; no text means no readout.
    expect(modeChoices(undefined, "Qwen")).toEqual([]);
  });

  it("maps an alias onto the mode it lists", () => {
    const claude = modeChoices("auto-accept");
    expect(currentMode(claude, "auto-accept")).toBe("accept edits");
    expect(currentMode(claude, "plan")).toBe("plan");
    expect(currentMode(claude, "read only")).toBeUndefined();
    const qwen = modeChoices("yolo");
    expect(currentMode(qwen, "accept edits")).toBe("auto-accept");
  });

  it("reads Codex's bare auto mode without claiming Claude's auto-compact", () => {
    expect(sessionStatus(lines("> ", "auto"))?.mode).toBe("auto");
    expect(sessionStatus(lines("> ", "~/projects/auto  ·  auto-compact left: 12%"))?.mode).toBeUndefined();
  });
});

describe("Eldrun Mobile input frame", () => {
  const cut = (...texts: string[]) => {
    const rows = lines(...texts);
    return rows.slice(0, inputFrameStart(rows)).map((row) => row.text);
  };

  it("cuts the input box, its rule and the status lines under it", () => {
    // The bottom of a live Claude Code screen, as readableScreen renders it:
    // the box's side edges are already stripped, its labelled top rule is not.
    expect(cut(
      "● Done — the reading view now stops above the box.",
      "",
      `${"\u2500".repeat(40)} ProjectEldrun \u2500`,
      "\u276f",
      "  ~/eldrun/projects/projecteldrun (develop) \u00b7 Opus 5 \u00b7 ctx 93%",
      "  \u23f5\u23f5 auto mode on (shift+tab to cycle)",
    )).toEqual(["● Done — the reading view now stops above the box."]);
  });

  it("keeps a dialog the session is waiting on", () => {
    // `\u276f 1. Yes` opens with the input line's own marker. Cutting there
    // would hide the question and leave the reader tapping at nothing.
    const dialog = [
      "Do you want to proceed?",
      "\u276f 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ];
    expect(cut(...dialog)).toEqual(dialog);
  });

  it("keeps a screen that is not showing an input frame at all", () => {
    const output = ["$ npm test", " \u2713 MobileReadableScreen.test.ts (11 tests)", ""];
    expect(cut(...output)).toEqual(output);
    // A prompt further up than the frame window is scrolled-past output.
    expect(cut("\u276f ", "a", "b", "c", "d", "e", "f", "g", "h", "i").length).toBe(10);
  });
});
