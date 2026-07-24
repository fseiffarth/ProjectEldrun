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
  type PublishFrom,
  type SandboxSpec,
} from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useActivityStore, type TabStatusCounts } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { isResumableAgentTab, useTabsStore } from "../../stores/tabs";
import { IS_WINDOWS } from "../../lib/platform";
import { runInstallInTab, PROVIDER_CLI_INSTALL, providerAuthLoginCmd } from "../../lib/installCommand";
import { PythonInterpreterWindow } from "./PythonInterpreterWindow";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { providerName, gitTypeLabel } from "./projectTypeTags";
import { ProjectHoverCard, projectDescription, useProjectHoverCard } from "./ProjectHoverCard";
import { ActivityCalendar } from "./ActivityCalendar";
import { CategoryEditor } from "./CategoryEditor";
import { ExtendToRemoteDialog } from "./ExtendToRemoteDialog";
import { useRemoteMachinesStore, type DroppedGlobalMachine } from "../../stores/remoteMachines";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { RemoteConnMenu } from "../header/RemoteConnMenu";
import { categoryColor, primaryCategoryColor, projectCategories } from "../../lib/categoryColor";
import { usePillDragStore } from "../../stores/pillDrag";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useT, type TranslationKey } from "../../lib/i18n";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onReorder: (fromId: string, toId: string) => void;
  /** Alt-drop one pill onto another: box the two projects together. */
  onGroup?: (fromId: string, toId: string) => void;
  /** Drop onto a box pill: assign this project to that box instead of reordering. */
  onAssignToBox?: (boxId: string) => void;
  /** True while THIS pill is the one being pointer-dragged. ProjectSwitcher owns
   *  the shared gesture state (`stores/pillDrag`) so every sibling can react to
   *  one gesture without prop-drilling the raw drag object through each pill. */
  isDragged?: boolean;
  /** Live pointer-follow offset (px) while `isDragged`. */
  dragDx?: number;
  /** Parting offset (px) while a SIBLING pill is being dragged past this one —
   *  the "nicely apart" slide that opens its landing slot. */
  shiftPx?: number;
  /** An Alt-drag is hovering THIS pill as a group (new-box) target. */
  groupHintActive?: boolean;
}

/** File endings that mark a project as holding Python — the "Python interpreter…"
 *  menu entry is offered only when one is present. Matched against
 *  `list_project_endings` (lowercased). */
const PYTHON_ENDINGS = new Set([".py", ".pyw", ".pyi"]);

/** Folder-icon title/color per git state — mirrors the file-tree markers'
 *  priority (red ▸ orange ▸ green), plus a neutral "clean" default. */
