/**
 * Custom agents (Settings.custom_agents): a user-defined CLI offered in the
 * add-tab menu's Agents group. These tests lock in the two pure helpers that
 * make a custom agent behave like a built-in one — `buildStaticTabSpec` (the
 * launch-spec builder, including the resume-flag → restart-resumable promotion)
 * and `agentMenuEntries` (the shared Agents-group row builder).
 */
import { describe, it, expect } from "vitest";

import {
  agentMenuEntries,
  buildStaticTabSpec,
  customAgentToItem,
} from "../components/tabs/newTabItems";
import { isResumableAgentTab } from "../stores/tabs";
import type { CustomAgent } from "../types";

describe("buildStaticTabSpec — custom agents", () => {
  it("launches a bare custom agent as a launch-only agent tab", () => {
    const ca: CustomAgent = { id: "1", label: "Mine", cmd: "my-agent" };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj");
    expect(spec.kind).toBe("agent");
    expect(spec.cmd).toBe("my-agent");
    expect(spec.args).toEqual([]);
    // No resume flag → not restart-resumable → no minted session id / tab uid.
    expect(spec.resumeArgs).toBeUndefined();
    expect(spec.sessionId).toBeUndefined();
    expect(spec.env?.ELDRUN_TAB_UID).toBeUndefined();
    expect(isResumableAgentTab({ ...spec })).toBe(false);
  });

  it("prepends the custom agent's own args", () => {
    const ca: CustomAgent = {
      id: "1",
      label: "Mine",
      cmd: "my-agent",
      args: ["--model", "x"],
    };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj");
    expect(spec.args).toEqual(["--model", "x"]);
  });

  it("promotes a custom agent with a resume flag to restart-resumable", () => {
    const ca: CustomAgent = {
      id: "1",
      label: "Mine",
      cmd: "my-agent",
      resumeArgs: ["--continue"],
    };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj");
    expect(spec.resumeArgs).toEqual(["--continue"]);
    // A session id is minted so the tab satisfies the persistence gate, and the
    // tab is tagged with the ELDRUN_TAB_UID env var like the built-in resumables.
    expect(typeof spec.sessionId).toBe("string");
    expect(spec.env?.ELDRUN_TAB_UID).toBe(spec.sessionId);
    expect(isResumableAgentTab({ ...spec })).toBe(true);
  });
});

describe("agentMenuEntries", () => {
  const custom: CustomAgent[] = [
    { id: "a", label: "Present", cmd: "here" },
    { id: "b", label: "Absent", cmd: "gone" },
  ];

  it("lists installed built-ins, then custom agents, then the add row", () => {
    const entries = agentMenuEntries({
      installedBuiltins: new Set(["claude"]),
      installedCmds: new Set(["here"]),
      customAgents: custom,
      pick: () => {},
      onAddCustom: () => {},
    });
    const labels = entries.map((e) => e.label);
    expect(labels).toEqual(["Claude", "Present", "Absent (not found)", "Add agent…"]);
    // The known-missing custom agent is greyed out; the present one is pickable.
    const present = entries.find((e) => e.key === "custom:a");
    const absent = entries.find((e) => e.key === "custom:b");
    expect(present?.disabled).toBeFalsy();
    expect(absent?.disabled).toBe(true);
  });

  it("hides built-ins until their probe resolves, but the add row is always present", () => {
    const entries = agentMenuEntries({
      installedBuiltins: null,
      installedCmds: null,
      customAgents: [],
      pick: () => {},
      onAddCustom: () => {},
    });
    expect(entries.map((e) => e.key)).toEqual(["__add_custom_agent__"]);
  });
});
