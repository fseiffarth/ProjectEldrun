import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RemoteEntry, SshTooling } from "../../types";
import { joinRemotePath, parseSshAddress, type ParsedSshAddress } from "./scaffold";

type ConnStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Owns the optional SSH + OpenVPN connection lifecycle for the new/import
 * project dialog: tooling probe, connect/disconnect, the live remote folder
 * browser, and the OpenVPN tunnel. Extracted from `ProjectDialog` so the dialog
 * stays a single cohesive form component; behavior is unchanged.
 */
export function useRemoteSession({ kind }: { kind: "new" | "import" }) {
  // Whether this is a remote (SSH) project. The whole SSH section — address,
  // password, connect, and the remote browser — only appears when this is on.
  const [isRemoteProject, setIsRemoteProject] = useState(false);
  // Availability of sshfs/sshpass/openvpn, fetched the first time the remote
  // checkbox is enabled so missing tools are flagged up front rather than only
  // after a connect/mount fails. `null` until probed.
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
  const [vpnEnabled, setVpnEnabled] = useState(false);
  const [vpnConfig, setVpnConfig] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  const [vpnStatus, setVpnStatus] = useState<ConnStatus>("idle");
  const [vpnError, setVpnError] = useState("");

  const isRemote = sshStatus === "connected" && remoteConn !== null;

  // Drop any live remote session back to the disconnected state. Called when
  // the user edits a credential (address/password) or unchecks "remote".
  const resetSshSession = () => {
    setSshStatus("idle");
    setSshError("");
    setRemoteConn(null);
    setRemotePassword("");
    setRemoteEntries([]);
    setRemoteBrowsePath("");
    setRemoteChosenPath("");
    setRemoteListError("");
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
      setVpnEnabled(false);
      setVpnConfig("");
      setVpnPassword("");
      setVpnStatus("idle");
      setVpnError("");
    }
  };

  // Pick a `.ovpn` config and copy it into Eldrun so the project no longer
  // depends on the original file's location (stored on first use).
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
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // Bring the tunnel up now so a VPN-gated host becomes reachable for browsing.
  const connectVpn = async () => {
    if (!vpnConfig) return;
    setVpnStatus("connecting");
    setVpnError("");
    try {
      await invoke("openvpn_connect", { config: vpnConfig, password: vpnPassword });
      setVpnStatus("connected");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
    }
  };

  // Disconnect/reset the remote session when the user edits the SSH address.
  const onSshAddressChange = (value: string) => {
    setSshAddress(value);
    if (sshStatus !== "idle") resetSshSession();
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

  // Build the `remote` spec for the create/import request, or undefined when not
  // a connected remote project. NEW: name becomes a subdir under the chosen
  // path. IMPORT: the chosen path IS the project root.
  const buildRemoteSpec = (safeName: string) =>
    isRemote && remoteConn
      ? {
          user: remoteConn.user ?? undefined,
          host: remoteConn.host,
          port: remoteConn.port ?? undefined,
          remote_path:
            kind === "new" ? joinRemotePath(remoteChosenPath, safeName) : remoteChosenPath,
          openvpn: vpnEnabled && vpnConfig ? { config: vpnConfig } : undefined,
        }
      : undefined;

  return {
    isRemoteProject,
    isRemote,
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
    vpnPassword,
    setVpnPassword,
    vpnStatus,
    setVpnStatus,
    vpnError,
    setVpnError,
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
