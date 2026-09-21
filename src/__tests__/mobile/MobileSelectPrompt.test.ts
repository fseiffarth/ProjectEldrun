import { describe, expect, it } from "vitest";
import { mergeSelectRows, missingSelectRow, readSelectPrompt, sameSelectStep, selectKeys, selectMoveKeys, selectSignature } from "../../../mobile-web/src/terminal/selectPrompt";
import { currentMode, modeChoices } from "../../../mobile-web/src/terminal/agentModes";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";

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
      // Where the rows start: what sits above them is the question they
      // answer, which a caller listing the rows itself still has to show.
      start: 3,
      // …and where that question starts. Here the heading and its blurb are
      // one block, so the question is both the dialog's own text and all the
      // context there is.
      question: 0,
      context: 0,
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

  it("reads a question whose notes sit on the rows under each label", () => {
    // Claude Code 2.1.278's AskUserQuestion dialog (`compact-vertical`): the
    // note is its own row, indented to the label, wrapping at the same indent.
    const prompt = readSelectPrompt(lines(
      "←  ☐ Color  ☐ Size  ✔ Submit  →",
      "",
      "Which color should the banner use?",
      "",
      "❯ 1. Red",
      "     Warm and loud",
      "  2. Green",
      "     Calm, and it matches the logo we",
      "     already ship",
      "  3. Blue",
      "  4. Type something.",
      "",
      "  5. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ));
    expect(prompt?.title).toBe("Which color should the banner use?");
    expect(prompt?.current).toBe(0);
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Red", description: "Warm and loud" },
      { index: 1, number: 2, label: "Green", description: "Calm, and it matches the logo we already ship" },
      { index: 2, number: 3, label: "Blue", description: undefined },
      { index: 3, number: 4, label: "Type something.", description: undefined },
    ]);
    // The highlight walked down: the same dialog, read the same way.
    expect(readSelectPrompt(lines("  1. Red", "     Warm and loud", "❯ 2. Green", "     Calm"))?.current).toBe(1);
  });

  it("keeps a question's preview panel out of its rows", () => {
    // Claude Code 2.1.278's AskUserQuestion with previews, captured off a real
    // session at 215 columns and read back through `readableScreen`: the rows
    // stay on the left and the highlighted row's preview is drawn in a panel
    // beside them. What stands in the rows' second column is that panel's
    // frame, not a note — and the panel's own rows, which `readableScreen`
    // strips the left edge off, end the run.
    const prompt = readSelectPrompt(lines(
      " ☐ Status strip",
      "",
      "In fullscreen Claude, Focus also loses the swipe-in status strip. Restore it from the same frame?",
      "",
      "\u276f 1. Restore it too               \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "  2. Just the question            \u2502 swipe \u2192 on the reading view",
      "\u250c\u2500 Status line \u2500\u2500\u2500\u2500\u2500\u2715\u2510",
      "\u2502 ~/eldrun/\u2026/projecteldrun       \u2502",
      "",
      "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes \u00b7 Esc to cancel",
    ), "Claude Code");
    expect(prompt?.current).toBe(0);
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Restore it too", description: undefined },
      { index: 1, number: 2, label: "Just the question", description: undefined },
    ]);
  });

  it("keeps reading a Codex question whose label wraps beside its note", () => {
    // codex-rs request_user_input `long_option_text` snapshot, narrowed: the
    // label wraps at its own column while the note wraps at the note's.
    const prompt = readSelectPrompt(lines(
      "  Question 1/1 (1 unanswered)",
      "  Choose one option.",
      "",
      "  › 1. Job: running/completed/failed/    Keep async job statuses",
      "       expired (Recommended)             for progress tracking.",
      "    2. Add a short status model          Simpler labels.",
      "",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ));
    expect(prompt?.title).toBe("Question 1/1 (1 unanswered)");
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Job: running/completed/failed/ expired (Recommended)", description: "Keep async job statuses for progress tracking." },
      { index: 1, number: 2, label: "Add a short status model", description: "Simpler labels." },
    ]);
  });

  it("bounds a Codex question to the dialog, not to the session above it", () => {
    // The real screen of a codex 0.155.1 tab that had not been prompted yet
    // (captured off the pane, replayed through xterm): its whole startup
    // banner sits above the question, and used to be shown as what the rows
    // answered. The question is the block right above them; the context stops
    // at the line that says why it is being asked.
    const prompt = readSelectPrompt(lines(
      ">_ OpenAI Codex (v0.155.1)",
      "model:     gpt-6-astra high   /model to change",
      "directory: ~/eldrun/projects/projecteldrun",
      "",
      "  Tip: New Use /fast to enable our fastest inference with increased plan usage.",
      "",
      "⚠ clamping SessionEnd hook timeout to 3s in /home/florian/.codex/config.toml",
      "",
      "• Automatically switched to Luna Reserve high due to usage limits.",
      "",
      "  You’re now using Luna, a faster model for simpler tasks.",
      "  Add credits or upgrade to continue using the most advanced models, or wait for usage to reset after 15:55.",
      "",
      "› 1. Upgrade",
      "  2. Add Credits",
      "  3. Continue with Luna Reserve",
      "",
      "  Press enter to confirm or esc to continue working",
    ), "Codex");
    expect(prompt?.options.map((option) => option.label)).toEqual(["Upgrade", "Add Credits", "Continue with Luna Reserve"]);
    expect(prompt?.start).toBe(13);
    expect(prompt?.question).toBe(10);
    expect(prompt?.context).toBe(8);
  });

  it("keeps the block above a permission dialog's question — the file it asks about", () => {
    // Claude Code's edit prompt: what is being approved stands above a blank
    // line, so the question alone would not say what the answer applies to.
    const prompt = readSelectPrompt(lines(
      "I'll add the clear button.",
      "",
      "Edit file",
      "  src/lib/i18n.ts",
      "",
      "Do you want to make this edit to i18n.ts?",
      "❯ 1. Yes",
      "  2. No",
    ));
    expect(prompt?.start).toBe(6);
    expect(prompt?.question).toBe(5);
    expect(prompt?.context).toBe(2);
  });

  it("reads a Codex list too narrow for two columns, its notes stacked under the rows", () => {
    // codex-rs list_selection_view `narrow_width_preserves_rows` snapshot.
    const prompt = readSelectPrompt(lines(
      "  Debug",
      "",
      "› 1. Item 1",
      "             xxxxxxxxx",
      "             x",
      "  2. Item 2",
      "             xxxxxxxxx",
    ));
    expect(prompt?.options.map((option) => [option.label, option.description])).toEqual([
      ["Item 1", "xxxxxxxxx x"],
      ["Item 2", "xxxxxxxxx"],
    ]);
  });

  it("reads Gemini CLI's radio dot as the highlight, on a Gemini or Qwen tab only", () => {
    // gemini-cli 0.56 BaseSelectionList: the dot, the number, then the label
    // with its note (AskUser's description, a sublabel) on the row under it.
    const screen = lines(
      "Which color should the banner use?",
      "",
      "  1.  Red",
      "      Warm and loud",
      "● 2.  Green",
      "  3.  Enter a custom value",
    );
    for (const agent of ["Gemini", "Qwen Code"]) {
      const prompt = readSelectPrompt(screen, agent);
      expect(prompt?.current).toBe(1);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Red", "Green", "Enter a custom value"]);
      expect(prompt?.options[0].description).toBe("Warm and loud");
    }
    // On Claude Code (Linux) and Kimi Code `●` opens an answer, and an answer
    // opening with a numbered list is no dialog.
    const answer = lines("● 1. Read the file", "  2. Change the function");
    expect(readSelectPrompt(answer, "Claude")).toBeNull();
    expect(readSelectPrompt(answer)).toBeNull();
    expect(readSelectPrompt(answer, "Gemini")?.current).toBe(0);
  });

  it("does not take text shallower than the label for its note", () => {
    const prompt = readSelectPrompt(lines("❯ 1. Red", "  2. Green", "    not a note", "  3. Blue"));
    expect(prompt?.options.map((option) => option.label)).toEqual(["Red", "Green"]);
    expect(prompt?.options[1].description).toBeUndefined();
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

  // Claude Code 2.1.278's `/model` in an 80×24 pane — the size a phone attach
  // leaves it — draws three of its five rows and scrolls that window with the
  // highlight, marking the hidden side with ↑/↓ and counting under it.
  const WINDOW_TOP = lines(
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new",
    "   sessions. For other/previous model names, specify with --model.",
    "",
    "     1. Default (recommended)  Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "     2. Opus (1M context)      Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "   ❯ 3. Fable ✔                Fable 5.1 · Most capable for your hardest and",
    "                               longest-running tasks",
    "      … +2 models",
    "",
    "   ● High effort (default) ←/→ to adjust",
  );
  const WINDOW_MIDDLE = lines(
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new",
    "   sessions. For other/previous model names, specify with --model.",
    "",
    "   ↑ 2. Opus (1M context)      Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "   ❯ 3. Fable ✔                Fable 5.1 · Most capable for your hardest and",
    "                               longest-running tasks",
    "   ↓ 4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
    "      … +2 models",
  );

  it("reads a windowed picker's slice and how many rows it hides", () => {
    const top = readSelectPrompt(WINDOW_TOP, "Claude");
    expect(top?.title).toBe("Select model");
    expect(top?.hidden).toBe(2);
    expect(top?.current).toBe(2);
    expect(top?.options.map((option) => option.label)).toEqual(["Default (recommended)", "Opus (1M context)", "Fable ✔"]);
    expect(top?.options[2].description).toBe("Fable 5.1 · Most capable for your hardest and longest-running tasks");

    // A slice from the middle: ↑/↓ mark the edges, never the highlight.
    const middle = readSelectPrompt(WINDOW_MIDDLE, "Claude");
    expect(middle?.hidden).toBe(2);
    expect(middle?.options.map((option) => option.number)).toEqual([2, 3, 4]);
    expect(middle?.current).toBe(1);
  });

  it("still refuses a run that starts past 1 without a window's marks", () => {
    expect(readSelectPrompt(lines("❯ 2. Opus", "  3. Sonnet"))).toBeNull();
  });

  it("adds a windowed picker's slices up to the whole list, and asks for what is missing", () => {
    const top = readSelectPrompt(WINDOW_TOP, "Claude")!;
    const middle = readSelectPrompt(WINDOW_MIDDLE, "Claude")!;
    let step = mergeSelectRows(null, top);
    expect(missingSelectRow(step, top)).toBe(4);
    step = mergeSelectRows(step, middle);
    expect(step.options.map((option) => `${option.index}:${option.number}`)).toEqual(["0:1", "1:2", "2:3", "3:4"]);
    expect(missingSelectRow(step, middle)).toBe(5);
    // Nothing new: the same object, so state holding it does not re-render.
    expect(mergeSelectRows(step, middle)).toBe(step);
    // A list that is not a slice of it (the next step) starts over.
    const next = readSelectPrompt(lines("Select effort", "", "❯ 1. Low", "  2. High"))!;
    expect(sameSelectStep(step, next)).toBe(false);
    expect(mergeSelectRows(step, next).options.map((option) => option.label)).toEqual(["Low", "High"]);
    // A picker that draws every row has nothing missing.
    expect(missingSelectRow(mergeSelectRows(null, next), next)).toBeUndefined();
  });

  it("moves the highlight without accepting it", () => {
    expect(selectMoveKeys(3, 5)).toEqual([`${ESC}[B`, `${ESC}[B`]);
    expect(selectMoveKeys(3, 1)).toEqual([`${ESC}[A`, `${ESC}[A`]);
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
