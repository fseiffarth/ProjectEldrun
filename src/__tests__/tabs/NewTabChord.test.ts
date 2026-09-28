/**
 * The new-tab chords: Ctrl+Shift+N / M and Ctrl+1–9 resolve to the right
 * request (digits by physical key too), and the agent numbering the + menu
 * shows is the one the chord opens — default agent first.
 */
import { describe, it, expect } from "vitest";
import { newTabRequestFor } from "../../lib/shortcuts/newTabChord";
import { agentMenuEntries, agentShortcutSlots } from "../../components/tabs/newTabItems";
import type { CustomAgent } from "../../types";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("newTabRequestFor", () => {
  it("maps the default chords", () => {
    expect(newTabRequestFor(key({ key: "N", ctrlKey: true, shiftKey: true }), undefined)).toEqual({ kind: "shell" });
    expect(newTabRequestFor(key({ key: "M", ctrlKey: true, shiftKey: true }), undefined)).toEqual({ kind: "monitor" });
    expect(newTabRequestFor(key({ key: "1", code: "Digit1", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 0 });
    expect(newTabRequestFor(key({ key: "9", code: "Digit9", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 8 });
  });

  it("matches digits by physical key where the layout types a symbol", () => {
    // AZERTY: the key US calls 1 types "&".
    expect(newTabRequestFor(key({ key: "&", code: "Digit1", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 0 });
  });

  it("leaves plain digits and other modifiers alone", () => {
    expect(newTabRequestFor(key({ key: "1", code: "Digit1" }), undefined)).toBeNull();
    expect(newTabRequestFor(key({ key: "1", code: "Digit1", ctrlKey: true, altKey: true }), undefined)).toBeNull();
    expect(newTabRequestFor(key({ key: "n", ctrlKey: true }), undefined)).toBeNull();
  });

  it("follows a rebind", () => {
    const overrides = { newShellTab: { key: "e", alt: true } };
    expect(newTabRequestFor(key({ key: "e", altKey: true }), overrides)).toEqual({ kind: "shell" });
    expect(newTabRequestFor(key({ key: "N", ctrlKey: true, shiftKey: true }), overrides)).toBeNull();
  });
});

describe("agentShortcutSlots", () => {
  const custom: CustomAgent[] = [
    { id: "a", label: "Mine", cmd: "mine" } as CustomAgent,
    { id: "b", label: "Gone", cmd: "gone" } as CustomAgent,
  ];
  const base = {
    installedBuiltins: new Set(["claude", "codex", "gemini"]),
    installedCmds: new Set(["mine"]),
    customAgents: custom,
  };

  it("puts the default agent first, then the rest in menu order, skipping missing ones", () => {
    const slots = agentShortcutSlots({ ...base, defaultAgentBin: "codex" });
    expect(slots.map((s) => s?.key)).toEqual(["codex", "claude", "gemini", "custom:a"]);
  });

  it("leaves slot 1 empty when the default agent is not in the menu", () => {
    const slots = agentShortcutSlots({ ...base, defaultAgentBin: "aider" });
    expect(slots[0]).toBeNull();
    expect(slots.slice(1).map((s) => s?.key)).toEqual(["claude", "codex", "gemini", "custom:a"]);
  });

  it("labels the menu rows with the same numbers", () => {
    const entries = agentMenuEntries({
      ...base,
      pick: () => {},
      onAddCustom: () => {},
      defaultAgentBin: "codex",
      t: (k) => k,
    });
    const chord = (k: string) => entries.find((e) => e.key === k)?.shortcut;
    expect(chord("codex")).toBe("agentTab1");
    expect(chord("claude")).toBe("agentTab2");
    expect(chord("custom:a")).toBe("agentTab4");
    expect(chord("custom:b")).toBeUndefined();
  });

  it("shows no numbers where the chords do not work", () => {
    const entries = agentMenuEntries({ ...base, pick: () => {}, onAddCustom: () => {}, t: (k) => k });
    expect(entries.every((e) => e.shortcut === undefined)).toBe(true);
  });
});
