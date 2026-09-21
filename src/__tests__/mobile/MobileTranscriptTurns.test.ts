import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { transcriptTurns } from "../../../mobile-web/src/terminal/transcriptTurns";

const prompt = (text: string, at?: string): TranscriptEntry => ({ kind: "prompt", text, at });
const answer = (text: string, at?: string): TranscriptEntry => ({ kind: "answer", text, at });

describe("Eldrun Mobile stored-session turns", () => {
  it("makes every record a bubble of its own: the next message is the next bubble", () => {
    const turns = transcriptTurns([
      prompt("fix the test", "10:00:00"),
      answer("Let me check the test.", "10:00:01"),
      answer("The assertion compares the wrong field.", "10:00:05"),
    ]);
    expect(turns.map((turn) => [turn.kind, turn.text, turn.index])).toEqual([
      ["prompt", "fix the test", 0],
      ["answer", "Let me check the test.", 1],
      ["answer", "The assertion compares the wrong field.", 2],
    ]);
  });

  it("keeps each bubble's key and text when the oldest records drop off and new ones arrive", () => {
    const all = [
      prompt("one", "10:00:00"),
      answer("a", "10:00:01"),
      prompt("two", "10:01:00"),
      answer("b", "10:01:01"),
    ];
    const before = transcriptTurns(all);
    // The desktop sends the newest N: the window slid by one and the agent
    // wrote another message.
    const after = transcriptTurns([...all.slice(1), answer("c", "10:01:09")]);
    const shown = new Map(before.map((turn) => [turn.key, turn.text]));
    for (const turn of after) {
      if (shown.has(turn.key)) expect(turn.text).toBe(shown.get(turn.key));
    }
    expect(after.map((turn) => turn.text)).toEqual(["a", "two", "b", "c"]);
    expect(after.filter((turn) => shown.has(turn.key))).toHaveLength(3);
  });

  it("gives every bubble a distinct key, times missing or shared", () => {
    const turns = transcriptTurns([prompt("x"), answer("y"), prompt("z", "t"), answer("w", "t"), prompt("again", "t")]);
    expect(new Set(turns.map((turn) => turn.key)).size).toBe(turns.length);
  });
});
