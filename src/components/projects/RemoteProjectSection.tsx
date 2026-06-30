import { joinRemotePath } from "./scaffold";
import { TerminalView } from "../terminal/TerminalView";
import { ConnectionLog } from "../common/ConnectionLog";
import type { useRemoteSession } from "./useRemoteSession";

type RemoteSession = ReturnType<typeof useRemoteSession>;

/** Human-readable status shown when hovering the "Connect VPN" button, so the
 *  current tunnel state (and any failure reason) is reported without taking up
 *  permanent space in the dialog. */
function vpnStatusHint(
  status: RemoteSession["vpnStatus"],
  error: string,
  config: string,
): string {
  switch (status) {
    case "connecting":
      return "Bringing the OpenVPN tunnel up — pkexec may prompt for elevation…";
    case "connected":
      return "OpenVPN tunnel is up. Click to reconnect.";
    case "error":
      return error ? `VPN connection failed: ${error}` : "VPN connection failed. Click to retry.";
    default:
      return config
        ? "Bring the OpenVPN tunnel up now to reach a VPN-gated host."
        : "Select an OpenVPN config first.";
  }
}

/**
 * Presentational SSH + OpenVPN + remote-browser section of the project dialog.
 * All state and effects live in `useRemoteSession`; this component only renders
 * it and forwards events. `onClose` lets Escape in the fields dismiss the dialog.
 */
