import { describe, it, expect } from "vitest";
import { decodeBase64, hostsLabel, remoteImageHosts } from "../lib/remote/remoteImages";

describe("remote markdown images", () => {
  it("lists each host once, in document order, skipping unparsable URLs", () => {
    expect(
      remoteImageHosts([
        "https://img.shields.io/a.svg",
        "https://github.com/x/badge.svg",
        "not a url",
        "https://img.shields.io/b.svg",
      ]),
    ).toEqual(["img.shields.io", "github.com"]);
  });

  it("names at most three hosts in the banner", () => {
    expect(hostsLabel(["a", "b"])).toBe("a, b");
    expect(hostsLabel(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
  });

  it("decodes the backend's base64 payload to bytes", () => {
    expect(Array.from(decodeBase64("iVBORw=="))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
