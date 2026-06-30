import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { RemoteEntry, SshTooling, StoredVpnConfig } from "../../types";
import { joinRemotePath, parseSshAddress, type ParsedSshAddress } from "./scaffold";
import { IS_WINDOWS } from "../../lib/platform";
import { forgetConnection, markConnectionOpened } from "../../lib/remoteConnect";
import type { LogLine } from "../common/ConnectionLog";

type ConnStatus = "idle" | "connecting" | "connected" | "error";

// OpenVPN prints this once the tunnel is fully up (mirrors the backend's
// READY_MARKER in services/openvpn.rs). The embedded VPN login terminal is
// watched for it to flip the lamp green (see the readiness watcher below).
const VPN_READY_MARKER = "Initialization Sequence Completed";

// Shape of the `terminal-output` event payload (PTY id + a raw output chunk),
// matching the backend emit and TerminalView's own listener.
interface TerminalOutput {
  id: string;
  data: string;
}

/** Steps of the remote-project flow: connect (SSH + VPN) → browse a remote
 *  folder → fill in name/details. Local projects bypass these entirely. */
export type RemoteStep = "connect" | "browse" | "details";

// Monotonic id source for the dialog-embedded connection terminals. The id has
// no ":" so it never collides with a tab PTY id (`<scope>:<key>`) or trips the
// detached-PTY check. (Module scope so the counter survives re-renders.)
let dialogTermSeq = 0;
const nextDialogTermId = (kind: string) => `dialog-${kind}-${++dialogTermSeq}`;

/**
 * Owns the optional SSH + OpenVPN connection lifecycle for the new/import
 * project dialog: tooling probe, connect/disconnect, the live remote folder
 * browser, and the OpenVPN tunnel. Extracted from `ProjectDialog` so the dialog
 * stays a single cohesive form component; behavior is unchanged.
 */
