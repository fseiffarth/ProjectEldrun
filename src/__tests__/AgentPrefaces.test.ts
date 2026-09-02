/**
 * The prefix chips and model pick the side-panel agent composer submits ahead of
 * a prompt. The rules under test are the ones that keep the frontend and the
 * backend from disagreeing (`services::agent_tasks::validate_preface_command`)
 * and the ones that decide what actually reaches the agent.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PREFACE_COMMANDS,
  agentComposerKey,
  agentModelsFor,
  buildPreface,
  modelCommand,
  prefaceCommandsFor,
  sanitizePrefaceCommand,
  splitPreface,
} from "../lib/agentPrefaces";
import { buildSendNowSchedule } from "../lib/agentPromptSend";

describe("preface command sanitizing", () => {
  it("mirrors the backend's rules", () => {
    expect(sanitizePrefaceCommand("  /clear  ")).toBe("/clear");
    expect(sanitizePrefaceCommand("/model opus\u001b[31m")).toBe("/model opus[31m");
    // Not a command: a preface is a list of the agent's own slash commands, not
    // a second channel for prompt text submitted outside the reviewed message.
    expect(sanitizePrefaceCommand("clear")).toBe("");
    // A newline would be a second submission the user never saw.
    expect(sanitizePrefaceCommand("/clear\nrm -rf /")).toBe("");
    expect(sanitizePrefaceCommand("   ")).toBe("");
    expect(sanitizePrefaceCommand(`/${"x".repeat(300)}`)).toBe("");
  });

  it("keys a list by the bare command, whatever the tab carries", () => {
    expect(agentComposerKey("claude")).toBe("claude");
    expect(agentComposerKey("/home/me/bin/Claude")).toBe("claude");
    expect(agentComposerKey("C:\\tools\\codex.exe")).toBe("codex");
  });
});

describe("resolving the offered lists", () => {
  it("falls back to the defaults and honours an explicit empty override", () => {
    expect(prefaceCommandsFor("claude")).toContain("/clear");
    expect(prefaceCommandsFor("claude", { claude: ["/goal", "/clear"] })).toEqual(["/goal", "/clear"]);
    // Present-but-empty is a decision ("no chips for this agent"), not "unset".
    expect(prefaceCommandsFor("claude", { claude: [] })).toEqual([]);
    // An agent with no default gets nothing rather than a guessed command.
    expect(prefaceCommandsFor("some-new-agent")).toEqual([]);
  });

  it("drops entries that are not commands and caps the list", () => {
    expect(prefaceCommandsFor("claude", { claude: ["/ok", "not a command", "/ok"] })).toEqual(["/ok"]);
    const many = Array.from({ length: MAX_PREFACE_COMMANDS + 3 }, (_, index) => `/c${index}`);
    expect(prefaceCommandsFor("claude", { claude: many })).toHaveLength(MAX_PREFACE_COMMANDS);
  });

  it("offers models only where they are known or configured", () => {
    expect(agentModelsFor("claude")).toEqual(["opus", "sonnet", "haiku"]);
    expect(agentModelsFor("codex")).toEqual([]);
    expect(agentModelsFor("codex", { codex: ["gpt-5-codex"] })).toEqual(["gpt-5-codex"]);
  });
});

describe("reading a saved preface back", () => {
  it("splits the chips from the model, keeping the last model picked", () => {
    expect(splitPreface(["/clear", "/model opus"])).toEqual({ commands: ["/clear"], model: "opus" });
    expect(splitPreface(["/model haiku", "/clear", "/model opus"]))
      .toEqual({ commands: ["/clear"], model: "opus" });
    expect(splitPreface(undefined)).toEqual({ commands: [], model: "" });
  });

  it("round-trips what buildPreface wrote", () => {
    const offered = ["/clear", "/compact"];
    const preface = buildPreface(offered, ["/compact", "/clear"], "sonnet");
    const parsed = splitPreface(preface);
    expect(buildPreface(offered, parsed.commands, parsed.model)).toEqual(preface);
  });
});

describe("building one send's preface", () => {
  const offered = ["/clear", "/compact", "/context"];

  it("keeps the offered order, not the click order", () => {
    expect(buildPreface(offered, ["/context", "/clear"])).toEqual(["/clear", "/context"]);
  });

  it("puts the model last so a resetting chip cannot undo it", () => {
    expect(buildPreface(offered, ["/clear"], "opus")).toEqual(["/clear", modelCommand("opus")]);
  });

  it("ignores a selection that is not on offer and an empty model", () => {
    expect(buildPreface(offered, ["/rm -rf"], "  ")).toEqual([]);
  });

  it("rides a send-now schedule, and is omitted entirely when empty", () => {
    const now = new Date(2026, 8, 2, 14, 30);
    const withPreface = buildSendNowSchedule("check the build", now, "id-1", ["/clear"]);
    expect(withPreface.preface).toEqual(["/clear"]);
    // No key at all, so a send with no prefix commands serializes exactly as it
    // did before the composer existed.
    expect(Object.prototype.hasOwnProperty.call(buildSendNowSchedule("x", now, "id-2"), "preface")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(buildSendNowSchedule("x", now, "id-3", []), "preface")).toBe(false);
  });
});
