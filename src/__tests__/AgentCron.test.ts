import { describe, it, expect } from "vitest";
import {
  AGENT_CRON_GRACE_MIN,
  addTime,
  agentCronEnabled,
  agentCronKey,
  agentCronTimes,
  dueAgentCronRuns,
  formatTimeOfDay,
  localDayKey,
  nextAgentCronRun,
  normalizeTimes,
  parseTimeOfDay,
  removeTime,
  scheduledAgentCmds,
  allAgentsEnabled,
  withAgentCronEnabled,
  withAgentCronTimes,
  withAllAgentsEnabled,
  withCronEnabled,
  withGlobalTimes,
  type AgentCron,
} from "../lib/agentCron";

/** A local moment. Every case here is a wall-clock case, so the fixtures are
 *  built the way the schedule is read — in local time, never from an ISO Z. */
const at = (h: number, m: number, day = 12) => new Date(2026, 7, day, h, m, 0, 0);

const cron: AgentCron = {
  enabled: true,
  times: ["09:00"],
  agents: {
    claude: { enabled: true, times: ["06:00", "11:30"] },
    codex: { enabled: true },
    gemini: { enabled: false, times: ["07:00"] },
  },
};

describe("agent cron — time values", () => {
  it("parses and formats a wall-clock time", () => {
    expect(parseTimeOfDay("06:00")).toBe(360);
    expect(parseTimeOfDay("6:05")).toBe(365);
    expect(parseTimeOfDay(" 23:59 ")).toBe(1439);
    expect(formatTimeOfDay(365)).toBe("06:05");
    expect(formatTimeOfDay(0)).toBe("00:00");
  });

  it("refuses anything that is not a time", () => {
    // A half-typed value must not resolve to a slot that then fires: "1:" as
    // 01:00 would schedule something nobody asked for.
    for (const bad of ["", "1:", "24:00", "12:60", "0900", "noon", "12:0"]) {
      expect(parseTimeOfDay(bad)).toBeNull();
    }
  });

  it("normalizes a stored list: parsed, deduped, sorted", () => {
    expect(normalizeTimes(["11:30", "6:00", "11:30", "nope", "06:00"])).toEqual([
      "06:00",
      "11:30",
    ]);
    expect(normalizeTimes(undefined)).toEqual([]);
  });

  it("adds and removes without duplicating a slot", () => {
    expect(addTime(["09:00"], "06:00")).toEqual(["06:00", "09:00"]);
    expect(addTime(["09:00"], "09:00")).toEqual(["09:00"]);
    expect(removeTime(["06:00", "09:00"], "06:00")).toEqual(["09:00"]);
  });
});

describe("agent cron — which agents are scheduled", () => {
  it("an agent's own times override the global list; an empty list follows it", () => {
    expect(agentCronTimes(cron, "claude")).toEqual(["06:00", "11:30"]);
    expect(agentCronTimes(cron, "codex")).toEqual(["09:00"]);
  });

  it("needs the master switch, the agent's own opt-in, and a time", () => {
    expect(agentCronEnabled(cron, "claude")).toBe(true);
    expect(agentCronEnabled(cron, "codex")).toBe(true);
    // Ticked off, even though it names times of its own.
    expect(agentCronEnabled(cron, "gemini")).toBe(false);
    // Never mentioned at all.
    expect(agentCronEnabled(cron, "aider")).toBe(false);
    // Master off takes everything with it.
    expect(agentCronEnabled({ ...cron, enabled: false }, "claude")).toBe(false);
    // Armed with nothing to fire on is not scheduled — the state the panel
    // reports rather than pretending a next run exists.
    expect(agentCronEnabled({ enabled: true, agents: { codex: { enabled: true } } }, "codex")).toBe(
      false,
    );
    expect(scheduledAgentCmds(cron)).toEqual(["claude", "codex"]);
  });
});