const GIT_ICON_TITLE_KEY: Record<GitDirtyState, TranslationKey> = {
  clean: "pill.gitClean",
  dirty: "pill.gitDirty",
  staged: "pill.gitStaged",
  unpushed: "pill.gitUnpushed",
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
function statusBarTitle(c: TabStatusCounts, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (c.working) parts.push(t("pill.statusWorking", { count: c.working }));
  if (c.decision) parts.push(t("pill.statusWaiting", { count: c.decision }));
  if (c.done) parts.push(t("pill.statusFinished", { count: c.done }));
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
  const t = useT();
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
          <span className="activity-window-title">{t("pill.activityTitle", { name: project.name })}</span>
          <button className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="activity-window-body">
          {loading ? (
            <div className="activity-loading">{t("common.loading")}</div>
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
  const t = useT();
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
          <h2>{t("pill.descTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <textarea
          value={value}
          autoFocus
          placeholder={t("pill.descPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
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
  const t = useT();
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!value.trim()) {
      setError(t("pill.nameEmpty"));
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
          <h2>{t("pill.renameTitle")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <input
          type="text"
          value={value}
          autoFocus
          placeholder={t("pill.namePlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
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

/** The provider's own "create a personal access token" page. Reads the host
 *  off a configured profile URL so a self-hosted GitLab/GitHub Enterprise
 *  instance gets its own token page rather than the public one. */
function tokenPageUrl(provider: GitProvider, profileUrl: string): string {
  let host = provider === "gitlab" ? "gitlab.com" : "github.com";
  try {
    const parsed = new URL(profileUrl);
    if (parsed.host) host = parsed.host;
  } catch {
    // No usable profile URL yet — fall back to the public host.
  }
  return provider === "gitlab"
    ? `https://${host}/-/user_settings/personal_access_tokens`
    : `https://${host}/settings/tokens`;
}

function PublishWindow({
  project,
  onPublish,
  onClose,
}: {
  project: ProjectEntry;
  onPublish: (
    provider: GitProvider,
    visibility: "public" | "private",
    publishFrom: PublishFrom,
  ) => Promise<string>;
  onClose: () => void;
}) {
  const t = useT();
  const [provider, setProvider] = useState<GitProvider>(() => guessProvider(project));
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  // Which side runs the CLI. Defaults to this machine (for a remote project, its
  // lockstep mirror): the provider login lives here, not on the work remote.
  const [publishFrom, setPublishFrom] = useState<PublishFrom>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  // True when the CLI will run on this machine — always for a local project, and
  // for a remote one unless the host was explicitly chosen.
  const runsLocally = !isRemoteWork || publishFrom === "local";
  // The CLI the chosen provider drives, surfaced in the command preview/help.
  const cli = provider === "gitlab" ? "glab" : "gh";
  const createPreview =
    provider === "gitlab"
      ? `glab repo create ${project.name} --${visibility} --remoteName origin && git push`
      : `gh repo create ${project.name} --${visibility} --source=. --push`;
  const cliInstall = PROVIDER_CLI_INSTALL[provider];
  // Whether `cli` is on PATH here. Meaningful whenever the publish runs on this
  // machine — which now includes a work-remote project publishing from its
  // mirror. Only the explicit "work-remote host" choice runs somewhere this
  // probe (a local `<cli> --version`) can't see. `null` while probing/unknown,
  // so a pending answer never claims the CLI is missing.
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  // The saved global token (⚙ Settings → Git hosting) — a project-specific
  // override is possible too (`GitHostingWindow`) but rare enough that this
  // approximation (skip the sign-in nudge when a token is set at all) is fine.
  const gitToken = useSettingsStore((s) => s.settings?.git_token ?? "");

  useEffect(() => {
    if (!runsLocally) {
      setCliAvailable(null);
      return;
    }
    let cancelled = false;
    setCliAvailable(null);
    invoke<boolean>("provider_cli_available", { provider })
      .then((ok) => !cancelled && setCliAvailable(ok))
      .catch(() => !cancelled && setCliAvailable(false));
    return () => {
      cancelled = true;
    };
  }, [runsLocally, provider]);

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const output = await onPublish(provider, visibility, publishFrom);
      setResult(output || t("pill.published"));
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
          <h2>{t("pill.publishTitle", { name: project.name, provider: providerName(provider) })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          {t("pill.currentPrefix")} {gitTypeLabel(project.git_type, project.git_provider)}
          {isRemoteWork && !runsLocally && ` ${t("pill.runsOnWorkRemote")}`}
        </div>
        <label>
          {t("pill.hostingProvider")}
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
        {/* A work-remote project has the same history on both sides, so which one
            creates the repo is a real choice — and only this machine holds the
            provider login, which is why it is the default. */}
        {isRemoteWork && (
          <label>
            {t("pill.publishFrom")} <UntestedTag />
            <Dropdown
              className="dropdown-block"
              value={publishFrom}
              disabled={busy || Boolean(result)}
              onChange={(v) => setPublishFrom(v as PublishFrom)}
              options={[
                { value: "local", label: t("pill.publishFromLocal") },
                { value: "remote", label: t("pill.publishFromRemote") },
              ]}
            />
          </label>
        )}
        <label>
          {t("pill.repoVisibility")}
          <Dropdown
            className="dropdown-block"
            value={visibility}
            disabled={busy || Boolean(result)}
            onChange={(v) => setVisibility(v as "public" | "private")}
            options={[
              { value: "private", label: t("pill.visPrivate") },
              { value: "public", label: t("pill.visPublic") },
            ]}
          />
        </label>
        <div className="project-dialog-path">
          {t("pill.publishRunsPre")} <code>{createPreview}</code>. {t("pill.publishRunsMid")} <code>{cli}</code>{" "}
          {t("pill.publishRunsPost")}
        </div>

        {isRemoteWork && (
          <div className="project-dialog-path">
            {runsLocally
              ? t("pill.publishFromLocalHint", { cli })
              : t("pill.publishRemoteCliHint", { cli })}
          </div>
        )}

        {!runsLocally ? null : cliAvailable === false ? (
          <div className="tex-install-banner" role="status">
            <span className="tex-install-banner-text">
              {t("pill.publishCliMissingPre")} <code>{cliInstall.bin}</code>{" "}
              {t("pill.publishCliMissingMid")} <code>{cliInstall.bin} auth login</code>
              {t("pill.publishCliMissingPost")}
            </span>
            <code className="ollama-install-cmd">{cliInstall.cmd}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              title={t("projectDialog.runInTerminalTitle")}
              onClick={() =>
                runInstallInTab(
                  t("projectDialog.installBinLabel", { bin: cliInstall.bin }),
                  cliInstall.cmd,
                  IS_WINDOWS ? "default" : "bash",
                )
              }
            >
              {t("projectDialog.runInTerminalBtn")}
            </button>
          </div>
        ) : cliAvailable === true && !gitToken.trim() ? (
          <div className="tex-install-banner" role="status">
            <span className="tex-install-banner-text">{t("pill.publishSignInHint", { cli })}</span>
            <button
              type="button"
              className="ollama-action-btn primary"
              title={t("pill.publishSignInTitle", { cmd: providerAuthLoginCmd(provider) })}
              onClick={() =>
                runInstallInTab(
                  t("pill.publishSignInBtn", { cli }),
                  providerAuthLoginCmd(provider),
                  IS_WINDOWS ? "default" : "bash",
                )
              }
            >
              {t("pill.publishSignInBtn", { cli })}
            </button>
          </div>
        ) : null}

        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? t("common.close") : t("common.cancel")}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void publish()}>
              {busy ? t("pill.publishing") : t("pill.publish")}
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
  const t = useT();
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
    if (newToken.trim()) return t("pill.tokenStatusWillSet");
    if (effectiveClear) return t("pill.tokenStatusWillRemove");
    if (info?.has_token) return t("pill.tokenStatusHasToken");
    if (info?.has_global_token) return t("pill.tokenStatusInherits");
    return t("pill.tokenStatusNone");
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
  // Which provider's token page to link to: the URL field being edited (live,
  // so it updates as the user types) wins, else the field it inherits, else
  // the project's own best guess.
  const tokenProvider: GitProvider = (profileUrl || globalUrl).toLowerCase().includes("gitlab")
    ? "gitlab"
    : guessProvider(project);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("pill.gitHostingTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">{t("pill.gitHostingDesc")}</div>

        <label>
          {t("git.profileUrl")}
          <input
            type="text"
            value={profileUrl}
            placeholder={
              globalUrl ? t("pill.inheritsGlobal", { url: globalUrl }) : t("git.profileUrlPlaceholder")
            }
            onChange={(e) => setProfileUrl(e.target.value)}
          />
        </label>

        <label>
          {info?.has_token ? t("pill.replaceToken") : t("git.accessToken")}
          <PasswordInput
            value={newToken}
            placeholder={info?.has_token ? t("pill.enterNewToken") : t("git.tokenPlaceholder")}
            onChange={(e) => {
              setNewToken(e.target.value);
              if (e.target.value) setClearToken(false);
            }}
          />
        </label>
        <span className="ssh-optional-hint">
          {t("pill.getTokenHint")}{" "}
          <button
            type="button"
            className="inline-link-btn"
            onClick={() =>
              void invoke("open_external_url", {
                url: tokenPageUrl(tokenProvider, profileUrl || globalUrl),
              })
            }
          >
            {t("pill.getTokenCta", { provider: providerName(tokenProvider) })}
          </button>
        </span>
        <div className="project-dialog-path">{tokenStatus}</div>
        {info?.has_token && !newToken.trim() && (
          <label className="settings-switch-row">
            <span>{t("pill.removeProjectToken")}</span>
            <Toggle
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
            />
          </label>
        )}

        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={saving || !info}>
            {saving ? t("common.saving") : t("common.save")}
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
  const t = useT();
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
          <h2>{t("pill.disableGitTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-error">
          {t("pill.disableGitWarn1")} <code>.git</code> {t("pill.disableGitWarn2")}{" "}
          <strong>{t("pill.cannotBeUndone")}</strong>
          {" "}{t("pill.disableGitWarn3")}
        </div>
        <label>
          {t("pill.typeNameConfirmPre")} <code>{project.name}</code> {t("pill.typeNameConfirmPost")}
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
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button
            type="button"
            className="danger"
            onClick={() => void run()}
            disabled={!armed}
          >
            {busy ? t("pill.removing") : t("pill.deleteGitHistory")}
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
  const t = useT();
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
          <h2>{t("pill.deleteProjectTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          {t("pill.archiveDescPre")} <strong>{project.name}</strong> {t("pill.archiveDescMid")}{" "}
          <em>{t("pill.archiveSettingsLink")}</em>.
          {project.remote && (
            <> {t("pill.archiveRemoteNotTouchedPre")} <strong>{t("pill.notWord")}</strong> {t("pill.archiveRemoteNotTouchedPost")}</>
          )}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button
            type="button"
            className="danger"
            autoFocus
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? t("pill.deleting") : t("pill.deleteToArchive")}
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
  const t = useT();
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
          <h2>{t("pill.detachTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          {t("pill.detachDesc1Pre")} <strong>{project.name}</strong> {t("pill.detachDesc1Mid")}
          {" "}<strong>{t("pill.notWord")}</strong> {t("pill.detachDesc1Post")}
        </p>
        <p className="settings-help">
          {t("pill.detachDesc2Pre")} <strong>{t("pill.pairingWord")}</strong>{t("pill.detachDesc2Post")}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" autoFocus onClick={() => void run()} disabled={busy}>
            {busy ? t("pill.detaching") : t("pill.detachToLocal")}
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
  const t = useT();
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
      setError(t("pill.processLimitError"));
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
          <h2>{t("pill.containerSettingsTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">{t("pill.containerAppliedNote")}</p>
        <label>
          {t("pill.buildFromDockerfile")}
          <input
            type="text"
            value={dockerfile}
            placeholder={t("pill.dockerfilePlaceholder")}
            onChange={(e) => setDockerfile(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          {t("pill.image")}
          <input
            type="text"
            value={image}
            placeholder={t("pill.imagePlaceholder")}
            onChange={(e) => setImage(e.target.value)}
            spellCheck={false}
            disabled={Boolean(dockerfile.trim())}
          />
        </label>
        <label>
          {t("pill.network")}
          <input
            type="text"
            value={network}
            placeholder={t("pill.networkPlaceholder")}
            onChange={(e) => setNetwork(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="settings-help">
          {t("pill.networkNotePre")}
          <code> none</code> {t("pill.networkNotePost")}
        </p>
        <label>
          {t("pill.memoryCap")}
          <input
            type="text"
            value={memory}
            placeholder={t("pill.memoryPlaceholder")}
            onChange={(e) => setMemory(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          {t("pill.cpuCap")}
          <input
            type="text"
            value={cpus}
            placeholder={t("pill.cpuPlaceholder")}
            onChange={(e) => setCpus(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          {t("pill.processLimit")}
          <input
            type="text"
            value={pids}
            placeholder={t("pill.processLimitPlaceholder")}
            onChange={(e) => setPids(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="container-settings-toggle">
          <span>{t("pill.readonlyRootfs")}</span>
          <Toggle
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
            size="sm"
          />
        </label>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
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
  const t = useT();
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
          <h2>{t("pill.unpublishTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          {t("pill.unpublishDesc1")} <code>origin</code> {t("pill.unpublishDesc2")}
          {" "}{providerName(project.git_provider)} {t("pill.unpublishDesc3")} <strong>{t("pill.notWord")}</strong>{" "}
          {t("pill.unpublishDesc4")}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" autoFocus onClick={() => void run()} disabled={busy}>
            {busy ? t("pill.unpublishing") : t("pill.unpublishKeepRepo")}
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
  const t = useT();
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
      setResult(out || t("pill.nowVisibility", { target: t(target === "public" ? "pill.visPublic" : "pill.visPrivate") }));
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
          <h2>{t("pill.changeVisibilityTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          {t("pill.currentPrefix")} {providerName(project.git_provider)} · {t(current === "public" ? "pill.visPublic" : "pill.visPrivate")}
          {isRemoteWork && ` ${t("pill.runsOnWorkRemote")}`}
        </div>
        <p className="settings-help">
          {t("pill.flipVisibility1")} <strong>{t(current === "public" ? "pill.visPublic" : "pill.visPrivate")}</strong> {t("pill.flipVisibility2")}{" "}
          <strong>{t(target === "public" ? "pill.visPublic" : "pill.visPrivate")}</strong> {t("pill.flipVisibility3")} <code>{cli} repo edit</code>. {t("pill.flipVisibility4")}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? t("common.close") : t("common.cancel")}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void apply()}>
              {busy ? t("pill.applying") : t("pill.makeVisibility", { target: t(target === "public" ? "pill.visPublic" : "pill.visPrivate") })}
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
  onMigrate: (
    provider: GitProvider,
    visibility: "public" | "private",
    publishFrom: PublishFrom,
  ) => Promise<string>;
  onClose: () => void;
}) {
  const t = useT();
  const currentProvider: GitProvider = project.git_provider === "gitlab" ? "gitlab" : "github";
  const [provider, setProvider] = useState<GitProvider>(
    currentProvider === "github" ? "gitlab" : "github",
  );
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  // A migration ends in a publish, so it takes the same side choice (the old
  // origin is always moved aside wherever it actually is).
  const [publishFrom, setPublishFrom] = useState<PublishFrom>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  const runsLocally = !isRemoteWork || publishFrom === "local";

  const migrate = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await onMigrate(provider, visibility, publishFrom);
      setResult(out || t("pill.migrated"));
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
          <h2>{t("pill.moveToProviderTitle", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          {t("pill.currentPrefix")} {gitTypeLabel(project.git_type, project.git_provider)}
          {isRemoteWork && !runsLocally && ` ${t("pill.runsOnWorkRemote")}`}
        </div>
        <label>
          {t("pill.newProvider")}
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
        {isRemoteWork && (
          <label>
            {t("pill.publishFrom")} <UntestedTag />
            <Dropdown
              className="dropdown-block"
              value={publishFrom}
              disabled={busy || Boolean(result)}
              onChange={(v) => setPublishFrom(v as PublishFrom)}
              options={[
                { value: "local", label: t("pill.publishFromLocal") },
                { value: "remote", label: t("pill.publishFromRemote") },
              ]}
            />
          </label>
        )}
        <label>
          {t("pill.repoVisibility")}
          <Dropdown
            className="dropdown-block"
            value={visibility}
            disabled={busy || Boolean(result)}
            onChange={(v) => setVisibility(v as "public" | "private")}
            options={[
              { value: "private", label: t("pill.visPrivate") },
              { value: "public", label: t("pill.visPublic") },
            ]}
          />
        </label>
        <p className="settings-help">
          {t("pill.migrateDesc1")} {providerName(provider)}{t("pill.migrateDesc2")}{" "}
          <code>origin</code>{t("pill.migrateDesc3")}{" "}
          {providerName(project.git_provider)} {t("pill.migrateDesc4")}{" "}
          <strong>{t("pill.leftIntact")}</strong> {t("pill.migrateDesc5")} <code>origin-old</code>{t("pill.migrateDesc6")}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? t("common.close") : t("common.cancel")}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void migrate()}>
              {busy ? t("pill.migrating") : t("pill.moveToProvider", { provider: providerName(provider) })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectPill({
  project,
  active,
  onClick,
  onClose,
  onReorder,
  onGroup,
  onAssignToBox,
  isDragged,
  dragDx,
  shiftPx,
  groupHintActive,
}: Props) {
  const t = useT();
  // Shared hover card (identical popup in the right file-viewer). Owns the
  // popup position, today's time, CPU% and the scaffold-missing flag.
  const hover = useProjectHoverCard(project);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  // Whether a remote project's SSH password sits in the OS keychain — the other way
  // (besides key auth) an auto-connect can run without asking. Filled when the
  // context menu opens; see handleContextMenu.
  const [sshPasswordSaved, setSshPasswordSaved] = useState(false);
  // With `connections_headless` off Eldrun handles no passwords at all, so neither
  // of those two answers can ever be yes — auto-connect there means the login opens
  // in the root terminal instead (see `autoConnectInteractive` in stores/projects).
  const connHeadless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
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
  // Set instead of `extendRemote` alone when a global machine was handed to this
  // (local-only) project from the header's Machines menu — seeds the "Extend to
  // remote" dialog's SSH address with that machine, so the pick becomes "make
  // this the project's primary".
  const [extendRemoteMachine, setExtendRemoteMachine] = useState<DroppedGlobalMachine | null>(
    null,
  );
  // When set, the in-app "Move project…" folder browser is open, seeded at this
  // parent directory. `null` = closed.
  const [movePickerInitial, setMovePickerInitial] = useState<string | null>(null);
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
  // A global machine picked for THIS (local) project in the header's Machines
  // menu: that menu can't own the extend dialog, so it parks the request here
  // and the target's pill opens it. Cleared on pickup so it fires once.
  const extendTarget = useRemoteMachinesStore((s) => s.extendTarget);
  const clearExtend = useRemoteMachinesStore((s) => s.clearExtend);
  useEffect(() => {
    if (extendTarget?.projectId !== project.id) return;
    setExtendRemoteMachine(extendTarget.machine);
    setExtendRemote(true);
    clearExtend();
  }, [extendTarget, project.id, clearExtend]);
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
  // Auto-connect is only offered when the connect can complete with no *modal*: a
  // key/agent-auth host (recorded by the backend on its last successful connect) or
  // a password in the keychain (looked up when the menu opens) — or, in non-headless
  // mode, always: there is no keychain to qualify against there, and the connect is
  // by definition a login waiting in the root terminal. Same substitution the
  // header's "Connect on launch" makes for a tunnel (`VpnIndicator`).
  const autoConnectEligible =
    !connHeadless || project.remote?.key_auth === true || sshPasswordSaved;
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

  /**
   * Pointer-driven drag: reorder / Alt-group / drop-on-box, replacing native
   * HTML5 DnD (the same move TabBar/YamlTree/MachinesIndicator already made —
   * a native drag out of a webview gesture can hang or drop mid-drag under
   * WebKitGTK). The whole pill is the drag catchment, exactly as `draggable`
   * used to be, EXCEPT the close button and the remote-connection lamps, which
   * stay their own plain controls.
   *
   * Sibling rects are measured ONCE, at the moment the drag threshold is
   * crossed — the DOM order is frozen for the gesture (only `transform`
   * changes, via `shiftPx`/`groupHintActive`/BoxPill's forced hover, all read
   * from `usePillDragStore` by ProjectSwitcher), so the rects stay valid for
   * its whole duration. `onClick` is never wired natively on `pill-main` for
   * the mouse path — `e.preventDefault()` below suppresses the compatibility
   * click a plain press+release would otherwise fire, and a genuine (non-drag)
   * release calls it here instead; a keyboard Enter/Space still reaches
   * `pill-main`'s own onClick untouched, since it never goes through a pointer
   * event at all.
   */
  const startPillDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pressed = e.target as HTMLElement;
    if (pressed.closest(".pill-close-btn, .header-conn-lamps")) return;
    e.preventDefault();
    const startX = e.clientX;
    const pointerId = e.pointerId;
    const captureEl = document.documentElement;
    let dragging = false;
    let projectRects: { id: string; left: number; width: number }[] = [];
    let boxRects: { id: string; left: number; top: number; right: number; bottom: number }[] = [];
    // This pill's index among the OTHER (frozen) rects — i.e. how many of them
    // sat to its left at drag-start. `onReorder(fromId, toId)` always lands the
    // dragged pill immediately BEFORE toId when toId was originally to its
    // left, and immediately AFTER when toId was to its right (see the commit
    // math below) — so which of those two rules applies, and hence which
    // neighbor to target, depends on this frozen index.
    let fromIdx = 0;

    const dropSlot = (clientX: number) =>
      projectRects.filter((r) => clientX > r.left + r.width / 2).length;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5) return;
        dragging = true;
        hover.close();
        const container = pillRef.current?.closest(".project-pills-scroll");
        const selfRect = pillRef.current?.getBoundingClientRect();
        const width = selfRect?.width ?? 0;
        const selfLeft = selfRect?.left ?? 0;
        projectRects = container
          ? Array.from(container.querySelectorAll<HTMLElement>("[data-pill-id]"))
              .filter((el) => el.dataset.pillId !== project.id)
              .map((el) => {
                const r = el.getBoundingClientRect();
                return { id: el.dataset.pillId!, left: r.left, width: r.width };
              })
          : [];
        fromIdx = projectRects.filter((r) => r.left < selfLeft).length;
        boxRects = container
          ? Array.from(container.querySelectorAll<HTMLElement>("[data-box-id]")).map((el) => {
              const r = el.getBoundingClientRect();
              return {
                id: el.dataset.boxId!,
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
              };
            })
          : [];
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* best-effort */
          }
        }
        usePillDragStore.getState().start(project.id, width, dropSlot(ev.clientX));
      }
      const overBoxId =
        boxRects.find(
          (r) =>
            ev.clientX >= r.left &&
            ev.clientX <= r.right &&
            ev.clientY >= r.top &&
            ev.clientY <= r.bottom,
        )?.id ?? null;
      // Alt-group targets whichever pill's own rect (not just its midpoint) the
      // cursor sits over — matches the old alt-drop-onto-a-pill gesture.
      const groupTargetId =
        !overBoxId && ev.altKey
          ? (projectRects.find((r) => ev.clientX >= r.left && ev.clientX <= r.left + r.width)
              ?.id ?? null)
          : null;
      usePillDragStore.getState().move(ev.clientX - startX);
      usePillDragStore.getState().setTarget({
        overIndex: dropSlot(ev.clientX),
        overBoxId,
        groupTargetId,
      });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const finish = (commit: boolean) => {
      cleanup();
      const drag = usePillDragStore.getState().drag;
      usePillDragStore.getState().end();
      if (!dragging) {
        // Never dragged → this was a click (pill-main's own onClick already
        // covers the keyboard path; this covers the mouse one, since its
        // native click was suppressed above).
        if (commit) onClick();
        return;
      }
      if (!commit || !drag) return;
      if (drag.overBoxId) {
        onAssignToBox?.(drag.overBoxId);
      } else if (drag.groupTargetId && onGroup) {
        onGroup(project.id, drag.groupTargetId);
      } else {
        // Resolve the landing slot (`overIndex`, an index into the OTHER
        // pills without this one) back to a `toId` for `onReorder`. This is
        // NOT simply `projectRects[overIndex]`: `reorderProjects` always
        // drops the dragged pill immediately BEFORE toId when toId sat to its
        // left at drag-start, and immediately AFTER it when toId sat to its
        // right — landing "before OTHERS[k]" therefore means targeting
        // OTHERS[k] itself when k is on the left (< fromIdx), but targeting
        // OTHERS[k-1] (and relying on the "after" rule) when k is on the
        // right (> fromIdx). Using OTHERS[k] unconditionally landed the pill
        // one slot further right than its shown gap whenever the drop was on
        // the right side of the original position.
        const k = Math.max(0, Math.min(drag.overIndex, projectRects.length));
        if (k === fromIdx) return; // already there — no real move
        const toId = k < fromIdx ? projectRects[k]?.id : projectRects[k - 1]?.id;
        if (toId) onReorder(project.id, toId);
      }
    };

    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: () => finish(true), onAbort: () => finish(false) });
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
            <div className="context-menu-group-label">{t("pill.viewGroup")}</div>
            <button
              onClick={() => {
                setContextMenu(null);
                setShowActivity(true);
              }}
            >
              {t("pill.showActivity")}
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                void revealOnDisk();
              }}
              title={t(project.remote ? "pill.showOnDiskRemoteTitle" : "pill.showOnDiskLocalTitle")}
            >
              {t("pill.showOnDisk")}
            </button>
          </div>

          {/* Edit metadata */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">{t("pill.editGroup")}</div>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenaming(true);
              }}
            >
              {t("pill.renameEllipsis")}
            </button>
            {project.remote && (
              <button
                className="untested"
                onClick={() => {
                  setContextMenu(null);
                  void moveMirror();
                }}
                title={t("pill.movePillTitle")}
              >
                {t("pill.moveProjectEllipsis")}
                <UntestedTag />
              </button>
            )}
            <button
              onClick={() => {
                setContextMenu(null);
                setEditDescription(true);
              }}
            >
              {t("pill.editDescription")}
            </button>
            <button
              className="untested"
              onClick={() => {
                setContextMenu(null);
                setEditCategories(true);
              }}
              title={t("pill.categoriesMenuTitle")}
            >
              {t("blob.categoriesEllipsis")}
              <UntestedTag />
            </button>
            <button
              className="untested"
              onClick={() => {
                setContextMenu(null);
                void repairProjectScaffold(project.id);
              }}
              title={t("pill.repairScaffoldTitle")}
            >
              {t("pill.repairScaffold")}
              <UntestedTag />
            </button>
            {!project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setExtendRemoteMachine(null);
                  setExtendRemote(true);
                }}
                title={t("pill.extendToRemoteMenuTitle")}
              >
                {t("pill.extendToRemoteEllipsis")}
              </button>
            )}
          </div>

          {/* Git */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">{t("pill.gitGroup")}</div>
            {project.git_type === "none" ? (
              !project.remote && (
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    void setProjectGitDisabled(project.id, false);
                  }}
                  title={t("pill.gitInitTitle")}
                >
                  {t("pill.enableGit")}
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
                  title={t("pill.makePrivateTitle")}
                >
                  {project.git_type === "remote-public" ? t("pill.makePrivate") : t("pill.makePublic")}
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowMigrate(true);
                  }}
                  title={t("pill.moveProviderMenuTitle")}
                >
                  {project.git_provider === "gitlab" ? t("pill.moveToGithub") : t("pill.moveToGitlab")}
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowUnpublish(true);
                  }}
                  title={t("pill.unpublishMenuTitle")}
                >
                  {t("pill.unpublishKeepRepoEllipsis")}
                  <UntestedTag />
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    setContextMenu(null);
                    setShowGitHosting(true);
                  }}
                  title={t("pill.gitHostingMenuTitle")}
                >
                  {t("pill.gitHostingEllipsis")}
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
                {t("pill.publishEllipsis")}
                <UntestedTag />
              </button>
            )}
          </div>

          {/* Runtime */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">{t("pill.runtimeGroup")}</div>
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
                  title={t("pill.containerRunTitle")}
                >
                  {project.sandbox?.enabled ? "✓ " : ""}{t("pill.runInContainer")}
                </button>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowContainerSettings(true);
                  }}
                  title={t("pill.containerSettingsMenuTitle")}
                >
                  {t("pill.containerSettingsEllipsis")}
                </button>
              </>
            )}
            {showPython && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setShowPythonSettings(true);
                }}
                title={t("pill.pythonInterpMenuTitle")}
              >
                {project.python_interpreter ? "✓ " : ""}{t("pill.pythonInterpreterEllipsis")}
              </button>
            )}
            {project.remote && (
              <button
                disabled={!autoConnectEligible}
                onClick={() => {
                  setContextMenu(null);
                  void setProjectAutoConnect(project.id, !project.remote?.auto_connect);
                }}
                title={t(
                  !connHeadless
                    ? "pill.autoConnectTitleNonHeadless"
                    : autoConnectEligible
                      ? "pill.autoConnectTitleEligible"
                      : "pill.autoConnectTitleNotEligible"
                )}
              >
                {project.remote.auto_connect ? "✓ " : ""}{t("pill.autoConnectOnLaunch")}
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
                title={t("pill.persistSessionsMenuTitle")}
              >
                {project.remote.persist_sessions !== false ? "✓ " : ""}{t("pill.persistentSessionsTmux")}
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
                title={t("pill.remoteMachinesMenuTitle")}
              >
                {project.compute_hosts?.length
                  ? t("pill.remoteMachinesCount", { count: project.compute_hosts.length })
                  : t("pill.remoteMachinesEllipsis")}
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
              {t("pill.closeAllTabs")}
            </button>
          </div>

          {/* Danger zone — irreversible / destructive actions, fenced off */}
          <div className="context-menu-danger-zone">
            <div className="context-menu-group-label">{t("pill.dangerZone")}</div>
            {project.remote && (
              <button
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  setShowDetach(true);
                }}
                title={t("pill.detachSshMenuTitle")}
              >
                {t("pill.detachSshEllipsis")}
              </button>
            )}
            {!project.remote && project.git_type !== "none" && (
              <button
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  setShowDisableGit(true);
                }}
                title={t("pill.removeGitMenuTitle")}
              >
                {t("pill.removeGitHistoryEllipsis")}
              </button>
            )}
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                setShowArchive(true);
              }}
              title={t("pill.deleteProjectMenuTitle")}
            >
              {t("pill.deleteProjectEllipsis")}
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
          onPublish={(provider, visibility, publishFrom) =>
            publishProject(project.id, provider, visibility, publishFrom)
          }
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

      {/* Extend a local project to remote (attach an SSH host) — either from
          the context menu, or a global machine dropped onto this pill. */}
      {extendRemote && (
        <ExtendToRemoteDialog
          project={project}
          initialMachine={extendRemoteMachine ?? undefined}
          onClose={() => {
            setExtendRemote(false);
            setExtendRemoteMachine(null);
          }}
        />
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
          onMigrate={(provider, visibility, publishFrom) =>
            switchProjectProvider(project.id, provider, visibility, publishFrom)
          }
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
        data-pill-id={project.id}
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}${groupHintActive ? " drag-group" : ""}${isDragged ? " dragging" : ""}${!isDragged && shiftPx ? " reorder-parting" : ""}${catColor ? " has-category" : ""}`}
        style={{
          ...(catColor ? { "--cat-color": catColor } : {}),
          ...(isDragged
            ? { transform: `translateX(${dragDx ?? 0}px) scale(0.94)` }
            : shiftPx
              ? { transform: `translateX(${shiftPx}px)` }
              : {}),
        } as React.CSSProperties}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => hover.close()}
        onContextMenu={handleContextMenu}
        onPointerDown={startPillDrag}
      >
        <button className="pill-main" onClick={onClick}>
          <span
            className={`pill-folder-icon git-${gitDirty ?? "clean"}`}
            title={t(GIT_ICON_TITLE_KEY[gitDirty ?? "clean"])}
            aria-hidden
          >
            {/* The folder + its git color are shown ALWAYS — the git dirty state
                must never be hidden by an unrelated concern. A paused time-tracking
                timer is signalled non-destructively: a small ⏸ overlay badge (plus
                the pill's own `.timer-paused` dimming), never by swapping the icon
                out, which used to erase every pill's git colour the moment you
                paused the timer. */}
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
            </svg>
            {timerPaused && <span className="pill-folder-pause">⏸</span>}
          </span>
          <span className="project-pill-label">{project.name}</span>
        </button>
        {categories.length > 0 && (
          <span className="pill-category-dots" title={t("pill.categoriesLabel", { list: categories.join(", ") })}>
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
          title={t("pill.closeProject")}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          ×
        </button>
        {statusCounts && (
          <span className="pill-status-bars" title={statusBarTitle(statusCounts, t)}>
            {statusBarKinds(statusCounts).map((kind, i) => (
              <span key={i} className={`pill-status-bar ${kind}`} />
            ))}
          </span>
        )}
      </div>
    </>
  );
}
