import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { Toggle } from "../common/Toggle";
import { ConnLamp } from "../common/ConnLamp";
import { ConnectionLog } from "../common/ConnectionLog";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useRemoteReconnect } from "./useRemoteReconnect";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useProjectsStore, disconnectRemote } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useVpnSectionVisible } from "../../stores/vpnStatus";
import { VpnTunnelUpNotice } from "../common/VpnTunnelUpNotice";
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
  const hostId = useConnectDialogStore((s) => s.hostId);
  const project = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  if (!projectId || !project?.remote) return null;
  // Multi-host remote: the modal targets the primary or a worker host. Resolve the
  // selected worker (if any) so its own spec drives the connect + lamp.
  const worker =
    hostId && hostId !== "primary"
      ? project.compute_hosts?.find((h) => h.id === hostId)
      : undefined;
  return (
    <RemoteConnectDialogInner key={`${project.id}:${hostId ?? "primary"}`} project={project} host={worker} />
  );
}

function RemoteConnectDialogInner({
  project,
  host,
}: {
  project: ProjectEntry;
  host?: import("../../types").ComputeHost;
}) {
  const close = useConnectDialogStore((s) => s.close);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  const {
    sshStatus,
    vpnStatus,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    vpnNeedsKeyPassphrase,
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
    autoConnect,
    autoConnectEligible,
    setAutoConnect,
    setWorkerLabel,
    connectVpnHeadless,
    connectSshHeadless,
    forgetPasswords,
    forgetSshPassword,
    forgetVpnPassword,
  } = useRemoteReconnect(project, host);

  // Editable name: for a worker its `label`, for the primary the project name.
  // Seeded from the current value and re-synced when the store's copy changes (a
  // rename commits into the store); committed on blur / Enter so a write fires once,
  // not per keystroke. The two differ on blank: a worker label may be cleared (it
  // then falls back to the host), but a project name may not — the backend rejects
  // it, so we restore the field instead.
  const currentName = host ? host.label ?? "" : project.name;
  const [nameDraft, setNameDraft] = useState(currentName);
  useEffect(() => setNameDraft(currentName), [currentName]);
  const commitName = () => {
    const next = nameDraft.trim();
    if (next === currentName) return;
    if (host) {
      setWorkerLabel(next);
    } else if (next) {
      void useProjectsStore.getState().renameProject(project.id, next).catch(() => {});
    } else {
      setNameDraft(currentName); // project name can't be blank — undo the edit
    }
  };

  // The primary's own machine name (`remote.label`) — distinct from the project
  // name above: a project can be renamed without touching which name identifies
  // its primary host across the multi-host surfaces (System Monitor's source
  // picker, the pill's connection lamps). Worker-only equivalent is `host.label`,
  // already covered by the "Name" field above since a worker has no project name
  // of its own to conflict with it.
  const currentMachineLabel = host ? "" : project.remote?.label ?? "";
  const [machineDraft, setMachineDraft] = useState(currentMachineLabel);

  // "Disconnect & end jobs": the *active* teardown — kills every running tmux
  // session on this host before the ordinary disconnect, distinct from plain
  // Disconnect which leaves them alive to reattach. Two-step confirm (this arms
  // it) because killing jobs can't be undone. Target is the worker's own spec or
  // the primary's `remote`.
  const [killArm, setKillArm] = useState(false);
  const killTarget = host
    ? { user: host.user, host: host.host, port: host.port }
    : {
        user: project.remote?.user,
        host: project.remote?.host ?? "",
        port: project.remote?.port,
      };
  useEffect(() => setMachineDraft(currentMachineLabel), [currentMachineLabel]);
  const commitMachineLabel = () => {
    const next = machineDraft.trim();
    if (next === currentMachineLabel) return;
    setWorkerLabel(next);
  };

  const [sshPassword, setSshPassword] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  // Only a separate secret when the config has BOTH an `auth-user-pass` account and
  // an encrypted key — OpenVPN prompts for the two independently. For a key-only
  // config `vpnPassword` already is the key passphrase, and this field stays hidden.
  const [vpnKeyPassphrase, setVpnKeyPassphrase] = useState("");
  // "Connect via OpenVPN" opt-in, default OFF: this project is VPN-gated, but on
  // the right network the tunnel is unnecessary and SSH connects directly. The
  // VPN fields stay collapsed until the user turns this on — *unless* a tunnel is
  // already up (or coming up) for this project, in which case the section opens
  // itself. A live tunnel must never hide behind a collapsed section: that is
  // exactly the state where the user needs it, to bring the tunnel back down.
  const [vpnEnabled, setVpnEnabled] = useState(vpnStatus !== "off");
  useEffect(() => {
    if (vpnStatus === "connecting" || vpnStatus === "connected") setVpnEnabled(true);
  }, [vpnStatus]);
  // "Save password" opt-in (default off). Pre-checked when a credential is
  // already saved for this target, so it reflects the true keychain state.
  const [sshRemember, setSshRemember] = useState(false);
  const [vpnRemember, setVpnRemember] = useState(false);
  useEffect(() => setSshRemember(sshSaved), [sshSaved]);
  useEffect(() => setVpnRemember(vpnSaved), [vpnSaved]);
  const localMirror = resolveLocalMirror(project);

  // Re-open the config picker for a project that already has one ("Change…").
  // The stored config is remembered, but it must stay swappable: a host can move
  // behind a different VPN, or the first pick can simply have been the wrong file.
  const [changingVpnConfig, setChangingVpnConfig] = useState(false);
  const showVpnPicker = vpnEnabled && (!vpnConfig || changingVpnConfig);
  // Prefer the recents-list name (the stored copy's file name); fall back to the
  // path's own basename for a config that isn't in the list yet.
  const vpnConfigName = vpnConfig
    ? vpnConfigs.find((c) => c.path === vpnConfig)?.name ??
      vpnConfig.split(/[\\/]/).pop() ??
      vpnConfig
    : "";

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
  // The tunnel is up or on its way — every VPN field/button is locked while so.
  const vpnBusy = vpnStatus === "connecting" || vpnStatus === "connected";
  // A tunnel is machine-wide, so once *any* config is live there's nothing left for
  // this project's OpenVPN section to offer — except when it's THIS project's own
  // attempt that made it live, in which case its controls (log, Stop/Disconnect)
  // must stay reachable here. `vpnBusy` already mirrors that via the machine store.
  const showVpnSection = useVpnSectionVisible(vpnBusy);
  // One submit for the whole VPN form: the fields are separate prompts OpenVPN
  // raises, but they're answered in a single connect.
  const submitVpn = () => void connectVpnHeadless(vpnPassword, vpnKeyPassphrase, vpnRemember);

  return createPortal(
    <div className="modal-backdrop modal-backdrop-elevated" onMouseDown={close}>
      <div
        className="project-dialog dialog-framed remote-connect-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {host
              ? `Connect worker · ${host.label || host.host}`
              : "Connect remote project"}
          </h2>
          <button type="button" className="dialog-close-btn" onClick={close}>×</button>
        </div>

        <div className="dialog-scroll">
        <div className="remote-connect-target">
          <div className="remote-connect-location">
            <span className="remote-connect-location-label">Remote</span>
            <span
              className="remote-connect-location-path"
              title={host ? formatRemoteTarget(host) : project.remote ? formatRemoteTarget(project.remote) : undefined}
            >
              {host ? formatRemoteTarget(host) : project.remote && formatRemoteTarget(project.remote)}
            </span>
          </div>
          {/* A worker is code-read-only (one-way sync, outputs stay on it) — it
              has no local mirror to show; only the primary does. */}
          {!host && localMirror && (
            <div className="remote-connect-location">
              <span className="remote-connect-location-label">Local</span>
              <span className="remote-connect-location-path" title={localMirror}>{localMirror}</span>
            </div>
          )}
        </div>

        {/* Rename here — a worker's name was only settable once (at add time), and the
            primary's project name was only editable elsewhere. Blank clears a worker
            label (it falls back to the host); a project name can't be blank. */}
        <label className="remote-connect-field remote-worker-name">
          <span className="remote-machine-add-label">
            Name
            <UntestedTag />
          </span>
          <input
            type="text"
            value={nameDraft}
            placeholder={host ? host.host : "Project name"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="ssh-optional-hint">
            {host
              ? "Shown on the pill and in “Remote machines”. Leave blank to use the host name."
              : "The project name, shown on its pill and across Eldrun."}
          </span>
        </label>

        {/* The primary's own machine name — worker rows already get this via the
            "Name" field above (a worker has no project name to conflict with it);
            the primary needs a second field since its "Name" above is the project
            name. Optional: blank falls back to the bare host everywhere hosts are
            listed side by side (System Monitor, pill lamps, "Remote machines"). */}
        {!host && (
          <label className="remote-connect-field remote-worker-name">
            <span className="remote-machine-add-label">
              Machine name
              <UntestedTag />
            </span>
            <input
              type="text"
              value={machineDraft}
              placeholder={project.remote?.host ?? ""}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setMachineDraft(e.target.value)}
              onBlur={commitMachineLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="ssh-optional-hint">
              Identifies this machine in the System Monitor and connection lamps
              when the project has more than one host. Leave blank to use the host
              name.
            </span>
          </label>
        )}

        {/* ── OpenVPN (always offered; opt-in, default off) ─────────────────────
            Shown for every remote project, not only ones that stored a config at
            create time: a project made on a no-VPN network may need a tunnel when
            reconnected from a VPN-gated one. With no config yet, enabling the
            toggle reveals a picker; the choice is persisted to the project.
            But once *any* tunnel is already up machine-wide, this whole section is
            redundant — the routing this project needs is already there — so it
            collapses to a one-line status and the dialog goes straight to SSH. */}
        {!showVpnSection && (
          <div className="remote-reconnect-section">
            <VpnTunnelUpNotice />
          </div>
        )}
        {showVpnSection && (
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
                disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                onChange={(e) => setVpnEnabled(e.target.checked)}
              />
              <span className="eld-switch-track" aria-hidden="true" />
            </span>
          </label>
          {/* The config in use, always visible once one is stored — with the way
              back to the picker. Chosen once, remembered, but never locked in. */}
          {vpnEnabled && vpnConfig && (
            <div className="vpn-config-current">
              <span className="remote-connect-location-label">Config</span>
              <span className="vpn-config-current-name" title={vpnConfig}>{vpnConfigName}</span>
              <button
                type="button"
                className="vpn-config-change-btn"
                disabled={vpnBusy || changingVpnConfig}
                title="Pick a different OpenVPN config for this project."
                onClick={() => setChangingVpnConfig(true)}
              >
                Change…
              </button>
            </div>
          )}
          {showVpnPicker && (
            <div className="vpn-config-pick">
              <span className="ssh-optional-hint">
                {vpnConfig
                  ? "Pick the OpenVPN config to use instead — the new choice replaces the saved one."
                  : "Choose the OpenVPN config for this host — it's saved to the project so you only pick it once."}
              </span>
              {vpnConfigs.length > 0 && (
                <div className="folder-picker-row">
                  <Dropdown
                    className="dropdown-block vpn-config-recent"
                    value=""
                    placeholder="Recently used…"
                    title="Reuse a previously-used OpenVPN config"
                    onChange={(v) => {
                      if (!v) return;
                      selectVpnConfig(v);
                      setChangingVpnConfig(false);
                    }}
                    options={vpnConfigs.map((c) => ({ value: c.path, label: c.name }))}
                  />
                </div>
              )}
              <div className="folder-picker-row">
                <button
                  type="button"
                  className="dialog-connect-btn"
                  onClick={async () => {
                    await browseVpnConfig();
                    setChangingVpnConfig(false);
                  }}
                >
                  Choose .ovpn config…
                </button>
                {/* Only an escape hatch when there is a config to fall back to. */}
                {vpnConfig && (
                  <button type="button" onClick={() => setChangingVpnConfig(false)}>
                    Cancel
                  </button>
                )}
              </div>
              {vpnStatus === "error" && vpnError && (
                <div className="project-dialog-error">{vpnError}</div>
              )}
            </div>
          )}
          {vpnEnabled && vpnConfig && !changingVpnConfig && (headless ? (
              <>
                {vpnNeeds.username && (
                  <label className="remote-connect-field">
                    VPN username
                    <input
                      type="text"
                      value={vpnUsername}
                      autoComplete="off"
                      placeholder="OpenVPN account username…"
                      disabled={vpnBusy}
                      onChange={(e) => setVpnUsername(e.target.value)}
                    />
                  </label>
                )}
                <label className="remote-connect-field">
                  {vpnNeeds.username ? "VPN password" : "VPN passphrase"}
                  <PasswordInput
                    value={vpnPassword}
                    autoComplete="off"
                    // A saved secret can't be pre-filled — it never leaves the
                    // backend — so say so: blank means "use the saved one".
                    placeholder={
                      vpnSaved
                        ? "Using saved passphrase — leave blank"
                        : vpnNeeds.username
                          ? "OpenVPN account password…"
                          : "OpenVPN passphrase…"
                    }
                    disabled={vpnBusy}
                    onChange={(e) => setVpnPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitVpn();
                    }}
                  />
                </label>
                {vpnNeedsKeyPassphrase && (
                  <label className="remote-connect-field">
                    Private key passphrase
                    <PasswordInput
                      value={vpnKeyPassphrase}
                      autoComplete="off"
                      placeholder={
                        vpnSaved
                          ? "Using saved passphrase — leave blank"
                          : "Passphrase for the config's encrypted key…"
                      }
                      disabled={vpnBusy}
                      onChange={(e) => setVpnKeyPassphrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitVpn();
                      }}
                    />
                    <span className="ssh-optional-hint">
                      This config's private key is encrypted, so OpenVPN asks for its
                      passphrase separately from your account password.
                    </span>
                  </label>
                )}
                <div className="remote-connect-field">
                  {!vpnBusy && (
                    <button
                      type="button"
                      className="dialog-connect-btn"
                      onClick={submitVpn}
                    >
                      {vpnStatus === "error" ? "Retry VPN" : "Connect VPN"}
                    </button>
                  )}
                  {/* The tunnel's own teardown, independent of SSH: a VPN that came
                      up while SSH still fails has to be droppable on its own (retry
                      on another network, swap the config, or just get off the VPN). */}
                  {vpnBusy && (
                    <button
                      type="button"
                      className="vpn-disconnect-btn"
                      title={
                        vpnStatus === "connected"
                          ? "Bring this OpenVPN tunnel down. The SSH connection is left as it is."
                          : "Stop this VPN connection attempt and reset the tunnel state."
                      }
                      onClick={stopVpn}
                    >
                      {vpnStatus === "connected" ? "Disconnect VPN" : "Stop"}
                    </button>
                  )}
                </div>
                <label className="remote-connect-remember">
                  <Toggle
                    size="sm"
                    checked={vpnRemember}
                    disabled={vpnBusy}
                    onChange={(e) => {
                      setVpnRemember(e.target.checked);
                      // Unticking is a request to *not* have the secret stored —
                      // honour it now, not at the next connect (which may never come).
                      if (!e.target.checked && vpnSaved) void forgetVpnPassword();
                    }}
                  />
                  {vpnNeedsKeyPassphrase ? "Save VPN credentials" : "Save passphrase"}
                  <span className="ssh-optional-hint">
                    {vpnSaved
                      ? "saved in your OS keychain — turn off to delete it"
                      : "stored securely in your OS keychain"}
                  </span>
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
                      {/* A re-adopted terminal (tunnel still running from an earlier
                          open of this dialog) attaches to its live PTY instead of
                          spawning a second one — and so must not re-type the command. */}
                      <TerminalView
                        id={vpnTerm.id}
                        cmd=""
                        cwd=""
                        initialInput={vpnTerm.adopted ? undefined : vpnTerm.command}
                        attachOnly={vpnTerm.adopted}
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
        )}

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
                  // The saved password stays in the keychain (the backend never hands
                  // it back), so the field can't be pre-filled. Blank + Connect uses it.
                  placeholder={sshSaved ? "Using saved password — leave blank" : "SSH password…"}
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
                <Toggle
                  size="sm"
                  checked={sshRemember}
                  disabled={connecting || connected}
                  onChange={(e) => {
                    setSshRemember(e.target.checked);
                    // Untick = delete it now. Waiting for the next connect to clear it
                    // leaves the password in the keychain the user just asked to drop.
                    if (!e.target.checked && sshSaved) void forgetSshPassword();
                  }}
                />
                Save password
                <span className="ssh-optional-hint">
                  {sshSaved
                    ? "saved in your OS keychain — turn off to delete it"
                    : "stored securely in your OS keychain"}
                </span>
              </label>
              <label
                className="remote-connect-remember"
                title={
                  autoConnectEligible
                    ? "Connect this project by itself on launch and when you switch to it. It never asks for anything: it goes straight in when the host is reachable, and brings the VPN up only when it isn't. Note that bringing the VPN up reroutes this whole computer's traffic — with auto-connect that happens without a prompt, so watch the header's VPN indicator."
                    : "Save the SSH password (or use key authentication) first — auto-connect is only offered when connecting needs nothing from you."
                }
              >
                <Toggle
                  size="sm"
                  checked={autoConnect}
                  disabled={!autoConnectEligible}
                  onChange={(e) => setAutoConnect(e.target.checked)}
                />
                Auto-connect
                <span className="ssh-optional-hint">
                  {autoConnectEligible
                    ? "on launch and on switch — VPN only if the host isn’t reachable directly"
                    : "needs a saved password or key authentication"}
                </span>
              </label>
              {/* Auto-connect never prompts — so if it can reach for the VPN, this
                  line is the user's only chance to know that launching Eldrun may
                  reroute their machine before they've clicked anything. */}
              {autoConnectEligible && autoConnect && vpnEnabled && (
                <div className="remote-connect-vpn-warning">
                  Heads up: if the host isn’t reachable directly, auto-connect brings
                  the VPN up <strong>without asking</strong> — rerouting this
                  computer’s traffic on launch. The header’s VPN indicator shows when
                  a tunnel is up, and can bring it down.
                </div>
              )}
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
                      initialInput={sshTerm.adopted ? undefined : sshTerm.command}
                      attachOnly={sshTerm.adopted}
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
          {/* Shown whenever *either* channel is up or coming up — a tunnel that came
              up while SSH stayed down still has to be teardownable, and gating this
              on SSH alone left exactly that state with no way out. */}
          {(sshStatus !== "off" || vpnStatus !== "off") && (
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
          {/* Active teardown: end every running tmux job on this host, then
              disconnect. Distinct from plain Disconnect (which detaches and
              leaves sessions alive to reattach). Only when SSH is up — there are
              no host jobs to end otherwise. Two-step: the first click arms it. */}
          {sshStatus === "connected" &&
            (killArm ? (
              <button
                type="button"
                className="vpn-disconnect-btn"
                title="Confirm: this kills every running tmux session on the host — it can't be undone."
                onClick={() => {
                  setKillArm(false);
                  void invoke("remote_kill_all_jobs", killTarget).catch(() => {});
                  stopSsh();
                  if (vpnConfig) stopVpn();
                  disconnectRemote(project.id);
                  close();
                }}
              >
                Confirm: end all jobs
              </button>
            ) : (
              <button
                type="button"
                title="Actively disconnect: end every running tmux job on this host and close the connection. Jobs are killed only on this click — never on an Eldrun restart."
                onClick={() => setKillArm(true)}
              >
                Disconnect &amp; end jobs
                <UntestedTag />
              </button>
            ))}
          {/* Only offered when there is something to forget — the keychain state
              (queried on mount) is the source of truth, not the toggles. Stays
              open afterwards so the emptied "Save password" toggles are visible
              and the user can reconnect with a fresh password right here. */}
          {(sshSaved || vpnSaved) && (
            <button
              type="button"
              title="Delete this host's saved password from your OS keychain. The current connection stays up; the next connect asks for the password again."
              onClick={() => void forgetPasswords()}
            >
              Forget saved password
            </button>
          )}
          <button type="button" onClick={close}>Close</button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
