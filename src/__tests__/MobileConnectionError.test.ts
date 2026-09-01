import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../mobile-web/src/api";
import {
  classifyUnavailable,
  describeUnavailable,
  unavailableDetail,
  type UnavailableReason,
} from "../../mobile-web/src/connection";

/** `navigator.onLine` is read-only on the real object. */
function withOnline(online: boolean, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(Navigator.prototype, "onLine", original);
    Reflect.deleteProperty(navigator as object, "onLine");
  }
}

afterEach(() => vi.restoreAllMocks());

describe("classifyUnavailable", () => {
  it("separates a phone with no network from one that simply cannot reach the host", () => {
    // The distinction the whole screen exists for: both are `status: 0`, and
    // only `navigator.onLine` tells them apart.
    withOnline(false, () => {
      expect(classifyUnavailable(new ApiError(0, "offline"))).toBe("phone_offline");
    });
    withOnline(true, () => {
      expect(classifyUnavailable(new ApiError(0, "offline"))).toBe("unreachable");
    });
  });

  it("reads a gateway status with no sidecar error code as the sidecar being down", () => {
    // Tailscale serve reached the desktop and found nothing on the port, so its
    // own proxy body comes back — which `api()` renders as `request_failed`.
    for (const status of [502, 503, 504]) {
      expect(classifyUnavailable(new ApiError(status, "request_failed"))).toBe("host_down");
    }
  });

  it("keeps the sidecar's own 503 distinct from a proxy's", () => {
    // Same status class, opposite meaning: here the sidecar answered, and the
    // thing that is missing is the desktop app behind it.
    expect(classifyUnavailable(new ApiError(503, "desktop_unavailable"))).toBe("desktop_down");
  });

  it("names a rejected origin rather than calling it a server error", () => {
    expect(classifyUnavailable(new ApiError(403, "invalid_origin"))).toBe("blocked_origin");
  });

  it("names a timeout and a rate limit", () => {
    expect(classifyUnavailable(new ApiError(0, "timeout"))).toBe("timeout");
    expect(classifyUnavailable(new ApiError(429, "rate_limited"))).toBe("busy");
  });

  it("falls back to a server error for anything unplaceable", () => {
    expect(classifyUnavailable(new ApiError(500, "boom"))).toBe("server_error");
    expect(classifyUnavailable(new Error("not an ApiError"))).toBe("server_error");
    expect(classifyUnavailable(undefined)).toBe("server_error");
  });
});

describe("describeUnavailable", () => {
  const REASONS: UnavailableReason[] = [
    "phone_offline",
    "unreachable",
    "timeout",
    "host_down",
    "desktop_down",
    "busy",
    "blocked_origin",
    "server_error",
    "storage_blocked",
  ];

  it("gives every reason its own title and hint", () => {
    const titles = new Set<string>();
    for (const reason of REASONS) {
      const { title, hint } = describeUnavailable(reason);
      expect(title.length).toBeGreaterThan(0);
      // The hint is the half that says which machine to go and fix; a reason
      // without one is back to "Host unavailable" with extra steps.
      expect(hint.length).toBeGreaterThan(0);
      titles.add(title);
    }
    expect(titles.size).toBe(REASONS.length);
  });

  it("points the two look-alike outages at different machines", () => {
    // `host_down` and `desktop_down` are the pair a reader is most likely to
    // confuse, and the copy has to send them to different places.
    expect(describeUnavailable("host_down").title).toContain("Eldrun Mobile isn't running");
    expect(describeUnavailable("desktop_down").title).toContain("Eldrun isn't running");
  });

  it("does not blame one machine when the phone cannot tell which failed", () => {
    // From the browser, off-the-tailnet and desktop-asleep are identical.
    const { hint } = describeUnavailable("unreachable");
    expect(hint).toContain("Tailscale");
    expect(hint).toContain("asleep");
  });
});

describe("unavailableDetail", () => {
  it("reports the bare code for a transport failure and status+code otherwise", () => {
    expect(unavailableDetail(new ApiError(0, "offline"))).toBe("offline");
    expect(unavailableDetail(new ApiError(503, "desktop_unavailable"))).toBe("503 desktop_unavailable");
    expect(unavailableDetail(new Error("nope"))).toBeUndefined();
  });
});
