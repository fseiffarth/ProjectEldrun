/**
 * The pairing screen is the first thing a new phone sees, and its failures
 * used to be shown as `Error: invalid_pairing_code` — the sidecar's own codes,
 * word for word. Each one now says what to do.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../mobile-web/src/api";
import { Pair, describePairFailure } from "../../mobile-web/src/screens/Pair";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("describePairFailure", () => {
  it("explains a wrong or expired code and where a fresh one is", () => {
    const copy = describePairFailure(new ApiError(400, "invalid_pairing_code"));
    expect(copy).not.toContain("invalid_pairing_code");
    expect(copy).toContain("Eldrun Settings");
  });

  it("names the rate limiter instead of its code", () => {
    expect(describePairFailure(new ApiError(400, "too_many_attempts"))).toMatch(/Too many pairing attempts/);
  });

  it("uses the splash's machine-naming copy for anything not about the code", () => {
    expect(describePairFailure(new ApiError(0, "offline"))).toMatch(/Can't reach your desktop|This phone is offline/);
    expect(describePairFailure(new ApiError(503, "request_failed"))).toContain("Eldrun Mobile isn't running");
  });
});

describe("Pair screen", () => {
  it("shows the rejection as an alert in plain words", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_pairing_code" }), { status: 400 }));
    render(<Pair onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That code is wrong or has expired");
    expect(alert.textContent).not.toContain("invalid_pairing_code");
  });
});
