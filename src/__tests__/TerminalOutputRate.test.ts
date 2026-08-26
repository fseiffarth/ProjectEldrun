import { describe, expect, it } from "vitest";
import { TerminalOutputRateMeter } from "../dev/terminalOutputRate";

describe("terminal output rate", () => {
  it("counts only the requested scope over the trailing second", () => {
    const meter = new TerminalOutputRateMeter();
    meter.note("project-a:shell", 100, 100);
    meter.note("project-a:agent", 50, 500);
    meter.note("project-b:shell", 900, 500);

    expect(meter.charsPerSecond(["project-a:shell", "project-a:agent"], 999)).toBe(150);
    expect(meter.charsPerSecond(["project-a:shell", "project-a:agent"], 1100)).toBe(50);
    expect(meter.charsPerSecond(["project-b:shell"], 1100)).toBe(900);
  });

  it("keeps colon-bearing box scopes intact", () => {
    const meter = new TerminalOutputRateMeter();
    meter.note("box:research:shell", 240, 100);

    expect(meter.charsPerSecond(["box:research:shell"], 500)).toBe(240);
    expect(meter.charsPerSecond(["box:other:shell"], 500)).toBe(0);
  });

  it("ignores bare non-tab terminal ids and expires quiet output", () => {
    const meter = new TerminalOutputRateMeter();
    meter.note("vpn-login", 300, 100);
    meter.note("project-a:shell", 80, 100);

    expect(meter.charsPerSecond(["project-a:shell"], 500)).toBe(80);
    expect(meter.charsPerSecond(["project-a:shell"], 1100)).toBe(0);
  });
});
