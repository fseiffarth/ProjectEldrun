import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectEntry } from "../../types";
import { IS_WINDOWS } from "../../lib/platform";
import { forgetConnection, markConnectionOpened } from "../../lib/remoteConnect";
import { useRemoteStatusStore, type ConnState } from "../../stores/remoteStatus";
import type { LogLine } from "../common/ConnectionLog";

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

  // Headless-path error strings (surfaced under the password fields in the
  // Connect modal). The lamps carry the coarse state; these carry the reason.
  const [sshError, setSshError] = useState("");
  const [vpnError, setVpnError] = useState("");
  // Live OpenVPN handshake log for the headless connect (fed by the backend's
  // `openvpn-progress` event, same as the new-project dialog). Capped so a
  // chatty handshake can't grow unbounded.
  const [vpnLog, setVpnLog] = useState<LogLine[]>([]);
  const vpnLogSeq = useRef(0);

  // Whether a password is already saved in the OS keychain for this project's
  // SSH host / VPN config, so the Connect modal can pre-check the "Save password"
  // box and show "saved". Queried once on mount (the secret itself never leaves
  // the backend).
  const [sshSaved, setSshSaved] = useState(false);
  const [vpnSaved, setVpnSaved] = useState(false);
  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    void invoke<boolean>("remote_has_saved_password", {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
    })
      .then((v) => !cancelled && setSshSaved(v))
      .catch(() => {});
    if (vpnConfig) {
      void invoke<boolean>("vpn_has_saved_password", { config: vpnConfig })
        .then((v) => !cancelled && setVpnSaved(v))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, remote, vpnConfig]);

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

  // Per-channel connect "generation". A connect (headless invoke or ControlMaster
  // poll) captures the current value and only writes its outcome back if it still
  // matches — so `stopSsh`/`stopVpn` can bump the counter to *abandon* an in-flight
  // attempt whose backend call can't itself be cancelled (the ssh probe self-times
  // out at ConnectTimeout=10s; the OpenVPN handshake at CONNECT_TIMEOUT=45s). This
  // is what makes the Stop button actually resolve a frozen "connecting…" lamp:
  // without it the stale invoke would later flip the lamp back to error/connected.
  const sshGen = useRef(0);
  const vpnGen = useRef(0);

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

  // Stop the OpenVPN channel: cancel any in-flight connect (headless invoke or the
  // embedded login terminal) and reset the lamp to off. Bumping the generation
  // abandons a frozen headless connect; killing the PTY + dropping the dedupe mark
  // tears down an interactive tunnel; `openvpn_disconnect` best-effort kills a
  // tunnel that had already come up. Used by both the terminal Disconnect and the
  // headless Stop button.
  const stopVpn = () => {
    vpnGen.current++;
    const term = vpnTermRef.current;
    if (term) {
      void invoke("pty_kill", { id: term.id }).catch(() => {});
      forgetConnection(term.key);
      vpnTermRef.current = null;
    }
    if (vpnConfig) void invoke("openvpn_disconnect", { config: vpnConfig }).catch(() => {});
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
  const pollSshReady = (attempt = 0, gen = sshGen.current) => {
    if (!remote || gen !== sshGen.current) return; // stopped mid-poll
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
      password: null,
    })
      .then(async () => {
        if (gen !== sshGen.current) return; // stopped while the probe ran
        clearSshPoll();
        // Master is up; bring the pool up so every later channel rides it.
        try {
          await invoke("remote_connect", { projectId, password: null });
          if (gen !== sshGen.current) return;
          setSsh(projectId, "connected");
        } catch {
          if (gen !== sshGen.current) return;
          setSsh(projectId, "error");
        }
      })
      .catch(() => {
        if (gen !== sshGen.current) return; // stopped while the probe ran
        if (attempt + 1 >= maxAttempts) {
          clearSshPoll();
          setSsh(projectId, "error");
          return;
        }
        sshPollTimer.current = setTimeout(() => pollSshReady(attempt + 1, gen), 3000);
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
      const gen = ++sshGen.current;
      setSsh(projectId, "connecting");
      force();
      pollSshReady(0, gen);
    } catch {
      setSsh(projectId, "error");
    }
  };

  // Manual re-arm of the readiness poll ("I've logged in — connect"), for when
  // the user authenticates after the auto-poll gave up, or wants to retry sooner.
  const tryConnectNow = () => {
    if (!sshTermRef.current) return;
    clearSshPoll();
    const gen = ++sshGen.current;
    setSsh(projectId, "connecting");
    pollSshReady(0, gen);
  };

  // ── Headless connect path (Connect modal, `connections_headless` ON) ─────────
  // Eldrun feeds the password to the backend itself (no visible login terminal);
  // the OpenVPN handshake streams into `vpnLog` as a read-only progress view.

  // Stream the live OpenVPN handshake into `vpnLog` (only lines for this
  // project's config; the backend tags each line with its config path).
  useEffect(() => {
    if (!vpnConfig) return;
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<{ config: string; line: string }>("openvpn-progress", (ev) => {
      if (ev.payload.config !== vpnConfig) return;
      setVpnLog((prev) => [...prev, { id: vpnLogSeq.current++, text: ev.payload.line }].slice(-500));
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [vpnConfig]);

  // Bring the OpenVPN tunnel up with the supplied passphrase. Blocks until the
  // backend reports the tunnel ready (or fails). Mirrors `useRemoteSession`'s
  // headless `connectVpn`.
  const connectVpnHeadless = async (password: string, remember = false) => {
    if (!vpnConfig) return;
    const gen = ++vpnGen.current;
    setVpn(projectId, "connecting");
    setVpnError("");
    setVpnLog([]);
    try {
      await invoke("openvpn_connect", { config: vpnConfig, password, remember });
      if (gen !== vpnGen.current) return; // stopped mid-connect
      setVpnSaved(remember);
      setVpn(projectId, "connected");
    } catch (e) {
      if (gen !== vpnGen.current) return; // stopped — ignore the stale failure
      setVpn(projectId, "error");
      setVpnError(String(e));
    }
  };

  // Open the pooled SSH/SFTP connection with the supplied password. On success
  // the pool is up and the SSH lamp goes green — which lets the CenterPanel's
  // held remote panes mount and spawn. Mirrors `pollSshReady`'s success branch
  // but with a user-typed password rather than riding an existing ControlMaster.
  const connectSshHeadless = async (password: string, remember = false) => {
    if (!remote) return;
    const gen = ++sshGen.current;
    setSsh(projectId, "connecting");
    setSshError("");
    try {
      await invoke("ssh_connect", {
        user: remote.user ?? null,
        host: remote.host,
        port: remote.port ?? null,
        password,
        remember,
      });
      if (gen !== sshGen.current) return; // stopped mid-connect
      await invoke("remote_connect", { projectId, password: null });
      if (gen !== sshGen.current) return;
      setSshSaved(remember);
      setSsh(projectId, "connected");
    } catch (e) {
      if (gen !== sshGen.current) return; // stopped — ignore the stale failure
      setSsh(projectId, "error");
      setSshError(String(e));
    }
  };

  // Stop the SSH channel: cancel any in-flight connect (headless invoke or the
  // ControlMaster poll), tear down an embedded login terminal, best-effort drop a
  // half-open pool, and reset the lamp to off. Mirror of `stopVpn`; used by both
  // the terminal Disconnect and the headless Stop button.
  const stopSsh = () => {
    sshGen.current++;
    clearSshPoll();
    const term = sshTermRef.current;
    if (term) {
      void invoke("pty_kill", { id: term.id }).catch(() => {});
      forgetConnection(term.key);
      sshTermRef.current = null;
    }
    void invoke("remote_disconnect", { projectId }).catch(() => {});
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
    stopVpn,
    startSshTerm,
    stopSsh,
    tryConnectNow,
    // Headless connect path
    sshError,
    vpnError,
    vpnLog,
    sshSaved,
    vpnSaved,
    connectVpnHeadless,
    connectSshHeadless,
  };
}
