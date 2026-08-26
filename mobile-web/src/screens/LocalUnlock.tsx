import { useEffect, useRef, useState } from "react";
import { MIN_NEW_PIN, configureLocalUnlock, localUnlockPinLength, platformBiometricAvailable, unlockLocal, validPin } from "../localLock";

export function LocalUnlock({ setup, onUnlocked }: { setup: boolean; onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const [pinLength, setPinLength] = useState<number | null>(null);
  const attempt = useRef(0);
  useEffect(() => {
    void platformBiometricAvailable().then(setBiometricAvailable).catch(() => setBiometricAvailable(false));
  }, []);
  useEffect(() => {
    if (!setup) void localUnlockPinLength().then(setPinLength).catch(() => setPinLength(null));
  }, [setup]);
  const submit = () => {
    attempt.current += 1;
    setBusy(true);
    setError("");
    const action = setup
      ? pin !== confirm
        ? Promise.reject(new Error("The PIN entries do not match."))
        : configureLocalUnlock(pin)
      : unlockLocal(pin);
    void action.then(onUnlocked).catch((reason) => setError(String(reason))).finally(() => setBusy(false));
  };
  useEffect(() => {
    const currentAttempt = ++attempt.current;
    // Auto-submit only when the exact length is known. On a record saved before
    // `pinLength` existed, this fired at 4, 5 *and* 6 digits — three 210,000
    // round PBKDF2 runs and two "Incorrect PIN." flashes while still typing,
    // each one now also burning a failed-attempt slot.
    if (setup || pinLength === null || !validPin(pin) || pin.length !== pinLength) {
      setBusy(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      void unlockLocal(pin).then(() => {
        if (currentAttempt === attempt.current) onUnlocked();
      }).catch((reason) => {
        if (currentAttempt === attempt.current) setError(String(reason));
      }).finally(() => {
        if (currentAttempt === attempt.current) setBusy(false);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [onUnlocked, pin, pinLength, setup]);
  return <main className="pair screen local-unlock">
    <div className="brand"><span className="spark">✦</span><h1>{setup ? "Secure Eldrun Mobile" : "Eldrun Mobile locked"}</h1></div>
    {setup ? <>
      <p>{biometricAvailable === false
        ? "This browser does not expose a platform biometric authenticator. The app PIN will be required; keep the phone’s own screen lock enabled."
        : "Create an app PIN. Setup also requires the device’s fingerprint, Face ID, or secure screen-lock verification when available."}</p>
      <label>New PIN ({MIN_NEW_PIN}–12 digits)<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
      <label>Confirm PIN<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))} /></label>
    </> : <>
      <p>Enter your app PIN, then verify with your device biometric or secure screen lock before Eldrun reconnects.</p>
      <label>PIN<input className="code" type="password" inputMode="numeric" autoComplete="current-password" autoFocus maxLength={pinLength ?? 12} value={pin} onChange={(event) => {
        const next = event.target.value.replace(/\D/g, "");
        setPin(pinLength === null ? next : next.slice(0, pinLength));
      }} /></label>
    </>}
    {error && <p className="error">{error}</p>}
    {setup
      ? <button className="primary" disabled={busy || !validPin(pin) || pin.length < MIN_NEW_PIN || pin !== confirm} onClick={submit}>
          {busy ? "Securing…" : biometricAvailable === false ? "Set app PIN" : "Set PIN and verify device"}
        </button>
      : pinLength === null && <button className="primary" disabled={busy || !validPin(pin)} onClick={submit}>
          {busy ? "Checking…" : "Unlock"}
        </button>}
    <p className="local-unlock-note">This local lock protects against casual access to an unlocked phone. It does not replace the phone’s own device lock or Eldrun’s paired-device authentication.</p>
  </main>;
}
