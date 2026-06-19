import { useEffect, useRef, useState } from "react";
import { useVpnPromptStore } from "../../stores/vpnPrompt";

/**
 * Activation-time OpenVPN password prompt. Rendered once at the app root; shows
 * a modal whenever a VPN-gated project is being activated and needs its (never
 * persisted) password. Resolves the pending `vpnPrompt` request.
 */
export function VpnPasswordPrompt() {
  const pending = useVpnPromptStore((s) => s.pending);
  const submit = useVpnPromptStore((s) => s.submit);
  const cancel = useVpnPromptStore((s) => s.cancel);
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever a new prompt opens.
  useEffect(() => {
    if (pending) {
      setPassword("");
      inputRef.current?.focus();
    }
  }, [pending]);

  if (!pending) return null;

  const onSubmit = () => submit(password);

  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="project-dialog vpn-prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>VPN password</h2>
        <p className="vpn-prompt-text">
          Connecting OpenVPN for <strong>{pending.projectName}</strong>.
        </p>
        <label>
          Password
          <input
            ref={inputRef}
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
        </label>
        <div className="vpn-prompt-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={onSubmit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