export function RemoteProjectSection({
  kind,
  safeName,
  onClose,
  onUseThisFolder,
  remote,
}: {
  kind: "new" | "import";
  safeName: string;
  onClose: () => void;
  onUseThisFolder: () => void;
  remote: RemoteSession;
}) {
  const {
    isRemoteProject,
    isRemote,
    headless,
    sshTooling,
    sshAddress,
    sshPassword,
    sshStatus,
    sshError,
    remoteBrowsePath,
    remoteEntries,
    remoteListBusy,
    remoteListError,
    remoteChosenPath,
    setRemoteChosenPath,
    vpnEnabled,
    setVpnEnabled,
    vpnConfig,
    vpnConfigs,
    selectVpnConfig,
    vpnPassword,
    setVpnPassword,
    vpnStatus,
    setVpnStatus,
    vpnError,
    setVpnError,
    vpnLog,
    vpnTerm,
    startVpnTerm,
    stopVpnTerm,
    sshTerm,
    startSshTerm,
    stopSshTerm,
    browseVpnConfig,
    connectVpn,
    onSshAddressChange,
    onSshPasswordChange,
    connectSsh,
    enterRemoteFolder,
    remoteGoUp,
  } = remote;

  return (
    <>
      {isRemoteProject && sshTooling && (() => {
        // Mount-free remote: no sshfs/FUSE needed. Only password-auth (sshpass)
        // and VPN-gated (openvpn/pkexec) hosts depend on extra tooling.
        const warnings: string[] = [];
        if (sshPassword && !sshTooling.sshpass) {
          warnings.push(
            "sshpass not found — password auth won't work. Install sshpass, or use SSH keys (leave the password blank).",
          );
        }
        if (vpnEnabled && !sshTooling.openvpn) {
          warnings.push(
            "openvpn/pkexec not found — VPN-gated hosts can't connect. Install openvpn and polkit.",
          );
        }
        if (warnings.length === 0) return null;
        return (
          <div className="ssh-tooling-warning" role="alert">
            {warnings.map((w) => (
              <div key={w}>⚠ {w}</div>
            ))}
          </div>
        );
      })()}

      {isRemoteProject && (
        <div className="ssh-connect-fields" role="group" aria-label="OpenVPN tunnel">
          <label className="remote-project-toggle vpn-toggle">
            <input
              type="checkbox"
              checked={vpnEnabled}
              onChange={(e) => {
                setVpnEnabled(e.target.checked);
                if (!e.target.checked) {
                  setVpnPassword("");
                  setVpnStatus("idle");
                  setVpnError("");
                }
              }}
            />
            Connect via OpenVPN
          </label>
          {vpnEnabled && (
            <>
              <label>
                OpenVPN config{" "}
                <span className="ssh-optional-hint">(copied into Eldrun on selection)</span>
                {vpnConfigs.length > 0 && (
                  <div className="folder-picker-row">
                    <select
                      className="ssh-address-input vpn-config-recent"
                      value={vpnConfigs.some((c) => c.path === vpnConfig) ? vpnConfig : ""}
                      title="Reuse a previously-used OpenVPN config"
                      onChange={(e) => {
                        if (e.target.value) selectVpnConfig(e.target.value);
                      }}
                    >
                      <option value="">Recently used…</option>
                      {vpnConfigs.map((c) => (
                        <option key={c.path} value={c.path} title={c.path}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="folder-picker-row">
                  <input
                    className="ssh-address-input"
                    readOnly
                    value={vpnConfig}
                    placeholder="No .ovpn selected"
                    title={vpnConfig}
                  />
                  <button type="button" onClick={() => void browseVpnConfig()}>
                    Browse…
                  </button>
                </div>
              </label>
              {headless ? (
                <>
                  <label>
                    VPN password{" "}
                    <span className="ssh-optional-hint">(not stored; asked again on activation)</span>
                    <div className="folder-picker-row">
                      <input
                        className="ssh-password-input"
                        type="password"
                        value={vpnPassword}
                        placeholder="VPN passphrase"
                        onChange={(e) => {
                          setVpnPassword(e.target.value);
                          if (vpnStatus !== "idle") setVpnStatus("idle");
                        }}
                      />
                      <button
                        type="button"
                        className={`vpn-connect-btn vpn-status-${vpnStatus}`}
                        disabled={!vpnConfig || vpnStatus === "connecting"}
                        title={vpnStatusHint(vpnStatus, vpnError, vpnConfig)}
                        onClick={() => void connectVpn()}
                      >
                        {vpnStatus === "connecting" && (
                          <span className="vpn-spinner" aria-hidden="true" />
                        )}
                        {vpnStatus === "connecting"
                          ? "Connecting…"
                          : vpnStatus === "connected"
                            ? "Connected"
                            : vpnStatus === "error"
                              ? "Retry VPN"
                              : "Connect VPN"}
                      </button>
                    </div>
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
                    disabled={!vpnConfig || !!vpnTerm}
                    title={
                      vpnConfig
                        ? "Bring the OpenVPN tunnel up in a terminal below — enter the passphrase there. It stays up for the new project."
                        : "Select an OpenVPN config first."
                    }
                    onClick={() => void startVpnTerm()}
                  >
                    <span className="dialog-connect-btn-icon" aria-hidden="true">▶_</span>
                    {vpnTerm ? "VPN terminal open below" : "Open VPN login terminal"}
                  </button>
                  {!vpnTerm && (
                    <div className="ssh-optional-hint">
                      Click above to open a terminal here — enter the passphrase there.
                      Eldrun never handles it; the tunnel stays up for the new project.
                    </div>
                  )}
                  {vpnTerm && (
                    <div className="dialog-connect-terminal">
                      <div className="dialog-connect-terminal-bar">
                        <span className="ssh-optional-hint">
                          Authenticate the tunnel below — it keeps running for the new
                          project after you close this dialog.
                        </span>
                        <button
                          type="button"
                          className="vpn-disconnect-btn"
                          onClick={() => stopVpnTerm()}
                        >
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
                  {vpnError && <div className="project-dialog-error">{vpnError}</div>}
                </div>
              )}
            </>
          )}
          <label>
            SSH address
            <input
              className="ssh-address-input"
              value={sshAddress}
              placeholder="user@host or host:2222"
              onChange={(e) => onSshAddressChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                  e.preventDefault();
                  void connectSsh();
                }
                if (e.key === "Escape") onClose();
              }}
            />
          </label>
          {headless ? (
            <>
              <label>
                Password{" "}
                <span className="ssh-optional-hint">
                  (not stored; blank uses SSH key)
                </span>
                <div className="folder-picker-row">
                  <input
                    className="ssh-password-input"
                    type="password"
                    value={sshPassword}
                    placeholder="leave empty for key/agent auth"
                    onChange={(e) => onSshPasswordChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                        e.preventDefault();
                        void connectSsh();
                      }
                      if (e.key === "Escape") onClose();
                    }}
                  />
                  <button
                    type="button"
                    disabled={!sshAddress.trim() || sshStatus === "connecting"}
                    onClick={() => void connectSsh()}
                  >
                    {sshStatus === "connecting"
                      ? "Connecting..."
                      : sshStatus === "connected"
                        ? "Connected"
                        : "Connect"}
                  </button>
                </div>
              </label>
              {sshStatus === "error" && sshError && (
                <div className="project-dialog-error">{sshError}</div>
              )}
            </>
          ) : (
            <>
              <label>
                Remote path{" "}
                <span className="ssh-optional-hint">
                  {kind === "new"
                    ? "(parent folder; the project is created inside it)"
                    : "(absolute path of the existing project)"}
                </span>
                <input
                  className="ssh-address-input"
                  value={remoteChosenPath}
                  placeholder="/home/user/projects"
                  onChange={(e) => setRemoteChosenPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                  }}
                />
              </label>
              <div className="dialog-connect">
                <button
                  type="button"
                  className="dialog-connect-btn"
                  disabled={!sshAddress.trim() || !!sshTerm}
                  title="Open the SSH login in a terminal below — enter any password there. The login stays up for the new project."
                  onClick={() => void startSshTerm()}
                >
                  <span className="dialog-connect-btn-icon" aria-hidden="true">▶_</span>
                  {sshTerm ? "SSH terminal open below" : "Open SSH login terminal"}
                </button>
                {!sshTerm && (
                  <div className="ssh-optional-hint">
                    Click above to open a terminal here — enter any password there.
                    Eldrun never handles it; the login stays up for the new project.
                  </div>
                )}
                {sshTerm && (
                  <div className="dialog-connect-terminal">
                    <div className="dialog-connect-terminal-bar">
                      <span className="ssh-optional-hint">
                        Log in below — the session keeps running for the new project
                        after you close this dialog.
                      </span>
                      <button
                        type="button"
                        className="vpn-disconnect-btn"
                        onClick={() => stopSshTerm()}
                      >
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
                {sshStatus === "error" && sshError && (
                  <div className="project-dialog-error">{sshError}</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {isRemote && (
        <div className="remote-browser" role="group" aria-label="Remote folder browser">
          <div className="remote-browser-header">
            <button type="button" className="remote-up-btn" onClick={remoteGoUp} title="Go up">
              ..
            </button>
            <span className="remote-breadcrumb" title={remoteBrowsePath}>
              {remoteBrowsePath || "/"}
            </span>
            <button type="button" onClick={onUseThisFolder}>
              Use this folder
            </button>
          </div>
          <div className="remote-list">
            {remoteListBusy && <div className="scaffold-empty">Listing...</div>}
            {!remoteListBusy && remoteListError && (
              <div className="project-dialog-error">{remoteListError}</div>
            )}
            {!remoteListBusy && !remoteListError && remoteEntries.length === 0 && (
              <div className="scaffold-empty">Empty folder.</div>
            )}
            {!remoteListBusy &&
              !remoteListError &&
              remoteEntries.map((entry) => (
                <div
                  key={entry.name}
                  className={`remote-entry ${entry.is_dir ? "is-dir" : "is-file"}`}
                  role={entry.is_dir ? "button" : undefined}
                  tabIndex={entry.is_dir ? 0 : undefined}
                  onClick={() => enterRemoteFolder(entry)}
                  onKeyDown={(e) => {
                    if (entry.is_dir && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      enterRemoteFolder(entry);
                    }
                  }}
                >
                  <span className="remote-entry-icon">{entry.is_dir ? "[ ]" : "·"}</span>
                  <span className="remote-entry-name">{entry.name}</span>
                </div>
              ))}
          </div>
          <div className="remote-chosen">
            {remoteChosenPath
              ? kind === "new"
                ? `Will create: ${joinRemotePath(remoteChosenPath, safeName || "<name>")}`
                : `Selected: ${remoteChosenPath}`
              : "Browse to a folder, then click “Use this folder”."}
          </div>
        </div>
      )}
    </>
  );
}
