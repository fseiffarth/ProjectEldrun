import { useState } from "react";
import { pair } from "../auth";

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
    {error && <p className="error">{error}</p>}
    <button className="primary" disabled={busy || code.length !== 8 || !name.trim()} onClick={() => {
      setBusy(true); setError(""); void pair(code, name).then(onDone).catch((reason) => setError(String(reason))).finally(() => setBusy(false));
    }}>{busy ? "Pairing…" : "Pair device"}</button>
  </main>;
}

