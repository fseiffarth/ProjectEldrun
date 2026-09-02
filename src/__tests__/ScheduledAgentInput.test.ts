import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/terminalInput", () => ({
  writePtyInput: vi.fn(() => Promise.resolve()),
}));

import { writePtyInput } from "../lib/terminalInput";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
  submitScheduledAgentMessage,
} from "../lib/scheduledAgentInput";

const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

beforeEach(() => {
  _clearScheduledAgentInputsForTest();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
});

describe("scheduled agent input", () => {
  it("replaces the composer, pastes safely, and submits in separate writes", async () => {
    const record = vi.fn();
    registerScheduledAgentInput("target", {
      ptyId: "project:agent",
      ready: () => true,
      bracketedPaste: () => true,
      recordAuthorizedInput: record,
    });

    await expect(submitScheduledAgentMessage("target", "first\nsecond")).resolves.toBe("project:agent");

    expect(record).toHaveBeenCalledOnce();
    expect(writeMock.mock.calls.map(([id, bytes]) => [id, decode(bytes)])).toEqual([
      ["project:agent", "\u0001\u000b"],
      ["project:agent", "\u001b[200~first\nsecond\u001b[201~"],
      ["project:agent", "\r"],
    ]);
  });

  it("submits each prefix command on its own, in order, before the message", async () => {
    const record = vi.fn();
    const noteInput = vi.fn();
    const settle = vi.fn(() => Promise.resolve());
    registerScheduledAgentInput("target", {
      ptyId: "project:agent",
      ready: () => true,
      bracketedPaste: () => true,
      recordAuthorizedInput: record,
      noteInput,
    });

    await submitScheduledAgentMessage("target", "check the build", {
      preface: ["/clear", "/model opus"],
      settle,
    });

    expect(writeMock.mock.calls.map(([, bytes]) => decode(bytes))).toEqual([
      "\u0001\u000b", "\u001b[200~/clear\u001b[201~", "\r",
      "\u0001\u000b", "\u001b[200~/model opus\u001b[201~", "\r",
      "\u0001\u000b", "\u001b[200~check the build\u001b[201~", "\r",
    ]);
    // Exactly one prompt is counted: a slash command is not a question asked.
    expect(record).toHaveBeenCalledOnce();
    expect(noteInput).toHaveBeenCalledTimes(2);
    // The caller's settle runs between submissions, never after the last one.
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("skips a prefix entry that sanitizes away rather than submitting a bare newline", async () => {
    const settle = vi.fn(() => Promise.resolve());
    registerScheduledAgentInput("target", {
      ptyId: "project:agent",
      ready: () => true,
      bracketedPaste: () => true,
      recordAuthorizedInput: vi.fn(),
    });

    await submitScheduledAgentMessage("target", "go", { preface: ["   ", "/clear"], settle });

    expect(writeMock.mock.calls.map(([, bytes]) => decode(bytes))).toEqual([
      "\u0001\u000b", "\u001b[200~/clear\u001b[201~", "\r",
      "\u0001\u000b", "\u001b[200~go\u001b[201~", "\r",
    ]);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("does not write until the PTY owner reports ready", async () => {
    const record = vi.fn();
    registerScheduledAgentInput("target", {
      ptyId: "project:agent",
      ready: () => false,
      bracketedPaste: () => false,
      recordAuthorizedInput: record,
    });

    await expect(submitScheduledAgentMessage("target", "hello")).rejects.toThrow("not ready");
    expect(record).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("surfaces a partial write failure without sending the submit", async () => {
    registerScheduledAgentInput("target", {
      ptyId: "project:agent",
      ready: () => true,
      bracketedPaste: () => true,
      recordAuthorizedInput: vi.fn(),
    });
    writeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("write failed"));

    await expect(submitScheduledAgentMessage("target", "hello")).rejects.toThrow("write failed");
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls.some(([, bytes]) => decode(bytes) === "\r")).toBe(false);
  });
});
