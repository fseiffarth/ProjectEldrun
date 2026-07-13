import { useState } from "react";
import { joinRemotePath } from "./scaffold";
import { fileIcon, folderIcon } from "../../lib/viewers/fileUtils";
import { TerminalView } from "../terminal/TerminalView";
import { ConnectionLog } from "../common/ConnectionLog";
import { ConnLamp } from "../common/ConnLamp";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import type { ConnState } from "../../stores/remoteStatus";
import type { useRemoteSession } from "./useRemoteSession";

type RemoteSession = ReturnType<typeof useRemoteSession>;

/** Extension (".py", ".md", …) of a remote listing entry, for picking its
 *  file-type icon the same way the right-hand file tree does. A leading-dot
 *  name (e.g. ".gitignore") has no extension, so it falls back to the generic
 *  file icon. */
function remoteEntryExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : null;
}

/** Map the dialog's connection status (`idle|connecting|connected|error`) to a
 *  lamp state (`off|connecting|connected|error`). */
function lampOf(status: RemoteSession["sshStatus"]): ConnState {
  return status === "idle" ? "off" : status;
}

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
 *
 * The remote flow is stepped: step "connect" (SSH + OpenVPN, each with a lamp)
 * → step "browse" (the live remote folder picker) → step "details" (handled by
 * the dialog body). Windows non-headless has no ControlMaster to browse over, so
 * it skips "browse" and types the remote path in the connect step instead.
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
    headless,
    winManual,
    step,
    tryBrowseNow,
    sshTooling,
    sshAddress,
    sshAddresses,
    sshPassword,
    sshStatus,
    sshError,
    remoteBrowsePath,
    remoteEntries,
    remoteListBusy,
    remoteListError,
    remoteChosenPath,
    setRemoteChosenPath,
    remotePaths,
    jumpToRemotePath,
    vpnEnabled,
    setVpnEnabled,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    vpnNeedsKeyPassphrase,
    selectVpnConfig,
    vpnPassword,
    setVpnPassword,
    vpnKeyPassphrase,
    setVpnKeyPassphrase,
    vpnStatus,
    setVpnStatus,
    vpnError,
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
    createRemoteFolder,
  } = remote;

  // Inline "new folder" entry within the remote browser (local to this view).
  const [newFolderName, setNewFolderName] = useState("");
  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    void createRemoteFolder(name);
    setNewFolderName("");
  };

  if (!isRemoteProject) return null;

  // Rendered beside whichever credential field comes last, so the button always
  // sits at the end of the VPN form rather than mid-way through it.
  const vpnConnectButton = (
    <button
      type="button"
      className={`vpn-connect-btn vpn-status-${vpnStatus}`}
      disabled={!vpnConfig || vpnStatus === "connecting"}
      title={vpnStatusHint(vpnStatus, vpnError, vpnConfig)}
      onClick={() => void connectVpn()}
    >
      {vpnStatus === "connecting" && <span className="vpn-spinner" aria-hidden="true" />}
      {vpnStatus === "connecting"
        ? "Connecting…"
        : vpnStatus === "connected"
          ? "Connected"
          : vpnStatus === "error"
            ? "Retry VPN"
            : "Connect VPN"}
    </button>
  );

  // The non-headless login authenticates in a terminal, so its lamp tracks the
  // readiness poll (connecting while the master comes up, green once browsable).
  const sshLamp: ConnState = winManual ? "off" : lampOf(sshStatus);

  return (
    <>
      <div className="remote-steps" role="list" aria-label="Remote project steps">
        <span className={`remote-step${step === "connect" ? " is-active" : ""}`} role="listitem">
          1 Connect
        </span>
        {!winManual && (
          <span className={`remote-step${step === "browse" ? " is-active" : ""}`} role="listitem">
            2 Browse
          </span>
        )}
        <span className={`remote-step${step === "details" ? " is-active" : ""}`} role="listitem">
          {winManual ? "2" : "3"} Details
        </span>
      </div>

      {step === "connect" && (
        <>
          {sshTooling &&
            (() => {
              // Mount-free remote: no sshfs/FUSE needed. Only password auth and
              // VPN-gated (openvpn/pkexec) hosts depend on extra tooling. Password
              // auth rides OpenSSH's own SSH_ASKPASS everywhere; on Windows that
              // needs OpenSSH ≥ 8.4, with sshpass as the legacy fallback — the
              // warning fires only when neither is available. The VPN warning fires
              // only once a config is selected, since OpenVPN is optional.
              const warnings: string[] = [];
              if (sshPassword && !sshTooling.password_auth) {
                warnings.push(
                  "Password auth needs OpenSSH 8.4+ or sshpass — update OpenSSH or install sshpass, or use SSH keys (leave the password blank).",
                );
              }
              if (vpnEnabled && vpnConfig && !sshTooling.openvpn) {
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

          <div className="ssh-connect-fields" role="group" aria-label="OpenVPN tunnel">
            {/* OpenVPN is opt-in (default off): reaching the host directly needs
                no tunnel when you're already on the right network. Flip the toggle
                only for a VPN-gated host; the config + connect UI stays collapsed
                otherwise, and no VPN config is stored on the project. */}
            <label className={`toggle-card${vpnEnabled ? " is-on" : ""}`}>
              <span className="toggle-card-body">
                <span className="toggle-card-title">
                  <ConnLamp status={lampOf(vpnStatus)} label="OpenVPN" />
                  Connect via OpenVPN
                </span>
                <span className="toggle-card-desc">
                  Only needed for a VPN-gated host — leave off when you're already on
                  the right network.
                  <br />
                  The tunnel is <strong>machine-wide</strong>: while it is up, this
                  computer's traffic routes through it — your browser too, not just
                  Eldrun.
                </span>
              </span>
              <span className="eld-switch">
                <input
                  type="checkbox"
                  checked={vpnEnabled}
                  onChange={(e) => setVpnEnabled(e.target.checked)}
                />
                <span className="eld-switch-track" aria-hidden="true" />
              </span>
            </label>
            {vpnEnabled && (
            <div className="vpn-details">
                <label>
                  OpenVPN config{" "}
                  <span className="ssh-optional-hint">(copied into Eldrun on selection)</span>
                  {vpnConfigs.length > 0 && (
                    <div className="folder-picker-row">
                      <Dropdown
                        className="dropdown-block vpn-config-recent"
                        value={vpnConfigs.some((c) => c.path === vpnConfig) ? vpnConfig : ""}
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
                    {vpnNeeds.username && (
                      <label>
                        VPN username{" "}
                        <span className="ssh-optional-hint">(stored with the project)</span>
                        <input
                          className="ssh-password-input"
                          type="text"
                          value={vpnUsername}
                          placeholder="OpenVPN account username"
                          onChange={(e) => {
                            setVpnUsername(e.target.value);
                            if (vpnStatus !== "idle") setVpnStatus("idle");
                          }}
                        />
                      </label>
                    )}
                    <label>
                      {vpnNeeds.username ? "VPN password" : "VPN passphrase"}{" "}
                      <span className="ssh-optional-hint">(not stored; asked again on activation)</span>
                      <div className="folder-picker-row">
                        <PasswordInput
                          className="ssh-password-input"
                          value={vpnPassword}
                          placeholder={vpnNeeds.username ? "OpenVPN account password" : "VPN passphrase"}
                          onChange={(e) => {
                            setVpnPassword(e.target.value);
                            if (vpnStatus !== "idle") setVpnStatus("idle");
                          }}
                        />
                        {/* The connect button sits with the *last* credential field, so
                            a config that also needs a key passphrase moves it below. */}
                        {!vpnNeedsKeyPassphrase && vpnConnectButton}
                      </div>
                    </label>
                    {vpnNeedsKeyPassphrase && (
                      <label>
                        Private key passphrase{" "}
                        <span className="ssh-optional-hint">(not stored; asked again on activation)</span>
                        <div className="folder-picker-row">
                          <PasswordInput
                            className="ssh-password-input"
                            value={vpnKeyPassphrase}
                            placeholder="Passphrase for the config's encrypted key"
                            onChange={(e) => {
                              setVpnKeyPassphrase(e.target.value);
                              if (vpnStatus !== "idle") setVpnStatus("idle");
                            }}
                          />
                          {vpnConnectButton}
                        </div>
                      </label>
                    )}
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
              </div>
            )}
            <label>
              <span className="remote-field-label">
                <ConnLamp status={sshLamp} label="SSH" />
                SSH address
              </span>
              {sshAddresses.length > 0 && (
                <div className="folder-picker-row">
                  <Dropdown
                    className="dropdown-block vpn-config-recent"
                    value={sshAddresses.includes(sshAddress) ? sshAddress : ""}
                    placeholder="Recently used…"
                    title="Reuse a previously-used SSH address"
                    onChange={(v) => {
                      if (v) onSshAddressChange(v);
                    }}
                    options={sshAddresses.map((addr) => ({ value: addr, label: addr }))}
                  />
                </div>
              )}
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
                    <PasswordInput
                      className="ssh-password-input"
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
                {winManual && (
                  <label>
                    Remote path{" "}
                    <span className="ssh-optional-hint">
                      {kind === "new"
                        ? "(parent folder; the project is created inside it)"
                        : "(absolute path of the existing project)"}
                    </span>
                    {remotePaths.length > 0 && (
                      <div className="folder-picker-row">
                        <Dropdown
                          className="dropdown-block vpn-config-recent"
                          value={remotePaths.includes(remoteChosenPath) ? remoteChosenPath : ""}
                          placeholder="Recently used…"
                          title="Reuse a previously-used remote path for this host"
                          onChange={(v) => {
                            if (v) setRemoteChosenPath(v);
                          }}
                          options={remotePaths.map((p) => ({ value: p, label: p }))}
                        />
                      </div>
                    )}
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
                )}
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
                  {!winManual && sshTerm && sshStatus !== "connected" && (
                    <button
                      type="button"
                      className="dialog-connect-btn"
                      title="If you've finished logging in above, browse the remote tree now."
                      onClick={() => tryBrowseNow()}
                    >
                      I've logged in — browse
                    </button>
                  )}
                  {!sshTerm && (
                    <div className="ssh-optional-hint">
                      Click above to open a terminal here — enter any password there.
                      Eldrun never handles it; the login stays up for the new project.
                      {!winManual && " Once you're logged in, the remote tree opens for browsing."}
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
        </>
      )}

      {step === "browse" && !winManual && (
        <div className="remote-browser" role="group" aria-label="Remote folder browser">
          <div className="remote-browser-header">
            <button type="button" className="remote-up-btn" onClick={remoteGoUp} title="Go up">
              ..
            </button>
            <span className="remote-breadcrumb" title={remoteBrowsePath}>
              {remoteBrowsePath || "/"}
            </span>
            {remotePaths.length > 0 && (
              <Dropdown
                className="vpn-config-recent"
                value=""
                placeholder="Recently used…"
                title="Jump to a previously-used remote path for this host"
                onChange={(v) => {
                  if (v) jumpToRemotePath(v);
                }}
                options={remotePaths.map((p) => ({ value: p, label: p }))}
              />
            )}
            <button type="button" onClick={onUseThisFolder}>
              Use this folder
            </button>
          </div>
          <div className="remote-newfolder">
            <input
              type="text"
              className="remote-newfolder-input"
              placeholder="New folder name…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitNewFolder();
                }
              }}
              disabled={remoteListBusy}
            />
            <button
              type="button"
              onClick={submitNewFolder}
              disabled={remoteListBusy || !newFolderName.trim()}
              title="Create a new folder here"
            >
              + Add folder
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
                  <span className="remote-entry-icon file-icon">
                    {entry.is_dir ? folderIcon() : fileIcon(remoteEntryExt(entry.name))}
                  </span>
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
