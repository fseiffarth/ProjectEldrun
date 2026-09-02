import { describe, it, expect } from "vitest";
import { matchAnchorId, slugify } from "../lib/viewers/markdown";
import { useMdAnchorStore } from "../stores/mdAnchor";

describe("matchAnchorId", () => {
  const ids = ["project-map", "docs", "agent-instructions", "Config"];

  it("matches an authored slug verbatim", () => {
    expect(matchAnchorId(ids, "docs")).toBe("docs");
  });

  it("slugifies a fragment written as the heading's visible text", () => {
    expect(matchAnchorId(ids, "Agent Instructions")).toBe("agent-instructions");
    expect(slugify("Agent Instructions")).toBe("agent-instructions");
  });

  it("decodes percent-encoded fragments", () => {
    expect(matchAnchorId(ids, "agent%20instructions")).toBe("agent-instructions");
  });

  it("falls back to a case-insensitive match", () => {
    expect(matchAnchorId(ids, "config")).toBe("Config");
    expect(matchAnchorId(ids, "DOCS")).toBe("docs");
  });

  it("returns null when nothing matches, and survives bad escapes", () => {
    expect(matchAnchorId(ids, "nope")).toBeNull();
    expect(matchAnchorId(ids, "%E0%A4%A")).toBeNull(); // malformed escape
  });
});

describe("useMdAnchorStore", () => {
  it("records a request per path and bumps the nonce on repeats", () => {
    const store = useMdAnchorStore.getState();
    store.requestAnchor("/p/a.md", "setup");
    let req = useMdAnchorStore.getState().requestsByPath["/p/a.md"];
    expect(req).toEqual({ fragment: "setup", nonce: 1 });

    store.requestAnchor("/p/a.md", "setup");
    req = useMdAnchorStore.getState().requestsByPath["/p/a.md"];
    expect(req.nonce).toBe(2);

    store.requestAnchor("/p/b.md", "other");
    expect(Object.keys(useMdAnchorStore.getState().requestsByPath).sort()).toEqual([
      "/p/a.md",
      "/p/b.md",
    ]);
  });

  it("consume clears only the named path", () => {
    const store = useMdAnchorStore.getState();
    store.requestAnchor("/p/a.md", "x");
    store.requestAnchor("/p/b.md", "y");
    store.consume("/p/a.md");
    const left = useMdAnchorStore.getState().requestsByPath;
    expect(left["/p/a.md"]).toBeUndefined();
    expect(left["/p/b.md"]).toBeDefined();
    store.consume("/p/b.md");
    store.consume("/p/b.md"); // consuming nothing is a no-op
    expect(useMdAnchorStore.getState().requestsByPath).toEqual({});
  });
});
