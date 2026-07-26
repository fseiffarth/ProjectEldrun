/**
 * Tests for the shared from-blank deck creation (`lib/viewers/deck/create`).
 *
 * The one property that matters: the file is a *valid deck on disk from its
 * first moment*. The generic "New File" path creates an empty file, which
 * `parseDeck("")` rejects — which is why creating a presentation is its own
 * action in the file views rather than a name typed into New File.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    return null;
  }),
}));

import { createDeckFile, deckFileName, deckStem } from "../lib/viewers/deck/create";
import { parseDeck } from "../lib/viewers/deck/sidecar";

beforeEach(() => {
  calls.length = 0;
});

describe("deckStem", () => {
  it("accepts a bare name, a .pdf and the deck's own extension alike", () => {
    expect(deckStem("talk")).toBe("talk");
    expect(deckStem("  talk  ")).toBe("talk");
    expect(deckStem("talk.pdf")).toBe("talk");
    expect(deckStem("talk.PDF")).toBe("talk");
    expect(deckStem("talk.eldeck.json")).toBe("talk");
  });

  it("leaves an unrelated extension alone — it is part of the name", () => {
    expect(deckStem("talk.v2")).toBe("talk.v2");
    expect(deckFileName(deckStem("talk.v2"))).toBe("talk.v2.eldeck.json");
  });
});

describe("createDeckFile", () => {
  it("writes a parseable deck at <folder>/<stem>.eldeck.json", async () => {
    const out = await createDeckFile({
      projectDir: "/p",
      projectId: "proj",
      relDir: "talks",
      name: "kickoff.pdf",
    });

    expect(out).toMatchObject({
      stem: "kickoff",
      fileName: "kickoff.eldeck.json",
      rel: "talks/kickoff.eldeck.json",
      abs: "/p/talks/kickoff.eldeck.json",
    });

    expect(calls.map((c) => c.cmd)).toEqual(["create_file", "write_file_text"]);
    expect(calls[0].args).toMatchObject({
      projectDir: "/p",
      relPath: "talks/kickoff.eldeck.json",
    });
    expect(calls[1].args).toMatchObject({
      path: "/p/talks/kickoff.eldeck.json",
      projectId: "proj",
    });

    // The whole point: what landed parses, and points at its own base plate.
    const parsed = parseDeck(String(calls[1].args.content), null);
    expect(parsed.deck.base).toBe("kickoff.pdf");
  });

  it("creates at the project root when no folder is browsed", async () => {
    const out = await createDeckFile({
      projectDir: "/p",
      projectId: null,
      relDir: "",
      name: "talk",
    });
    expect(out.rel).toBe("talk.eldeck.json");
    expect(out.abs).toBe("/p/talk.eldeck.json");
  });
});
