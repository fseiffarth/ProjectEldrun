import { useEffect, useRef, useState } from "react";
import { MIN_NEW_PIN, configureLocalUnlock, localUnlockBiometricEnabled, localUnlockPinLength, maybeEnrollBiometric, platformBiometricAvailable, unlockLocal, unlockLocalBiometric, validPin } from "../localLock";

export function LocalUnlock({ setup, onUnlocked }: { setup: boolean; onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  /** null while the record is being read — the unlock form waits for it, so
   * the PIN field's autoFocus (which fires at mount only) can be withheld
   * when the fingerprint prompt is about to cover the screen. */
  const [biometricEnrolled, setBiometricEnrolled] = useState<boolean | null>(setup ? false : null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [pinLength, setPinLength] = useState<number | null>(null);
  const attempt = useRef(0);
  const autoPrompted = useRef(false);
  useEffect(() => {
    void platformBiometricAvailable().then(setBiometricAvailable).catch(() => setBiometricAvailable(false));
  }, []);
  useEffect(() => {
    if (!setup) void localUnlockPinLength().then(setPinLength).catch(() => setPinLength(null));
  }, [setup]);
  useEffect(() => {
    if (!setup) void localUnlockBiometricEnabled().then(setBiometricEnrolled).catch(() => setBiometricEnrolled(false));
  }, [setup]);
  const unlockWithBiometric = () => {
    attempt.current += 1;
    setBiometricBusy(true);
    setError("");
    void unlockLocalBiometric().then(onUnlocked).catch((reason) => setError(String(reason))).finally(() => setBiometricBusy(false));
  };
  useEffect(() => {
    // Fingerprint is the default unlock: raise the OS sheet as the screen opens,
    // with no button in between. A browser that wants a user gesture (iOS
    // Safari) rejects quietly and the button below stays as the way in; the PIN
    // is always the fallback.
    if (setup || !biometricEnrolled) return;
    let disposed = false;
    const promptWhenReady = () => {
      if (disposed || autoPrompted.current) return;
      // WebAuthn refuses outright on a hidden or unfocused document, and that
      // is exactly the state this screen mounts in when the lock fires while
      // the app is in the background: spending the one attempt there left the
      // reader facing the button on their return. Wait for the app to actually
      // be in front of them, then ask.
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      autoPrompted.current = true;
      setBiometricBusy(true);
      // A rejection is not retried: a cancelled sheet hands focus straight back,
      // and re-asking on that would trap the reader in a prompt they closed.
      void unlockLocalBiometric().then(() => { if (!disposed) onUnlocked(); }).catch(() => {}).finally(() => { if (!disposed) setBiometricBusy(false); });
    };
    promptWhenReady();
    document.addEventListener("visibilitychange", promptWhenReady);
    window.addEventListener("focus", promptWhenReady);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", promptWhenReady);
      window.removeEventListener("focus", promptWhenReady);
    };
  }, [biometricEnrolled, onUnlocked, setup]);
  const submit = () => {
    attempt.current += 1;
    setBusy(true);
    setError("");
    const action = setup
      ? pin !== confirm
        ? Promise.reject(new Error("The PIN entries do not match."))
        : configureLocalUnlock(pin)
      : unlockLocal(pin).then(maybeEnrollBiometric);
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
      void unlockLocal(pin).then(maybeEnrollBiometric).then(() => {
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
        ? "This browser offers no fingerprint or Face ID unlock — browsers built on the system WebView (DuckDuckGo among them) do not support it. The app PIN will be your only unlock here; keep the phone’s own screen lock enabled, or pair again in Chrome or Safari to use a fingerprint."
        : "Create a fallback app PIN. Your fingerprint, Face ID, or secure screen lock becomes the default unlock; the PIN steps in when it fails."}</p>
      <label>New PIN ({MIN_NEW_PIN}–12 digits)<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
      <label>Confirm PIN<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))} /></label>
    </> : biometricEnrolled === null ? null : <>
      <p>{biometricEnrolled
        ? "Unlock with your fingerprint or device screen lock — or enter your app PIN below."
        : biometricAvailable
          ? "Enter your app PIN. Unlocking also registers your fingerprint or screen lock as the default unlock for next time."
          : "Enter your app PIN before Eldrun reconnects."}</p>
      {/* A missing fingerprint option must not read as a broken one. Some
        * phone browsers are built on the system WebView and expose no platform
        * authenticator at all, so the lock can only ever be the PIN there —
        * say which browsers do offer it rather than leaving it unexplained. */}
      {!biometricEnrolled && biometricAvailable === false && <p className="local-unlock-note">
        This browser offers no fingerprint or Face ID unlock — browsers built on the
        system WebView (DuckDuckGo among them) do not support it. Open Eldrun Mobile in
        Chrome or Safari to unlock with a fingerprint; that means pairing the phone once more,
        since a pairing belongs to the browser it was made in.
      </p>}
      {biometricEnrolled && <button className="primary" disabled={biometricBusy} onClick={unlockWithBiometric}>
        {biometricBusy ? "Waiting for the device…" : "Unlock with fingerprint"}
      </button>}
      <label>PIN<input className="code" type="password" inputMode="numeric" autoComplete="current-password" autoFocus={!biometricEnrolled} maxLength={pinLength ?? 12} value={pin} onChange={(event) => {
        const next = event.target.value.replace(/\D/g, "");
        setPin(pinLength === null ? next : next.slice(0, pinLength));
      }} /></label>
    </>}
    {error && <p className="error">{error}</p>}
    {setup
      ? <button className="primary" disabled={busy || !validPin(pin) || pin.length < MIN_NEW_PIN || pin !== confirm} onClick={submit}>
          {busy ? "Securing…" : biometricAvailable === false ? "Set app PIN" : "Set PIN and verify device"}
        </button>
      : biometricEnrolled !== null && pinLength === null && <button className="primary" disabled={busy || !validPin(pin)} onClick={submit}>
          {busy ? "Checking…" : "Unlock"}
        </button>}
    <p className="local-unlock-note">This local lock protects against casual access to an unlocked phone. It does not replace the phone’s own device lock or Eldrun’s paired-device authentication.</p>
  </main>;
}
