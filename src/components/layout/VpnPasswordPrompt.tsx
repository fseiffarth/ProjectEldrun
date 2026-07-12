import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { listen } from "@tauri-apps/api/event";
import { useVpnPromptStore } from "../../stores/vpnPrompt";
import { ConnectionLog, type LogLine } from "../common/ConnectionLog";
import { PasswordInput } from "../common/PasswordInput";

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
  // Auth username for `auth-user-pass` configs. `needsUsername` (queried per
  // prompt) decides whether the field is shown; seeded from the pending prompt's
  // stored spec username.
  const [username, setUsername] = useState("");
  const [needsUsername, setNeedsUsername] = useState(false);
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
      setUsername(pending.username ?? "");
      setLog([]);
      inputRef.current?.focus();
      const config = pending.config;
      let cancelled = false;
      void invoke<boolean>("vpn_has_saved_password", { config })
        .then((v) => !cancelled && setRemember(v))
        .catch(() => {});
      void invoke<boolean>("openvpn_needs_username", { config })
        .then((v) => !cancelled && setNeedsUsername(v))
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
      void submit(password, remember, username);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={connecting ? undefined : cancel}>
      <div className="project-dialog vpn-prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>VPN password</h2>
        <p className="vpn-prompt-text">
          Connecting OpenVPN for <strong>{pending.projectName}</strong>.
        </p>
        {needsUsername && (
          <label>
            Username
            <input
              type="text"
              value={username}
              autoComplete="off"
              placeholder="OpenVPN account username…"
              disabled={connecting}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
                if (e.key === "Escape" && !connecting) {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
          </label>
        )}
        <label>
          {needsUsername ? "Password" : "Passphrase"}{" "}
          <span className="ssh-optional-hint">
            {remember ? "(saved in OS keychain)" : "(not stored)"}
          </span>
          <PasswordInput
            ref={inputRef}
            value={password}
            autoFocus
            disabled={connecting}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
              if (e.key === "Escape" && !connecting) {
                e.preventDefault();
                cancel();
              }
            }}
          />
        </label>
        <label className="remote-connect-remember">
          <Toggle
            size="sm"
            checked={remember}
            disabled={connecting}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Save passphrase
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
