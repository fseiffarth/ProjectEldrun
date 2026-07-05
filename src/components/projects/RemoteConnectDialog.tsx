import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TerminalView } from "../terminal/TerminalView";
import { ConnLamp } from "../common/ConnLamp";
import { ConnectionLog } from "../common/ConnectionLog";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { useRemoteReconnect } from "./useRemoteReconnect";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useProjectsStore, disconnectRemote } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { formatRemoteTarget, resolveLocalMirror, type ProjectEntry } from "../../types";

/**
 * Centered "Connect" modal for an existing remote (SSH) project — the single
 * entry point the per-pill status lamp and the disconnected-pane placeholder
 * open. It is the connect-only sibling of the new-project dialog's SSH section:
 * no address entry, no folder browse, no project creation — the target is the
 * project's known `remote` spec.
 *
 * Two paths, matching the `connections_headless` setting (default ON):
 *  - headless → Eldrun feeds the password to the backend (SSH password + VPN
 *    passphrase fields, a live handshake log for VPN), and
 *  - non-headless → embedded login terminals where the user types the secret
 *    directly and Eldrun never handles it.
 * Both drive `useRemoteReconnect`, so the shared SSH/VPN lamp state (and the
 * pooled `remote_connect`) is identical to the header lamps. The modal
 * auto-closes once SSH reaches "connected".
 */
export function RemoteConnectDialog() {
  const projectId = useConnectDialogStore((s) => s.projectId);
  const project = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  if (!projectId || !project?.remote) return null;
  return <RemoteConnectDialogInner key={project.id} project={project} />;
}

