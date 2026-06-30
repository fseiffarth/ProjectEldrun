import { invoke } from "@tauri-apps/api/core";
import { joinRemotePath } from "./scaffold";
import type { useRemoteSession } from "./useRemoteSession";

type RemoteSession = ReturnType<typeof useRemoteSession>;

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
    sshfsGuide,
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
    vpnPassword,
    setVpnPassword,
    vpnStatus,
    setVpnStatus,
    vpnError,
    setVpnError,
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
        const sshfsMissing = !sshTooling.sshfs;
        const warnings: string[] = [];
        if (sshfsMissing) {
          warnings.push("sshfs not found — remote projects can't be mounted.");
        }
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
            {sshfsMissing && sshfsGuide && (
              <div className="sshfs-install">
                <div className="sshfs-install-instruction">{sshfsGuide.instruction}</div>
                {sshfsGuide.commands.length > 0 && (
                  <div className="sshfs-install-commands">
                    {sshfsGuide.commands.map((cmd) => (
                      <code key={cmd} className="sshfs-install-cmd">
                        <span className="sshfs-install-cmd-text">{cmd}</span>
                        <button
                          type="button"
                          className="sshfs-install-copy"
                          title="Copy command"
                          onClick={() => void navigator.clipboard?.writeText(cmd)}
                        >
                          Copy
                        </button>
                      </code>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="sshfs-install-guide-btn"
                  onClick={() =>
                    void invoke("open_external_url", { url: sshfsGuide.url }).catch(() => {})
                  }
                >
                  Open install guide
                </button>
              </div>
            )}
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
                        disabled={!vpnConfig || vpnStatus === "connecting"}
                        onClick={() => void connectVpn()}
                      >
                        {vpnStatus === "connecting"
                          ? "Connecting…"
                          : vpnStatus === "connected"
                            ? "Connected"
                            : "Connect VPN"}
                      </button>
                    </div>
                  </label>
                  {vpnStatus === "error" && vpnError && (
                    <div className="project-dialog-error">{vpnError}</div>
                  )}
                </>
              ) : (
                <div className="ssh-optional-hint">
                  The tunnel opens in the Eldrun root terminal on activation — enter
                  the passphrase there.
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
              <span className="ssh-optional-hint">
                You log in (and enter any password) in the Eldrun root terminal when
                the project is activated — Eldrun never handles it.
              </span>
            </label>
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
