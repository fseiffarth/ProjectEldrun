import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { senderColor, senderInitial } from "../../lib/mail";

describe("senderInitial", () => {
  it("takes the display name's first letter or digit", () => {
    expect(senderInitial({ name: "  \"ada\" lovelace", address: "x@example.com" })).toBe("A");
    expect(senderInitial({ name: "42 Ltd", address: "x@example.com" })).toBe("4");
  });

  it("falls back to the address, then to ?", () => {
    expect(senderInitial({ address: "zoe@example.com" })).toBe("Z");
    expect(senderInitial({ name: "—", address: "_@example.com" })).toBe("E");
    expect(senderInitial({ name: "", address: "" })).toBe("?");
  });

  it("skips bidi/format controls in front of the name", () => {
    expect(senderInitial({ name: "‮bob", address: "x@example.com" })).toBe("B");
  });
});

describe("senderColor", () => {
  it("is stable and ignores case and padding in the address", () => {
    expect(senderColor("Ada@Example.com ")).toBe(senderColor("ada@example.com"));
    expect(senderColor("ada@example.com")).toMatch(/^hsl\(\d+ 62% 58%\)$/);
  });

  it("differs for different addresses", () => {
    expect(senderColor("ada@example.com")).not.toBe(senderColor("bob@example.com"));
  });
});
