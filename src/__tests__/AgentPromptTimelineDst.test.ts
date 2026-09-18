/**
 * The Hour view's ◀ ▶ and the Day view's ticks across Europe/Berlin's two 2026
 * transitions (29 March, spring forward; 25 October, fall back).
 *
 * The zone is set for this file only. Vitest runs files in forked processes,
 * and Node re-reads `TZ` when it is assigned, so the dates below are local to
 * Berlin however the machine running the suite is configured. The canary makes
 * that loud: on Linux or macOS a zone that did not apply fails the first case
 * instead of letting every other one pass in UTC, where there is no transition
 * to test. Windows does not honour a runtime `TZ` everywhere, so there — and
 * only there — the suite is skipped, with a warning saying why.
 */
import { afterAll, describe, expect, it } from "vitest";
import { shiftAnchor, timelineTicks, timelineWindow } from "../lib/agents/prompt/timeline";

// The app's tsconfig carries no Node types; the test runner is Node all the same.
const { process } = globalThis as unknown as {
  process: { env: Record<string, string | undefined>; platform: string };
};
const previousZone = process.env.TZ;
process.env.TZ = "Europe/Berlin";
const zoneApplied = new Date(2026, 2, 29, 12).getTimezoneOffset() === -120;
const unsupported = !zoneApplied && process.platform === "win32";
if (unsupported) {
  console.warn("AgentPromptTimelineDst: this platform ignores a runtime TZ, so the Europe/Berlin DST cases are skipped");
}

afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

function walk(anchor: string, step: -1 | 1, count: number): string[] {
  const seen: string[] = [];
  for (let n = 0; n < count; n += 1) {
    anchor = shiftAnchor("hour", anchor, step);
    seen.push(anchor);
  }
  return seen;
}

describe.skipIf(unsupported)("hour navigation and day ticks across DST in Europe/Berlin", () => {
  it("runs in the zone it names", () => {
    expect(new Date(2026, 2, 28, 12).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 2, 29, 12).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 9, 25, 12).getTimezoneOffset()).toBe(-60);
  });

  it("steps over the hour that does not exist on the spring-forward day, both ways", () => {
    expect(walk("2026-03-28T23", 1, 4)).toEqual(["2026-03-29T00", "2026-03-29T01", "2026-03-29T03", "2026-03-29T04"]);
    expect(walk("2026-03-29T04", -1, 4)).toEqual(["2026-03-29T03", "2026-03-29T01", "2026-03-29T00", "2026-03-28T23"]);
  });

  it("steps past the repeated hour on the fall-back day, both ways", () => {
    expect(walk("2026-10-24T23", 1, 5)).toEqual(["2026-10-25T00", "2026-10-25T01", "2026-10-25T02", "2026-10-25T03", "2026-10-25T04"]);
    expect(walk("2026-10-25T04", -1, 5)).toEqual(["2026-10-25T03", "2026-10-25T02", "2026-10-25T01", "2026-10-25T00", "2026-10-24T23"]);
  });

  it("never sticks and always moves the window the way it was asked, across both days", () => {
    for (const [from, count] of [["2026-03-28T12", 36], ["2026-10-24T12", 36]] as const) {
      for (const step of [1, -1] as const) {
        let anchor: string = step === 1 ? from : walk(from, 1, count)[count - 1];
        for (let n = 0; n < count; n += 1) {
          const next = shiftAnchor("hour", anchor, step);
          const before = timelineWindow("hour", anchor, 1).start.getTime();
          const after = timelineWindow("hour", next, 1).start.getTime();
          expect(next, `${anchor} ${step}`).not.toBe(anchor);
          expect(Math.sign(after - before), `${anchor} → ${next}`).toBe(step);
          anchor = next;
        }
      }
    }
  });

  it("draws each real hour of a transition day once", () => {
    const spring = timelineTicks(timelineWindow("day", "2026-03-29", 1), 2400);
    const fall = timelineTicks(timelineWindow("day", "2026-10-25", 1), 2400);
    expect(spring).toHaveLength(23);
    expect(fall).toHaveLength(25);
    for (const ticks of [spring, fall]) {
      expect(new Set(ticks.map((tick) => tick.at.getTime())).size).toBe(ticks.length);
    }
    expect(spring.map((tick) => tick.at.getHours()).slice(0, 4)).toEqual([0, 1, 3, 4]);
    expect(fall.map((tick) => tick.at.getHours()).slice(0, 5)).toEqual([0, 1, 2, 2, 3]);
  });
});
