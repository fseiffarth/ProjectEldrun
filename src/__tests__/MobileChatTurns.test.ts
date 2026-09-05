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
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["fix the failing test"]);
    // The blank row after the echo is the seam, not the answer's first line.
    expect(turns[1].lines.map((row) => row.text)).toEqual([
      "⏺ Reading the test first.",
      "  It fails on the second assertion.",
      "",
      "⏺ Done.",
    ]);
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
      "⏺ Second paragraph.",
      "",
      "> next question",
      "",
      "",
      "⏺ Answer.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent", "user", "agent"]);
    expect(turns[0].lines.map((row) => row.text)).toEqual(["⏺ First paragraph.", "", "⏺ Second paragraph."]);
    expect(turns[2].lines.map((row) => row.text)).toEqual(["⏺ Answer."]);
  });

  it("answers no turns for no lines and one agent turn for plain output", () => {
    expect(chatTurns([])).toEqual([]);
    const turns = chatTurns(lines("$ npm test", "ok"));
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("agent");
  });
});
