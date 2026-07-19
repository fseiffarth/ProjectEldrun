import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseSshAddress, joinRemotePath, type ParsedSshAddress } from "./scaffold";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { fileIcon, folderIcon } from "../../lib/viewers/fileUtils";
import { useProjectsStore } from "../../stores/projects";
import type { ComputeHost, ProjectEntry, RemoteEntry } from "../../types";

/** Extension (".py", ".md", …) of a remote listing entry, for its file-type
 *  icon. A leading-dot name (".gitignore") has none, so it falls back to the
 *  generic file icon. Mirrors `RemoteProjectSection`'s helper. */
function remoteEntryExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : null;
}

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

  // Patch the project's `compute_hosts` in the store from a CRUD command's return
  // value — cheaper and side-effect-free vs a full project reload.
  const applyHosts = (hosts: ComputeHost[]) => {
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, compute_hosts: hosts } : p,
      ),
    }));
  };

  // Add-machine form. A new machine defaults to a SHARED-FILESYSTEM host (no copy,
  // shells run in the primary's shared folder); tick "Sync a copy" to make it the
  // synced-copy worker instead. The path defaults to the primary's own remote path,
  // since on a shared filesystem the folder is usually at the same place.
  const [address, setAddress] = useState("");
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
  const [browsing, setBrowsing] = useState(false);
  const [browseConnecting, setBrowseConnecting] = useState(false);
  const [browseConn, setBrowseConn] = useState<ParsedSshAddress | null>(null);
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<RemoteEntry[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [browsePaths, setBrowsePaths] = useState<string[]>([]);
  const [newFolderName, setNewFolderName] = useState("");

  // Editing the address after opening the browser invalidates the frozen
  // connection it lists over — close it so a stale listing can't be trusted.
  const onAddressChange = (v: string) => {
    setAddress(v);
    if (browsing) setBrowsing(false);
    setBrowseConn(null);
  };

  const startBrowse = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError("Enter a host as [user@]host[:port] before browsing");
      return;
    }
    setAddError("");
    setBrowseError("");
    setBrowseConnecting(true);
    const password = browsePassword ? browsePassword : null;
    try {
      // Validate the credential + warm the ControlMaster (a key-auth host connects
      // with a null password). `remember: null` never touches the keychain.
      await invoke("ssh_connect", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        password,
        remember: null,
      });
      const configured = await invoke<string | null>("remote_get_default_path", {
        host: parsed.host,
      }).catch(() => null);
      const startDir =
        configured ||
        (await invoke<string>("ssh_default_dir", {
          user: parsed.user,
          host: parsed.host,
          port: parsed.port,
          password,
        }).catch(() => ""));
      setBrowseConn(parsed);
      setBrowsePath(startDir || "/");
      setBrowsing(true);
      invoke<string[]>("remote_list_paths", { host: parsed.host })
        .then(setBrowsePaths)
        .catch(() => setBrowsePaths([]));
    } catch (e) {
      setBrowseError(String(e));
    } finally {
      setBrowseConnecting(false);
    }
  };

  // Refresh the listing whenever the browse path (or frozen connection) changes.
  useEffect(() => {
    if (!browsing || !browseConn) return;
    let cancelled = false;
    setBrowseBusy(true);
    setBrowseError("");
    invoke<RemoteEntry[]>("ssh_list_dir", {
      user: browseConn.user,
      host: browseConn.host,
      port: browseConn.port,
      password: browsePassword ? browsePassword : null,
      path: browsePath,
    })
      .then((entries) => {
        if (!cancelled) setBrowseEntries(entries);
      })
      .catch((e) => {
        if (cancelled) return;
        setBrowseEntries([]);
        setBrowseError(String(e));
      })
      .finally(() => {
        if (!cancelled) setBrowseBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // browsePassword is intentionally omitted: it's frozen at connect time and
    // re-listing on every keystroke would thrash the SFTP session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing, browseConn, browsePath]);

  const enterBrowseFolder = (entry: RemoteEntry) => {
    if (entry.is_dir) setBrowsePath(joinRemotePath(browsePath, entry.name));
  };

  const browseGoUp = () => {
    const p = browsePath.replace(/\/+$/, "");
    if (!p || p === "/") {
      setBrowsePath("/");
      return;
    }
    const idx = p.lastIndexOf("/");
    setBrowsePath(idx <= 0 ? "/" : p.slice(0, idx));
  };

  const addBrowseFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !browseConn) return;
    if (name.includes("/")) {
      setBrowseError("Folder name can't contain '/'.");
      return;
    }
    const target = joinRemotePath(browsePath || "/", name);
    setBrowseBusy(true);
    setBrowseError("");
    try {
      await invoke("ssh_mkdir", {
        user: browseConn.user,
        host: browseConn.host,
        port: browseConn.port,
        password: browsePassword ? browsePassword : null,
        path: target,
      });
      setNewFolderName("");
      setBrowsePath(target); // descend into it; the listing effect refreshes
    } catch (e) {
      setBrowseError(String(e));
      setBrowseBusy(false);
    }
  };

  const useBrowsedFolder = () => {
    setRemotePath(browsePath || "/");
    setBrowsing(false);
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
    const parsed = parseSshAddress(address);
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
      setRemotePath(project.remote?.remote_path ?? "");
      setLabel("");
      setSyncCopy(false);
      setBrowsePassword("");
      setBrowsing(false);
      setBrowseConn(null);
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
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Remote machines</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <p className="settings-help">
          Extra machines run the <strong>same code</strong> as this project. By
          default a machine uses a <strong>shared filesystem</strong>: it already
          sees the primary's project folder at the path below, so Eldrun copies
          nothing and runs no git on it — shells just open in that folder. Tick{" "}
          <strong>Sync a copy</strong> instead to give a machine its own one-way-synced
          copy (read-only code, experiment outputs preserved and pulled on demand) —
          for hosts that don't share storage with the primary.
        </p>

        {/* Existing workers */}
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

        {/* Add machine */}
        <div className="remote-machine-add">
          <div className="remote-machine-add-title">Add a machine</div>
          <label>
            SSH address
            <input
              placeholder="[user@]host[:port]  (e.g. me@gpu-2:22)"
              value={address}
              onChange={(e) => onAddressChange(e.target.value)}
              spellCheck={false}
            />
          </label>
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
                title={
                  syncCopy
                    ? "Connect to this machine and browse to (or create) the folder where the code copy should live."
                    : "Connect to this machine and browse to the shared project folder on it."
                }
                onClick={() => void startBrowse()}
              >
                {browseConnecting ? "Connecting…" : browsing ? "Reconnect" : "Browse…"}
              </button>
            </div>
          </label>
          {/* Transient credential, used only to browse — the worker's real connect
              (and its "Save password") lives in the Connect modal opened later. */}
          <label>
            Password (to browse — not saved)
            <PasswordInput
              placeholder="SSH password — leave blank for key auth"
              value={browsePassword}
              autoComplete="off"
              onChange={(e) => setBrowsePassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void startBrowse();
              }}
            />
          </label>
          {browseError && !browsing && (
            <div className="project-dialog-error">{browseError}</div>
          )}

          {browsing && browseConn && (
            <div className="remote-browser" role="group" aria-label="Remote folder browser">
              <div className="remote-browser-header">
                <button type="button" className="remote-up-btn" onClick={browseGoUp} title="Go up">
                  ..
                </button>
                <span className="remote-breadcrumb" title={browsePath}>
                  {browsePath || "/"}
                </span>
                {browsePaths.length > 0 && (
                  <Dropdown
                    className="vpn-config-recent"
                    value=""
                    placeholder="Recently used…"
                    title="Jump to a previously-used remote path for this host"
                    onChange={(v) => {
                      if (v) setBrowsePath(v);
                    }}
                    options={browsePaths.map((p) => ({ value: p, label: p }))}
                  />
                )}
                <button type="button" onClick={useBrowsedFolder}>
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
                      void addBrowseFolder();
                    }
                  }}
                  disabled={browseBusy}
                />
                <button
                  type="button"
                  onClick={() => void addBrowseFolder()}
                  disabled={browseBusy || !newFolderName.trim()}
                  title="Create a new folder here"
                >
                  + Add folder
                </button>
              </div>
              <div className="remote-list">
                {browseBusy && <div className="scaffold-empty">Listing...</div>}
                {!browseBusy && browseError && (
                  <div className="project-dialog-error">{browseError}</div>
                )}
                {!browseBusy && !browseError && browseEntries.length === 0 && (
                  <div className="scaffold-empty">Empty folder.</div>
                )}
                {!browseBusy &&
                  !browseError &&
                  browseEntries.map((entry) => (
                    <div
                      key={entry.name}
                      className={`remote-entry ${entry.is_dir ? "is-dir" : "is-file"}`}
                      role={entry.is_dir ? "button" : undefined}
                      tabIndex={entry.is_dir ? 0 : undefined}
                      onClick={() => enterBrowseFolder(entry)}
                      onKeyDown={(e) => {
                        if (entry.is_dir && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          enterBrowseFolder(entry);
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
                Browse to a folder, then click “Use this folder”.
              </div>
            </div>
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
          <label className="container-settings-toggle" title="Off (default): this machine shares the primary's project folder over a shared filesystem — no copy, no git. On: give it its own one-way-synced copy of the code (for hosts that don't share storage).">
            <span>Sync a copy of the code to this machine</span>
            <Toggle checked={syncCopy} onChange={(e) => setSyncCopy(e.target.checked)} size="sm" />
          </label>
          {addError && <div className="project-dialog-error">{addError}</div>}
          <div className="project-dialog-actions">
            <button type="button" onClick={onClose}>Close</button>
            <button type="button" disabled={busy} onClick={() => void addMachine()}>
              {busy ? "Adding…" : "Add machine"}
            </button>
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
