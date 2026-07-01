import { useEffect, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectEntry } from "../../types";
import { IS_WINDOWS } from "../../lib/platform";
import { forgetConnection, markConnectionOpened } from "../../lib/remoteConnect";
import { useRemoteStatusStore, type ConnState } from "../../stores/remoteStatus";

// OpenVPN prints this once the tunnel is fully up (mirrors the backend's
// READY_MARKER in services/openvpn.rs). The embedded VPN login terminal is
// watched for it to flip the lamp green — identical to the new-project dialog
// (see useRemoteSession).
const VPN_READY_MARKER = "Initialization Sequence Completed";

// Shape of the `terminal-output` event payload (PTY id + raw output chunk).
interface TerminalOutput {
  id: string;
  data: string;
}

// Monotonic id source for the reconnect-panel embedded terminals. The id has no
// ":" so it never collides with a tab PTY id (`<scope>:<key>`) or trips the
// detached-PTY check. Module scope so it survives re-renders, and a distinct
// "reconnect-" prefix so it never collides with the dialog's "dialog-" ids.
let reconnectTermSeq = 0;
const nextReconnectTermId = (kind: string) => `reconnect-${kind}-${++reconnectTermSeq}`;

/** An embedded interactive login terminal: `{ id, command, key }` for a
 *  `TerminalView` that runs `command`, plus the activation dedupe `key` it
 *  pre-marked so the matching stop forgets exactly that key. */
type LoginTerm = { id: string; command: string; key: string };

/**
 * Reconnect lifecycle for an *existing* remote project, providing the same
 * embedded-login parts the new-project dialog has (`useRemoteSession`) but
 * driven by the project's already-known `remote` spec rather than fresh-entered
 * address / config + folder browse:
 *
 *  - an embedded OpenVPN login terminal (the user types the passphrase there;
 *    Eldrun never handles it; the VPN lamp flips green on the ready marker), and
 *  - an embedded SSH login terminal that establishes the ControlMaster; once a
 *    credential-less `ssh_connect` rides it, the pooled SSH/SFTP connection is
 *    opened (`remote_connect`) and the SSH lamp goes green — which un-gates the
 *    CenterPanel tab restore exactly as the headline Reconnect button does.
 *
 * Status is published to `useRemoteStatusStore` (keyed by project id) so the
 * header lamps and the restore gate observe the same state this panel drives.
 */
