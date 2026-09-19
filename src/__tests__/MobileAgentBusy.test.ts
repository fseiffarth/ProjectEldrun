import { describe, expect, it } from "vitest";
import { agentWorking } from "../../mobile-web/src/terminal/agentBusy";

const rows = (...text: string[]) => text.map((line) => ({ text: line }));

describe("Eldrun Mobile agent busy reader", () => {
  it("reads each family's working hint", () => {
    expect(agentWorking(rows("⏺ Reading files", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"))).toBe(true);
    expect(agentWorking(rows("✻ Pondering… (esc to interrupt)", "> "))).toBe(true);
    expect(agentWorking(rows("› fix the tests", "• Working (0s • esc to interrupt)"))).toBe(true);
    expect(agentWorking(rows("⠏ Thinking about it (esc to cancel, 3s)", "> Type your message"))).toBe(true);
    expect(agentWorking(rows(" BUILD  ⬝⬝■■  esc interrupt"))).toBe(true);
  });

  it("stays idle for a finished turn, a dialog, and prose about the key", () => {
    expect(agentWorking(rows("⏺ Done.", "> ", "  ? for shortcuts"))).toBe(false);
    expect(agentWorking(rows("Pick a model", "❯ 1. Opus", "  2. Sonnet", "Esc to cancel"))).toBe(false);
    expect(agentWorking(rows("⏺ Press Esc to interrupt is the one you want.", "> "))).toBe(false);
  });

  it("only reads the bottom of the screen", () => {
    const stale = ["✻ Thinking… (2s · esc to interrupt)", ...Array.from({ length: 30 }, () => "output")];
    expect(agentWorking(rows(...stale))).toBe(false);
  });
});