describe("agent cron — what is due", () => {
  const none = new Set<string>();

  it("fires at the time and inside the grace window, not before", () => {
    expect(dueAgentCronRuns(cron, at(5, 59), none)).toEqual([]);
    expect(dueAgentCronRuns(cron, at(6, 0), none).map((r) => r.cmd)).toEqual(["claude"]);
    expect(
      dueAgentCronRuns(cron, at(6, AGENT_CRON_GRACE_MIN), none).map((r) => r.time),
    ).toEqual(["06:00"]);
  });

  it("never fires late: a slot the clock has run past is skipped for the day", () => {
    // The point of the feature is *which* five hours the window covers, so a
    // 06:00 slot sent at 10:20 would be worse than not sending it at all.
    expect(dueAgentCronRuns(cron, at(6, AGENT_CRON_GRACE_MIN + 1), none)).toEqual([]);
    expect(dueAgentCronRuns(cron, at(10, 20), none)).toEqual([]);
  });

  it("a slot already fired today is not sent again", () => {
    const run = dueAgentCronRuns(cron, at(9, 0), none);
    expect(run.map((r) => r.cmd)).toEqual(["codex"]);
    expect(run[0].key).toBe(agentCronKey("codex", "2026-08-12", "09:00"));
    expect(dueAgentCronRuns(cron, at(9, 1), new Set([run[0].key]))).toEqual([]);
  });

  it("the same slot on the next day is a different run", () => {
    const today = dueAgentCronRuns(cron, at(9, 0), none)[0];
    const tomorrow = dueAgentCronRuns(cron, at(9, 0, 13), new Set([today.key]))[0];
    expect(tomorrow.cmd).toBe("codex");
    expect(tomorrow.key).not.toBe(today.key);
  });

  it("does not carry a late-evening slot across midnight", () => {
    const late: AgentCron = { enabled: true, times: ["23:58"], agents: { codex: { enabled: true } } };
    expect(dueAgentCronRuns(late, at(23, 58), none)).toHaveLength(1);
    expect(dueAgentCronRuns(late, at(0, 1, 13), none)).toEqual([]);
  });

  it("nothing scheduled means nothing due", () => {
    expect(dueAgentCronRuns(undefined, at(9, 0), none)).toEqual([]);
    expect(dueAgentCronRuns({ ...cron, enabled: false }, at(9, 0), none)).toEqual([]);
  });
});

describe("agent cron — the next run", () => {
  it("takes the next slot strictly after the current minute", () => {
    expect(nextAgentCronRun(cron, "claude", at(5, 0))).toEqual(at(6, 0));
    expect(nextAgentCronRun(cron, "claude", at(6, 0))).toEqual(at(11, 30));
  });

  it("rolls to tomorrow's first slot after the last one today", () => {
    expect(nextAgentCronRun(cron, "claude", at(23, 0))).toEqual(at(6, 0, 13));
  });

  it("is null for an agent that is not scheduled", () => {
    expect(nextAgentCronRun(cron, "gemini", at(5, 0))).toBeNull();
    expect(nextAgentCronRun(undefined, "claude", at(5, 0))).toBeNull();
  });

  it("keys the fired record by the local day", () => {
    expect(localDayKey(at(0, 5))).toBe("2026-08-12");
    expect(localDayKey(at(23, 55))).toBe("2026-08-12");
  });
});

describe("agent cron — editing the config", () => {
  it("flips the master switch without touching the schedule", () => {
    const next = withCronEnabled(cron, false);
    expect(next.enabled).toBe(false);
    expect(next.agents).toEqual(cron.agents);
  });

  it("normalizes on the way in, so what is stored is what is read", () => {
    expect(withGlobalTimes(cron, ["9:00", "06:00", "junk"]).times).toEqual(["06:00", "09:00"]);
    expect(withAgentCronTimes(cron, "claude", ["7:5"]).agents?.claude.times).toEqual([]);
  });

  it("drops an agent that ends up carrying nothing", () => {
    // Off with no times of its own is not an answer to store — `agents` holds
    // only the agents the user actually said something about.
    const next = withAgentCronEnabled(cron, "codex", false);
    expect(next.agents && "codex" in next.agents).toBe(false);
    // ...but one that still names times is kept, so switching it back on
    // restores what was typed rather than an empty list.
    const kept = withAgentCronEnabled(cron, "gemini", false);
    expect(kept.agents?.gemini.times).toEqual(["07:00"]);
  });

  it("the all-agents toggle is a bulk flip that keeps each agent's own times", () => {
    const cmds = ["claude", "codex", "gemini"];
    expect(allAgentsEnabled(cron, cmds)).toBe(false);
    const on = withAllAgentsEnabled(cron, cmds, true);
    expect(allAgentsEnabled(on, cmds)).toBe(true);
    expect(on.agents?.gemini).toEqual({ enabled: true, times: ["07:00"] });
    expect(on.agents?.claude.times).toEqual(["06:00", "11:30"]);
    const off = withAllAgentsEnabled(on, cmds, false);
    expect(allAgentsEnabled(off, cmds)).toBe(false);
    expect(scheduledAgentCmds(off)).toEqual([]);
    expect(off.agents?.gemini.times).toEqual(["07:00"]);
    // Default is off, and an empty list has nothing to be on.
    expect(allAgentsEnabled(undefined, cmds)).toBe(false);
    expect(allAgentsEnabled(on, [])).toBe(false);
  });

  it("an agent's empty list hands it back to the global schedule", () => {
    const next = withAgentCronTimes(cron, "claude", []);
    expect(agentCronTimes(next, "claude")).toEqual(["09:00"]);
    expect(agentCronEnabled(next, "claude")).toBe(true);
  });
});
