import { TerminalView } from "../terminal/TerminalView";
import { ConnLamp } from "../common/ConnLamp";
import { useRemoteReconnect } from "./useRemoteReconnect";
import type { ProjectEntry } from "../../types";
import type { ConnState } from "../../stores/remoteStatus";

/**
 * The "Disconnected" center placeholder for a remote project, grown into a
 * reconnect panel that hosts the same embedded-login parts as the new-project
 * dialog (`RemoteProjectSection`): an OpenVPN login terminal (when the project is
 * VPN-gated) and an SSH login terminal — the user types the passphrase/password
 * directly into each visible terminal, and Eldrun never handles it.
 *
 * Reconnect is the OpenVPN tunnel + SSH login: the user brings the tunnel up (for
 * VPN-gated projects) and signs in through the visible login terminals — Eldrun
 * never handles the passphrase/password. Once the SSH login establishes the
 * ControlMaster, the pooled connection comes up and the SSH lamp turns green —
 * which un-gates the tab restore and replaces this panel. (Key/agent-auth hosts
 * still reconnect in one click from the header connection-lamp menu.)
 */
export function RemoteReconnectPanel({
  project,
  sshState,
}: {
  project: ProjectEntry;
  // The pooled SSH state the CenterPanel already reads for its gate; passed in so
  // the headline button/title reflect the same value without a second subscribe.
  sshState: ConnState | undefined;
}) {
  const {
    sshStatus,
    vpnStatus,
    vpnConfig,
    winManual,
    vpnTerm,
    sshTerm,
    startVpnTerm,
    stopVpnTerm,
    startSshTerm,
    stopSshTerm,
    tryConnectNow,
  } = useRemoteReconnect(project);

  return (
    <div className="center-placeholder-card remote-reconnect-card">
      <div className="center-placeholder-title">
        {sshState === "connecting"
          ? "Connecting…"
          : sshState === "error"
            ? "Connection failed"
            : "Disconnected"}
      </div>
      <div className="center-placeholder-hint">
        {sshState === "connecting"
          ? "Bringing the SSH/SFTP connection up. Your tabs will restore once it’s ready."
          : "Reconnect this remote project to restore its tabs — sign in through the login terminals below (bring the OpenVPN tunnel up first when the project is VPN-gated, then sign in over SSH)."}
      </div>

      {/* OpenVPN login terminal — only for VPN-gated projects. */}
      {vpnConfig && (
        <div className="remote-reconnect-section" role="group" aria-label="OpenVPN tunnel">
          <div className="remote-field-label">
            <ConnLamp status={vpnStatus} label="OpenVPN" />
            Connect via OpenVPN
          </div>
          <div className="dialog-connect">
            <button
              type="button"
              className="dialog-connect-btn"
              disabled={!!vpnTerm}
              title="Bring the OpenVPN tunnel up in a terminal below — enter the passphrase there. It stays up for the reconnected project."
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
                  <button type="button" className="vpn-disconnect-btn" onClick={stopVpnTerm}>
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
        </div>
      )}

      {/* SSH login terminal — establishes the ControlMaster the pool rides.
          Windows has no control socket, so it relies on the headline Reconnect. */}
      {!winManual && (
        <div className="remote-reconnect-section" role="group" aria-label="SSH login">
          <div className="remote-field-label">
            <ConnLamp status={sshStatus} label="SSH" />
            Sign in over SSH
          </div>
          <div className="dialog-connect">
            <button
              type="button"
              className="dialog-connect-btn"
              disabled={!!sshTerm}
              title="Open the SSH login in a terminal below — enter the password there. The login stays up for this project."
              onClick={() => void startSshTerm()}
            >
              <span className="dialog-connect-btn-icon" aria-hidden="true">▶_</span>
              {sshTerm ? "SSH terminal open below" : "Open SSH login terminal"}
            </button>
            {sshTerm && sshStatus !== "connected" && (
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
                    Log in below — the session keeps running for this project, and the
                    pooled connection comes up once you’re authenticated.
                  </span>
                  <button type="button" className="vpn-disconnect-btn" onClick={stopSshTerm}>
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
        </div>
      )}
    </div>
  );
}