function RemoteConnectDialogInner({ project }: { project: ProjectEntry }) {
  const close = useConnectDialogStore((s) => s.close);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  const {
    sshStatus,
    vpnStatus,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeedsUsername,
    selectVpnConfig,
    browseVpnConfig,
    winManual,
    vpnTerm,
    sshTerm,
    startVpnTerm,
    stopVpn,
    startSshTerm,
    stopSsh,
    tryConnectNow,
    sshError,
    vpnError,
    vpnLog,
    sshSaved,
    vpnSaved,
    connectVpnHeadless,
    connectSshHeadless,
  } = useRemoteReconnect(project);

  const [sshPassword, setSshPassword] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  // "Connect via OpenVPN" opt-in, default OFF: this project is VPN-gated, but on
  // the right network the tunnel is unnecessary and SSH connects directly. The
  // VPN fields stay collapsed until the user turns this on.
  const [vpnEnabled, setVpnEnabled] = useState(false);
  // "Save password" opt-in (default off). Pre-checked when a credential is
  // already saved for this target, so it reflects the true keychain state.
  const [sshRemember, setSshRemember] = useState(false);
  const [vpnRemember, setVpnRemember] = useState(false);
  useEffect(() => setSshRemember(sshSaved), [sshSaved]);
  useEffect(() => setVpnRemember(vpnSaved), [vpnSaved]);
  const localMirror = resolveLocalMirror(project);

  // Auto-close only on a *fresh* connect made from within this dialog — the held
  // panes mount and the work surface takes over, so the modal has nothing left
  // to do. If it was already connected when opened (the user clicked the pill to
  // manage/disconnect an up connection), keep it open so the Disconnect action
  // stays reachable — clicking the lamps of a connected project must show the
  // same menu as when disconnected.
  const prevSshStatus = useRef(sshStatus);
  useEffect(() => {
    const prev = prevSshStatus.current;
    prevSshStatus.current = sshStatus;
    if (sshStatus === "connected" && prev !== "connected") close();
  }, [sshStatus, close]);

  const connected = sshStatus === "connected";
  const connecting = sshStatus === "connecting";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="project-dialog remote-connect-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Connect remote project</h2>
          <button type="button" className="dialog-close-btn" onClick={close}>×</button>
        </div>

        <div className="remote-connect-target">
          <div className="remote-connect-location">
            <span className="remote-connect-location-label">Remote</span>
            <span className="remote-connect-location-path" title={project.remote ? formatRemoteTarget(project.remote) : undefined}>
              {project.remote && formatRemoteTarget(project.remote)}
            </span>
          </div>
          {localMirror && (
            <div className="remote-connect-location">
              <span className="remote-connect-location-label">Local</span>
              <span className="remote-connect-location-path" title={localMirror}>{localMirror}</span>
            </div>
          )}
        </div>

        {/* ── OpenVPN (always offered; opt-in, default off) ─────────────────────
            Shown for every remote project, not only ones that stored a config at
            create time: a project made on a no-VPN network may need a tunnel when
            reconnected from a VPN-gated one. With no config yet, enabling the
            toggle reveals a picker; the choice is persisted to the project. */}
        <div className="remote-reconnect-section" role="group" aria-label="OpenVPN tunnel">
          <label className={`toggle-card${vpnEnabled ? " is-on" : ""}`}>
            <span className="toggle-card-body">
              <span className="toggle-card-title">
                <ConnLamp status={vpnStatus} label="OpenVPN" />
                Connect via OpenVPN
              </span>
              <span className="toggle-card-desc">
                Bring up a tunnel first if this host is VPN-gated. Skip it when
                you're already on the right network — SSH connects directly.
              </span>
            </span>
            <span className="eld-switch">
              <input
                type="checkbox"
                checked={vpnEnabled}
                disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                onChange={(e) => setVpnEnabled(e.target.checked)}
              />
              <span className="eld-switch-track" aria-hidden="true" />
            </span>
          </label>
          {vpnEnabled && !vpnConfig && (
            <div className="vpn-config-pick">
              <span className="ssh-optional-hint">
                Choose the OpenVPN config for this host — it's saved to the project
                so you only pick it once.
              </span>
              {vpnConfigs.length > 0 && (
                <div className="folder-picker-row">
                  <Dropdown
                    className="dropdown-block vpn-config-recent"
                    value=""
                    placeholder="Recently used…"
                    title="Reuse a previously-used OpenVPN config"
                    onChange={(v) => {
                      if (v) selectVpnConfig(v);
                    }}
                    options={vpnConfigs.map((c) => ({ value: c.path, label: c.name }))}
                  />
                </div>
              )}
              <div className="folder-picker-row">
                <button type="button" className="dialog-connect-btn" onClick={() => void browseVpnConfig()}>
                  Choose .ovpn config…
                </button>
              </div>
              {vpnStatus === "error" && vpnError && (
                <div className="project-dialog-error">{vpnError}</div>
              )}
            </div>
          )}
          {vpnEnabled && vpnConfig && (headless ? (
              <>
                {vpnNeedsUsername && (
                  <label className="remote-connect-field">
                    VPN username
                    <input
                      type="text"
                      value={vpnUsername}
                      autoComplete="off"
                      placeholder="OpenVPN account username…"
                      disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                      onChange={(e) => setVpnUsername(e.target.value)}
                    />
                  </label>
                )}
                <label className="remote-connect-field">
                  {vpnNeedsUsername ? "VPN password" : "VPN passphrase"}
                  <PasswordInput
                    value={vpnPassword}
                    autoComplete="off"
                    placeholder={vpnNeedsUsername ? "OpenVPN account password…" : "OpenVPN passphrase…"}
                    disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                    onChange={(e) => setVpnPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void connectVpnHeadless(vpnPassword, vpnRemember);
                    }}
                  />
                  <button
                    type="button"
                    className="dialog-connect-btn"
                    disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                    onClick={() => void connectVpnHeadless(vpnPassword, vpnRemember)}
                  >
                    {vpnStatus === "connected"
                      ? "VPN connected"
                      : vpnStatus === "connecting"
                        ? "Connecting…"
                        : "Connect VPN"}
                  </button>
                  {vpnStatus === "connecting" && (
                    <button
                      type="button"
                      className="vpn-disconnect-btn"
                      title="Stop this VPN connection attempt and reset the tunnel state."
                      onClick={stopVpn}
                    >
                      Stop
                    </button>
                  )}
                </label>
                <label className="remote-connect-remember">
                  <input
                    type="checkbox"
                    checked={vpnRemember}
                    disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                    onChange={(e) => setVpnRemember(e.target.checked)}
                  />
                  Save passphrase
                  <span className="ssh-optional-hint">stored securely in your OS keychain</span>
                </label>
                {(vpnStatus === "connecting" || vpnLog.length > 0) && (
                  <ConnectionLog lines={vpnLog} busy={vpnStatus === "connecting"} />
                )}
                {vpnStatus === "error" && vpnError && (
                  <div className="project-dialog-error">{vpnError}</div>
                )}
              </>
            ) : (
              <div className="dialog-connect">
                <button
                  type="button"
                  className="dialog-connect-btn"
                  disabled={!!vpnTerm}
                  title="Bring the OpenVPN tunnel up in a terminal below — enter the passphrase there."
                  onClick={() => void startVpnTerm()}
                >
                  <span className="dialog-connect-btn-icon" aria-hidden="true">▶_</span>
                  {vpnTerm ? "VPN terminal open below" : "Open VPN login terminal"}
                </button>
                {vpnTerm && (
                  <div className="dialog-connect-terminal">
                    <div className="dialog-connect-terminal-bar">
                      <span className="ssh-optional-hint">
                        Authenticate the tunnel below — it keeps running for this project.
                      </span>
                      <button type="button" className="vpn-disconnect-btn" onClick={stopVpn}>
                        Disconnect
                      </button>
                    </div>
                    <div className="dialog-connect-terminal-host">
                      <TerminalView
                        id={vpnTerm.id}
                        cmd=""
                        cwd=""
                        initialInput={vpnTerm.command}
                        visible
                        focused
                        persistOnUnmount
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* ── SSH ───────────────────────────────────────────────────────────── */}
        <div className="remote-reconnect-section" role="group" aria-label="SSH login">
          <div className="remote-field-label">
            <ConnLamp status={sshStatus} label="SSH" />
            Sign in over SSH
          </div>
          {headless ? (
            <>
              <label className="remote-connect-field">
                Password
                <PasswordInput
                  value={sshPassword}
                  autoFocus
                  autoComplete="off"
                  placeholder="SSH password…"
                  disabled={connecting || connected}
                  onChange={(e) => setSshPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void connectSshHeadless(sshPassword, sshRemember);
                  }}
                />
                <button
                  type="button"
                  className="dialog-connect-btn"
                  disabled={connecting || connected}
                  onClick={() => void connectSshHeadless(sshPassword, sshRemember)}
                >
                  {connected ? "Connected" : connecting ? "Connecting…" : "Connect"}
                </button>
                {connecting && (
                  <button
                    type="button"
                    className="vpn-disconnect-btn"
                    title="Stop this SSH connection attempt and reset the connection state."
                    onClick={stopSsh}
                  >
                    Stop
                  </button>
                )}
              </label>
              <label className="remote-connect-remember">
                <input
                  type="checkbox"
                  checked={sshRemember}
                  disabled={connecting || connected}
                  onChange={(e) => setSshRemember(e.target.checked)}
                />
                Save password
                <span className="ssh-optional-hint">stored securely in your OS keychain</span>
              </label>
              {sshStatus === "error" && sshError && (
                <div className="project-dialog-error">{sshError}</div>
              )}
            </>
          ) : winManual ? (
            // Windows has no ControlMaster socket to ride an interactive login,
            // so fall back to the headless-style key-auth connect.
            <div className="dialog-connect">
              <button
                type="button"
                className="dialog-connect-btn"
                disabled={connecting || connected}
                onClick={() => void connectSshHeadless("")}
              >
                {connected ? "Connected" : connecting ? "Connecting…" : "Connect"}
              </button>
              {connecting && (
                <button
                  type="button"
                  className="vpn-disconnect-btn"
                  title="Stop this SSH connection attempt and reset the connection state."
                  onClick={stopSsh}
                >
                  Stop
                </button>
              )}
              {sshStatus === "error" && sshError && (
                <div className="project-dialog-error">{sshError}</div>
              )}
            </div>
          ) : (
            <div className="dialog-connect">
              <button
                type="button"
                className="dialog-connect-btn"
                disabled={!!sshTerm}
                title="Open the SSH login in a terminal below — enter the password there."
                onClick={() => void startSshTerm()}
              >
                <span className="dialog-connect-btn-icon" aria-hidden="true">▶_</span>
                {sshTerm ? "SSH terminal open below" : "Open SSH login terminal"}
              </button>
              {sshTerm && !connected && (
                <button
                  type="button"
                  className="dialog-connect-btn"
                  title="If you've finished logging in above, connect now."
                  onClick={tryConnectNow}
                >
                  I've logged in — connect
                </button>
              )}
              {sshTerm && (
                <div className="dialog-connect-terminal">
                  <div className="dialog-connect-terminal-bar">
                    <span className="ssh-optional-hint">
                      Log in below — the pooled connection comes up once you're authenticated.
                    </span>
                    <button type="button" className="vpn-disconnect-btn" onClick={stopSsh}>
                      Disconnect
                    </button>
                  </div>
                  <div className="dialog-connect-terminal-host">
                    <TerminalView
                      id={sshTerm.id}
                      cmd=""
                      cwd=""
                      initialInput={sshTerm.command}
                      visible
                      focused
                      persistOnUnmount
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="project-dialog-actions">
          {sshStatus !== "off" && (
            <button
              type="button"
              onClick={() => {
                // Cancellation-aware teardown of both channels (abandons an
                // in-flight connect too, not just a live pool), then mirror it into
                // the projects store so a switch-away can't resurrect the pool.
                stopSsh();
                if (vpnConfig) stopVpn();
                disconnectRemote(project.id);
                close();
              }}
            >
              Disconnect
            </button>
          )}
          <button type="button" onClick={close}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