export function useRemoteReconnect(project: ProjectEntry) {
  const projectId = project.id;
  const remote = project.remote;
  const vpnConfig = remote?.openvpn?.config ?? "";

  const status = useRemoteStatusStore((s) => s.byProject[projectId]);
  const sshStatus: ConnState = status?.ssh ?? "off";
  const vpnStatus: ConnState = status?.vpn ?? "off";
  const setSsh = useRemoteStatusStore((s) => s.setSsh);
  const setVpn = useRemoteStatusStore((s) => s.setVpn);

  // Windows has no ssh ControlMaster socket, so an interactive login can't be
  // ridden for the pooled connection — fall back to the headline (key-auth)
  // Reconnect there rather than offering the SSH login terminal.
  const winManual = IS_WINDOWS;

  const vpnTermRef = useRef<LoginTerm | null>(null);
  const sshTermRef = useRef<LoginTerm | null>(null);
  // Bump to force a re-render when a ref-held terminal is opened/closed (the
  // terminals themselves live in refs so the readiness effects can read the
  // current one without re-subscribing on every status change).
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Readiness poll timer for the SSH login's ControlMaster (see startSshTerm).
  const sshPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSshPoll = () => {
    if (sshPollTimer.current) {
      clearTimeout(sshPollTimer.current);
      sshPollTimer.current = null;
    }
  };

  // Tear everything down when the panel unmounts (project switch / reconnect
  // succeeded and the panel is replaced by the restored tabs). The PTYs are NOT
  // killed here — they `persistOnUnmount`, so an authenticated login/tunnel keeps
  // running for the now-connected project; only the poll timer is cleared.
  useEffect(() => clearSshPoll, []);

  // Flip the VPN lamp green once the interactive tunnel comes up. The embedded
  // login spawns `pkexec openvpn` in its own PTY, so the tunnel is not in the
  // backend's registry — watch the terminal's own output for the ready marker
  // (a small rolling buffer in case it straddles two chunks), mirroring the
  // dialog's watcher.
  useEffect(() => {
    const term = vpnTermRef.current;
    if (!term) return;
    const termId = term.id;
    let cancelled = false;
    let un: (() => void) | undefined;
    let buf = "";
    void listen<TerminalOutput>("terminal-output", (ev) => {
      if (ev.payload.id !== termId) return;
      buf = (buf + ev.payload.data).slice(-512);
      if (buf.includes(VPN_READY_MARKER)) setVpn(projectId, "connected");
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
    // vpnTerm is ref-held; re-run when its identity changes via the force tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpnTermRef.current?.id, projectId, setVpn]);

  // Bring the OpenVPN tunnel up in an embedded terminal. The connect command
  // runs interactively so the user types the passphrase in that visible terminal
  // — Eldrun never handles it. The PTY persists past this panel so the tunnel
  // stays up for the reconnected project; we pre-mark the dedupe key so any later
  // activation root-terminal fallback is suppressed.
  const startVpnTerm = async () => {
    if (!vpnConfig || vpnTermRef.current) return;
    try {
      const command = await invoke<string>("openvpn_login_command", { config: vpnConfig });
      const key = `vpn:${vpnConfig}`;
      markConnectionOpened(key);
      vpnTermRef.current = { id: nextReconnectTermId("vpn"), command, key };
      setVpn(projectId, "connecting");
      force();
    } catch {
      setVpn(projectId, "error");
    }
  };

  // Tear the embedded VPN terminal down (explicit disconnect). Kills the PTY and
  // drops the dedupe mark so a later attempt can re-open it.
  const stopVpnTerm = () => {
    const term = vpnTermRef.current;
    if (!term) return;
    void invoke("pty_kill", { id: term.id }).catch(() => {});
    forgetConnection(term.key);
    vpnTermRef.current = null;
    setVpn(projectId, "off");
    force();
  };

  // Poll for the embedded login's ControlMaster to come up: a credential-less
  // ssh_connect rides the master once it is live (and on key-auth hosts succeeds
  // immediately). On the first success we open the pooled SSH/SFTP connection
  // (`remote_connect`) and mark SSH connected — which un-gates the CenterPanel
  // tab restore. Bounded (~2 min) so a never-authenticated login eventually
  // stops; never hard-errors while the terminal is up (the login may just not be
  // authenticated yet).
  const pollSshReady = (attempt = 0) => {
    if (!remote) return;
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
      password: null,
    })
      .then(async () => {
        clearSshPoll();
        // Master is up; bring the pool up so every later channel rides it.
        try {
          await invoke("remote_connect", { projectId, password: null });
          setSsh(projectId, "connected");
        } catch {
          setSsh(projectId, "error");
        }
      })
      .catch(() => {
        if (attempt + 1 >= maxAttempts) {
          clearSshPoll();
          setSsh(projectId, "error");
          return;
        }
        sshPollTimer.current = setTimeout(() => pollSshReady(attempt + 1), 3000);
      });
  };

  // Open the interactive SSH login in an embedded terminal. It establishes the
  // ControlMaster the pooled connection then rides, so reconnect completes
  // without Eldrun ever handling the password. Persisted past the panel; the
  // dedupe mark suppresses any activation root-terminal login.
  const startSshTerm = async () => {
    if (!remote || sshTermRef.current || winManual) return;
    try {
      const command = await invoke<string>("remote_login_command", {
        user: remote.user ?? null,
        host: remote.host,
        port: remote.port ?? null,
      });
      const target = `${remote.user ? `${remote.user}@` : ""}${remote.host}`;
      const key = `ssh:${target}:${remote.port ?? ""}`;
      markConnectionOpened(key);
      sshTermRef.current = { id: nextReconnectTermId("ssh"), command, key };
      setSsh(projectId, "connecting");
      force();
      pollSshReady();
    } catch {
      setSsh(projectId, "error");
    }
  };

  // Manual re-arm of the readiness poll ("I've logged in — connect"), for when
  // the user authenticates after the auto-poll gave up, or wants to retry sooner.
  const tryConnectNow = () => {
    if (!sshTermRef.current) return;
    clearSshPoll();
    setSsh(projectId, "connecting");
    pollSshReady();
  };

  const stopSshTerm = () => {
    const term = sshTermRef.current;
    if (!term) return;
    void invoke("pty_kill", { id: term.id }).catch(() => {});
    forgetConnection(term.key);
    sshTermRef.current = null;
    clearSshPoll();
    setSsh(projectId, "off");
    force();
  };

  return {
    sshStatus,
    vpnStatus,
    vpnConfig,
    winManual,
    vpnTerm: vpnTermRef.current,
    sshTerm: sshTermRef.current,
    startVpnTerm,
    stopVpnTerm,
    startSshTerm,
    stopSshTerm,
    tryConnectNow,
  };
}
