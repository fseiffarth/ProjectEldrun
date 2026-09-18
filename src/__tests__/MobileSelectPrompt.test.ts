import { describe, expect, it } from "vitest";
import { readSelectPrompt, selectKeys, selectSignature } from "../../mobile-web/src/terminal/selectPrompt";
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
      // The heading is read too: a dialog can be several steps, and it is the
      // only thing on screen that says which one.
      title: "Select Model",
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

  it("reads the heading a step drew, and the next step's over it", () => {
    // codex-cli 0.153.4: `/model` is two questions, and only the heading says
    // which one is on screen. Both are drawn in the same place.
    const models = readSelectPrompt(lines(
      "Select Model and Effort",
      "Access legacy models by running codex -m <model_name> or in your config.toml",
      "",
      "  1. gpt-6-astra (default)  Our most capable model for complex, demanding work.",
      "\u203a 2. gpt-5.6-sol (current)  Reliable agentic workhorse for everyday tasks.",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(models?.title).toBe("Select Model and Effort");
    const levels = readSelectPrompt(lines(
      "Select Reasoning Level for gpt-5.6-sol",
      "",
      "  1. Low (default)   Fast responses with lighter reasoning",
      "\u203a 2. High (current)  Greater reasoning depth for complex problems",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(levels?.title).toBe("Select Reasoning Level for gpt-5.6-sol");
    // Which is what tells a sheet that answered the first one that the second
    // is a new question and not the answered list, still painted.
    expect(selectSignature(models!)).not.toBe(selectSignature(levels!));
    // The highlight is not part of it: walking a list is not changing it.
    const walked = readSelectPrompt(lines(
      "Select Reasoning Level for gpt-5.6-sol",
      "",
      "\u203a 1. Low (default)   Fast responses with lighter reasoning",
      "  2. High (current)  Greater reasoning depth for complex problems",
      "",
    ));
    expect(selectSignature(walked!)).toBe(selectSignature(levels!));
  });

  it("keeps reading rows past a note wrapped at phone width", () => {
    // codex-cli 0.155.0 at 70 columns: sol's note fits, astra's wraps, and the
    // wrapped line used to end the list after the second row.
    const codex = readSelectPrompt(lines(
      "Select Model and Effort",
      "Access legacy models by running codex -m <model_name> or in your c",
      "",
      "  1. gpt-5.6-sol (default)  Latest frontier agentic coding model.",
      "\u203a 2. gpt-6-astra (current)  Our most capable model for complex,",
      "                            demanding work.",
      "  3. gpt-5.6-terra          Balanced agentic coding model for",
      "                            everyday work.",
      "  4. gpt-5.6-luna           Fast and affordable agentic coding",
      "                            model.",
      "  5. gpt-5.5                Proven previous-generation model for",
      "                            coding and general work.",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(codex?.options.map((option) => option.label)).toEqual([
      "gpt-5.6-sol (default)",
      "gpt-6-astra (current)",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(codex?.current).toBe(1);
    expect(codex?.title).toBe("Select Model and Effort");
    expect(codex?.options[1].description).toBe("Our most capable model for complex, demanding work.");
    // Claude Code 50 columns wide wraps every note, the same way.
    const claude = readSelectPrompt(lines(
      "   Select model",
      "   Switch between Claude models.",
      "",
      "     1. Default (recommended)  Opus 5 with 1M",
      "                               context",
      "   \u276f 2. Fable \u2714                Fable 5.1 · Most",
      "                               capable",
      "     3. Haiku                  Haiku 4.5 ·",
      "                               Fastest",
    ));
    expect(claude?.options).toHaveLength(3);
    expect(claude?.current).toBe(1);
    expect(claude?.options[2].description).toBe("Haiku 4.5 · Fastest");
  });

  it("ends the run at text shallower than the note's column", () => {
    const prompt = readSelectPrompt(lines(
      "  1. Opus    Big",
      "\u276f 2. Sonnet  Mid",
      "  some output",
      "  3. Haiku   Small",
    ));
    expect(prompt?.options).toHaveLength(2);
    expect(prompt?.options[1].description).toBe("Mid");
  });

  it("leaves a dialog untitled rather than titling it with the output above it", () => {
    const prompt = readSelectPrompt(lines(
      "I read the three files and they agree on the shape of the fix,",
      "which is to move the guard up into the caller so the two paths",
      "cannot disagree about it, and then delete the second check.",
      "Which one should I write first?",
      "",
      "\u276f 1. The caller",
      "  2. The callee",
    ));
    expect(prompt?.options).toHaveLength(2);
    expect(prompt?.title).toBeUndefined();
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
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
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
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    // "auto" is Codex's without a label and Qwen's with one.
    expect(modeChoices("auto", "Qwen")[0].value).toBe("ask permissions");
    expect(modeChoices("auto")[0].value).toBe("working");
    // "plan" is Codex's too since 0.151 — the label is again the only tie-break,
    // and without it Claude Code's list wins by declaration order.
    expect(modeChoices("plan mode", "Codex").map((choice) => choice.value))
      .toEqual(["working", "plan", "read only", "auto", "full access"]);
  });

  it("never hands a labelled tab another family's list for a mode its own does not know", () => {
    // The label names the family; a mode it does not list earns no list,
    // rather than walking the session through another family's choices.
    expect(modeChoices("read only", "Qwen")).toEqual([]);
    expect(modeChoices("full access", "Claude")).toEqual([]);
  });

  it("gives Claude Code's auto mode to a Claude tab, and only to one", () => {
    // Claude Code draws "auto mode on" (read out of the 2.1.272 bundle). Bare
    // "auto" is Codex's and Qwen's word too, so only the label hands it to
    // Claude — unlabelled, the first family that always claimed it still wins.
    const claude = modeChoices("auto", "Claude");
    expect(claude.map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    expect(currentMode(claude, "auto", true)).toBe("auto");
    expect(modeChoices("auto")[0].value).toBe("working");
    expect(modeChoices("auto", "Qwen")[0].value).toBe("ask permissions");
  });

  it("reads a frame without mode text as a silent-mode family's default", () => {
    // Claude Code prints nothing while in default mode, so the label alone
    // earns the list — but only for a family that has a silent mode.
    const claude = modeChoices(undefined, "Claude");
    expect(claude.map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
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
