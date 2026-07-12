/**
 * Tests for looksLikeDecisionPrompt: classifying a quiet agent tab as blocked on
 * a decision (a selection menu in its output) vs simply finished — including off
 * the raw PTY stream, escape codes and all, which is the only view of the screen
 * available for a tab whose pane has never been opened.
 */
import { describe, it, expect } from "vitest";
import { looksLikeDecisionPrompt, stripAnsi } from "../lib/agentPrompt";

describe("looksLikeDecisionPrompt", () => {
  it("detects a pointer + numbered choice (Claude/Codex approval menu)", () => {
    const screen = [
      "Do you want to make this edit to activity.ts?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("detects a yes/no numbered menu without the pointer glyph", () => {
    const screen = ["Allow this command?", "1. Yes  2. No"].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("treats a finished turn (no prompt) as not-a-decision", () => {
    const screen = [
      "Done. I updated the activity store and the tests pass.",
      "",
      "> ",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(false);
  });

  it("does not fire on ordinary numbered prose", () => {
    const screen = [
      "Here are the steps:",
      "1. Read the file",
      "2. Edit it",
      "3. Run the tests",
    ].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(false);
  });

  it("is false for empty text", () => {
    expect(looksLikeDecisionPrompt("")).toBe(false);
  });

  it("sees through the escape codes of a raw PTY chunk", () => {
    // What a colour-coded approval menu actually looks like on the wire: cursor
    // moves, SGR colour runs, and an OSC title update wrapped around the text.
    const raw =
      "\x1b]0;claude\x07\x1b[2J\x1b[H\x1b[1mDo you want to make this edit?\x1b[0m\r\n" +
      "\x1b[32m❯ \x1b[1m1.\x1b[0m\x1b[32m Yes\x1b[0m\r\n" +
      "\x1b[2m  2. No, and tell Claude what to do differently\x1b[0m\r\n";
    expect(looksLikeDecisionPrompt(raw)).toBe(true);
  });

  it("does not mistake a colour-coded finished turn for a prompt", () => {
    const raw = "\x1b[32m✔\x1b[0m Done — \x1b[1m12 tests\x1b[0m pass.\r\n\x1b[2m❯ \x1b[0m";
    expect(looksLikeDecisionPrompt(raw)).toBe(false);
  });

  it("detects a bare pointer + word binary confirmation (no numbering)", () => {
    const screen = ["Allow this command?", "❯ Yes", "  No"].join("\n");
    expect(looksLikeDecisionPrompt(screen)).toBe(true);
  });

  it("sees through escape codes on a bare pointer + word prompt", () => {
    const raw =
      "\x1b[2J\x1b[H\x1b[1mAllow this command?\x1b[0m\r\n" +
      "\x1b[32m❯ Yes\x1b[0m\r\n\x1b[2m  No\x1b[0m\r\n";
    expect(looksLikeDecisionPrompt(raw)).toBe(true);
  });

  it("does not fire on a bare idle input-line cursor", () => {
    expect(looksLikeDecisionPrompt("❯ ")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("removes SGR, cursor and OSC sequences but keeps the text", () => {
    const raw = "\x1b]0;title\x07\x1b[2J\x1b[1;1H\x1b[31mhello\x1b[0m world\x1b(B";
    expect(stripAnsi(raw)).toBe("hello world");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("❯ 1. Yes\n  2. No")).toBe("❯ 1. Yes\n  2. No");
  });
});
