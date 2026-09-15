import { describe, expect, it } from "vitest";
import { chatTurns, isPromptEcho } from "../../mobile-web/src/terminal/chatTurns";
import type { ReadableLine } from "../../mobile-web/src/terminal/readableScreen";

let seq = 0;
const line = (text: string, className?: string): ReadableLine => ({
  key: `l${seq += 1}`,
  text,
  spans: text ? [{ text, className, color: className ? "#777" : undefined }] : [],
});
const lines = (...texts: string[]) => texts.map((text) => line(text));

describe("Eldrun Mobile chat turns", () => {
  it("puts the echoed prompt in a user turn and the answer in an agent turn", () => {
    const turns = chatTurns(lines(
      "> fix the failing test",
      "",
      "⏺ Reading the test first.",
      "  It fails on the second assertion.",
      "",
      "⏺ Done.",
    ));
    // Each ⏺ message is an answer of its own.
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["fix the failing test"]);
    // The blank row after the echo is the seam, not the answer's first line.
    expect(turns[1].lines.map((row) => row.text)).toEqual([
      "⏺ Reading the test first.",
      "  It fails on the second assertion.",
    ]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Reading the test first.", "It fails on the second assertion."]);
    expect(turns[2].lines.map((row) => row.text)).toEqual(["⏺ Done."]);
  });

  it("keeps the printed marker in the lines and strips it only from the bubble", () => {
    const echo = line("> run it", "d");
    const [turn] = chatTurns([echo]);
    expect(turn.lines[0]).toBe(echo);
    expect(turn.key).toBe(echo.key);
    expect(turn.prompt?.[0].spans).toEqual([{ text: "run it", className: "d", color: "#777" }]);
  });

  it("reads Codex's › and a Gemini box with padding as the same echo", () => {
    expect(chatTurns(lines("› explain this repo")).map((turn) => turn.role)).toEqual(["user"]);
    // Gemini frames the echo; readableScreen strips `│ ` and leaves the
    // padding space in front of the marker.
    const [turn] = chatTurns(lines(" > explain this repo", "   and its tests"));
    expect(turn.role).toBe("user");
    expect(turn.prompt?.map((row) => row.text)).toEqual(["explain this repo", " and its tests"]);
  });

  it("keeps a multi-line prompt together by its indent", () => {
    const turns = chatTurns(lines(
      "> first line of the prompt",
      "  second line",
      "  third line",
      "⏺ Sure.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual([
      "first line of the prompt",
      "second line",
      "third line",
    ]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Sure."]);
  });

  it("never reads a dialog row, a bare input marker or an indented quote as a prompt", () => {
    expect(isPromptEcho({ text: "❯ 1. Yes" })).toBe(false);
    expect(isPromptEcho({ text: "> 2) No, and tell Claude what to do differently" })).toBe(false);
    expect(isPromptEcho({ text: ">" })).toBe(false);
    expect(isPromptEcho({ text: "> " })).toBe(false);
    expect(isPromptEcho({ text: "  > a quoted sentence inside the answer" })).toBe(false);
    expect(isPromptEcho({ text: "-> arrow in prose" })).toBe(false);
    const turns = chatTurns(lines("❯ 1. Yes", "  2. No", "> ", "  > quoted"));
    expect(turns.map((turn) => turn.role)).toEqual(["agent"]);
  });

  it("drops the blank seam around a prompt but keeps paragraph breaks inside a turn", () => {
    const turns = chatTurns(lines(
      "⏺ First paragraph.",
      "",
      "  Still the first message.",
      "",
      "⏺ Second message.",
      "",
      "> next question",
      "",
      "",
      "⏺ Answer.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent", "agent", "user", "agent"]);
    expect(turns[0].lines.map((row) => row.text)).toEqual(["⏺ First paragraph.", "", "  Still the first message."]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Second message."]);
    expect(turns[3].lines.map((row) => row.text)).toEqual(["⏺ Answer."]);
  });

  it("answers no turns for no lines and one agent turn for plain output", () => {
    expect(chatTurns([])).toEqual([]);
    const turns = chatTurns(lines("$ npm test", "ok"));
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("agent");
  });

  it("makes each ⏺ message its own answer, marker removed, and leaves Claude's tool calls out", () => {
    const turns = chatTurns(lines(
      "> add a clear button",
      "",
      "⏺ Looking at the composer first.",
      "",
      "⏺ Read(mobile-web/src/screens/Terminal.tsx)",
      "  ⎿  Read 1459 lines",
      "",
      "⏺ Update(mobile-web/src/screens/Terminal.tsx)",
      "  ⎿  Updated mobile-web/src/screens/Terminal.tsx with 3 additions and 1 removal",
      "       12    const draft = \"\";",
      "       13 +  const clear = () => setDraft(\"\");",
      "",
      "⏺ Bash(npm test)",
      "  ⎿  Tests: 12 passed",
      "     … +40 lines (ctrl+o to expand)",
      "",
      "⏺ Done: the ✕ empties the draft.",
      "  It sits beside the textarea.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    // The answer shows without its bullet and its indent; the lines keep both.
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Looking at the composer first."]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Looking at the composer first."]);
    expect(turns[2].answer?.map((row) => row.text)).toEqual(["Done: the ✕ empties the draft.", "It sits beside the textarea."]);
    // The read, the edit and its diff, the command and its output: not laid out.
    const shown = turns.flatMap((turn) => (turn.answer ?? turn.prompt ?? turn.lines).map((row) => row.text)).join("\n");
    expect(shown).not.toContain("Update(");
    expect(shown).not.toContain("additions");
    expect(shown).not.toContain("Tests: 12 passed");
  });

  it("keeps a question the session is waiting on under a tool call, and prose that is not a call", () => {
    const turns = chatTurns(lines(
      "⏺ Bash(rm -rf dist)",
      "  ⎿  Running…",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "",
      "⏺ Fixed — the build (and lint) passes.",
      "⏺ Ready when you are.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent", "agent", "agent"]);
    expect(turns[0].lines.map((row) => row.text)).toEqual(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]);
    expect(turns[0].answer).toBeUndefined();
    // A `(` later in the sentence is not a tool call: the name is followed by it directly.
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Fixed — the build (and lint) passes."]);
    expect(turns[2].answer?.map((row) => row.text)).toEqual(["Ready when you are."]);
  });

  it("leaves another TUI's output as one plain agent turn", () => {
    const turns = chatTurns(lines("› explain", "", "• Sure, this repo is a phone app.", "  It has two screens."));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[1].answer).toBeUndefined();
    expect(turns[1].lines.map((row) => row.text)).toEqual(["• Sure, this repo is a phone app.", "  It has two screens."]);
  });
});
