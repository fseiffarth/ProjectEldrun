import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  resolveProjectDirectory,
  type GitHostingInfo,
  type GitProvider,
  type ProjectEntry,
  type SandboxSpec,
} from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useActivityStore, type TabStatusCounts } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { isResumableAgentTab, useTabsStore } from "../../stores/tabs";
import { IS_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import { PythonInterpreterWindow } from "./PythonInterpreterWindow";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { providerName, gitTypeLabel } from "./projectTypeTags";
import { ProjectHoverCard, projectDescription, useProjectHoverCard } from "./ProjectHoverCard";
import { ActivityCalendar } from "./ActivityCalendar";
import { CategoryEditor } from "./CategoryEditor";
import { ExtendToRemoteDialog } from "./ExtendToRemoteDialog";
import { useRemoteMachinesStore, type DroppedGlobalMachine } from "../../stores/remoteMachines";
import { GLOBAL_MACHINE_DRAG_TYPE } from "../header/MachinesIndicator";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { RemoteConnMenu } from "../header/RemoteConnMenu";
import { categoryColor, primaryCategoryColor, projectCategories } from "../../lib/categoryColor";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onReorder: (fromId: string, toId: string) => void;
  /** Alt-drop one pill onto another: box the two projects together. */
  onGroup?: (fromId: string, toId: string) => void;
  /** Set when this pill is a member of a box (id of that box). */
  boxId?: string;
  /** Dragging the pill out of its box and releasing over empty space removes it. */
  onLeaveBox?: (projectId: string) => void;
}

export const PILL_DRAG_TYPE = "application/x-eldrun-project";

/** File endings that mark a project as holding Python — the "Python interpreter…"
 *  menu entry is offered only when one is present. Matched against
 *  `list_project_endings` (lowercased). */
const PYTHON_ENDINGS = new Set([".py", ".pyw", ".pyi"]);

/** Folder-icon title/color per git state — mirrors the file-tree markers'
 *  priority (red ▸ orange ▸ green), plus a neutral "clean" default. */
const GIT_ICON_TITLE: Record<GitDirtyState, string> = {
  clean: "No pending changes",
  dirty: "Uncommitted changes — not yet added",
  staged: "Staged changes — not yet committed",
  unpushed: "Committed — not yet pushed",
};

/** Most status bars the pill will draw. A project with more busy tabs than this
 *  would overflow a narrow pill, so the strip stops here and the tooltip carries
 *  the true tally. */
const MAX_STATUS_BARS = 6;

/** The strip's bars, most urgent state first, one per tab. */
function statusBarKinds(c: TabStatusCounts): string[] {
  const kinds = [
    ...Array<string>(c.working).fill("working"),
    ...Array<string>(c.decision).fill("needs-decision"),
    ...Array<string>(c.done).fill("finished"),
  ];
  return kinds.slice(0, MAX_STATUS_BARS);
}

/** Tooltip spelling out the tally the bars stand for (never truncated). */
function statusBarTitle(c: TabStatusCounts): string {
  const parts: string[] = [];
  if (c.working) parts.push(`${c.working} working`);
  if (c.decision) parts.push(`${c.decision} waiting on you`);
  if (c.done) parts.push(`${c.done} finished`);
  return parts.join(" · ");
}

interface ContextMenuPos { x: number; y: number }

function ActivityWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const [data, setData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<Record<string, number>>("get_project_activity", { projectId: project.id })
      .then(setData)
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, [project.id]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="activity-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-window-header">
          <span className="activity-window-title">{project.name} — Activity</span>
          <button className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="activity-window-body">
          {loading ? (
            <div className="activity-loading">Loading…</div>
          ) : (
            <ActivityCalendar data={data} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EditDescriptionWindow({
  project,
  onSave,
  onClose,
}: {
  project: ProjectEntry;
  onSave: (description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(projectDescription(project));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(value);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="project-dialog edit-description-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{project.name} — Description</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <textarea
          value={value}
          autoFocus
          placeholder="Short description for this project…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RenameWindow({
  project,
  onSave,
  onClose,
}: {
  project: ProjectEntry;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!value.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="project-dialog edit-description-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Rename project</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <input
          type="text"
          value={value}
          autoFocus
          placeholder="Project name…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Best-effort guess at the provider for a not-yet-published project: an
 *  explicit prior provider wins, else sniff the profile URL host, else GitHub. */
function guessProvider(project: ProjectEntry): GitProvider {
  if (project.git_provider === "github" || project.git_provider === "gitlab") {
    return project.git_provider;
  }
  if (project.git_profile_url?.toLowerCase().includes("gitlab")) return "gitlab";
  return "github";
}

function PublishWindow({
  project,
  onPublish,
  onClose,
}: {
  project: ProjectEntry;
  onPublish: (provider: GitProvider, visibility: "public" | "private") => Promise<string>;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<GitProvider>(() => guessProvider(project));
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  // The CLI the chosen provider drives, surfaced in the command preview/help.
  const cli = provider === "gitlab" ? "glab" : "gh";
  const createPreview =
    provider === "gitlab"
      ? `glab repo create ${project.name} --${visibility} --remoteName origin && git push`
      : `gh repo create ${project.name} --${visibility} --source=. --push`;

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const output = await onPublish(provider, visibility);
      setResult(output || "Published.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Publish to {providerName(provider)}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Current: {gitTypeLabel(project.git_type, project.git_provider)}
          {isRemoteWork && " · runs on the work-remote host"}
        </div>
        <label>
          Hosting provider
          <Dropdown
            className="dropdown-block"
            value={provider}
            disabled={busy || Boolean(result)}
            onChange={(v) => setProvider(v as GitProvider)}
            options={[
              { value: "github", label: "GitHub" },
              { value: "gitlab", label: "GitLab" },
            ]}
          />
        </label>
        <label>
          Repository visibility
          <Dropdown
            className="dropdown-block"
            value={visibility}
            disabled={busy || Boolean(result)}
            onChange={(v) => setVisibility(v as "public" | "private")}
            options={[
              { value: "private", label: "private" },
              { value: "public", label: "public" },
            ]}
          />
        </label>
        <div className="project-dialog-path">
          Runs <code>{createPreview}</code>. Requires <code>{cli}</code> installed and
          authenticated (or a token under ⚙ Settings → Git hosting).
        </div>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void publish()}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GitHostingWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const getProjectGitHosting = useProjectsStore((s) => s.getProjectGitHosting);
  const setProjectGitHosting = useProjectsStore((s) => s.setProjectGitHosting);
  const [info, setInfo] = useState<GitHostingInfo | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [newToken, setNewToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getProjectGitHosting(project.id)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setProfileUrl(i.profile_url ?? "");
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id, getProjectGitHosting]);

  // A typed token always wins over a "remove" request, so clearing only applies
  // when the user hasn't also entered a replacement.
  const effectiveClear = clearToken && !newToken.trim();

  const tokenStatus = (() => {
    if (newToken.trim()) return "Will set a project token (overrides global).";
    if (effectiveClear) return "Will remove the project token; reverts to the global one.";
    if (info?.has_token) return "A project token is set (hidden). Leave blank to keep it.";
    if (info?.has_global_token) return "Inherits the global token.";
    return "No token set — pushes use your system git credentials.";
  })();

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await setProjectGitHosting(project.id, {
        profileUrl: profileUrl.trim() || null,
        token: newToken.trim() || null,
        clearToken: effectiveClear,
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const globalUrl = info?.global_profile_url ?? "";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Git hosting</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Overrides the global git hosting for this project only. Leave fields blank
          to inherit the global settings.
        </div>

        <label>
          Profile URL
          <input
            type="text"
            value={profileUrl}
            placeholder={
              globalUrl ? `Inherits global: ${globalUrl}` : "https://github.com/me or https://gitlab.com/me"
            }
            onChange={(e) => setProfileUrl(e.target.value)}
          />
        </label>

        <label>
          {info?.has_token ? "Replace access token" : "Access token"}
          <PasswordInput
            value={newToken}
            placeholder={info?.has_token ? "Enter a new token to replace…" : "ghp_… / glpat-…"}
            onChange={(e) => {
              setNewToken(e.target.value);
              if (e.target.value) setClearToken(false);
            }}
          />
        </label>
        <div className="project-dialog-path">{tokenStatus}</div>
        {info?.has_token && !newToken.trim() && (
          <label className="settings-switch-row">
            <span>Remove the project token (use global)</span>
            <Toggle
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
            />
          </label>
        )}

        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !info}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DisableGitWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Require the exact project name to arm the destructive button.
  const armed = typed.trim() === project.name.trim() && !busy;

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Remove git &amp; history</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-error">
          This permanently deletes this project's <code>.git</code> directory —
          every commit, branch, stash, and remote. <strong>It cannot be undone.</strong>
          {" "}The project becomes a “No git (no repo)” project; your working
          files are left untouched.
        </div>
        <label>
          Type the project name <code>{project.name}</code> to confirm
          <input
            type="text"
            value={typed}
            autoFocus
            placeholder={project.name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            onClick={() => void run()}
            disabled={!armed}
          >
            {busy ? "Removing…" : "Delete git history"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Simple (reversible) confirm for deleting a project to the archive. Permanent
 *  deletion lives behind a typed-confirm in Settings → Archived projects. */
function ArchiveConfirmWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Delete {project.name}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          This disconnects <strong>{project.name}</strong> and moves it to the
          Eldrun archive. You can restore it — or permanently delete it — later
          from <em>Settings → Archived projects</em>.
          {project.remote && (
            <> The files on the remote host are <strong>not</strong> touched.</>
          )}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            autoFocus
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete to archive"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Confirm for detaching a remote (SSH) project back to local. The host's files are never
 *  touched — only the local mirror is promoted back in place.
 *
 *  Lives in the pill's **danger zone** despite destroying nothing on either side, because
 *  what it drops is not a file but a *pairing*: `clear_host_bound_state` discards the
 *  byte-sync manifest (every auto-sync marker the user set up for this host, and every
 *  size/mtime base behind the file tree's green) along with the lockstep state. That purge
 *  is mandatory — those records describe ONE host, and a project that keeps its id can be
 *  re-extended to a different one — but it is not undoable, and re-attaching the very same
 *  host means choosing the auto-sync scope again from scratch. Say so before, not after. */
function DetachRemoteWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Detach SSH host</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          This turns <strong>{project.name}</strong> back into a plain local
          project: its local working copy stays exactly where it is and becomes
          the project directory again. The files on the remote host are
          {" "}<strong>not</strong> touched, and nothing local is deleted.
        </p>
        <p className="settings-help">
          What it does drop is the <strong>pairing</strong>: git lockstep stops, and the
          auto-sync scope you chose for this host — which folders cross, and the record of
          what was already in step — is discarded. Re-attaching the same host later means
          picking that scope again from scratch.
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" autoFocus onClick={() => void run()} disabled={busy}>
            {busy ? "Detaching…" : "Detach to local"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Simple confirm for unpublishing (forgetting the push target). Non-destructive:
 *  the hosted repo and local history are both kept. */
/**
 * Edit a project's container spec — image/Dockerfile source, network, resource
 * caps, read-only rootfs (#38). The knobs existed in `SandboxSpec` before but
 * were hand-edit-only; the spec-preserving toggle is what makes exposing them
 * safe. Saving only stores the spec: the container itself is replaced lazily —
 * the spec fingerprint changes, so the next `up` (project activation or tab
 * spawn) recreates it. The `enabled` flag is owned by the menu toggle and
 * passed through unchanged.
 */
function ContainerSettingsWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const setProjectSandboxSpec = useProjectsStore((s) => s.setProjectSandboxSpec);
  const spec = project.sandbox;
  const [dockerfile, setDockerfile] = useState(spec?.dockerfile ?? "");
  const [image, setImage] = useState(spec?.image ?? "");
  const [network, setNetwork] = useState(spec?.network ?? "");
  const [memory, setMemory] = useState(spec?.memory ?? "");
  const [cpus, setCpus] = useState(spec?.cpus ?? "");
  const [pids, setPids] = useState(spec?.pids_limit ? String(spec.pids_limit) : "");
  const [readonly, setReadonly] = useState(spec?.readonly_rootfs ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (busy) return;
    const pidsNum = pids.trim() ? Number(pids.trim()) : undefined;
    if (pidsNum !== undefined && (!Number.isInteger(pidsNum) || pidsNum <= 0)) {
      setError("Process limit must be a positive whole number.");
      return;
    }
    setBusy(true);
    setError("");
    const next: SandboxSpec = {
      enabled: spec?.enabled ?? false,
      dockerfile: dockerfile.trim() || undefined,
      image: image.trim() || undefined,
      network: network.trim() || undefined,
      memory: memory.trim() || undefined,
      cpus: cpus.trim() || undefined,
      pids_limit: pidsNum,
      readonly_rootfs: readonly,
    };
    try {
      await setProjectSandboxSpec(project.id, next);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Container settings</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          Applied at the next container start (project activation or tab spawn) —
          a running container whose settings changed is replaced automatically.
        </p>
        <label>
          Build from a Dockerfile in this project
          <input
            type="text"
            value={dockerfile}
            placeholder="e.g. Dockerfile — empty: use the image below"
            onChange={(e) => setDockerfile(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          Image
          <input
            type="text"
            value={image}
            placeholder="empty: eldrun-agent-sandbox:latest"
            onChange={(e) => setImage(e.target.value)}
            spellCheck={false}
            disabled={Boolean(dockerfile.trim())}
          />
        </label>
        <label>
          Network
          <input
            type="text"
            value={network}
            placeholder={'empty: docker bridge — "none" blocks all egress (breaks cloud agents)'}
            onChange={(e) => setNetwork(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="settings-help">
          Note: the default bridge still reaches services bound on this machine
          (Ollama, dev servers) via the docker gateway IP. Fully closed means
          <code> none</code> or a custom allowlist network.
        </p>
        <label>
          Memory cap
          <input
            type="text"
            value={memory}
            placeholder="e.g. 4g — empty: unlimited"
            onChange={(e) => setMemory(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          CPU cap
          <input
            type="text"
            value={cpus}
            placeholder="e.g. 2 — empty: unlimited"
            onChange={(e) => setCpus(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          Process limit
          <input
            type="text"
            value={pids}
            placeholder="empty: 1024 (fork-bomb guard)"
            onChange={(e) => setPids(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="container-settings-toggle">
          <span>Read-only root filesystem (keeps a writable /tmp)</span>
          <Toggle
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
            size="sm"
          />
        </label>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function UnpublishWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Unpublish</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          This removes the <code>origin</code> remote and resets the project to a
          local git repo. Your commits stay intact and the repository on
          {" "}{providerName(project.git_provider)} is <strong>not</strong>{" "}
          deleted — only the local link to it is dropped. You can re-publish later.
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" autoFocus onClick={() => void run()} disabled={busy}>
            {busy ? "Unpublishing…" : "Unpublish (keep repo)"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Flip a published project's visibility (public ↔ private) in place. */
function VisibilityWindow({
  project,
  onApply,
  onClose,
}: {
  project: ProjectEntry;
  onApply: (visibility: "public" | "private") => Promise<string>;
  onClose: () => void;
}) {
  const current: "public" | "private" =
    project.git_type === "remote-public" ? "public" : "private";
  const target: "public" | "private" = current === "public" ? "private" : "public";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  const cli = project.git_provider === "gitlab" ? "glab" : "gh";

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await onApply(target);
      setResult(out || `Now ${target}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Change visibility</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Current: {providerName(project.git_provider)} · {current}
          {isRemoteWork && " · runs on the work-remote host"}
        </div>
        <p className="settings-help">
          Flip this repository from <strong>{current}</strong> to{" "}
          <strong>{target}</strong> in place via <code>{cli} repo edit</code>. The
          repo, its URL, and its history are preserved.
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void apply()}>
              {busy ? "Applying…" : `Make ${target}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Migrate a published project to the other hosting provider (old repo kept). */
function MigrateProviderWindow({
  project,
  onMigrate,
  onClose,
}: {
  project: ProjectEntry;
  onMigrate: (provider: GitProvider, visibility: "public" | "private") => Promise<string>;
  onClose: () => void;
}) {
  const currentProvider: GitProvider = project.git_provider === "gitlab" ? "gitlab" : "github";
  const [provider, setProvider] = useState<GitProvider>(
    currentProvider === "github" ? "gitlab" : "github",
  );
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);

  const migrate = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await onMigrate(provider, visibility);
      setResult(out || "Migrated.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Move to another provider</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Current: {gitTypeLabel(project.git_type, project.git_provider)}
          {isRemoteWork && " · runs on the work-remote host"}
        </div>
        <label>
          New provider
          <Dropdown
            className="dropdown-block"
            value={provider}
            disabled={busy || Boolean(result)}
            onChange={(v) => setProvider(v as GitProvider)}
            options={[
              { value: "github", label: "GitHub" },
              { value: "gitlab", label: "GitLab" },
            ]}
          />
        </label>
        <label>
          Repository visibility
          <Dropdown
            className="dropdown-block"
            value={visibility}
            disabled={busy || Boolean(result)}
            onChange={(v) => setVisibility(v as "public" | "private")}
            options={[
              { value: "private", label: "private" },
              { value: "public", label: "public" },
            ]}
          />
        </label>
        <p className="settings-help">
          Creates the repo on {providerName(provider)}, re-points{" "}
          <code>origin</code>, and pushes. The existing{" "}
          {providerName(project.git_provider)} repository is{" "}
          <strong>left intact</strong> (kept as <code>origin-old</code>) — delete
          it yourself if you no longer want it.
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void migrate()}>
              {busy ? "Migrating…" : `Move to ${providerName(provider)}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectPill({ project, active, onClick, onClose, onReorder, onGroup, boxId, onLeaveBox }: Props) {
  // Shared hover card (identical popup in the right file-viewer). Owns the
  // popup position, today's time, CPU% and the scaffold-missing flag.
  const hover = useProjectHoverCard(project);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  // Whether a remote project's SSH password sits in the OS keychain — the other way
  // (besides key auth) an auto-connect can run without asking. Filled when the
  // context menu opens; see handleContextMenu.
  const [sshPasswordSaved, setSshPasswordSaved] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [editDescription, setEditDescription] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showGitHosting, setShowGitHosting] = useState(false);
  const [showDisableGit, setShowDisableGit] = useState(false);
  const [showDetach, setShowDetach] = useState(false);
  const [showUnpublish, setShowUnpublish] = useState(false);
  const [showVisibility, setShowVisibility] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [editCategories, setEditCategories] = useState(false);
  const [extendRemote, setExtendRemote] = useState(false);
  // When set, the in-app "Move project…" folder browser is open, seeded at this
  // parent directory. `null` = closed.
  const [movePickerInitial, setMovePickerInitial] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // True while an Alt-drag hovers this pill: the drop will box the two
  // projects together rather than reorder. Drives the distinct hover affordance.
  const [groupHint, setGroupHint] = useState(false);
  const [dragging, setDragging] = useState(false);
  // True while a global machine (MachinesIndicator) is dragged over this pill —
  // distinct from `dragOver` (pill reorder), which never fires for this MIME type.
  const [machineDragOver, setMachineDragOver] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);
  const categories = projectCategories(project);
  const catColor = primaryCategoryColor(categories);

  const timerPaused = useTimerStore((s) => s.paused);
  // One little bar per non-idle tab along the bottom edge of the pill, so a
  // glance at the switcher says how many tabs of each project are working
  // (green, pulsing), waiting on a decision (orange, pulsing) or finished unseen
  // (green, steady). This replaced a whole-pill tint that could only ever show
  // one state and said nothing about how many tabs were in it.
  // The SELECTED project keeps its bars: the strip is a tally of what the project
  // is doing, not a list of what still needs a glance, and the project you are in
  // is the one whose agents you most need to see running. Only "finished unseen"
  // is inherently about unread output, and it can't arise for a tab on screen.
  const statusCounts = useActivityStore((s) => s.statusCountsByScope[project.id]);
  const gitDirty = useGitDirtyStore((s) => s.byId[project.id]);
  const updateProjectDescription = useProjectsStore((s) => s.updateProjectDescription);
  const renameProject = useProjectsStore((s) => s.renameProject);
  const moveRemoteMirror = useProjectsStore((s) => s.moveRemoteMirror);
  const setProjectSandbox = useProjectsStore((s) => s.setProjectSandbox);
  const [showContainerSettings, setShowContainerSettings] = useState(false);
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const [showPythonSettings, setShowPythonSettings] = useState(false);
  // Whether this project actually contains Python files — the interpreter/venv
  // setting is only worth offering then. Probed lazily when the context menu
  // opens (see handleContextMenu), like the saved-password lookup, so no pill
  // scans on render. `null` = not yet probed. A remote project's `directory` is
  // its local state dir, not the host tree, so the local ending scan can't see
  // its files: offer the setting for any remote project rather than hide it
  // wrongly (the dialog probes the host for that project anyway).
  const [hasPythonFiles, setHasPythonFiles] = useState<boolean | null>(null);
  const showPython = project.remote ? true : hasPythonFiles === true;

  // Flip the project-container toggle. The flag is in every TerminalView's
  // spawn deps, so flipping respawns each live tab of this project —
  // Claude/Codex resume across the respawn, but a live NON-resumable agent
  // (Gemini/Vibe/…) would lose its conversation: confirm before destroying it
  // (the same hazard class tabs/agentModes.ts exists for). On enable, run the
  // docker preflight right away so a missing image becomes a one-click build
  // running in a fresh terminal tab (house convention — never a
  // copy-it-yourself message) instead of an error at the next tab spawn.
  const toggleContainer = useCallback(async () => {
    const enabling = !project.sandbox?.enabled;
    const tabs = useTabsStore.getState().tabsByScope[project.id] ?? [];
    const doomed = tabs.filter((t) => t.kind === "agent" && !isResumableAgentTab(t));
    if (doomed.length > 0) {
      const names = [...new Set(doomed.map((t) => t.cmd))].join(", ");
      const ok = await confirm(
        `Turning the container ${enabling ? "on" : "off"} restarts every tab of this project. ` +
          `${doomed.length} agent tab${doomed.length > 1 ? "s" : ""} (${names}) cannot resume ` +
          `and will lose the conversation. Continue?`,
        { title: "Restart this project's tabs?", kind: "warning" },
      );
      if (!ok) return;
    }
    await setProjectSandbox(project.id, enabling);
    if (!enabling) return;
    try {
      const pf = await invoke<{ status: string; image: string; build_command: string | null }>(
        "sandbox_preflight",
        { projectId: project.id },
      );
      if (pf.status === "image_missing" && pf.build_command) {
        runInstallInTab(`container image ${pf.image}`, pf.build_command, "bash");
      } else if (pf.status === "daemon_down") {
        useProjectsStore.setState({
          switchToast: "Docker isn't running — start it before opening tabs in this project",
        });
      } else if (pf.status === "no_docker") {
        useProjectsStore.setState({
          switchToast: "Docker isn't installed — the container toggle needs it",
        });
      }
    } catch {
      // Preflight is advisory; a real problem still surfaces in the next tab spawn.
    }
  }, [project.id, project.sandbox?.enabled, setProjectSandbox]);

  const setProjectAutoConnect = useProjectsStore((s) => s.setProjectAutoConnect);
  const setProjectPersistSessions = useProjectsStore((s) => s.setProjectPersistSessions);
  // Auto-connect is only offered when the connect can complete with no prompt: a
  // key/agent-auth host (recorded by the backend on its last successful connect) or
  // a password in the keychain (looked up when the menu opens).
  const autoConnectEligible = project.remote?.key_auth === true || sshPasswordSaved;
  const setProjectGitDisabled = useProjectsStore((s) => s.setProjectGitDisabled);
  const repairProjectScaffold = useProjectsStore((s) => s.repairProjectScaffold);
  const publishProject = useProjectsStore((s) => s.publishProject);
  const detachProjectFromRemote = useProjectsStore((s) => s.detachProjectFromRemote);
  const unpublishProject = useProjectsStore((s) => s.unpublishProject);
  const setProjectVisibility = useProjectsStore((s) => s.setProjectVisibility);
  const switchProjectProvider = useProjectsStore((s) => s.switchProjectProvider);
  const archiveProject = useProjectsStore((s) => s.archiveProject);

  // Reveal the project on disk. Local projects open their working directory; a
  // remote (SSH) project has no local tree, so we open its local mirror — the
  // paired connected working copy. If that mirror folder was deleted, let the
  // user freely pick a new location (defaulting to an ssh/<name> subfolder of the
  // projects root), which the backend re-creates and persists.
  const revealOnDisk = useCallback(async () => {
    try {
      let path: string | undefined = dir;
      if (project.remote) {
        const status = await invoke<{ path: string; exists: boolean; suggested: string }>(
          "remote_mirror_status",
          { projectId: project.id, name: project.name },
        );
        path = status.path;
        if (!status.exists) {
          const chosen = await open({
            directory: true,
            defaultPath: status.suggested,
            title: `${project.name} — choose a local mirror folder`,
          });
          if (typeof chosen !== "string") return; // cancelled
          path = await invoke<string>("set_remote_mirror_dir", {
            projectId: project.id,
            path: chosen,
          });
        }
      }
      if (!path) return;
      await invoke("open_in_file_manager", { path });
    } catch (e) {
      console.error("show on disk", e);
    }
  }, [project.remote, project.id, project.name, dir]);

  // Relocate a remote project's local mirror folder. Opens the in-app folder
  // browser (not the OS chooser) seeded at the current mirror's parent; the user
  // browses to a *parent* directory and the backend moves the mirror (and its
  // bytes) to `<parent>/<name>`, re-pointing the pointer. The confirm handler
  // (below, on the dialog) runs the move.
  const moveMirror = useCallback(async () => {
    if (!project.remote) return;
    try {
      const status = await invoke<{ path: string; exists: boolean; suggested: string }>(
        "remote_mirror_status",
        { projectId: project.id, name: project.name },
      );
      const parentOf = (p: string): string => {
        const trimmed = p.replace(/[/\\]+$/, "");
        const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
        return idx > 0 ? trimmed.slice(0, idx) : trimmed;
      };
      setMovePickerInitial(parentOf(status.exists ? status.path : status.suggested));
    } catch (e) {
      console.error("move mirror", e);
      // Fall back to opening the picker at the home default (empty path).
      setMovePickerInitial("");
    }
  }, [project.remote, project.id, project.name]);

  // Confirm handler for the in-app move picker: relocate the mirror into the
  // chosen parent, patch in-memory state (moveRemoteMirror), and close.
  const confirmMove = useCallback(
    async (parent: string, name?: string) => {
      setMovePickerInitial(null);
      try {
        // The chosen name defines the new local mirror folder (backend
        // sanitizes it); fall back to the display name when left blank.
        await moveRemoteMirror(project.id, name?.trim() || project.name, parent);
      } catch (e) {
        console.error("move mirror", e);
      }
    },
    [project.id, project.name, moveRemoteMirror],
  );

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [contextMenu]);

  const handleMouseEnter = () => {
    if (contextMenu) return;
    if (!pillRef.current) return;
    void hover.open(pillRef.current.getBoundingClientRect());
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    hover.close();
    // Auto-connect is only offerable when connecting needs nothing from the user.
    // `key_auth` is on the spec already; a saved password has to be asked for (a
    // local keychain lookup — no network, and the secret never leaves the backend).
    if (project.remote && project.remote.key_auth !== true) {
      void invoke<boolean>("remote_has_saved_password", {
        user: project.remote.user ?? null,
        host: project.remote.host,
        port: project.remote.port ?? null,
      })
        .then(setSshPasswordSaved)
        .catch(() => setSshPasswordSaved(false));
    }
    // Does this project hold any Python files? Gates the "Python interpreter…"
    // entry below. A cheap local ending scan (already the file tree's "hide these
    // endings" source), skipped for remote projects whose files live on the host
    // (showPython shows those regardless — see hasPythonFiles).
    if (!project.remote) {
      const dir = resolveProjectDirectory(project);
      if (dir) {
        void invoke<string[]>("list_project_endings", { projectDir: dir })
          .then((endings) =>
            setHasPythonFiles(
              endings.some((e) => PYTHON_ENDINGS.has(e.toLowerCase())),
            ),
          )
          .catch(() => setHasPythonFiles(false));
      } else {
        setHasPythonFiles(false);
      }
    }
    // Anchor to the pill's bottom-left corner so the menu opens downward, below
    // the bar, with its left edge flush to the pill's left border.
    const rect = pillRef.current?.getBoundingClientRect();
    setContextMenu({
      x: rect ? rect.left : e.clientX,
      y: rect ? rect.bottom : e.clientY,
    });
  };

  return (
    <>
      {/* Hover popup — hidden while context menu is open (which calls hover.close). */}
      {!contextMenu && <ProjectHoverCard project={project} state={hover} />}

      {/* Right-click context menu */}
      {contextMenu && createPortal(
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* View / inspect */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">View</div>
            <button
              onClick={() => {
                setContextMenu(null);
                setShowActivity(true);
              }}
            >
              Show Activity
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                void revealOnDisk();
              }}
              title={
                project.remote
                  ? "Open the local mirror (the connected working copy) in the file manager"
                  : "Open the project directory in the file manager"
              }
            >
              Show on disk
            </button>
          </div>

          {/* Edit metadata */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Edit</div>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenaming(true);
              }}
            >
              Rename…
            </button>
            {project.remote && (
              <button
                className="untested"
                onClick={() => {
                  setContextMenu(null);
                  void moveMirror();
                }}
                title="Move this project's local mirror (the connected working copy) to a new folder"
              >
                Move project…
                <UntestedTag />
              </button>
            )}
            <button
              onClick={() => {
                setContextMenu(null);
                setEditDescription(true);
              }}
            >
              Edit description
            </button>
            <button
              className="untested"
              onClick={() => {
                setContextMenu(null);
                setEditCategories(true);
              }}
              title="Tag this project to color and group it in the cloud and the pill bar"
            >
              Categories…
              <UntestedTag />
            </button>
            <button
              className="untested"
              onClick={() => {
                setContextMenu(null);
                void repairProjectScaffold(project.id);
              }}
              title="Fill in any missing scaffold file, default .gitignore pattern, or .claude/settings.json — never overwrites existing content"
            >
              Repair scaffold files
              <UntestedTag />
            </button>
            {!project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setExtendRemote(true);
                }}
                title="Attach a remote SSH host to this local project — files stay put; push them up manually"
              >
                Extend to remote…
              </button>
            )}
          </div>

          {/* Git */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Git</div>
            {project.git_type === "none" ? (
              !project.remote && (
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    void setProjectGitDisabled(project.id, false);
                  }}
                  title="Run git init to start version-controlling this project"
                >
                  Enable git (git init)
                  <UntestedTag />
                </button>
              )
            ) : typeof project.git_type === "string" && project.git_type.startsWith("remote") ? (
              // Already published — offer in-place management, not another publish.
              <>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowVisibility(true);
                  }}
                  title="Flip the repository between public and private in place (gh/glab repo edit)"
                >
                  {project.git_type === "remote-public" ? "Make private…" : "Make public…"}
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowMigrate(true);
                  }}
                  title="Publish to the other provider and re-point origin; the old repo is left intact"
                >
                  Move to {project.git_provider === "gitlab" ? "GitHub" : "GitLab"}…
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowUnpublish(true);
                  }}
                  title="Remove the origin remote and go back to a local repo; the hosted repo and history are kept"
                >
                  Unpublish (keep repo)…
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowGitHosting(true);
                  }}
                  title="Override the global git hosting (profile URL + token) for this project only"
                >
                  Git hosting…
                  <UntestedTag />
                </button>
              </>
            ) : (
              // Local git repo, not yet pushed anywhere.
              <button
                className="untested"
                onClick={() => {
                  setContextMenu(null);
                  setShowPublish(true);
                }}
              >
                Publish to GitHub / GitLab…
                <UntestedTag />
              </button>
            )}
          </div>

          {/* Runtime */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Runtime</div>
            {/* Project container (#38): local projects only (a remote project's
                tabs already run on its host), hidden on Windows (the backend
                refuses — host paths mean nothing inside a Linux container). */}
            {!project.remote && !IS_WINDOWS && (
              <>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    void toggleContainer();
                  }}
                  title="Run every terminal and agent tab of this project inside one closed Docker container. The project folder stays on the host at its normal path — the container just can't reach anything else."
                >
                  {project.sandbox?.enabled ? "✓ " : ""}Run this project in a container
                </button>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowContainerSettings(true);
                  }}
                  title="Image, network, memory/CPU caps and read-only rootfs for this project's container"
                >
                  Container settings…
                </button>
              </>
            )}
            {showPython && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setShowPythonSettings(true);
                }}
                title="The Python environment this project's scripts run and debug in. Auto-detected by default (in-tree venv, poetry, conda, pyenv); pin one when your environment lives somewhere Eldrun can't infer."
              >
                {project.python_interpreter ? "✓ " : ""}Python interpreter…
              </button>
            )}
            {project.remote && (
              <button
                disabled={!autoConnectEligible}
                onClick={() => {
                  setContextMenu(null);
                  void setProjectAutoConnect(project.id, !project.remote?.auto_connect);
                }}
                title={
                  autoConnectEligible
                    ? "Connect this project by itself on launch and when you switch to it. It never asks for anything: it goes straight in when the host is reachable, and brings the VPN up only when it isn't."
                    : "Save the SSH password (or use key authentication) first — auto-connect is only offered when connecting needs nothing from you."
                }
              >
                {project.remote.auto_connect ? "✓ " : ""}Auto-connect on launch
              </button>
            )}
            {/* Persistent remote sessions (TODO #85): shell/script tabs run inside a
                tmux session on the host, so a long run survives an SSH drop, a
                laptop sleep, or Eldrun quitting. Default ON — this opts out. */}
            {project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  void setProjectPersistSessions(
                    project.id,
                    project.remote?.persist_sessions === false,
                  );
                }}
                title="Run this project's remote shell and Python/script tabs inside a tmux session on the host, so a long run keeps going through an SSH drop, a laptop sleep, or Eldrun quitting — the tab reattaches when you reconnect. Closing a tab still ends its session (with a confirm). Agent tabs are unaffected."
              >
                {project.remote.persist_sessions !== false ? "✓ " : ""}Persistent sessions (tmux)
              </button>
            )}
            {/* Multi-host remote (docs/multi_host_remote_plan.md): manage the extra
                "worker" machines this project runs experiments on. Remote only. */}
            {project.remote && (
              <button
                className="untested"
                onClick={() => {
                  setContextMenu(null);
                  openRemoteMachines(project.id);
                }}
                title="Add and manage extra machines this project runs on. They run the same code (kept in one-way sync) as read-only experiment workers; their outputs stay on each machine."
              >
                {project.compute_hosts?.length
                  ? `Remote machines… (${project.compute_hosts.length})`
                  : "Remote machines…"}
                <UntestedTag />
              </button>
            )}
            <button
              onClick={() => {
                setContextMenu(null);
                const tabsStore = useTabsStore.getState();
                // Tear down every detached popout for this project first: each
                // one kills its tabs' PTYs and closes its OS window (in-window
                // closeAllTabs below never touches detached groups).
                for (const g of tabsStore.detachedGroupsByScope[project.id] ?? []) {
                  tabsStore.closeDetachedGroup(project.id, g.id);
                }
                // Clear this project's in-window tabs. For the ACTIVE project the
                // debounced persist effect writes the empty layout; for a non-active
                // project nothing else writes it, so persist explicitly.
                tabsStore.closeAllTabs(project.id);
                if (project.local_file) {
                  void invoke("save_tab_layout", {
                    localFile: project.local_file,
                    tabs: [],
                    groups: null,
                    sessions: [],
                    // This is THE close-all: the one empty save that is meant, by a user
                    // who clicked a button that says so. Everywhere else an empty layout
                    // is refused, because it far more often means "the caller had nothing
                    // loaded" than "erase four tabs and their agent conversations".
                    allowClear: true,
                  }).catch(() => {});
                }
              }}
            >
              Close all tabs and windows
            </button>
          </div>

          {/* Danger zone — irreversible / destructive actions, fenced off */}
          <div className="context-menu-danger-zone">
            <div className="context-menu-group-label">Danger zone</div>
            {project.remote && (
              <button
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  setShowDetach(true);
                }}
                title="Turn this back into a local project. The local working copy stays put and the remote host's files are untouched — but the pairing is dropped: lockstep stops, and the auto-sync scope you set up for this host is discarded."
              >
                Detach SSH host…
              </button>
            )}
            {!project.remote && project.git_type !== "none" && (
              <button
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  setShowDisableGit(true);
                }}
                title="Delete this project's .git directory and all version-control history (cannot be undone)"
              >
                Remove git &amp; history…
              </button>
            )}
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                setShowArchive(true);
              }}
              title="Disconnect this project and move it to the Eldrun archive. Restore or permanently delete it later from Settings. A remote host's files are never touched."
            >
              Delete project…
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Activity window */}
      {showActivity && (
        <ActivityWindow project={project} onClose={() => setShowActivity(false)} />
      )}

      {/* Rename window */}
      {renaming && (
        <RenameWindow
          project={project}
          onSave={(name) => renameProject(project.id, name)}
          onClose={() => setRenaming(false)}
        />
      )}

      {/* Edit description window */}
      {editDescription && (
        <EditDescriptionWindow
          project={project}
          onSave={(desc) => updateProjectDescription(project.id, desc)}
          onClose={() => setEditDescription(false)}
        />
      )}

      {/* Publish-to-GitHub/GitLab window */}
      {showPublish && (
        <PublishWindow
          project={project}
          onPublish={(provider, visibility) => publishProject(project.id, provider, visibility)}
          onClose={() => setShowPublish(false)}
        />
      )}

      {/* Per-project git-hosting override window */}
      {showGitHosting && (
        <GitHostingWindow project={project} onClose={() => setShowGitHosting(false)} />
      )}

      {/* Category-tag editor */}
      {editCategories && (
        <CategoryEditor project={project} onClose={() => setEditCategories(false)} />
      )}

      {/* Project-container spec knobs (image, network, resource caps) */}
      {showContainerSettings && (
        <ContainerSettingsWindow
          project={project}
          onClose={() => setShowContainerSettings(false)}
        />
      )}


      {/* Which Python the viewer's Run/Debug buttons use (#87) */}
      {showPythonSettings && (
        <PythonInterpreterWindow
          project={project}
          onClose={() => setShowPythonSettings(false)}
        />
      )}

      {/* Extend a local project to remote (attach an SSH host) */}
      {extendRemote && (
        <ExtendToRemoteDialog project={project} onClose={() => setExtendRemote(false)} />
      )}

      {/* Detach a remote project back to local */}
      {showDetach && (
        <DetachRemoteWindow
          project={project}
          onConfirm={() => detachProjectFromRemote(project.id)}
          onClose={() => setShowDetach(false)}
        />
      )}

      {/* Unpublish (forget the push target, keep repo + history) */}
      {showUnpublish && (
        <UnpublishWindow
          project={project}
          onConfirm={() => unpublishProject(project.id)}
          onClose={() => setShowUnpublish(false)}
        />
      )}

      {/* Flip repository visibility (public ↔ private) in place */}
      {showVisibility && (
        <VisibilityWindow
          project={project}
          onApply={(visibility) => setProjectVisibility(project.id, visibility)}
          onClose={() => setShowVisibility(false)}
        />
      )}

      {/* Migrate to the other hosting provider */}
      {showMigrate && (
        <MigrateProviderWindow
          project={project}
          onMigrate={(provider, visibility) => switchProjectProvider(project.id, provider, visibility)}
          onClose={() => setShowMigrate(false)}
        />
      )}

      {/* In-app folder browser for "Move project…" (replaces the OS chooser) */}
      {movePickerInitial !== null && (
        <FolderPickerDialog
          initialPath={movePickerInitial}
          title={`${project.name} — move mirror folder to…`}
          confirmLabel="Move here"
          nameLabel="Local folder name"
          nameInitial={project.name}
          onConfirm={confirmMove}
          onClose={() => setMovePickerInitial(null)}
        />
      )}

      {/* Destructive: delete .git + history (typed-confirm) */}
      {showDisableGit && (
        <DisableGitWindow
          project={project}
          onConfirm={() => setProjectGitDisabled(project.id, true)}
          onClose={() => setShowDisableGit(false)}
        />
      )}

      {/* Delete → archive (reversible; simple confirm) */}
      {showArchive && (
        <ArchiveConfirmWindow
          project={project}
          onConfirm={() => archiveProject(project.id)}
          onClose={() => setShowArchive(false)}
        />
      )}

      <div
        ref={pillRef}
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}${dragOver ? " drag-over" : ""}${groupHint ? " drag-group" : ""}${dragging ? " dragging" : ""}${catColor ? " has-category" : ""}${machineDragOver ? " machine-drag-over" : ""}`}
        style={catColor ? ({ "--cat-color": catColor } as React.CSSProperties) : undefined}
        draggable
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => hover.close()}
        onContextMenu={handleContextMenu}
        onDragStart={(e) => {
          // Hide the hover popup so it doesn't linger as a drag ghost.
          hover.close();
          setDragging(true);
          e.dataTransfer.setData(PILL_DRAG_TYPE, project.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(GLOBAL_MACHINE_DRAG_TYPE)) {
            // Only a remote project can host a worker; a local one simply
            // doesn't accept the drop (no preventDefault → rejecting cursor).
            if (!project.remote) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!machineDragOver) setMachineDragOver(true);
            return;
          }
          if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
          // Alt toggles the gesture to "box these two together" (see onDrop).
          const wantGroup = e.altKey && !!onGroup;
          if (wantGroup !== groupHint) setGroupHint(wantGroup);
        }}
        onDragLeave={() => { setDragOver(false); setGroupHint(false); setMachineDragOver(false); }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(GLOBAL_MACHINE_DRAG_TYPE)) {
            setMachineDragOver(false);
            if (!project.remote) return;
            const raw = e.dataTransfer.getData(GLOBAL_MACHINE_DRAG_TYPE);
            if (!raw) return;
            e.preventDefault();
            // Don't also bubble into an enclosing BoxChip/pills-strip handler.
            e.stopPropagation();
            try {
              const machine = JSON.parse(raw) as DroppedGlobalMachine;
              openRemoteMachines(project.id, machine);
            } catch {
              // Malformed payload — ignore the drop.
            }
            return;
          }
          setDragOver(false);
          setGroupHint(false);
          const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
          if (!fromId || fromId === project.id) return;
          e.preventDefault();
          // Consume the drop so it does NOT also bubble to an enclosing BoxChip
          // (→ assign-to-box) or the ungrouped pills strip (→ assign-to-null).
          e.stopPropagation();
          // Alt-drop boxes the two projects together; a plain drop reorders.
          if (e.altKey && onGroup) {
            onGroup(fromId, project.id);
          } else {
            onReorder(fromId, project.id);
          }
        }}
        onDragEnd={(e) => {
          setDragOver(false);
          setGroupHint(false);
          setDragging(false);
          // Released over no drop target (dropEffect "none") while this pill is a
          // box member → drag-out: remove it from the box. Drops that landed on a
          // real target (strip, another box, a reorder) set "move" and are handled
          // there, so they don't also trigger a leave here.
          if (boxId && onLeaveBox && e.dataTransfer.dropEffect === "none") {
            onLeaveBox(project.id);
          }
        }}
      >
        <button className="pill-main" onClick={onClick}>
          <span
            className={`pill-folder-icon${timerPaused ? "" : ` git-${gitDirty ?? "clean"}`}`}
            title={timerPaused ? undefined : GIT_ICON_TITLE[gitDirty ?? "clean"]}
            aria-hidden
          >
            {timerPaused ? (
              "⏸"
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
              </svg>
            )}
          </span>
          <span className="project-pill-label">{project.name}</span>
        </button>
        {categories.length > 0 && (
          <span className="pill-category-dots" title={`Categories: ${categories.join(", ")}`}>
            {categories.map((cat) => (
              <span
                key={cat.toLowerCase()}
                className="pill-category-dot"
                style={{ background: categoryColor(cat) }}
              />
            ))}
          </span>
        )}
        {project.remote && <RemoteConnMenu project={project} compact />}
        <button
          className="pill-close-btn"
          title="Close project"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          ×
        </button>
        {statusCounts && (
          <span className="pill-status-bars" title={statusBarTitle(statusCounts)}>
            {statusBarKinds(statusCounts).map((kind, i) => (
              <span key={i} className={`pill-status-bar ${kind}`} />
            ))}
          </span>
        )}
      </div>
    </>
  );
}
