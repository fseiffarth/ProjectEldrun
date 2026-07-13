import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { listen } from "@tauri-apps/api/event";
import { useVpnPromptStore } from "../../stores/vpnPrompt";
import { ConnectionLog, type LogLine } from "../common/ConnectionLog";
import { PasswordInput } from "../common/PasswordInput";
import { needsSeparateKeyPassphrase, type VpnAuthNeeds } from "../../types";

/**
 * Activation-time OpenVPN password prompt. Rendered once at the app root; shows
 * a modal whenever a VPN-gated project is being activated and needs its (never
 * persisted) password. The store owns the connect, so this modal stays open
 * while the tunnel comes up and surfaces any failure inline (with a retry)
 * rather than letting it fail silently in the background.
 */
export function VpnPasswordPrompt() {
  const pending = useVpnPromptStore((s) => s.pending);
  const status = useVpnPromptStore((s) => s.status);
  const error = useVpnPromptStore((s) => s.error);
  const submit = useVpnPromptStore((s) => s.submit);
  const cancel = useVpnPromptStore((s) => s.cancel);
  const [password, setPassword] = useState("");
  // Auth username for `auth-user-pass` configs. `needs` (queried per prompt)
  // decides which fields are shown; the username is seeded from the pending
  // prompt's stored spec.
  const [username, setUsername] = useState("");
  const [needs, setNeeds] = useState<VpnAuthNeeds>({ username: false, keyPassphrase: false });
  // A config with an encrypted key *and* an account has two secrets — OpenVPN
  // prompts for them separately. Without an account, `password` already is the
  // key passphrase, so this field stays hidden rather than asking twice.
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const needsKeyPassphrase = needsSeparateKeyPassphrase(needs);
  // Opt-in "Save passphrase" (default off). Pre-checked when a credential is
  // already saved for this config, so the box mirrors the true keychain state.
  const [remember, setRemember] = useState(false);
  // Live OpenVPN handshake output streamed from the backend, shown read-only so
  // the connect isn't an opaque spinner. Reset per prompt and per attempt.
  const [log, setLog] = useState<LogLine[]>([]);
  // Monotonic id source for `log` lines: a dedicated counter (never reset on
  // slice) gives each line a stable React key so the `.slice(-500)` cap trims
  // only the head without re-creating the surviving line nodes.
  const logSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever a new prompt opens (keyed on config so a superseding
  // prompt re-focuses, but a connect attempt on the same prompt doesn't wipe the
  // typed passphrase).
  useEffect(() => {
    if (pending) {
      setPassword("");
      setKeyPassphrase("");
      setUsername(pending.username ?? "");
      setLog([]);
      inputRef.current?.focus();
      const config = pending.config;
      let cancelled = false;
      void invoke<boolean>("vpn_has_saved_password", { config })
        .then((v) => !cancelled && setRemember(v))
        .catch(() => {});
      void invoke<VpnAuthNeeds>("openvpn_auth_needs", { config })
        .then((v) => !cancelled && setNeeds(v))
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [pending?.config]);

  // Stream the live handshake for this prompt's config into the log.
  useEffect(() => {
    const config = pending?.config;
    if (!config) return;
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<{ config: string; line: string }>("openvpn-progress", (ev) => {
      if (ev.payload.config !== config) return;
      setLog((prev) => [...prev, { id: logSeq.current++, text: ev.payload.line }].slice(-500));
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [pending?.config]);

  if (!pending) return null;

  const connecting = status === "connecting";
  const onSubmit = () => {
    if (!connecting) {
      setLog([]);
      void submit(password, remember, username, keyPassphrase);
    }
  };
  // Enter submits from any field; Escape cancels unless a connect is in flight.
  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
    if (e.key === "Escape" && !connecting) {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={connecting ? undefined : cancel}>
      <div className="project-dialog vpn-prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>VPN password</h2>
        <p className="vpn-prompt-text">
          Connecting OpenVPN for <strong>{pending.projectName}</strong>.
          <br />
          <span className="vpn-prompt-scope">
            While the tunnel is up, this computer's traffic routes through it — your
            browser too, not just Eldrun.
          </span>
        </p>
        {needs.username && (
          <label>
            Username
            <input
              type="text"
              value={username}
              autoComplete="off"
              placeholder="OpenVPN account username…"
              disabled={connecting}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onFieldKey}
            />
          </label>
        )}
        <label>
          {needs.username ? "Password" : "Passphrase"}{" "}
          <span className="ssh-optional-hint">
            {remember ? "(saved in OS keychain)" : "(not stored)"}
          </span>
          <PasswordInput
            ref={inputRef}
            value={password}
            autoFocus
            disabled={connecting}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </label>
        {needsKeyPassphrase && (
          <label>
            Private key passphrase
            <PasswordInput
              value={keyPassphrase}
              autoComplete="off"
              placeholder="Passphrase for the config's encrypted key…"
              disabled={connecting}
              onChange={(e) => setKeyPassphrase(e.target.value)}
              onKeyDown={onFieldKey}
            />
            <span className="ssh-optional-hint">
              This config's private key is encrypted, so OpenVPN asks for its
              passphrase separately from your account password.
            </span>
          </label>
        )}
        <label className="remote-connect-remember">
          <Toggle
            size="sm"
            checked={remember}
            disabled={connecting}
            onChange={(e) => setRemember(e.target.checked)}
          />
          {needsKeyPassphrase ? "Save VPN credentials" : "Save passphrase"}
          <span className="ssh-optional-hint">stored securely in your OS keychain</span>
        </label>
        {(connecting || log.length > 0) && <ConnectionLog lines={log} busy={connecting} />}
        {status === "error" && error && (
          <div className="project-dialog-error vpn-prompt-error">{error}</div>
        )}
        <div className="vpn-prompt-actions">
          <button type="button" onClick={cancel} disabled={connecting}>
            Cancel
          </button>
          <button
            type="button"
            className="primary vpn-connect-btn"
            onClick={onSubmit}
            disabled={connecting}
            title={
              connecting
                ? "Bringing the OpenVPN tunnel up — pkexec may prompt for elevation…"
                : status === "error"
                  ? "Connection failed — check the passphrase and retry."
                  : "Bring the OpenVPN tunnel up."
            }
          >
            {connecting && <span className="vpn-spinner" aria-hidden="true" />}
            {connecting ? "Connecting…" : status === "error" ? "Retry" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
