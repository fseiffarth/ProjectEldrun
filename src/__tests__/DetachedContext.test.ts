import { describe, expect, it } from "vitest";
import {
  getDetachedWindowContext,
  installDetachedWindowContext,
  setDetachedWindowContext,
  type DetachedWindowContext,
} from "../stores/detachedContext";

function context(label: string): DetachedWindowContext {
  return {
    scope: "p",
    groupId: "g-1",
    label,
    targetGroupId: () => "g-1",
    pushEdit: () => {},
    closeTab: () => {},
  };
}

describe("detached window context lifecycle", () => {
  it("is restored by StrictMode's second effect setup", () => {
    const value = context("detached-p-g-1");
    const firstCleanup = installDetachedWindowContext(value);
    firstCleanup();
    expect(getDetachedWindowContext()).toBeNull();

    const secondCleanup = installDetachedWindowContext(value);
    expect(getDetachedWindowContext()).toBe(value);
    secondCleanup();
  });

  it("an obsolete cleanup cannot clear a replacement context", () => {
    const old = context("old");
    const cleanup = installDetachedWindowContext(old);
    const replacement = context("replacement");
    installDetachedWindowContext(replacement);

    cleanup();
    expect(getDetachedWindowContext()).toBe(replacement);
    setDetachedWindowContext(null);
  });
});
