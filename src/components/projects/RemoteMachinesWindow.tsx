import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseSshAddress, type ParsedSshAddress } from "./scaffold";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { useRemoteBrowse } from "./useRemoteBrowse";
import { TerminalSignInToggle } from "./TerminalSignInToggle";
import { CredentialPasteBar, sshPasteEntries } from "./CredentialPasteBar";
import { TerminalView } from "../terminal/TerminalView";
import { forgetConnection, markConnectionOpened, resolveRemoteStartDir } from "../../lib/remoteConnect";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useRemoteStatusStore, PRIMARY_HOST } from "../../stores/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { useHostBusyStore, busyReading, busyLabel } from "../../stores/hostBusy";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { formatRemoteTarget, resolveLocalMirror } from "../../types";
import type { ComputeHost, ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";

/** Distinct PTY id per login terminal opened here — the id is the handle
 *  `pty_kill` and the output stream use, so it must never be reused. */
let machineTermSeq = 0;
const nextMachineTermId = () => `machines-ssh-${++machineTermSeq}`;

/**
 * Mounted once (AppShell). Renders the "Remote machines" manager for whichever
 * remote project the `useRemoteMachinesStore` points at — opened from the pill's
 * Runtime menu item and from a right-click on the pill's remote lamp. Keyed by
 * project id so it re-seeds when the target changes.
 */
export function RemoteMachinesDialogHost() {
  const projectId = useRemoteMachinesStore((s) => s.projectId);
  const close = useRemoteMachinesStore((s) => s.close);
  const project = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  if (!projectId || !project?.remote) return null;
  return <RemoteMachinesWindow key={project.id} project={project} onClose={close} />;
}

/** The `worker-sync-report` event the backend emits after a code fan-out. */
interface WorkerSyncReport {
  project_id: string;
  host_id: string;
  head?: string;
  ok: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * The pill's "Remote machines…" manager (`docs/multi_host_remote_plan.md` §4.4):
 * list the project's extra worker hosts, add a new one, connect each, push code,
 * pull outputs, and toggle per-worker settings. The primary remote stays the
 * project's own `remote` — this manages ONLY the workers, which are one-way,
 * read-only experiment machines.
 *
 * A remote project only. Rendered as a centered modal like ContainerSettings.
 */
export function RemoteMachinesWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const workers = project.compute_hosts ?? [];
  const openConnect = useConnectDialogStore((s) => s.open);
  const byHost = useRemoteStatusStore((s) => s.byHost[project.id]);
  // The primary host's live SSH state (multi-host remote keeps the primary in
  // `byProject`, workers in `byHost`) — drives the primary entry's lamp/action.
  const primary = useRemoteStatusStore((s) => s.byProject[project.id]);
  const readings = useHostBusyStore((s) => s.readings);

  // Sweep every CONNECTED host for live tmux sessions when this hub opens, so
  // each card's lamp says whether that machine is merely reachable or actually
  // working (`stores/hostBusy`). On-open only, never polled — one SSH round trip
  // per connected host, riding the pool that is already up. A disconnected host
  // is skipped: it has nothing to ask, and asking would dial it just to fail.
  const primarySsh = primary?.ssh ?? "off";
  const connectedKey = [
    primarySsh === "connected" ? "primary" : "",
    ...workers.filter((w) => (byHost?.[w.id]?.ssh ?? "off") === "connected").map((w) => w.id),
  ]
    .filter(Boolean)
    .join("|");
  useEffect(() => {
    const probe = useHostBusyStore.getState().probeProjectHost;
    if (primarySsh === "connected" && project.remote) {
      void probe(project.id, PRIMARY_HOST, project.remote);
    }
    for (const w of workers) {
      if ((byHost?.[w.id]?.ssh ?? "off") === "connected") void probe(project.id, w.id, w);
    }
    // Re-sweeps when the set of connected hosts changes (one just connected), not
    // on every unrelated re-render of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, connectedKey]);

  // Patch the project's `compute_hosts` in the store from a CRUD command's return
  // value — cheaper and side-effect-free vs a full project reload.
  const applyHosts = (hosts: ComputeHost[]) => {
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, compute_hosts: hosts } : p,
      ),
    }));
  };

  // ── Global machine handed to this project (from MachinesIndicator) ────────
  // The header's Machines menu picked this project in its "add to a project"
  // list, which opened this window pre-seeded with the machine. Only the shared
  // path is asked — everything else came with the machine — and the result is
  // always a shared-filesystem worker (no copy, no git), added and connected
  // exactly like the manual "Add a machine" flow.
  const pendingDrop = useRemoteMachinesStore((s) => s.pendingDrop);
  const setPendingDrop = useRemoteMachinesStore((s) => s.setPendingDrop);
  const [dropPath, setDropPath] = useState(project.remote?.remote_path ?? "");
  const [dropBusy, setDropBusy] = useState(false);
  const [dropError, setDropError] = useState("");

  const addDroppedMachine = async () => {
    if (!pendingDrop) return;
    const path = dropPath.trim();
    if (!path.startsWith("/")) {
      setDropError(t("remoteMachines.enterAbsolutePath"));
      return;
    }
    setDropBusy(true);
    setDropError("");
    const beforeIds = new Set(workers.map((w) => w.id));
    const host: ComputeHost = {
      id: "",
      label: pendingDrop.label,
      user: pendingDrop.user,
      host: pendingDrop.host,
      port: pendingDrop.port,
      remote_path: path,
      shared_fs: true,
      sync_code: false,
      pull_outputs: false,
    };
    try {
      const hosts = await invoke<ComputeHost[]>("add_compute_host", {
        projectId: project.id,
        host,
      });
      applyHosts(hosts);
      const added = hosts.find((h) => !beforeIds.has(h.id));
      // Best-effort: the global machine is already authenticated, so this rides
      // the same saved keychain credential (or key/agent auth) with no prompt.
      // Silent on failure — the new card's own Connect button still works.
      // `viaLogin`: riding *that* master is exactly why it needs no credential, so
      // the success must not be recorded as key auth (`record_key_auth`, backend).
      if (added)
        void invoke("remote_connect", {
          projectId: project.id,
          hostId: added.id,
          viaLogin: true,
        }).catch(() => {});
      setPendingDrop(null);
      setDropPath(project.remote?.remote_path ?? "");
    } catch (e) {
      setDropError(String(e));
    } finally {
      setDropBusy(false);
    }
  };

  // Add-machine form. A new machine defaults to a SHARED-FILESYSTEM host (no copy,
  // shells run in the primary's shared folder); tick "Sync a copy" to make it the
  // synced-copy worker instead. The path defaults to the primary's own remote path,
  // since on a shared filesystem the folder is usually at the same place.
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [remotePath, setRemotePath] = useState(project.remote?.remote_path ?? "");
  const [label, setLabel] = useState("");
  const [syncCopy, setSyncCopy] = useState(false);
  const [addError, setAddError] = useState("");
  const [busy, setBusy] = useState(false);

  // ── Connect-then-browse folder picker (same machinery as extend-to-remote) ──
  // Rather than typing the path blind, the user can connect to the machine and
  // browse its filesystem to the target folder — for a shared-fs worker that is
  // the existing primary folder; for a synced copy it's where the copy should go
  // (and can be created here). Uses the one-shot SFTP commands (`ssh_connect` to
  // validate + warm the ControlMaster, then `ssh_list_dir`/`ssh_mkdir`), so it
  // needs no pooled worker connection first. The password is transient — used
  // only for this browse, never persisted (the worker's real connect, and its
  // "Save password", live in the shared Connect modal opened later).
  const [browsePassword, setBrowsePassword] = useState("");
  // "Save password" opt-in (default off, matching the no-storage-by-default
  // policy). When on, the login below persists the SSH password to the OS
  // keychain via `ssh_connect`'s `remember` flag — keyed by host target, so the
  // machine's own Connect modal (RemoteConnectDialog) finds it and never asks.
  // `savedPw` reflects the keychain and pre-ticks the box so an untick is a
  // deliberate delete, never an accidental clear of another menu's credential.
  const [savePassword, setSavePassword] = useState(false);
  const [savedPw, setSavedPw] = useState(false);
  // The connect + browse mechanism is the SHARED one (`useRemoteBrowse`), the same
  // the primary machine's new/extend flow uses — this dialog only wraps its own
  // fields around it. `browsing` is a view flag on top (whether the folder panel is
  // expanded), distinct from `browse.conn` (whether a live session exists).
  const browse = useRemoteBrowse();
  const [browsing, setBrowsing] = useState(false);
  // ── "Sign in in a terminal" (see `TerminalSignInToggle`) ─────────────────────
  // This form only ever had the password field, in *both* modes — so a host that
  // asks anything else (a challenge code, a one-time code, a second prompt) could
  // not be added at all, and a `connections_headless: false` user was asked for a
  // password their mode says Eldrun should never handle. The terminal login fixes
  // both, which is why the switch **defaults to on in non-headless mode**: there it
  // is the mode, and only here was it missing.
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  const [viaTerminal, setViaTerminal] = useState(!headless);
  const [loginTerm, setLoginTerm] = useState<{ id: string; command: string; key: string } | null>(
    null,
  );
  const loginPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [browseConnecting, setBrowseConnecting] = useState(false);
  const [browsePaths, setBrowsePaths] = useState<string[]>([]);

  // Editing the address after opening the browser invalidates the frozen
  // connection it lists over — close it so a stale listing can't be trusted.
  const onAddressChange = (v: string) => {
    setAddress(v);
    if (browsing) setBrowsing(false);
    browse.reset();
    // A login terminal is bound to the target it was opened for; keeping it across
    // an address edit would leave the next browse riding the wrong host's master.
    stopLoginTerm();
  };

  // The login target: parse the address, then take the username from the
  // dedicated field when the address didn't inline a `user@` (the inline form
  // still wins, so a full `me@box` address keeps working).
  const parseTarget = (): ParsedSshAddress | null => {
    const parsed = parseSshAddress(address);
    if (!parsed) return null;
    return { ...parsed, user: parsed.user ?? (username.trim() || null) };
  };

  // Reflect the keychain: when the typed target already has a saved password,
  // say so and pre-tick "Save password" (so the box mirrors reality and an
  // untick reads as a deliberate delete). The credential is keyed by host
  // target and shared across every remote menu.
  useEffect(() => {
    const parsed = parseTarget();
    if (!parsed) {
      setSavedPw(false);
      setSavePassword(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("remote_has_saved_password", {
      user: parsed.user,
      host: parsed.host,
      port: parsed.port,
    })
      .then((has) => {
        if (cancelled) return;
        setSavedPw(has);
        setSavePassword(has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, username]);

  const startBrowse = async () => {
    const parsed = parseTarget();
    if (!parsed) {
      setAddError(t("remoteMachines.enterHostBeforeBrowsing"));
      return;
    }
    setAddError("");
    browse.setError("");
    setBrowseConnecting(true);
    const password = browsePassword ? browsePassword : null;
    try {
      // The shared connect: validate the credential + warm the ControlMaster (a
      // key-auth host connects with a null password), remember the working password
      // only on success (keyed by host target, so the machine's own Connect finds
      // it), then open the start dir. Seed the browse at the current path field —
      // which defaults to the primary machine's project path — so the picker opens
      // there *on the new machine* (usually the same shared folder) rather than at
      // this host's home; a synced-copy worker whose folder doesn't exist yet can
      // navigate up from it. The listing refreshes itself.
      await browse.connect({
        target: parsed,
        password,
        remember: savePassword,
        startPath: remotePath.trim() || null,
      });
      setSavedPw(savePassword);
      setBrowsing(true);
      invoke<string[]>("remote_list_paths", { host: parsed.host })
        .then(setBrowsePaths)
        .catch(() => setBrowsePaths([]));
    } catch (e) {
      browse.setError(String(e));
    } finally {
      setBrowseConnecting(false);
    }
  };

  // ── The terminal login, and the poll that turns it into a browsable session ──
  // Eldrun sees no password here: the user authenticates in the terminal below, and
  // the only signal is that the login's **ControlMaster** has come up — at which
  // point a credential-less `ssh_connect` starts succeeding and rides it. That is
  // exactly what `browse.openSession` is for: freeze the session somebody else
  // authenticated, no second login. Bounded (~2 min), because a login the user never
  // completes must stop polling rather than spin for the life of the window.
  const clearLoginPoll = () => {
    if (loginPoll.current) {
      clearTimeout(loginPoll.current);
      loginPoll.current = null;
    }
  };
  const pollLoginReady = (parsed: ParsedSshAddress, attempt = 0) => {
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: parsed.user,
      host: parsed.host,
      port: parsed.port,
      password: null,
    })
      .then(async () => {
        clearLoginPoll();
        setBrowseConnecting(false);
        // Same seed the password path uses: the primary's project path *on this
        // machine* (usually the same shared folder), else the host's default.
        const startDir =
          remotePath.trim() ||
          (await resolveRemoteStartDir(parsed.user, parsed.host, parsed.port, null));
        browse.openSession(parsed, "", startDir);
        setBrowsing(true);
        invoke<string[]>("remote_list_paths", { host: parsed.host })
          .then(setBrowsePaths)
          .catch(() => setBrowsePaths([]));
      })
      .catch(() => {
        if (attempt + 1 >= maxAttempts) {
          clearLoginPoll();
          setBrowseConnecting(false);
          return;
        }
        loginPoll.current = setTimeout(() => pollLoginReady(parsed, attempt + 1), 3000);
      });
  };

  const startLoginTerm = async () => {
    if (loginTerm) return;
    const parsed = parseTarget();
    if (!parsed) {
      setAddError(t("remoteMachines.enterHostBeforeLogin"));
      return;
    }
    setAddError("");
    browse.setError("");
    try {
      const command = await invoke<string>("remote_login_command", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
      });
      // Pre-mark the activation dedupe key this login satisfies, so the project's
      // own root-terminal login isn't opened a second time for the same target.
      const target = `${parsed.user ? `${parsed.user}@` : ""}${parsed.host}`;
      const key = `ssh:${target}:${parsed.port ?? ""}`;
      markConnectionOpened(key);
      setLoginTerm({ id: nextMachineTermId(), command, key });
      setBrowseConnecting(true);
      pollLoginReady(parsed);
    } catch (e) {
      setAddError(String(e));
    }
  };

  /** Re-arm the readiness poll — for a login finished after the bound ran out. */
  const retryLoginBrowse = () => {
    const parsed = parseTarget();
    if (!parsed) return;
    clearLoginPoll();
    setBrowseConnecting(true);
    pollLoginReady(parsed);
  };

  // Killing the login drops the ControlMaster every browse here rides, so this
  // returns the form to its logged-out state rather than leaving a listing that
  // nothing is behind.
  const stopLoginTerm = () => {
    clearLoginPoll();
    setBrowseConnecting(false);
    if (!loginTerm) return;
    void invoke("pty_kill", { id: loginTerm.id }).catch(() => {});
    forgetConnection(loginTerm.key);
    setLoginTerm(null);
  };

  // The window can be closed (or re-keyed to another project) mid-poll; the PTY is
  // deliberately left running — the ControlMaster it holds is the machine's — but a
  // timer firing into an unmounted component is nobody's.
  useEffect(() => clearLoginPoll, []);

  const useBrowsedFolder = () => {
    setRemotePath(browse.path || "/");
    setBrowsing(false);
  };

  // "Change…" after a successful login — drop the frozen connection so the
  // address/password step comes back and a fresh login can be made.
  const logout = () => {
    setBrowsing(false);
    browse.reset();
    stopLoginTerm();
    setRemotePath(project.remote?.remote_path ?? "");
  };

  // Last sync report per host (for the "last synced" line).
  const [reports, setReports] = useState<Record<string, WorkerSyncReport>>({});
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void listen<WorkerSyncReport>("worker-sync-report", (ev) => {
      if (ev.payload.project_id !== project.id) return;
      setReports((prev) => ({ ...prev, [ev.payload.host_id]: ev.payload }));
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [project.id]);

  const addMachine = async () => {
    const parsed = parseTarget();
    if (!parsed) {
      setAddError(t("remoteMachines.enterHost"));
      return;
    }
    const path = remotePath.trim();
    if (!path.startsWith("/")) {
      setAddError(t("remoteMachines.enterAbsolutePath"));
      return;
    }
    setBusy(true);
    setAddError("");
    const host: ComputeHost = {
      id: "", // backend mints one
      label: label.trim() || undefined,
      user: parsed.user ?? undefined,
      host: parsed.host,
      port: parsed.port ?? undefined,
      remote_path: path,
      // Default: shared filesystem (no copy). "Sync a copy" opts into a synced
      // worker that keeps its own tracked tree at the primary's HEAD.
      shared_fs: !syncCopy,
      sync_code: syncCopy,
      pull_outputs: false,
    };
    try {
      const hosts = await invoke<ComputeHost[]>("add_compute_host", {
        projectId: project.id,
        host,
      });
      applyHosts(hosts);
      setAddress("");
      setUsername("");
      setRemotePath(project.remote?.remote_path ?? "");
      setLabel("");
      setSyncCopy(false);
      setBrowsePassword("");
      setBrowsing(false);
      browse.reset();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMachine = async (hostId: string) => {
    // Disconnect it first (best effort), then drop it.
    await invoke("remote_disconnect", { projectId: project.id, hostId }).catch(() => {});
    useRemoteStatusStore.getState().clearHost(project.id, hostId);
    const hosts = await invoke<ComputeHost[]>("remove_compute_host", {
      projectId: project.id,
      hostId,
    }).catch(() => null);
    if (hosts) applyHosts(hosts);
  };

  const patch = async (hostId: string, fields: Record<string, unknown>) => {
    const hosts = await invoke<ComputeHost[]>("patch_compute_host", {
      projectId: project.id,
      hostId,
      ...fields,
    }).catch(() => null);
    if (hosts) applyHosts(hosts);
  };

  // Pull outputs: preview the size first (a checkpoint dir can be huge), confirm,
  // then fetch into a local outputs/<label>/ folder. The only worker→local path.
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullNote, setPullNote] = useState<Record<string, string>>({});
  const pullOutputs = async (hostId: string) => {
    setPulling(hostId);
    setPullNote((p) => ({ ...p, [hostId]: "" }));
    try {
      const preview = await invoke<{ files: number; bytes: number }>("worker_outputs_preview", {
        projectId: project.id,
        hostId,
      });
      if (preview.files === 0) {
        setPullNote((p) => ({ ...p, [hostId]: t("remoteMachines.noOutputFiles") }));
        return;
      }
      const ok = window.confirm(
        t("remoteMachines.pullConfirm", { files: preview.files, bytes: formatBytes(preview.bytes) }),
      );
      if (!ok) return;
      const rep = await invoke<{ pulled: number; bytes: number; dest: string; errors: string[] }>(
        "worker_pull_outputs",
        { projectId: project.id, hostId },
      );
      const errs = rep.errors.length ? t("remoteMachines.pullErrorsSuffix", { count: rep.errors.length }) : "";
      setPullNote((p) => ({
        ...p,
        [hostId]: t("remoteMachines.pulledResult", { pulled: rep.pulled, dest: rep.dest, errs }),
      }));
    } catch (e) {
      setPullNote((p) => ({ ...p, [hostId]: t("remoteMachines.pullFailed", { error: String(e) }) }));
    } finally {
      setPulling(null);
    }
  };

  const syncNow = async (hostId: string) => {
    setReports((prev) => ({
      ...prev,
      [hostId]: { project_id: project.id, host_id: hostId, ok: false, skipped: false },
    }));
    const rep = await invoke<WorkerSyncReport>("worker_sync_now", {
      projectId: project.id,
      hostId,
    }).catch((e) => ({
      project_id: project.id,
      host_id: hostId,
      ok: false,
      skipped: false,
      error: String(e),
    }));
    setReports((prev) => ({ ...prev, [hostId]: rep }));
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog dialog-framed remote-machines-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("remoteMachines.title", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="dialog-scroll">
        <p className="settings-help">
          {t("remoteMachines.introPre")} <strong>{t("remoteMachines.introStrongPrimary")}</strong>{" "}
          {t("remoteMachines.introMid1")}{" "}
          <strong>{t("remoteMachines.introStrongSameCode")}</strong>
          {t("remoteMachines.introMid2")} <strong>{t("remoteMachines.introStrongSyncCopy")}</strong>{" "}
          {t("remoteMachines.introPost")}
        </p>

        {/* ── Primary host ────────────────────────────────────────────────────
            The project's own `remote` — it owns files, git, and the local mirror,
            with full two-way sync. Listed first so the one menu covers connecting
            the primary too, not only the workers; its Connect/Manage opens the same
            per-host detail (`RemoteConnectDialog`) a worker's does, targeting
            `"primary"`. No sync/pull/remove: those are worker-only concepts. */}
        {(() => {
          const ssh = primary?.ssh ?? "off";
          const pLabel = project.remote?.label || project.remote?.host || project.name;
          const mirror = resolveLocalMirror(project);
          const busy = ssh === "connected" ? busyReading({ readings }, project.remote) : null;
          return (
            <div className="remote-machine-card">
              <div className="remote-machine-head">
                <ConnLamp
                  status={ssh}
                  busy={busy !== null}
                  label={busy ? `${pLabel} — ${busyLabel(busy)}` : pLabel}
                />
                <span className="remote-machine-name">{pLabel}</span>
                <span
                  className="remote-machine-tag"
                  title={t("remoteMachines.primaryTagTitle")}
                >
                  {t("remoteMachines.primaryTag")}
                </span>
                <UntestedTag />
                <span className="remote-machine-target">
                  {project.remote && formatRemoteTarget(project.remote)}
                </span>
              </div>
              <div className="remote-machine-status">
                {ssh === "connected" ? t("remoteMachines.connectedDot") : t("remoteMachines.notConnectedDot")}
                {mirror ? ` ${t("remoteMachines.localMirrorLabel")} ${mirror}` : ""}
              </div>
              <div className="remote-machine-actions">
                <button onClick={() => openConnect(project.id, "primary")}>
                  {ssh === "connected" ? t("remoteMachines.manage") : t("remoteMachines.connectEllipsis")}
                </button>
              </div>
            </div>
          );
        })()}

        {/* A global machine picked for this project in the header's Machines
            menu — confirm just the shared path, then add + connect it like any
            other worker. */}
        {pendingDrop && (
          <div className="remote-machine-card remote-machine-drop-panel">
            <div className="remote-machine-head">
              <ConnLamp status="connected" label={pendingDrop.label || pendingDrop.host} />
              <span className="remote-machine-name">
                {pendingDrop.label || pendingDrop.host}
              </span>
              <span className="remote-machine-tag">{t("remoteMachines.sharedFsTag")}</span>
              <span className="remote-machine-target">
                {pendingDrop.user ? `${pendingDrop.user}@` : ""}
                {pendingDrop.host}
                {pendingDrop.port ? `:${pendingDrop.port}` : ""}
              </span>
            </div>
            <p className="settings-help">
              {t("remoteMachines.dropIntro")}
            </p>
            <label>
              <span className="remote-machine-add-label">{t("remoteMachines.pathOnMachine")}</span>
              <input
                placeholder={t("remoteMachines.absolutePathPlaceholder")}
                value={dropPath}
                onChange={(e) => setDropPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addDroppedMachine();
                }}
                spellCheck={false}
                autoFocus
              />
            </label>
            {dropError && <div className="project-dialog-error">{dropError}</div>}
            <div className="project-dialog-actions">
              <button type="button" onClick={() => setPendingDrop(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" disabled={dropBusy} onClick={() => void addDroppedMachine()}>
                {dropBusy ? t("remoteMachines.adding") : t("remoteMachines.addMachineBtn")}
              </button>
            </div>
          </div>
        )}

        {/* Existing workers */}
        <div className="remote-machine-worker-list">
        {workers.length === 0 && (
          <p className="settings-help">{t("remoteMachines.noWorkers")}</p>
        )}
        {workers.map((w) => {
          const ssh = byHost?.[w.id]?.ssh ?? "off";
          const rep = reports[w.id];
          const wLabel = w.label || w.host;
          const wBusy = ssh === "connected" ? busyReading({ readings }, w) : null;
          const shared = w.shared_fs === true;
          const statusText = shared
            ? t("remoteMachines.sharedStatus")
            : rep?.error
              ? `${t("remoteMachines.syncFailedLabel")} ${rep.error}`
              : rep?.head
                ? `${t("remoteMachines.lastSyncedLabel")} ${rep.head}${rep.skipped ? ` ${t("remoteMachines.alreadyCurrent")}` : ""}`
                : rep && !rep.ok
                  ? t("remoteMachines.syncingEllipsis")
                  : t("remoteMachines.notSyncedYet");
          return (
            <div key={w.id} className="remote-machine-card">
              <div className="remote-machine-head">
                <ConnLamp
                  status={ssh}
                  busy={wBusy !== null}
                  label={wBusy ? `${wLabel} — ${busyLabel(wBusy)}` : wLabel}
                />
                <span className="remote-machine-name">{wLabel}</span>
                <span
                  className="remote-machine-tag"
                  title={
                    shared
                      ? t("remoteMachines.sharedTagTitle")
                      : t("remoteMachines.syncedTagTitle")
                  }
                >
                  {shared ? t("remoteMachines.sharedFsTag") : t("remoteMachines.syncedCopyTag")}
                </span>
                <span className="remote-machine-target">
                  {w.user ? `${w.user}@` : ""}{w.host}{w.port ? `:${w.port}` : ""}:{w.remote_path}
                </span>
              </div>
              <div className={`remote-machine-status${rep?.error && !shared ? " error" : ""}`}>
                {statusText}
              </div>
              <div className="remote-machine-actions">
                <button onClick={() => openConnect(project.id, w.id)}>
                  {ssh === "connected" ? t("remoteMachines.manage") : t("remoteMachines.connectEllipsis")}
                </button>
                {!shared && (
                  <>
                    <button disabled={ssh !== "connected"} onClick={() => void syncNow(w.id)}>
                      {t("remoteMachines.syncCodeNow")}
                    </button>
                    <button
                      disabled={ssh !== "connected" || pulling === w.id}
                      onClick={() => void pullOutputs(w.id)}
                      title={t("remoteMachines.pullOutputsTitle")}
                    >
                      {pulling === w.id ? t("remoteMachines.pulling") : t("remoteMachines.pullOutputsBtn")}
                    </button>
                  </>
                )}
                <button
                  className="danger"
                  onClick={() => void removeMachine(w.id)}
                  title={t("remoteMachines.removeTitle")}
                >
                  {t("remoteMachines.remove")}
                </button>
              </div>
              <label className="remote-machine-toggle" title={t("remoteMachines.syncCopyToggleTitle")}>
                <span>{t("remoteMachines.syncCopyLabel")}</span>
                <Toggle
                  checked={!shared}
                  onChange={(e) =>
                    void patch(
                      w.id,
                      e.target.checked ? { sharedFs: false, syncCode: true } : { sharedFs: true },
                    )
                  }
                  size="sm"
                />
              </label>
              {!shared && (
                <label className="remote-machine-toggle" title={t("remoteMachines.autoSyncTitle")}>
                  <span>{t("remoteMachines.autoSyncLabel")}</span>
                  <Toggle
                    checked={w.sync_code !== false}
                    onChange={(e) => void patch(w.id, { syncCode: e.target.checked })}
                    size="sm"
                  />
                </label>
              )}
              {pullNote[w.id] && <div className="settings-help">{pullNote[w.id]}</div>}
            </div>
          );
        })}
        </div>

        {/* Add machine — two steps: log in first, then choose the folder. */}
        <div className="remote-machine-add">
          <div className="remote-machine-add-title">{t("remoteMachines.addMachineTitle")}</div>

          {!browse.conn ? (
            /* ── Step 1: log in ────────────────────────────────────────── */
            <>
              <label>
                {t("remoteMachines.sshAddressLabel")}
                <input
                  placeholder={t("remoteMachines.sshAddressPlaceholder")}
                  value={address}
                  onChange={(e) => onAddressChange(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter means "get me logged in", which is a different call in
                    // each path — the password connect, or opening the terminal.
                    if (e.key === "Enter") void (viaTerminal ? startLoginTerm() : startBrowse());
                  }}
                  spellCheck={false}
                />
              </label>
              <label>
                <span className="remote-machine-add-label">
                  {t("remoteConnect.usernameLabel")}
                  <UntestedTag />
                </span>
                <input
                  placeholder={t("remoteMachines.usernamePlaceholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter means "get me logged in", which is a different call in
                    // each path — the password connect, or opening the terminal.
                    if (e.key === "Enter") void (viaTerminal ? startLoginTerm() : startBrowse());
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {!viaTerminal && (
                <label>
                  {t("remoteConnect.sshPasswordLabel")}
                  <PasswordInput
                    placeholder={
                      savedPw
                        ? t("remoteMachines.sshPasswordSavedPlaceholder")
                        : t("remoteMachines.sshPasswordPlaceholder")
                    }
                    value={browsePassword}
                    autoComplete="off"
                    onChange={(e) => setBrowsePassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void startBrowse();
                    }}
                  />
                </label>
              )}
              {/* Kept on screen in the terminal path too, and *disabled* rather than
                  hidden: a saved password belongs to the host, not to how you signed
                  in this time, and a row that vanishes reads as one that was
                  discarded. Nothing here can act in that path anyway — the toggle
                  only takes effect through `ssh_connect`'s `remember`, which a
                  terminal login never calls, so the keychain is left exactly as it
                  was found (delete it from the machine's own Connect menu). */}
              <label
                className="container-settings-toggle"
                title={
                  viaTerminal
                    ? t("remoteMachines.saveTitleTerminal")
                    : t("remoteMachines.saveTitleHeadless")
                }
              >
                <span className="remote-machine-add-label">
                  {t("remoteConnect.savePassword")}
                  <UntestedTag />
                </span>
                <Toggle
                  checked={savePassword}
                  disabled={viaTerminal}
                  onChange={(e) => setSavePassword(e.target.checked)}
                  size="sm"
                />
              </label>
              <div className="settings-help">
                {viaTerminal
                  ? savedPw
                    ? t("remoteMachines.saveHintKeptTerminal")
                    : t("remoteMachines.saveHintNothingTerminal")
                  : savePassword
                    ? savedPw
                      ? t("remoteMachines.saveHintSavedWillAskAgainOff")
                      : t("remoteMachines.saveHintWillSave")
                    : `${t("remoteMachines.saveHintNotSavedPre")} “${t("remoteConnect.savePassword")}” ${t("remoteMachines.saveHintNotSavedPost")}`}
              </div>
              {viaTerminal && loginTerm && (
                <div className="dialog-connect-terminal">
                  <div className="dialog-connect-terminal-bar">
                    <span className="ssh-optional-hint">
                      {t("remoteMachines.loginTermHint")}
                    </span>
                    <button type="button" className="vpn-disconnect-btn" onClick={stopLoginTerm}>
                      {t("remoteConnect.disconnect")}
                    </button>
                  </div>
                  {/* The password this form asks for is normally transient — but the
                      keychain may hold one for this host from the machine's own
                      Connect modal, or from the project that already uses it, and a
                      terminal login has no field to reach it. */}
                  <CredentialPasteBar
                    ptyId={loginTerm.id}
                    entries={sshPasteEntries(t, {
                      user: parseTarget()?.user,
                      host: parseTarget()?.host,
                      port: parseTarget()?.port,
                      saved: savedPw,
                    })}
                  />
                  <div className="dialog-connect-terminal-host">
                    <TerminalView
                      id={loginTerm.id}
                      cmd=""
                      cwd=""
                      initialInput={loginTerm.command}
                      visible
                      focused
                      persistOnUnmount
                    />
                  </div>
                </div>
              )}
              <TerminalSignInToggle
                channel="ssh"
                checked={viaTerminal}
                busy={!!loginTerm}
                onChange={setViaTerminal}
              />
              {browse.error && <div className="project-dialog-error">{browse.error}</div>}
              {addError && <div className="project-dialog-error">{addError}</div>}
              <div className="project-dialog-actions">
                <button type="button" onClick={onClose}>{t("common.close")}</button>
                {/* One action, three meanings — the step the form is actually on:
                    open the login, re-check a login that outlasted the poll, or the
                    ordinary password connect. */}
                {viaTerminal ? (
                  loginTerm ? (
                    <button
                      type="button"
                      title={t("remoteMachines.retryBrowseTitle")}
                      onClick={retryLoginBrowse}
                    >
                      {browseConnecting ? t("remoteMachines.waitingForLogin") : t("remoteMachines.loggedInBrowse")}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void startLoginTerm()}>
                      {t("remoteMachines.openLoginTerminal")}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={browseConnecting}
                    onClick={() => void startBrowse()}
                  >
                    {browseConnecting ? t("remoteMachines.loggingIn") : t("remoteMachines.logIn")}
                  </button>
                )}
              </div>
            </>
          ) : (
            /* ── Step 2: logged in — choose the folder ─────────────────── */
            <>
              {(() => {
                const loggedInAs = `${browse.conn!.user ? `${browse.conn!.user}@` : ""}${browse.conn!.host}${browse.conn!.port ? `:${browse.conn!.port}` : ""}`;
                return (
                  <div className="remote-machine-loggedin">
                    <ConnLamp status="connected" label={loggedInAs} />
                    <span>
                      {t("remoteMachines.loggedInToPre")} <strong>{loggedInAs}</strong>
                    </span>
                    <button type="button" onClick={logout}>{t("remoteConnect.changeConfig")}</button>
                  </div>
                );
              })()}

              <label className="container-settings-toggle" title={t("remoteMachines.sharedFsToggleTitleStep2")}>
                <span>{t("remoteMachines.syncCopyLabel")}</span>
                <Toggle checked={syncCopy} onChange={(e) => setSyncCopy(e.target.checked)} size="sm" />
              </label>
              <p className="settings-help">
                {syncCopy
                  ? t("remoteMachines.syncCopyDescOn")
                  : t("remoteMachines.syncCopyDescOff")}
              </p>

              <label>
                <span className="remote-machine-add-label">
                  {syncCopy ? t("remoteMachines.remotePathForCopy") : t("remoteMachines.pathToProject")}
                  <UntestedTag />
                </span>
                <div className="folder-picker-row">
                  <input
                    placeholder={t("remoteMachines.absolutePathPlaceholder")}
                    value={remotePath}
                    onChange={(e) => setRemotePath(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    disabled={browseConnecting}
                    onClick={() => void startBrowse()}
                  >
                    {browseConnecting ? t("vpnPrompt.connecting") : browsing ? t("remoteMachines.reconnect") : t("remoteMachines.browseEllipsis")}
                  </button>
                </div>
              </label>

              {browsing && browse.conn && (
                <RemoteFolderBrowser
                  path={browse.path}
                  entries={browse.entries}
                  busy={browse.busy}
                  error={browse.error}
                  recentPaths={browsePaths}
                  onGoUp={browse.goUp}
                  onJumpPath={browse.jump}
                  onEnterFolder={browse.enter}
                  onUseFolder={useBrowsedFolder}
                  onCreateFolder={browse.mkdir}
                  footer={t("remoteMachines.browserFooter")}
                />
              )}

              <label>
                {t("remoteMachines.labelOptional")}
                <input
                  placeholder={t("remoteMachines.labelPlaceholder")}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              {addError && <div className="project-dialog-error">{addError}</div>}
              <div className="project-dialog-actions">
                <button type="button" onClick={onClose}>{t("common.close")}</button>
                <button type="button" disabled={busy} onClick={() => void addMachine()}>
                  {busy ? t("remoteMachines.adding") : t("remoteMachines.addMachineBtn")}
                </button>
              </div>
            </>
          )}
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
