import { useState } from "react";
import { ApiError } from "../api";
import { pair } from "../auth";
import { classifyUnavailable, describeUnavailable } from "../connection";

/**
 * What to say when pairing fails. The sidecar answers a bad or expired code
 * and its own rate limiter with a 400 carrying a bare code, which used to be
 * shown as `Error: invalid_pairing_code` — the one screen a new user sees
 * first, speaking in identifiers. Anything that is not about the code itself
 * is a reachability problem and gets the same machine-naming copy as the
 * splash.
 */
export function describePairFailure(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.code === "invalid_pairing_code") return "That code is wrong or has expired. Eldrun Settings shows a fresh one.";
    if (reason.code === "too_many_attempts") return "Too many pairing attempts. Wait a minute, then try again with the code from Eldrun Settings.";
  }
  const { title, hint } = describeUnavailable(classifyUnavailable(reason));
  return `${title} ${hint}`;
}

export function Pair({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(navigator.userAgent.includes("iPhone") ? "iPhone" : "Mobile device");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="pair screen">
    <div className="brand"><span className="spark">✦</span><h1>Eldrun Mobile</h1></div>
    <p>Enter the one-time code shown in Eldrun Settings. This device receives keyboard-level access only to projects you explicitly enable.</p>
    <label>Device name<input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
    <label>Pairing code<input className="code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={8} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || code.length !== 8 || !name.trim()} onClick={() => {
      setBusy(true); setError(""); void pair(code, name).then(onDone).catch((reason) => setError(describePairFailure(reason))).finally(() => setBusy(false));
    }}>{busy ? "Pairing…" : "Pair device"}</button>
  </main>;
}
