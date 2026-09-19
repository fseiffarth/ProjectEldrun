/**
 * The local lock screen (`mobile-web/src/screens/LocalUnlock.tsx`), with the
 * keystore and WebAuthn behind it mocked away (`localLock.ts`'s pure half is
 * MobileLocalLock). What is pinned: digits-only entry, the setup gate on the
 * new-PIN length and the confirm match, the one-shot auto-submit when the exact
 * length is known — and never before it — and fingerprint as the default unlock
 * only once the app is in front of the reader.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../mobile-web/src/localLock", () => ({
  MIN_NEW_PIN: 6,
  validPin: (pin: string) => /^\d{4,12}$/.test(pin),
  configureLocalUnlock: vi.fn(),
  localUnlockBiometricEnabled: vi.fn(),
  localUnlockPinLength: vi.fn(),
  maybeEnrollBiometric: vi.fn(),
  platformBiometricAvailable: vi.fn(),
  unlockLocal: vi.fn(),
  unlockLocalBiometric: vi.fn(),
}));

import {
  configureLocalUnlock,
  localUnlockBiometricEnabled,
  localUnlockPinLength,
  maybeEnrollBiometric,
  platformBiometricAvailable,
  unlockLocal,
  unlockLocalBiometric,
} from "../../mobile-web/src/localLock";
import { LocalUnlock } from "../../mobile-web/src/screens/LocalUnlock";

const lock = {
  configure: vi.mocked(configureLocalUnlock),
  enrolled: vi.mocked(localUnlockBiometricEnabled),
  pinLength: vi.mocked(localUnlockPinLength),
  enroll: vi.mocked(maybeEnrollBiometric),
  available: vi.mocked(platformBiometricAvailable),
  unlock: vi.mocked(unlockLocal),
  biometric: vi.mocked(unlockLocalBiometric),
};

beforeEach(() => {
  lock.available.mockResolvedValue(true);
  lock.enrolled.mockResolvedValue(false);
  lock.pinLength.mockResolvedValue(6);
  lock.enroll.mockResolvedValue(true);
  lock.unlock.mockResolvedValue(undefined);
  lock.biometric.mockResolvedValue(undefined);
  lock.configure.mockResolvedValue({ biometricEnrolled: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of Object.values(lock)) fn.mockReset();
});

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Mobile local unlock — setup", () => {
  it("keeps digits only, and enables Set PIN only for a long-enough, confirmed PIN", async () => {
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup onUnlocked={onUnlocked} />);
    const button = await screen.findByRole("button", { name: "Set PIN and verify device" }) as HTMLButtonElement;
    type(/New PIN/, "12a3-45");
    expect((screen.getByLabelText(/New PIN/) as HTMLInputElement).value).toBe("12345");
    type(/New PIN/, "123456");
    type(/Confirm PIN/, "12345");
    expect(button.disabled).toBe(true);
    // A 4-digit PIN is valid for an old record but too short for a new one.
    type(/New PIN/, "1234");
    type(/Confirm PIN/, "1234");
    expect(button.disabled).toBe(true);
    type(/New PIN/, "123456");
    type(/Confirm PIN/, "123456");
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(lock.configure).toHaveBeenCalledWith("123456");
    expect(lock.unlock).not.toHaveBeenCalled();
  });

  it("says when the browser has no fingerprint at all, and labels the button accordingly", async () => {
    lock.available.mockResolvedValue(false);
    render(<LocalUnlock setup onUnlocked={() => {}} />);
    expect(await screen.findByRole("button", { name: "Set app PIN" })).toBeTruthy();
    expect(screen.getByText(/offers no fingerprint or Face ID unlock/)).toBeTruthy();
  });

  it("shows the reason when the setup is refused, and stays usable", async () => {
    lock.configure.mockRejectedValue(new Error("Choose a 6–12 digit PIN."));
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup onUnlocked={onUnlocked} />);
    await screen.findByRole("button", { name: "Set PIN and verify device" });
    type(/New PIN/, "123456");
    type(/Confirm PIN/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Set PIN and verify device" }));
    expect((await screen.findByText(/Choose a 6–12 digit PIN/)).textContent).toContain("Error");
    expect(onUnlocked).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Set PIN and verify device" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Mobile local unlock — unlock", () => {
  it("submits once by itself at the recorded length, with no Unlock button in the way", async () => {
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup={false} onUnlocked={onUnlocked} />);
    const field = await screen.findByLabelText("PIN") as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Unlock" })).toBeNull();
    expect(field.maxLength).toBe(6);
    // Five digits: valid as a PIN, but not the record's length, so nothing runs.
    type("PIN", "12345");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lock.unlock).not.toHaveBeenCalled();
    type("PIN", "1234567");
    // Trimmed to the recorded length rather than submitting a 7-digit guess.
    expect(field.value).toBe("123456");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(lock.unlock).toHaveBeenCalledTimes(1);
    expect(lock.unlock).toHaveBeenCalledWith("123456");
    // A verified unlock also offers the fingerprint enrolment for next time.
    expect(lock.enroll).toHaveBeenCalledOnce();
  });

  it("shows the failure of an auto-submitted PIN and does not unlock", async () => {
    lock.unlock.mockRejectedValue(new Error("Incorrect PIN."));
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup={false} onUnlocked={onUnlocked} />);
    await screen.findByLabelText("PIN");
    type("PIN", "123456");
    expect((await screen.findByText(/Incorrect PIN/)).textContent).toBe("Error: Incorrect PIN.");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("falls back to an Unlock button for a record that never stored its length", async () => {
    lock.pinLength.mockResolvedValue(null);
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup={false} onUnlocked={onUnlocked} />);
    const button = await screen.findByRole("button", { name: "Unlock" }) as HTMLButtonElement;
    expect((screen.getByLabelText("PIN") as HTMLInputElement).maxLength).toBe(12);
    expect(button.disabled).toBe(true);
    type("PIN", "123");
    expect(button.disabled).toBe(true);
    type("PIN", "1234");
    expect(button.disabled).toBe(false);
    // Nothing auto-submits without a known length, however long the reader waits.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lock.unlock).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(lock.unlock).toHaveBeenCalledWith("1234");
  });

  it("raises the fingerprint prompt on its own once the app is in front, and offers the button as the way back in", async () => {
    lock.enrolled.mockResolvedValue(true);
    lock.biometric.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup={false} onUnlocked={onUnlocked} />);
    const button = await screen.findByRole("button", { name: /Unlock with fingerprint|Waiting for the device/ });
    await waitFor(() => expect(lock.biometric).toHaveBeenCalledTimes(1));
    // A cancelled sheet is not retried and shows no error: the button stays.
    await waitFor(() => expect(button.textContent).toBe("Unlock with fingerprint"));
    expect(screen.queryByText(/Error/)).toBeNull();
    expect(onUnlocked).not.toHaveBeenCalled();
    // The PIN field is there as the fallback but does not steal focus from the sheet.
    expect(document.activeElement).not.toBe(screen.getByLabelText("PIN"));

    fireEvent.click(button);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(lock.biometric).toHaveBeenCalledTimes(2);
  });

  it("waits for the app to be in front before spending the one automatic attempt", async () => {
    lock.enrolled.mockResolvedValue(true);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const onUnlocked = vi.fn();
    render(<LocalUnlock setup={false} onUnlocked={onUnlocked} />);
    await screen.findByRole("button", { name: "Unlock with fingerprint" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lock.biometric).not.toHaveBeenCalled();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(lock.biometric).toHaveBeenCalledTimes(1);
  });

  it("explains a missing fingerprint option instead of leaving it out silently", async () => {
    lock.available.mockResolvedValue(false);
    render(<LocalUnlock setup={false} onUnlocked={() => {}} />);
    await screen.findByLabelText("PIN");
    expect(screen.getByText(/Open Eldrun Mobile in Chrome or Safari/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlock with fingerprint" })).toBeNull();
  });
});
