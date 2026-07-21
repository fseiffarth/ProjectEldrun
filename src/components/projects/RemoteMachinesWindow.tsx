import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseSshAddress, type ParsedSshAddress } from "./scaffold";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { useRemoteBrowse } from "./useRemoteBrowse";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { GLOBAL_MACHINE_DRAG_TYPE } from "../header/MachinesIndicator";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useProjectsStore } from "../../stores/projects";
import { formatRemoteTarget, resolveLocalMirror } from "../../types";
import type { ComputeHost, ProjectEntry } from "../../types";

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
  const workers = project.compute_hosts ?? [];
  const openConnect = useConnectDialogStore((s) => s.open);
  const byHost = useRemoteStatusStore((s) => s.byHost[project.id]);
  // The primary host's live SSH state (multi-host remote keeps the primary in
  // `byProject`, workers in `byHost`) — drives the primary entry's lamp/action.
  const primary = useRemoteStatusStore((s) => s.byProject[project.id]);

  // Patch the project's `compute_hosts` in the store from a CRUD command's return
  // value — cheaper and side-effect-free vs a full project reload.
  const applyHosts = (hosts: ComputeHost[]) => {
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, compute_hosts: hosts } : p,
      ),
    }));
  };

  // ── Global machine dropped here (drag-and-drop from MachinesIndicator) ────
  // Either dropped straight onto the worker-list area below, or the pill
  // already opened this window pre-seeded with the drop. Only the shared path
  // is asked — everything else came with the machine — and the result is
  // always a shared-filesystem worker (no copy, no git), added and connected
  // exactly like the manual "Add a machine" flow.
  const pendingDrop = useRemoteMachinesStore((s) => s.pendingDrop);
  const setPendingDrop = useRemoteMachinesStore((s) => s.setPendingDrop);
  const [dropPath, setDropPath] = useState(project.remote?.remote_path ?? "");
  const [dropBusy, setDropBusy] = useState(false);
  const [dropError, setDropError] = useState("");
  const [workerDragOver, setWorkerDragOver] = useState(false);

  const addDroppedMachine = async () => {
    if (!pendingDrop) return;
    const path = dropPath.trim();
    if (!path.startsWith("/")) {
      setDropError("Enter an absolute remote path (e.g. /home/me/project)");
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
      if (added) void invoke("remote_connect", { projectId: project.id, hostId: added.id }).catch(() => {});
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
  const [browseConnecting, setBrowseConnecting] = useState(false);
  const [browsePaths, setBrowsePaths] = useState<string[]>([]);

  // Editing the address after opening the browser invalidates the frozen
  // connection it lists over — close it so a stale listing can't be trusted.
  const onAddressChange = (v: string) => {
    setAddress(v);
    if (browsing) setBrowsing(false);
    browse.reset();
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
      setAddError("Enter a host as [user@]host[:port] before browsing");
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

  const useBrowsedFolder = () => {
    setRemotePath(browse.path || "/");
    setBrowsing(false);
  };

  // "Change…" after a successful login — drop the frozen connection so the
  // address/password step comes back and a fresh login can be made.
  const logout = () => {
    setBrowsing(false);
    browse.reset();
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
      setAddError("Enter a host as [user@]host[:port]");
      return;
    }
    const path = remotePath.trim();
    if (!path.startsWith("/")) {
      setAddError("Enter an absolute remote path (e.g. /home/me/project)");
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
        setPullNote((p) => ({ ...p, [hostId]: "No output files to pull." }));
        return;
      }
      const ok = window.confirm(
        `Pull ${preview.files} output file(s) (${formatBytes(preview.bytes)}) from this machine to your computer?`,
      );
      if (!ok) return;
      const rep = await invoke<{ pulled: number; bytes: number; dest: string; errors: string[] }>(
        "worker_pull_outputs",
        { projectId: project.id, hostId },
      );
      const errs = rep.errors.length ? ` (${rep.errors.length} failed)` : "";
      setPullNote((p) => ({
        ...p,
        [hostId]: `Pulled ${rep.pulled} file(s) → ${rep.dest}${errs}`,
      }));
    } catch (e) {
      setPullNote((p) => ({ ...p, [hostId]: `Pull failed: ${e}` }));
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
      <div className="project-dialog remote-machines-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Remote machines</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <p className="settings-help">
          Every machine this project reaches, in one place — the <strong>primary</strong>{" "}
          that owns its files and git, plus any extra worker machines that run its{" "}
          <strong>same code</strong>. Connect or manage any of them here, or add a new
          worker below. A new worker shares the primary's project folder by default (no
          copy, no git); tick <strong>Sync a copy</strong> to give it its own
          one-way-synced copy — for hosts that don't share storage with the primary.
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
          return (
            <div className="remote-machine-card">
              <div className="remote-machine-head">
                <ConnLamp status={ssh} label={pLabel} />
                <span className="remote-machine-name">{pLabel}</span>
                <span
                  className="remote-machine-tag"
                  title="The primary machine owns this project's files, git and local mirror, with full two-way sync."
                >
                  Primary
                </span>
                <UntestedTag />
                <span className="remote-machine-target">
                  {project.remote && formatRemoteTarget(project.remote)}
                </span>
              </div>
              <div className="remote-machine-status">
                {ssh === "connected" ? "Connected." : "Not connected."}
                {mirror ? ` Local mirror: ${mirror}` : ""}
              </div>
              <div className="remote-machine-actions">
                <button onClick={() => openConnect(project.id, "primary")}>
                  {ssh === "connected" ? "Manage…" : "Connect…"}
                </button>
              </div>
            </div>
          );
        })()}

        {/* Dropped a global machine here (or via the pill) — confirm just the
            shared path, then add + connect it like any other worker. */}
        {pendingDrop && (
          <div className="remote-machine-card remote-machine-drop-panel">
            <div className="remote-machine-head">
              <ConnLamp status="connected" label={pendingDrop.label || pendingDrop.host} />
              <span className="remote-machine-name">
                {pendingDrop.label || pendingDrop.host}
              </span>
              <span className="remote-machine-tag">Shared filesystem</span>
              <span className="remote-machine-target">
                {pendingDrop.user ? `${pendingDrop.user}@` : ""}
                {pendingDrop.host}
                {pendingDrop.port ? `:${pendingDrop.port}` : ""}
              </span>
            </div>
            <p className="settings-help">
              Dropped from your global machines. Give the shared path it sees this
              project's folder at — everything else is already known.
            </p>
            <label>
              <span className="remote-machine-add-label">Path on this machine</span>
              <input
                placeholder="Absolute path (e.g. /home/me/project)"
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
                Cancel
              </button>
              <button type="button" disabled={dropBusy} onClick={() => void addDroppedMachine()}>
                {dropBusy ? "Adding…" : "Add machine"}
              </button>
            </div>
          </div>
        )}

        {/* Existing workers */}
        <div
          className={`remote-machine-worker-list${workerDragOver ? " drag-over" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(GLOBAL_MACHINE_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!workerDragOver) setWorkerDragOver(true);
          }}
          onDragLeave={() => setWorkerDragOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(GLOBAL_MACHINE_DRAG_TYPE)) return;
            e.preventDefault();
            setWorkerDragOver(false);
            const raw = e.dataTransfer.getData(GLOBAL_MACHINE_DRAG_TYPE);
            if (!raw) return;
            try {
              setPendingDrop(JSON.parse(raw));
            } catch {
              // Malformed payload — ignore the drop.
            }
          }}
        >
        {workers.length === 0 && (
          <p className="settings-help">No worker machines yet.</p>
        )}
        {workers.map((w) => {
          const ssh = byHost?.[w.id]?.ssh ?? "off";
          const rep = reports[w.id];
          const wLabel = w.label || w.host;
          const shared = w.shared_fs === true;
          const statusText = shared
            ? "Runs in the primary's shared folder — no copy, no sync."
            : rep?.error
              ? `Sync failed: ${rep.error}`
              : rep?.head
                ? `Last synced: ${rep.head}${rep.skipped ? " (already current)" : ""}`
                : rep && !rep.ok
                  ? "Syncing…"
                  : "Not synced yet";
          return (
            <div key={w.id} className="remote-machine-card">
              <div className="remote-machine-head">
                <ConnLamp status={ssh} label={wLabel} />
                <span className="remote-machine-name">{wLabel}</span>
                <span
                  className="remote-machine-tag"
                  title={
                    shared
                      ? "Shared filesystem: shells run in the primary's project folder on this machine. No code is copied and git is never run here."
                      : "Synced copy: this machine keeps its own read-only copy of the code, one-way synced from the primary."
                  }
                >
                  {shared ? "Shared filesystem" : "Synced copy"}
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
                  {ssh === "connected" ? "Manage…" : "Connect…"}
                </button>
                {!shared && (
                  <>
                    <button disabled={ssh !== "connected"} onClick={() => void syncNow(w.id)}>
                      Sync code now
                    </button>
                    <button
                      disabled={ssh !== "connected" || pulling === w.id}
                      onClick={() => void pullOutputs(w.id)}
                      title="Fetch this machine's experiment outputs (untracked files) to your computer. Confirms the size first."
                    >
                      {pulling === w.id ? "Pulling…" : "Pull outputs…"}
                    </button>
                  </>
                )}
                <button
                  className="danger"
                  onClick={() => void removeMachine(w.id)}
                  title="Remove this machine from the project (its files on the host are left untouched)."
                >
                  Remove
                </button>
              </div>
              <label className="remote-machine-toggle" title="On: this machine keeps its own copy of the code, one-way synced from the primary. Off: it shares the primary's project folder over a shared filesystem (no copy, no git).">
                <span>Sync a copy of the code to this machine</span>
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
                <label className="remote-machine-toggle" title="Keep this machine's tracked code synced to the project HEAD on every commit.">
                  <span>Auto-sync code on every commit</span>
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
          <div className="remote-machine-add-title">Add a machine</div>

          {!browse.conn ? (
            /* ── Step 1: log in ────────────────────────────────────────── */
            <>
              <label>
                SSH address
                <input
                  placeholder="host[:port]  (e.g. gpu-2:22)"
                  value={address}
                  onChange={(e) => onAddressChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void startBrowse();
                  }}
                  spellCheck={false}
                />
              </label>
              <label>
                <span className="remote-machine-add-label">
                  Username
                  <UntestedTag />
                </span>
                <input
                  placeholder="SSH login user (e.g. me) — or include it as user@ above"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void startBrowse();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Password
                <PasswordInput
                  placeholder={
                    savedPw
                      ? "Using saved password — leave blank"
                      : "SSH password — leave blank for key auth"
                  }
                  value={browsePassword}
                  autoComplete="off"
                  onChange={(e) => setBrowsePassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void startBrowse();
                  }}
                />
              </label>
              <label
                className="container-settings-toggle"
                title="Save this machine's SSH password in your OS keychain, keyed by host — the machine's own Connect menu then finds it and won't ask again. Off by default; an untick deletes a previously-saved one."
              >
                <span className="remote-machine-add-label">
                  Save password
                  <UntestedTag />
                </span>
                <Toggle
                  checked={savePassword}
                  onChange={(e) => setSavePassword(e.target.checked)}
                  size="sm"
                />
              </label>
              <div className="settings-help">
                {savePassword
                  ? savedPw
                    ? "Saved in your OS keychain — this machine's Connect won't ask again. Turn off to delete it."
                    : "Will be saved to your OS keychain so this machine's Connect won't ask again."
                  : "Used only to log in — not saved. Turn on “Save password” to keep it."}
              </div>
              {browse.error && <div className="project-dialog-error">{browse.error}</div>}
              {addError && <div className="project-dialog-error">{addError}</div>}
              <div className="project-dialog-actions">
                <button type="button" onClick={onClose}>Close</button>
                <button
                  type="button"
                  disabled={browseConnecting}
                  onClick={() => void startBrowse()}
                >
                  {browseConnecting ? "Logging in…" : "Log in"}
                </button>
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
                      Logged in to <strong>{loggedInAs}</strong>
                    </span>
                    <button type="button" onClick={logout}>Change…</button>
                  </div>
                );
              })()}

              <label className="container-settings-toggle" title="Off (default): this machine shares the primary's project folder over a shared filesystem — no copy, no git. On: give it its own one-way-synced copy of the code (for hosts that don't share storage).">
                <span>Sync a copy of the code to this machine</span>
                <Toggle checked={syncCopy} onChange={(e) => setSyncCopy(e.target.checked)} size="sm" />
              </label>
              <p className="settings-help">
                {syncCopy
                  ? "This machine keeps its own copy of the code, one-way synced from the primary. Browse to (or create) the folder for that copy."
                  : "This machine shares the primary's project folder over a shared filesystem — no copy, no git. Browse to that folder on this machine."}
              </p>

              <label>
                <span className="remote-machine-add-label">
                  {syncCopy ? "Remote path for this machine's copy" : "Path to the project on this machine"}
                  <UntestedTag />
                </span>
                <div className="folder-picker-row">
                  <input
                    placeholder="Absolute path (e.g. /home/me/project)"
                    value={remotePath}
                    onChange={(e) => setRemotePath(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    disabled={browseConnecting}
                    onClick={() => void startBrowse()}
                  >
                    {browseConnecting ? "Connecting…" : browsing ? "Reconnect" : "Browse…"}
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
                  footer="Browse to a folder, then click “Use this folder”."
                />
              )}

              <label>
                Label (optional)
                <input
                  placeholder="e.g. gpu-2"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              {addError && <div className="project-dialog-error">{addError}</div>}
              <div className="project-dialog-actions">
                <button type="button" onClick={onClose}>Close</button>
                <button type="button" disabled={busy} onClick={() => void addMachine()}>
                  {busy ? "Adding…" : "Add machine"}
                </button>
              </div>
            </>
          )}
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
