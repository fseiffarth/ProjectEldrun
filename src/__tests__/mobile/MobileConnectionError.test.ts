import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../mobile-web/src/api";
import {
  classifyUnavailable,
  describeFailure,
  describeUnavailable,
  knownFailureCodes,
  localFailureText,
  unavailableDetail,
  type UnavailableReason,
} from "../../../mobile-web/src/connection";

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
    // The sidecar's own limiter never sends 429: `too_many_attempts` rides the
    // route's usual failure status — 400 on a challenge, 401 on a login — and
    // both used to read as "Your desktop reported an error".
    expect(classifyUnavailable(new ApiError(400, "too_many_attempts"))).toBe("busy");
    expect(classifyUnavailable(new ApiError(401, "too_many_attempts"))).toBe("busy");
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

describe("describeFailure", () => {
  it("turns every known code into a sentence that is not the code", () => {
    for (const code of knownFailureCodes()) {
      const text = describeFailure(code);
      expect(text, code).not.toBe(code);
      expect(text, code).not.toMatch(/^[a-z_]+$/);
      expect(text.length, code).toBeGreaterThan(12);
      // Prose on an ApiError too — the splash's own title where the code is
      // one `classifyUnavailable` places (a proxy, a limiter, a dead link).
      const onError = describeFailure(new ApiError(400, code));
      expect(onError, code).not.toBe(code);
      expect(onError, code).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("never renders a bare code, whatever shape it arrives in", () => {
    for (const source of ["some_new_code", new ApiError(500, "boom"), new Error("odd_thing"), undefined, 42]) {
      const text = describeFailure(source);
      expect(text).toBe("Your desktop reported an error.");
    }
    expect(describeFailure(new ApiError(503, "desktop_unavailable"))).toBe("Eldrun isn't running on your desktop.");
    expect(describeFailure("desktop_unavailable")).toBe("Eldrun isn't running on your desktop.");
    expect(describeFailure(new ApiError(502, "request_failed"))).toBe("Eldrun Mobile isn't running on your desktop.");
    expect(describeFailure("session_expired")).toMatch(/lapsed/);
    expect(describeFailure(new ApiError(0, "offline"))).toMatch(/Can't reach|offline/);
  });

  it("shows the phone's own lock messages as written, and nothing else raw", () => {
    expect(localFailureText(new Error("Incorrect PIN."))).toBe("Incorrect PIN.");
    expect(localFailureText(new Error("not_allowed"))).toBe("That did not work. Try again.");
    expect(localFailureText("NotAllowedError")).toBe("That did not work. Try again.");
  });
});

describe("unavailableDetail", () => {
  it("reports the bare code for a transport failure and status+code otherwise", () => {
    expect(unavailableDetail(new ApiError(0, "offline"))).toBe("offline");
    expect(unavailableDetail(new ApiError(503, "desktop_unavailable"))).toBe("503 desktop_unavailable");
    expect(unavailableDetail(new Error("nope"))).toBeUndefined();
  });
});
