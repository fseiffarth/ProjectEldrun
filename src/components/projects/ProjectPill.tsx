import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  resolveProjectDirectory,
  type GitHostingInfo,
  type GitProvider,
  type ProjectEntry,
} from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useActivityStore, type TabStatusCounts } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { providerName, gitTypeLabel } from "./projectTypeTags";
import { ProjectHoverCard, projectDescription, useProjectHoverCard } from "./ProjectHoverCard";
import { ActivityCalendar } from "./ActivityCalendar";
import { CategoryEditor } from "./CategoryEditor";
import { ExtendToRemoteDialog } from "./ExtendToRemoteDialog";
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

/** Simple confirm for detaching a remote (SSH) project back to local. The host's
 *  files are never touched — only the local mirror is promoted back in place. */
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
          {" "}<strong>not</strong> touched — this only drops the SSH link.
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
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);
  const categories = projectCategories(project);
  const catColor = primaryCategoryColor(categories);

  const timerPaused = useTimerStore((s) => s.paused);
  // Whole-pill status glow, matching the tab lamps: working (green pulse) wins,
  // else an agent in this project needs a decision (orange pulse) or has finished
  // unseen (green steady). Attention rolls up from the project's background tabs.
  // One little bar per non-idle tab along the bottom edge of the pill, so a
  // glance at the switcher says how many tabs of each project are working
  // (green, pulsing), waiting on a decision (orange, pulsing) or finished unseen
  // (green, steady). This replaced a whole-pill tint that could only ever show
  // one state and said nothing about how many tabs were in it.
  const statusCounts = useActivityStore((s) => s.statusCountsByScope[project.id]);
  const gitDirty = useGitDirtyStore((s) => s.byId[project.id]);
  const updateProjectDescription = useProjectsStore((s) => s.updateProjectDescription);
  const renameProject = useProjectsStore((s) => s.renameProject);
  const moveRemoteMirror = useProjectsStore((s) => s.moveRemoteMirror);
  const setProjectSandbox = useProjectsStore((s) => s.setProjectSandbox);
  const setProjectAutoConnect = useProjectsStore((s) => s.setProjectAutoConnect);
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
                onClick={() => {
                  setContextMenu(null);
                  void moveMirror();
                }}
                title="Move this project's local mirror (the connected working copy) to a new folder"
              >
                Move project…
              </button>
            )}
            {project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setShowDetach(true);
                }}
                title="Turn this back into a local project — the local working copy stays put; the remote host's files are untouched"
              >
                Detach SSH host…
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
              onClick={() => {
                setContextMenu(null);
                setEditCategories(true);
              }}
              title="Tag this project to color and group it in the cloud and the pill bar"
            >
              Categories…
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                void repairProjectScaffold(project.id);
              }}
              title="Fill in any missing scaffold file, default .gitignore pattern, or .claude/settings.json — never overwrites existing content"
            >
              Repair scaffold files
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
                  onClick={() => {
                    setContextMenu(null);
                    void setProjectGitDisabled(project.id, false);
                  }}
                  title="Run git init to start version-controlling this project"
                >
                  Enable git (git init)
                </button>
              )
            ) : typeof project.git_type === "string" && project.git_type.startsWith("remote") ? (
              // Already published — offer in-place management, not another publish.
              <>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowVisibility(true);
                  }}
                  title="Flip the repository between public and private in place (gh/glab repo edit)"
                >
                  {project.git_type === "remote-public" ? "Make private…" : "Make public…"}
                </button>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowMigrate(true);
                  }}
                  title="Publish to the other provider and re-point origin; the old repo is left intact"
                >
                  Move to {project.git_provider === "gitlab" ? "GitHub" : "GitLab"}…
                </button>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowUnpublish(true);
                  }}
                  title="Remove the origin remote and go back to a local repo; the hosted repo and history are kept"
                >
                  Unpublish (keep repo)…
                </button>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowGitHosting(true);
                  }}
                  title="Override the global git hosting (profile URL + token) for this project only"
                >
                  Git hosting…
                </button>
              </>
            ) : (
              // Local git repo, not yet pushed anywhere.
              <button
                onClick={() => {
                  setContextMenu(null);
                  setShowPublish(true);
                }}
              >
                Publish to GitHub / GitLab…
              </button>
            )}
          </div>

          {/* Runtime */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Runtime</div>
            {!project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  void setProjectSandbox(project.id, !project.sandbox?.enabled);
                }}
                title="Run this project's agent tabs inside a Docker container that mounts only the project directory"
              >
                {project.sandbox?.enabled ? "✓ " : ""}Run agents in Docker sandbox
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
                // debounced saveLayout effect persists the empty layout; for a
                // non-active project nothing else writes it, so persist explicitly.
                tabsStore.closeAllTabs(project.id);
                if (project.local_file) {
                  void invoke("save_tab_layout", {
                    localFile: project.local_file,
                    tabs: [],
                    groups: null,
                    sessions: [],
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
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}${dragOver ? " drag-over" : ""}${groupHint ? " drag-group" : ""}${dragging ? " dragging" : ""}${catColor ? " has-category" : ""}`}
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
          if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
          // Alt toggles the gesture to "box these two together" (see onDrop).
          const wantGroup = e.altKey && !!onGroup;
          if (wantGroup !== groupHint) setGroupHint(wantGroup);
        }}
        onDragLeave={() => { setDragOver(false); setGroupHint(false); }}
        onDrop={(e) => {
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