export function useRemoteSession({ kind }: { kind: "new" | "import" }) {
  // For now the new/import dialog *always* uses the integrated login terminal for
  // SSH and OpenVPN — the user types the password/passphrase into a visible
  // terminal embedded right here, and Eldrun never handles the secret. This used
  // to be gated on the `connections_headless` setting (headless → Eldrun made the
  // connection itself via an askpass file); that distinction is flattened so both
  // settings behave identically in the dialog until the headless path is revisited.
  const headless = false;
  // Whether this is a remote (SSH) project. The whole SSH section — address,
  // password, connect, and the remote browser — only appears when this is on.
  const [isRemoteProject, setIsRemoteProject] = useState(false);
  // Availability of sshpass/openvpn, fetched the first time the remote
  // checkbox is enabled so missing tools are flagged up front rather than only
  // after a connect fails. `null` until probed.
  const [sshTooling, setSshTooling] = useState<SshTooling | null>(null);
  const [sshAddress, setSshAddress] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [sshStatus, setSshStatus] = useState<ConnStatus>("idle");
  const [sshError, setSshError] = useState("");
  // The SSH address that was successfully connected (frozen at connect time so
  // edits to the input don't silently change which host we browse/submit to).
  const [remoteConn, setRemoteConn] = useState<ParsedSshAddress | null>(null);
  // The password that was used for the successful connect, frozen so the remote
  // listing always reuses the same credential the connection was made with.
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteBrowsePath, setRemoteBrowsePath] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[]>([]);
  const [remoteListBusy, setRemoteListBusy] = useState(false);
  const [remoteListError, setRemoteListError] = useState("");
  // The remote folder the user committed to via "Use this folder".
  const [remoteChosenPath, setRemoteChosenPath] = useState("");
  // --- Optional OpenVPN tunnel for VPN-gated remote hosts ---
  // `vpnConfig` holds the Eldrun-stored `.ovpn` path (the picked file is copied
  // into Eldrun on selection). The password is transient — never persisted.
  // OpenVPN is the only tunnel type, so there's no separate enable toggle: the
  // tunnel is "used" exactly when a config is selected (`vpnConfig` non-empty).
  const [vpnConfig, setVpnConfig] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  const [vpnStatus, setVpnStatus] = useState<ConnStatus>("idle");
  const [vpnError, setVpnError] = useState("");
  // Live OpenVPN handshake output for the headless connect, streamed from the
  // backend (`openvpn-progress`) and shown in a read-only log so the connect
  // isn't an opaque spinner. Reset at the start of each connect attempt.
  const [vpnLog, setVpnLog] = useState<LogLine[]>([]);
  // Monotonic id source for `vpnLog` lines. A dedicated counter (never reset on
  // slice) gives each pushed line a stable React key so the `.slice(-500)` cap
  // trims only the head without re-creating surviving line nodes.
  const vpnLogSeq = useRef(0);
  // Previously-used `.ovpn` configs (newest first), offered for reuse so a
  // config need only be browsed for once. Refreshed when the VPN section opens
  // and after a new config is stored.
  const [vpnConfigs, setVpnConfigs] = useState<StoredVpnConfig[]>([]);
  // --- Non-headless in-dialog connection terminals ---
  // In non-headless mode the OpenVPN tunnel and SSH login are interactive: the
  // user types the passphrase/password into a live terminal. Rather than
  // deferring those to a root-terminal tab at activation (the old flow), we
  // embed the live terminal right here in the dialog. Each holds `{ id, command }`
  // for an embedded `TerminalView` that runs `command` in a shell. The PTY is
  // spawned with `persistOnUnmount`, so closing the dialog leaves the
  // tunnel/login up for the new project to use; we also pre-mark the activation
  // dedupe key (see `markConnectionOpened`) so the root-tab flow is skipped.
  // Each holds the activation dedupe `key` it pre-marked (see `markConnectionOpened`)
  // so the matching `stopX` forgets *that* key — not one rebuilt from current
  // render state, which may have drifted (e.g. the config/address changed while
  // the terminal was up), leaving a stale mark that suppresses the real connect.
  const [vpnTerm, setVpnTerm] = useState<{ id: string; command: string; key: string } | null>(
    null,
  );
  const [sshTerm, setSshTerm] = useState<{ id: string; command: string; key: string } | null>(
    null,
  );

  const isRemote = sshStatus === "connected" && remoteConn !== null;

  // Windows has no ssh ControlMaster socket, so a non-headless login can't be
  // ridden for SFTP browsing — that mode falls back to typing the remote path.
  const winManual = IS_WINDOWS && !headless;

  // Which step of the remote flow we're on. Local projects ignore this (the
  // dialog renders its single form whenever the project isn't remote).
  const [step, setStep] = useState<RemoteStep>("connect");

  // Timer for the non-headless browse-readiness poll (see startSshTerm): once the
  // embedded interactive login authenticates, the shared ControlMaster comes up
  // and an otherwise-credential-less ssh_connect starts succeeding, at which point
  // we flip to the same connected/browse state headless reaches via connectSsh.
  const sshPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSshPoll = () => {
    if (sshPollTimer.current) {
      clearTimeout(sshPollTimer.current);
      sshPollTimer.current = null;
    }
  };
  useEffect(() => clearSshPoll, []);

  // Advance to the browser the moment the SSH session goes live (either mode),
  // so the user sees the lamp turn green and lands on the folder picker.
  useEffect(() => {
    if (isRemote) setStep((s) => (s === "connect" ? "browse" : s));
  }, [isRemote]);

  // Drop any live remote session back to the disconnected state. Called when
  // the user edits a credential (address/password) or unchecks "remote".
  const resetSshSession = () => {
    clearSshPoll();
    setSshStatus("idle");
    setSshError("");
    setRemoteConn(null);
    setRemotePassword("");
    setRemoteEntries([]);
    setRemoteBrowsePath("");
    setRemoteChosenPath("");
    setRemoteListError("");
    setStep("connect");
  };

  // Toggle remote mode. Turning it off tears down the SSH session and clears the
  // entered credentials so the dialog falls back to the local create/import flow.
  const toggleRemoteProject = (checked: boolean) => {
    setIsRemoteProject(checked);
    if (checked) {
      // Probe the remote tooling once so we can warn about anything missing
      // before the user fills in an address and hits Connect/Create.
      if (sshTooling === null) {
        invoke<SshTooling>("ssh_tooling_status").then(setSshTooling).catch(() => {});
      }
    }
    if (!checked) {
      setSshAddress("");
      setSshPassword("");
      resetSshSession();
      stopSshTerm();
      setVpnConfig("");
      setVpnPassword("");
      setVpnStatus("idle");
      setVpnError("");
      stopVpnTerm();
    }
  };

  // Load the list of previously-stored configs (newest first). Best-effort.
  const refreshVpnConfigs = () => {
    invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(setVpnConfigs)
      .catch(() => setVpnConfigs([]));
  };

  // Fetch the recent-configs list when the remote section opens so a
  // previously-used config can be picked without re-browsing.
  useEffect(() => {
    if (isRemoteProject) refreshVpnConfigs();
  }, [isRemoteProject]);

  // Stream the live OpenVPN handshake into `vpnLog` while the VPN section is
  // open. The backend tags each line with the config it belongs to, so we keep
  // only lines for the config currently selected here (the dialog connects one
  // tunnel at a time). Capped so a chatty handshake can't grow unbounded.
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

  // Select one of the previously-stored configs (its path is already an
  // Eldrun-stored copy, so it's used as-is — no re-copy needed).
  const selectVpnConfig = (path: string) => {
    setVpnConfig(path);
    setVpnStatus("idle");
    setVpnError("");
    setVpnLog([]); // drop the previous config's handshake output
  };

  // Pick a `.ovpn` config and copy it into Eldrun so the project no longer
  // depends on the original file's location (stored on first use). The new copy
  // joins the recent-configs list for future reuse.
  const browseVpnConfig = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await invoke<string>("openvpn_store_config", { config: picked });
      setVpnConfig(stored);
      setVpnStatus("idle");
      setVpnError("");
      setVpnLog([]); // drop the previous config's handshake output
      refreshVpnConfigs();
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // Bring the tunnel up now so a VPN-gated host becomes reachable for browsing.
  const connectVpn = async () => {
    if (!vpnConfig) return;
    setVpnStatus("connecting");
    setVpnError("");
    setVpnLog([]);
    try {
      await invoke("openvpn_connect", { config: vpnConfig, password: vpnPassword });
      setVpnStatus("connected");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
    }
  };

  // Non-headless: bring the OpenVPN tunnel up in a terminal embedded in the
  // dialog. The connect command (`pkexec openvpn … --auth-nocache`) runs
  // interactively so the user types the passphrase in that visible terminal —
  // Eldrun never handles it. The PTY persists past the dialog so the tunnel
  // stays up for the new project; we pre-mark the dedupe key so activation's
  // root-terminal fallback (`ensureVpnIfNeeded`) is suppressed.
  const startVpnTerm = async () => {
    if (!vpnConfig || vpnTerm) return;
    try {
      const command = await invoke<string>("openvpn_login_command", { config: vpnConfig });
      const key = `vpn:${vpnConfig}`;
      markConnectionOpened(key);
      setVpnTerm({ id: nextDialogTermId("vpn"), command, key });
      // The handshake is now in flight in the terminal below — light the lamp
      // orange until the readiness watcher (below) sees the ready marker.
      setVpnStatus("connecting");
      setVpnError("");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
    }
  };

  // Flip the VPN lamp green once the interactive tunnel comes up. The embedded
  // login spawns `pkexec openvpn` inside its own PTY, so the tunnel is *not* in
  // the backend's tunnel registry — `openvpn_status` can't see it. Instead we
  // watch that terminal's own output for OpenVPN's ready marker (the same string
  // the headless backend waits on). Output arrives in chunks, so we keep a small
  // rolling buffer in case the marker straddles two `terminal-output` events.
  useEffect(() => {
    if (!vpnTerm) return;
    const termId = vpnTerm.id;
    let cancelled = false;
    let un: (() => void) | undefined;
    let buf = "";
    void listen<TerminalOutput>("terminal-output", (ev) => {
      if (ev.payload.id !== termId) return;
      buf = (buf + ev.payload.data).slice(-512);
      if (buf.includes(VPN_READY_MARKER)) setVpnStatus("connected");
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [vpnTerm]);

  // Tear the embedded VPN terminal down (explicit disconnect / config change /
  // leaving remote mode). Kills the PTY and drops the dedupe mark so a later
  // activation can re-open the connection if still needed.
  const stopVpnTerm = () => {
    if (!vpnTerm) return;
    void invoke("pty_kill", { id: vpnTerm.id }).catch(() => {});
    forgetConnection(vpnTerm.key);
    setVpnTerm(null);
    setVpnStatus("idle");
  };

  // Non-headless: open the interactive SSH login in a dialog-embedded terminal.
  // It establishes the ControlMaster socket the sshfs mount later rides, so the
  // new project activates without a second prompt. Persisted past the dialog;
  // the dedupe mark suppresses activation's root-terminal login.
  // Poll for the embedded login's ControlMaster to come up: a credential-less
  // ssh_connect rides the master once it's live (and on key-auth hosts succeeds
  // immediately). On the first success we mirror connectSsh's connected state so
  // both modes converge on the same `isRemote` browser. Bounded (~2 min) so a
  // never-authenticated login eventually stops; the user can re-arm it with the
  // "I've logged in — browse" button (tryBrowseNow). Never hard-errors while the
  // terminal is up — the login may just not be authenticated yet.
  const pollSshReady = (parsed: ParsedSshAddress, attempt = 0) => {
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: parsed.user,
      host: parsed.host,
      port: parsed.port,
      password: null,
    })
      .then(async () => {
        clearSshPoll();
        const startDir = await invoke<string>("ssh_default_dir", {
          user: parsed.user,
          host: parsed.host,
          port: parsed.port,
          password: null,
        }).catch(() => "");
        setRemoteConn(parsed);
        setRemotePassword(""); // empty → null → rides the master in the listing effect
        setSshStatus("connected");
        setRemoteBrowsePath(startDir || "");
      })
      .catch(() => {
        if (attempt + 1 >= maxAttempts) {
          clearSshPoll();
          return;
        }
        sshPollTimer.current = setTimeout(() => pollSshReady(parsed, attempt + 1), 3000);
      });
  };

  // Manual re-arm of the readiness poll (the "I've logged in — browse" button),
  // for when the user authenticates after the auto-poll gave up, or wants to
  // retry sooner.
  const tryBrowseNow = () => {
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) return;
    clearSshPoll();
    setSshStatus("connecting");
    setSshError("");
    pollSshReady(parsed);
  };

  const startSshTerm = async () => {
    if (sshTerm) return;
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) {
      setSshStatus("error");
      setSshError("Enter an address like user@host or host:2222");
      return;
    }
    try {
      const command = await invoke<string>("remote_login_command", {
        user: parsed.user ?? null,
        host: parsed.host,
        port: parsed.port ?? null,
      });
      const target = `${parsed.user ? `${parsed.user}@` : ""}${parsed.host}`;
      const key = `ssh:${target}:${parsed.port ?? ""}`;
      markConnectionOpened(key);
      setSshTerm({ id: nextDialogTermId("ssh"), command, key });
      setSshError("");
      // Outside Windows, ride the login's ControlMaster to SFTP-browse — no stored
      // password. (Windows has no control socket, so it keeps the manual path input.)
      if (!winManual) {
        setSshStatus("connecting");
        pollSshReady(parsed);
      }
    } catch (e) {
      setSshStatus("error");
      setSshError(String(e));
    }
  };

  const stopSshTerm = () => {
    if (!sshTerm) return;
    void invoke("pty_kill", { id: sshTerm.id }).catch(() => {});
    // Drop the dedupe mark (symmetric with stopVpnTerm) so a later activation can
    // re-open the SSH login; otherwise the key lingers in openedConnections and
    // ensureRootSshLoginIfNeeded silently skips the real login.
    forgetConnection(sshTerm.key);
    setSshTerm(null);
    // Killing the login drops the ControlMaster the browse rode, so stop the
    // readiness poll and return to the disconnected state.
    clearSshPoll();
    setSshStatus("idle");
    setRemoteConn(null);
    setStep("connect");
  };

  // Disconnect/reset the remote session when the user edits the SSH address.
  const onSshAddressChange = (value: string) => {
    setSshAddress(value);
    if (sshStatus !== "idle") resetSshSession();
    // A live login is bound to the old target — drop it so a re-connect uses
    // the new address.
    stopSshTerm();
  };

  // Editing the password also invalidates a live session — the next connect
  // must re-authenticate with the new credential.
  const onSshPasswordChange = (value: string) => {
    setSshPassword(value);
    if (sshStatus !== "idle") resetSshSession();
  };

  const connectSsh = async () => {
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) {
      setSshStatus("error");
      setSshError("Enter an address like user@host or host:2222");
      return;
    }
    // Empty password → key/agent auth (Option<String> None on the backend).
    const password = sshPassword ? sshPassword : null;
    setSshStatus("connecting");
    setSshError("");
    setRemoteChosenPath("");
    try {
      await invoke<void>("ssh_connect", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        password,
      });
      const startDir = await invoke<string>("ssh_default_dir", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        password,
      }).catch(() => "");
      setRemoteConn(parsed);
      setRemotePassword(sshPassword);
      setSshStatus("connected");
      setRemoteBrowsePath(startDir || "");
    } catch (err) {
      setSshStatus("error");
      setSshError(String(err));
      setRemoteConn(null);
    }
  };

  // Refresh the remote folder listing whenever the browse path changes.
  useEffect(() => {
    if (sshStatus !== "connected" || !remoteConn) {
      setRemoteEntries([]);
      return;
    }
    let cancelled = false;
    setRemoteListBusy(true);
    setRemoteListError("");
    invoke<RemoteEntry[]>("ssh_list_dir", {
      user: remoteConn.user,
      host: remoteConn.host,
      port: remoteConn.port,
      password: remotePassword ? remotePassword : null,
      path: remoteBrowsePath,
    })
      .then((entries) => {
        if (cancelled) return;
        setRemoteEntries(entries);
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteEntries([]);
        setRemoteListError(String(err));
      })
      .finally(() => {
        if (!cancelled) setRemoteListBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sshStatus, remoteConn, remotePassword, remoteBrowsePath]);

  const enterRemoteFolder = (entry: RemoteEntry) => {
    if (!entry.is_dir) return;
    setRemoteBrowsePath(joinRemotePath(remoteBrowsePath, entry.name));
  };

  const remoteGoUp = () => {
    const path = remoteBrowsePath.replace(/\/+$/, "");
    if (!path || path === "/") {
      setRemoteBrowsePath("/");
      return;
    }
    const idx = path.lastIndexOf("/");
    setRemoteBrowsePath(idx <= 0 ? "/" : path.slice(0, idx));
  };

  // Build the `remote` spec for the create/import request, or undefined when this
  // isn't a usable remote project. NEW: name becomes a subdir under the chosen
  // path. IMPORT: the chosen path IS the project root.
  //
  // Headless: requires a live, browsed SSH session (`isRemote`). Non-headless:
  // no in-dialog connection is made (the live login happens in the root terminal
  // at activation), so the spec is built straight from the typed address + the
  // manually-entered remote path.
  const buildRemoteSpec = (safeName: string) => {
    if (!isRemoteProject) return undefined;
    const openvpn = vpnConfig ? { config: vpnConfig } : undefined;
    // Both modes now browse to a real folder over a live session (headless via
    // connectSsh, non-headless by riding the embedded login's ControlMaster), so a
    // committed remoteConn + chosen path is the single source of truth.
    if (remoteConn && remoteChosenPath.trim()) {
      return {
        user: remoteConn.user ?? undefined,
        host: remoteConn.host,
        port: remoteConn.port ?? undefined,
        remote_path:
          kind === "new" ? joinRemotePath(remoteChosenPath, safeName) : remoteChosenPath,
        openvpn,
      };
    }
    // Windows non-headless can't browse (no control socket) — fall back to the
    // typed address + manually-entered path.
    if (winManual) {
      const parsed = parseSshAddress(sshAddress);
      const path = remoteChosenPath.trim();
      if (!parsed || !path) return undefined;
      return {
        user: parsed.user ?? undefined,
        host: parsed.host,
        port: parsed.port ?? undefined,
        remote_path: kind === "new" ? joinRemotePath(path, safeName) : path,
        openvpn,
      };
    }
    return undefined;
  };

  // Ready to submit: a chosen remote folder over a live session, or (Windows
  // non-headless) a typed path. Drives the dialog's submit gating + step machine.
  const remoteReady =
    isRemoteProject &&
    (winManual ? remoteChosenPath.trim() !== "" : isRemote && remoteChosenPath.trim() !== "");

  return {
    isRemoteProject,
    isRemote,
    headless,
    winManual,
    remoteReady,
    step,
    setStep,
    tryBrowseNow,
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
    toggleRemoteProject,
    browseVpnConfig,
    connectVpn,
    onSshAddressChange,
    onSshPasswordChange,
    connectSsh,
    enterRemoteFolder,
    remoteGoUp,
    buildRemoteSpec,
  };
}
