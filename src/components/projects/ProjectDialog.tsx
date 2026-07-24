import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectEntry } from "../../types";
import { resolveProjectDirectory } from "../../types";
import { basename } from "../../lib/paths";
import { cmdToKind, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import {
  AGENT_SCAFFOLD_FILL_MODES,
  SCAFFOLD_FILL_OPTIONS,
  TERMINAL_OPTIONS,
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
  isCloneUrl,
  joinRemotePath,
  providerFromCloneUrl,
  repoNameFromCloneUrl,
  sanitizeName,
  type ScaffoldPreviewItem,
} from "./scaffold";
import { useRemoteSession, type RemoteStep } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";
import { stashRemotePassword, stashRemoteViaLogin } from "../../stores/projects";
import { Dropdown } from "../common/Dropdown";
import { runInstallInTab, PROVIDER_CLI_INSTALL } from "../../lib/installCommand";
import { UntestedTag } from "../common/UntestedTag";
import { IS_WINDOWS, IS_MAC } from "../../lib/platform";
import { useT } from "../../lib/i18n";

/** OS-appropriate command to install git, used by the one-click "Install git"
 *  prompt shown when creating/importing a git-backed project on a machine with
 *  no `git` on PATH (`scaffold_project`'s `git init` would otherwise silently
 *  no-op, registering a git-typed project with no repo). */
const GIT_INSTALL_CMD = IS_WINDOWS
  ? "winget install --id Git.Git -e --source winget"
  : IS_MAC
    ? "brew install git"
    : "sudo apt-get install -y git";

/** Where an import's files come from: a folder already on this machine, a
 *  repository cloned from GitHub/GitLab (any git URL), or a *fork* of one —
 *  the same clone, preceded by creating the user's own copy of the repository
 *  on the host so there is something to push to. */
export type ImportSource = "folder" | "git" | "fork";

export function ProjectDialog({
  kind,
  initialImportSource = "folder",
  onClose,
  onProject,
}: {
  kind: "new" | "import";
  initialImportSource?: ImportSource;
  onClose: () => void;
  onProject: (project: ProjectEntry) => void | Promise<void>;
}) {
  const t = useT();
  const defaultAgentCmd = useSettingsStore((s) => s.settings?.default_agent_cmd ?? "claude");
  // A GitHub/GitLab "connection through Eldrun" = a global access token saved in
  // Settings → Git Hosting (the credential publishing actually uses). Used to
  // decide whether picking a "Push to GitHub/GitLab" git type can proceed or
  // should first send the user to set the connection up.
  const gitToken = useSettingsStore((s) => s.settings?.git_token ?? "");
  const [projectsRoot, setProjectsRoot] = useState("");
  // Remote (SSH) projects only: the chosen parent dir for the LOCAL mirror (the
  // synced working copy). The mirror lands at `<mirrorParent>/<name>`. Seeded
  // from the backend default (`projects-ssh` root) so it matches
  // `default_remote_mirror`; editable via the "Local location" picker.
  const [mirrorParent, setMirrorParent] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionFillMode, setDescriptionFillMode] = useState("manual");
  const [gitType, setGitType] = useState("local");
  const [mode, setMode] = useState("keep");
  const [skipScaffold, setSkipScaffold] = useState(false);
  const [sourceDir, setSourceDir] = useState("");
  // Import source: an existing local folder, or a clone from GitHub/GitLab.
  const [importSource, setImportSource] = useState<ImportSource>(initialImportSource);
  const [repoUrl, setRepoUrl] = useState("");
  // Fork source only: which hosting provider drives the fork. "" = read it off
  // the URL's host, which is what a github.com/gitlab.com URL says on its own;
  // a self-hosted instance names neither, so it can also be picked explicitly.
  const [forkProvider, setForkProvider] = useState("");
  // Whether that provider's CLI (`gh`/`glab`) is on PATH. `null` while probing,
  // so a pending probe never blocks submit or flashes the install banner.
  const [forkCliAvailable, setForkCliAvailable] = useState<boolean | null>(null);
  const [cloning, setCloning] = useState(false);
  const [scaffoldPreview, setScaffoldPreview] = useState<ScaffoldPreviewItem[]>([]);
  const [scaffoldFillModes, setScaffoldFillModes] = useState<Record<string, string>>({});
  const [scaffoldError, setScaffoldError] = useState("");
  const [manualValidationConfirmed, setManualValidationConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Whether `git` is on PATH on this machine. `null` while still probing (never
  // block submit or show the install banner on that transient state); checked
  // once per dialog open since installing git mid-dialog is rare enough not to
  // warrant polling — the banner just won't self-clear without a reopen.
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  // Optional SSH + OpenVPN + remote-browser lifecycle (see useRemoteSession).
  const remote = useRemoteSession({ kind });
  const {
    isRemoteProject,
    isRemote,
    winManual,
    step,
    setStep,
    remoteReady,
    remoteBrowsePath,
    remoteChosenPath,
    setRemoteChosenPath,
    rememberChosenPath,
    remotePassword,
    toggleRemoteProject,
    buildRemoteSpec,
  } = remote;
  // Remote projects walk a stepped flow (connect → browse → details); the
  // name/git/description body only appears on the final "details" step. Local
  // projects ignore steps and show their single form.
  const showDetails = !isRemoteProject || step === "details";
  // Step order for the footer's Back/Next; Windows non-headless has no browse
  // step (it types the path in the connect step instead).
  const remoteSteps: RemoteStep[] = winManual
    ? ["connect", "details"]
    : ["connect", "browse", "details"];
  const stepIdx = remoteSteps.indexOf(step);
  const goBack = () => setStep(remoteSteps[Math.max(0, stepIdx - 1)]);
  const goNext = () => setStep(remoteSteps[Math.min(remoteSteps.length - 1, stepIdx + 1)]);
  const canNext =
    step === "connect"
      ? winManual
        ? remoteChosenPath.trim() !== ""
        : isRemote
      : step === "browse"
        ? remoteChosenPath.trim() !== ""
        : false;
  const safeName = sanitizeName(name);
  const targetDir = safeName && projectsRoot ? `${projectsRoot}/${safeName}` : "";
  // Cloning from a hosting service. A remote (SSH) project's tree lives on the
  // host and is never cloned locally, so the two are mutually exclusive. A fork
  // import *is* a clone import — same URL field, same destination, same "keep"
  // registration — with the fork created first, so it shares every branch below
  // and only adds the provider row.
  const isForkImport = kind === "import" && !isRemoteProject && importSource === "fork";
  const isCloneImport =
    (kind === "import" && !isRemoteProject && importSource === "git") || isForkImport;
  // Which provider a fork goes through: the explicit pick, else what the URL's
  // host says. "" means "can't tell" — the user has to choose before submitting.
  const forkProviderResolved = (forkProvider || providerFromCloneUrl(repoUrl)) as
    | "github"
    | "gitlab"
    | "";
  const forkCli = forkProviderResolved ? PROVIDER_CLI_INSTALL[forkProviderResolved] : null;
  // Same shape as the git-install banner: only claim the CLI is missing once the
  // probe has actually answered.
  const needsForkCliInstall = isForkImport && forkCliAvailable === false && forkCli !== null;
  // "Push to GitHub/GitLab" was chosen, but no Eldrun connection is set up yet.
  // Here "remote" is the git push target (a hosting service), distinct from the
  // SSH host the files may live on — see the git-hosting hint below.
  const wantsRemoteGit = gitType === "remote-private" || gitType === "remote-public";
  const gitConnected = gitToken.trim() !== "";
  // A clone is exempt: the gate exists because publishing a *new* repo needs a
  // token, and a cloned repo is already hosted — it has an origin to push back
  // to. (The clone itself only needs the token when the repo is private, which
  // the URL field's own hint covers.)
  const needsGitConnection = wantsRemoteGit && !gitConnected && !isCloneImport;
  // A git repo is created LOCALLY even for a remote (SSH) project — the local
  // mirror scaffolds with `git init` the same way a local project does — so this
  // gates on the chosen git type alone, not on isRemoteProject. A clone import
  // needs `git` too (`git_clone` shells out to it) regardless of gitType.
  const needsGitInstall = gitAvailable === false && (gitType !== "none" || isCloneImport);

  // Switching the import source resets the git-hosting default to the one that
  // fits it: a clone comes from a host, a plain folder does not. Both remain
  // freely overridable in the dropdown below.
  const changeImportSource = (next: ImportSource) => {
    setImportSource(next);
    setGitType(next === "folder" ? "local" : "remote-private");
  };

  const setRepoUrlAndName = (url: string) => {
    setRepoUrl(url);
    // Pre-fill the project name from the repo's own name, but only while the
    // user hasn't typed one of their own (and only while it still matches what
    // the previous URL suggested, so backspacing the URL keeps updating it).
    const suggested = repoNameFromCloneUrl(url);
    setName((cur) => (cur === "" || cur === repoNameFromCloneUrl(repoUrl) ? suggested : cur));
  };

  // Send the user to Settings → Git Hosting to establish the GitHub/GitLab
  // connection. The project dialog stays open (so the half-filled form isn't
  // lost); once a token is saved the `needsGitConnection` notice clears live.
  // Git Hosting is its own settings sub-panel, so open it directly.
  const openGitHostingSettings = () => {
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "git" }));
  };

  useEffect(() => {
    invoke<string>("projects_root_dir").then(setProjectsRoot).catch(() => {});
  }, []);

  useEffect(() => {
    invoke<boolean>("git_available").then(setGitAvailable).catch(() => setGitAvailable(false));
  }, []);

  // Probe the fork provider's CLI whenever the resolved provider changes (it
  // moves as the URL is typed). Reset to `null` first so the banner never shows
  // a previous provider's answer while the new one is still being asked.
  useEffect(() => {
    if (!isForkImport || !forkProviderResolved) {
      setForkCliAvailable(null);
      return;
    }
    let cancelled = false;
    setForkCliAvailable(null);
    invoke<boolean>("provider_cli_available", { provider: forkProviderResolved })
      .then((ok) => !cancelled && setForkCliAvailable(ok))
      .catch(() => !cancelled && setForkCliAvailable(false));
    return () => {
      cancelled = true;
    };
  }, [isForkImport, forkProviderResolved]);

  // Seed the remote local-mirror parent from the backend default (the
  // `projects-ssh` root) so the picker's default agrees with the backend
  // fallback. Only fills an empty value, so a user edit isn't clobbered.
  useEffect(() => {
    invoke<string>("remote_mirror_root_dir")
      .then((dir) => setMirrorParent((cur) => cur || dir.replace(/\/+$/, "")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (kind !== "import" || !sourceDir) {
      setScaffoldPreview([]);
      setScaffoldError("");
      return;
    }

    let cancelled = false;
    setScaffoldError("");
    invoke<ScaffoldPreviewItem[]>("preview_project_scaffold", { sourceDir })
      .then((items) => {
        if (cancelled) return;
        setScaffoldPreview(items);
        setScaffoldFillModes((current) => {
          const next: Record<string, string> = {};
          for (const item of items) next[item.path] = current[item.path] ?? "none";
          return next;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setScaffoldPreview([]);
        setScaffoldError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [kind, sourceDir]);

  useEffect(() => {
    setManualValidationConfirmed(false);
  }, [mode, sourceDir]);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setSourceDir(picked);
      if (!name.trim()) {
        setName(basename(picked));
      }
    }
  };

  const chooseLocation = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: projectsRoot || undefined });
    if (typeof picked === "string") {
      setProjectsRoot(picked.replace(/\/+$/, ""));
    }
  };

  // Pick the LOCAL mirror parent for a remote (SSH) project (mirror of
  // `chooseLocation`, but for the synced working copy rather than a local project).
  const chooseLocalMirrorLocation = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: mirrorParent || projectsRoot || undefined,
    });
    if (typeof picked === "string") {
      setMirrorParent(picked.replace(/\/+$/, ""));
    }
  };

  // Commit the currently-browsed remote folder. On import with an empty name,
  // default the name to the chosen folder's last segment.
  const useThisRemoteFolder = () => {
    const chosen = remoteBrowsePath || "/";
    setRemoteChosenPath(chosen);
    if (kind === "import" && !name.trim()) {
      const segs = chosen.split("/").filter(Boolean);
      if (segs.length) setName(segs[segs.length - 1]);
    }
    // Persist the committed folder against this host now (not only at submit),
    // so it's offered in the "Recently used…" lists for the next SSH project on
    // the same remote — even if this dialog is later cancelled.
    rememberChosenPath(chosen);
    // Committing the folder is the natural end of the browse step.
    setStep("details");
  };

  const selectedScaffoldAgentFills = () => {
    return collectScaffoldAgentFills(scaffoldPreview, scaffoldFillModes, defaultAgentCmd);
  };

  const selectedDescriptionAgent = () => {
    if (!AGENT_SCAFFOLD_FILL_MODES.has(descriptionFillMode)) return "";
    const agent = agentForScaffoldFillMode(descriptionFillMode, defaultAgentCmd);
    return TERMINAL_OPTIONS.includes(agent) ? agent : "claude";
  };

  const openScaffoldAgentTabs = async (project: ProjectEntry, filesByAgent: Map<string, string[]>) => {
    if (filesByAgent.size === 0) return;
    const projectCwd = resolveProjectDirectory(project);
    if (!projectCwd) return;

    const tabsStore = useTabsStore.getState();
    tabsStore.setScope(project.id);
    for (const [cmd, files] of filesByAgent) {
      const promptPath = `.eldrun/scaffold-fill-${cmd.replace(/[^a-z0-9_-]/gi, "-")}.md`;
      await invoke("write_project_file", {
        projectDir: projectCwd,
        relPath: promptPath,
        content: buildScaffoldFillPrompt(files),
      });
      tabsStore.addTab({
        label: `Fill scaffolds (${cmd})`,
        cmd,
        args: [],
        env: {},
        initialInput: `Read ${promptPath} and complete the scaffold filling task described there.`,
        cwd: projectCwd,
        kind: cmdToKind(cmd),
      });
    }
  };

  const openDescriptionAgentTab = async (project: ProjectEntry, cmd: string) => {
    if (!cmd) return;
    const projectCwd = resolveProjectDirectory(project);
    if (!projectCwd) return;

    const promptPath = `.eldrun/project-description-${cmd.replace(/[^a-z0-9_-]/gi, "-")}.md`;
    await invoke("write_project_file", {
      projectDir: projectCwd,
      relPath: promptPath,
      content: buildDescriptionFillPrompt(project.name),
    });
    const tabsStore = useTabsStore.getState();
    tabsStore.setScope(project.id);
    tabsStore.addTab({
      label: `Fill description (${cmd})`,
      cmd,
      args: [],
      env: {},
      initialInput: `Read ${promptPath} and complete the project description task described there.`,
      cwd: projectCwd,
      kind: cmdToKind(cmd),
    });
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // Remote scaffold filling runs over the local mount; for v1 we skip the
      // local-disk-only scaffold-fill agent tabs on import when remote.
      const scaffoldAgentFills =
        kind === "import" && !isRemoteProject && !skipScaffold
          ? selectedScaffoldAgentFills()
          : new Map<string, string[]>();
      const descriptionAgent = selectedDescriptionAgent();
      const remoteSpec = buildRemoteSpec(safeName);
      // Clone first, then import the resulting directory in place: the clone owns
      // getting the files onto the disk, `import_project` owns registering them.
      // A failed clone throws here, so nothing is registered for a tree that
      // isn't there.
      let clonedDir = "";
      if (isCloneImport) {
        setCloning(true);
        try {
          clonedDir = isForkImport
            ? // The fork is created first, then *it* is cloned — so the project
              // ends up on a repository the user can push to, with the original
              // wired as `upstream` by the backend.
              (
                await invoke<{ dir: string }>("git_fork_clone", {
                  url: repoUrl.trim(),
                  dest: targetDir,
                  provider: forkProvider || null,
                })
              ).dir
            : await invoke<string>("git_clone", {
                url: repoUrl.trim(),
                dest: targetDir,
              });
        } finally {
          setCloning(false);
        }
      }
      const project =
        kind === "new"
          ? await invoke<ProjectEntry>("create_project", {
              req: {
                name,
                directory: targetDir,
                description,
                gitType,
                skipScaffold,
                remote: remoteSpec,
                // Remote only: chosen local mirror parent (ignored for local).
                mirrorParent: isRemoteProject ? mirrorParent : undefined,
              },
            })
          : await invoke<ProjectEntry>("import_project", {
              req: {
                // Backend ignores sourceDir for remote but the field is required;
                // pass the (browsed or typed) remote path as a stand-in. A clone
                // registers the directory it just landed in.
                sourceDir: isRemoteProject
                  ? remoteChosenPath
                  : isCloneImport
                    ? clonedDir
                    : sourceDir,
                name,
                description,
                gitType,
                mode: isRemoteProject || isCloneImport ? "keep" : mode,
                scaffoldFillModes,
                manualValidationConfirmed,
                skipScaffold,
                remote: remoteSpec,
                // Remote only: chosen local mirror parent (ignored for local).
                mirrorParent: isRemoteProject ? mirrorParent : undefined,
              },
            });
      if (isRemoteProject) {
        rememberChosenPath();
        // The new project's pooled connect happens on activation, inside `onProject`
        // below — hand it the credential this dialog authenticated with, so that leg
        // doesn't have to ride the master we happen to have left up (and so a
        // password host isn't recorded as key-auth). Single-use; not persisted —
        // persisting is what the "Save password" toggle is for.
        stashRemotePassword(project.id, remotePassword);
        // A login the user typed into the embedded terminal leaves no password to
        // stash, and in headless mode the mode alone doesn't say so — mark it, or the
        // credential-less first connect is recorded as key auth on a password host.
        if (remote.sshTerm) stashRemoteViaLogin(project.id);
      }
      await onProject(project);
      await openScaffoldAgentTabs(project, scaffoldAgentFills);
      await openDescriptionAgentTab(project, descriptionAgent);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    // "Push to GitHub/GitLab" requires an Eldrun connection first — block submit
    // until a token is saved (the notice above links to Settings → Git Hosting).
    !needsGitConnection &&
    // git must be installed before a git-backed project (or a clone import) is
    // created — otherwise `git init`/`git clone` would silently fail underneath.
    !needsGitInstall &&
    // A fork is made by the provider's CLI, so it must be installed, and we must
    // know *which* provider (a self-hosted host names neither).
    !needsForkCliInstall &&
    (!isForkImport || forkProviderResolved !== "") &&
    (isRemoteProject
      ? // Remote mode: ready (live session when headless, typed path otherwise)
        // and has a remote folder.
        !remoteReady
        ? false
        : kind === "new"
          ? Boolean(name.trim() && safeName && remoteChosenPath && mirrorParent.trim())
          : Boolean(name.trim() && remoteChosenPath && mirrorParent.trim())
      : kind === "new"
        ? Boolean(name.trim() && targetDir && safeName)
        : isCloneImport
          ? // A clone needs a plausible URL and somewhere to land; it has no
            // source folder and no copy/move decision to validate.
            Boolean(name.trim() && safeName && targetDir && isCloneUrl(repoUrl))
          : Boolean(
              name.trim() &&
              sourceDir &&
              (mode === "keep" || safeName) &&
              (mode === "keep" || manualValidationConfirmed),
            ));

  const missingFillableScaffoldCount = scaffoldPreview.filter((item) => !item.exists && item.kind === "file").length;

  const applyScaffoldFillAll = (fillMode: string) => {
    setScaffoldFillModes((current) => {
      const next = { ...current };
      for (const item of scaffoldPreview) {
        if (!item.exists && item.kind === "file") next[item.path] = fillMode;
      }
      return next;
    });
  };

  const scaffoldStatusText = (item: ScaffoldPreviewItem) => {
    if (item.path === ".git") return item.exists ? "Already there" : "Missing";
    return item.exists ? "Already there, will be kept" : "Missing, will be added";
  };

  // The shared project name + description fields. They live in the always-visible
  // remote-basics block for a remote project (so name/description are editable
  // from the moment SSH is toggled on), and inside the details section for a local
  // project. Extracted so the markup isn't duplicated between the two placements.
  const nameField = (
    <label>
      {t("projectDialog.projectNameLabel")}
      <input
        // A clone starts at the URL field (which pre-fills this one), so the
        // focus belongs there — two autoFocus inputs would fight over it.
        autoFocus={!isCloneImport}
        value={name}
        placeholder="my-project"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit && !busy) void submit();
          if (e.key === "Escape") onClose();
        }}
      />
    </label>
  );

  const descriptionField = (
    <label className="project-description-field">
      <div className="project-description-header">
        <span>{t("projectDialog.descriptionLabel")}</span>
        <Dropdown
          title={t("projectDialog.descFillModeTitle")}
          value={descriptionFillMode}
          onChange={setDescriptionFillMode}
          options={[
            { value: "manual", label: t("projectDialog.fillModeManual") },
            { value: "agent_choice", label: t("projectDialog.fillModeAgentChoice") },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "gemini", label: "Gemini" },
            { value: "vibe", label: "Mistral" },
          ]}
        />
      </div>
      <textarea
        value={description}
        placeholder={t("projectDialog.descriptionPlaceholder")}
        rows={3}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{kind === "new" ? t("projectDialog.titleNew") : t("projectDialog.titleImport")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">

        <label className={`toggle-card${isRemoteProject ? " is-on" : ""}`}>
          <span className="toggle-card-body">
            <span className="toggle-card-title">{t("projectDialog.remoteToggleTitle")}</span>
            <span className="toggle-card-desc">
              {t("projectDialog.remoteToggleDesc")}
            </span>
          </span>
          <span className="eld-switch">
            <input
              type="checkbox"
              checked={isRemoteProject}
              onChange={(e) => toggleRemoteProject(e.target.checked)}
            />
            <span className="eld-switch-track" aria-hidden="true" />
          </span>
        </label>

        {/* Remote basics: a remote (SSH) project also needs a LOCAL location (its
            synced mirror). Show it plus the shared name/description up front — from
            the moment SSH is toggled on — while the remote location is chosen later
            in the connect → browse flow below. The project name is shared: it's the
            leaf of both `<local location>/<name>` and `<remote path>/<name>`. */}
        {isRemoteProject && (
          <>
            <label>
              {t("projectDialog.localLocationLabel")}
              <div className="folder-picker-row">
                <span title={mirrorParent}>{mirrorParent || t("projectDialog.noFolderSelected")}</span>
                <button type="button" onClick={chooseLocalMirrorLocation}>{t("projectDialog.browseBtn")}</button>
              </div>
              <span className="ssh-optional-hint">
                {t("projectDialog.localMirrorHint", { name: safeName || "<name>" })}
              </span>
            </label>
            {nameField}
            {descriptionField}
          </>
        )}

        <RemoteProjectSection
          kind={kind}
          safeName={safeName}
          onClose={onClose}
          onUseThisFolder={useThisRemoteFolder}
          remote={remote}
        />

        {showDetails && (
        <>
        {kind === "import" && !isRemoteProject && (
          <label>
            {t("projectDialog.importFromLabel")}
            <Dropdown
              className="dropdown-block"
              value={importSource}
              onChange={(v) => changeImportSource(v as ImportSource)}
              options={[
                { value: "folder", label: t("projectDialog.importFolderOpt") },
                { value: "git", label: t("projectDialog.importGitOpt") },
                { value: "fork", label: t("projectDialog.importForkOpt") },
              ]}
            />
          </label>
        )}

        {kind === "import" && !isRemoteProject && importSource === "folder" && (
          <label>
            {t("projectDialog.sourceFolderLabel")}
            <div className="folder-picker-row">
              <span title={sourceDir}>{sourceDir || t("projectDialog.noFolderSelected")}</span>
              <button type="button" onClick={chooseFolder}>{t("projectDialog.browseBtn")}</button>
            </div>
          </label>
        )}

        {isCloneImport && (
          <label>
            {isForkImport ? t("projectDialog.repoToForkLabel") : t("projectDialog.repoUrlLabel")}
            <input
              autoFocus
              value={repoUrl}
              placeholder="https://github.com/owner/repo.git"
              onChange={(e) => setRepoUrlAndName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit && !busy) void submit();
                if (e.key === "Escape") onClose();
              }}
            />
            <span className="ssh-optional-hint">
              {isForkImport ? (
                <>
                  {t("projectDialog.forkHintPre")}{" "}
                  <code>upstream</code> {t("projectDialog.forkHintMid")}{forkCli?.bin ?? "gh / glab"}{t("projectDialog.forkHintPost")}{" "}
                  <UntestedTag />
                </>
              ) : gitConnected ? (
                t("projectDialog.cloneHintPrivateConnected")
              ) : (
                t("projectDialog.cloneHintPublicOnly")
              )}
            </span>
          </label>
        )}

        {isForkImport && (
          <label>
            {t("projectDialog.hostTypeLabel")}
            <Dropdown
              className="dropdown-block"
              value={forkProvider}
              onChange={setForkProvider}
              options={[
                {
                  value: "",
                  label: forkProviderResolved
                    ? t("projectDialog.detectFromUrlWithProvider", { provider: forkProviderResolved === "github" ? "GitHub" : "GitLab" })
                    : t("projectDialog.detectFromUrl"),
                },
                { value: "github", label: "GitHub" },
                { value: "gitlab", label: "GitLab" },
              ]}
            />
            {!forkProviderResolved && (
              <span className="ssh-optional-hint">
                {t("projectDialog.hostTypeHint")}
              </span>
            )}
          </label>
        )}

        {needsForkCliInstall && forkCli && (
          <div className="tex-install-banner" role="status">
            <span className="tex-install-banner-text">
              {t("projectDialog.forkCliMissingPre")} <code>{forkCli.bin}</code> {t("projectDialog.forkCliMissingMid1")}{" "}
              <code>{forkCli.bin} auth login</code>{t("projectDialog.forkCliMissingPost")}{" "}
              {forkProviderResolved === "github" ? "GitHub" : "GitLab"}.
            </span>
            <code className="ollama-install-cmd">{forkCli.cmd}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              title={t("projectDialog.runInTerminalTitle")}
              onClick={() =>
                runInstallInTab(
                  t("projectDialog.installBinLabel", { bin: forkCli.bin }),
                  forkCli.cmd,
                  IS_WINDOWS ? "default" : "bash",
                )
              }
            >
              {t("projectDialog.runInTerminalBtn")}
            </button>
          </div>
        )}

        {(kind === "new" || isCloneImport) && !isRemoteProject && (
          <label>
            {t("projectDialog.locationLabel")}
            <div className="folder-picker-row">
              <span title={projectsRoot}>{projectsRoot || t("projectDialog.noFolderSelected")}</span>
              <button type="button" onClick={chooseLocation}>{t("projectDialog.browseBtn")}</button>
            </div>
            {isCloneImport && (
              <span className="ssh-optional-hint">
                {isForkImport ? t("projectDialog.cloneDestYourFork") : t("projectDialog.cloneDestTheRepo")} {t("projectDialog.cloneDestMid")}{" "}
                {safeName || "<name>"} {t("projectDialog.cloneDestPost")}
              </span>
            )}
          </label>
        )}

        {/* For a remote project these live in the always-visible remote-basics
            block above; here they render only for a local project. */}
        {!isRemoteProject && nameField}
        {!isRemoteProject && descriptionField}

        <label>
          Git hosting
          <Dropdown
            className="dropdown-block"
            value={gitType}
            onChange={setGitType}
            options={[
              { value: "none", label: t("projectDialog.gitNoneOpt") },
              { value: "local", label: t("projectDialog.gitLocalOpt") },
              { value: "remote-private", label: t("projectDialog.gitRemotePrivateOpt") },
              { value: "remote-public", label: t("projectDialog.gitRemotePublicOpt") },
            ]}
          />
          <span className="ssh-optional-hint">
            {t("projectDialog.gitHostingHintPre")}
            {isRemoteProject
              ? ` ${t("projectDialog.gitHostingHintRemoteSuffix")}`
              : "."}
          </span>
        </label>

        {needsGitConnection && (
          <div className="git-connect-notice" role="status">
            <span>
              {t("projectDialog.needsGitConnectionText")}
            </span>
            <button type="button" onClick={openGitHostingSettings}>
              {t("projectDialog.setUpGitHostingBtn")}
            </button>
          </div>
        )}

        {needsGitInstall && (
          <div className="tex-install-banner" role="status">
            <span className="tex-install-banner-text">
              {t("projectDialog.needsGitInstallTextPre")}{isCloneImport ? t("projectDialog.needsGitInstallOrClone") : ""}.
            </span>
            <code className="ollama-install-cmd">{GIT_INSTALL_CMD}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              title={t("projectDialog.runInTerminalTitle")}
              onClick={() =>
                runInstallInTab(t("projectDialog.installGitLabel"), GIT_INSTALL_CMD, IS_WINDOWS ? "default" : "bash")
              }
            >
              {t("projectDialog.runInTerminalBtn")}
            </button>
          </div>
        )}

        {kind === "import" && !isRemoteProject && importSource === "folder" && (
          <label>
            {t("projectDialog.importModeLabel")}
            <Dropdown
              className="dropdown-block"
              value={mode}
              onChange={setMode}
              options={[
                { value: "keep", label: t("projectDialog.modeKeepOpt") },
                { value: "copy", label: t("projectDialog.modeCopyOpt") },
                { value: "move", label: t("projectDialog.modeMoveOpt") },
              ]}
            />
          </label>
        )}

        {kind === "import" && isRemoteProject && (
          <div className="project-dialog-path">
            {t("projectDialog.remoteImportKeepsFolder")}
          </div>
        )}

        <label className="skip-scaffold-row">
          <Toggle
            size="sm"
            checked={skipScaffold}
            onChange={(e) => setSkipScaffold(e.target.checked)}
          />
          {t("projectDialog.skipScaffoldLabel")}
        </label>

        {/* The scaffold preview reads the source folder off the disk, so it only
            applies to a folder import — a clone's tree doesn't exist yet. Missing
            scaffold files are still written after the clone (unless skipped);
            they just can't be previewed or agent-filled from here. */}
        {kind === "import" && !isRemoteProject && importSource === "folder" && !skipScaffold && (
          <div className="scaffold-popover" role="group" aria-label={t("projectDialog.scaffoldGuidanceAria")}>
            <div className="scaffold-popover-title">{t("projectDialog.importGuidanceTitle")}</div>
            <ol className="scaffold-steps">
              <li>{t("projectDialog.stepSelectSource")}</li>
              <li>
                {mode === "keep"
                  ? t("projectDialog.stepRegisterKeep")
                  : mode === "copy"
                    ? t("projectDialog.stepCopyValidate")
                    : t("projectDialog.stepMoveValidate")}
              </li>
              <li>{t("projectDialog.stepCreateScaffold")}</li>
              <li>{t("projectDialog.stepWriteProjectJson")}</li>
            </ol>

            {mode !== "keep" && (
              <label className="manual-validation-row">
                <Toggle
                  size="sm"
                  checked={manualValidationConfirmed}
                  onChange={(e) => setManualValidationConfirmed(e.target.checked)}
                />
                {mode === "copy" ? t("projectDialog.manualValidationCopy") : t("projectDialog.manualValidationMove")}
              </label>
            )}

            <label className="scaffold-fill-all-row">
              <span>{t("projectDialog.fillAllLabel")}</span>
              <Dropdown
                value=""
                placeholder={missingFillableScaffoldCount === 0 ? t("projectDialog.noMissingFiles") : t("projectDialog.chooseFillMode")}
                disabled={missingFillableScaffoldCount === 0}
                onChange={(v) => {
                  if (v) applyScaffoldFillAll(v);
                }}
                options={SCAFFOLD_FILL_OPTIONS}
              />
            </label>

            <div className="scaffold-list">
              {scaffoldPreview.map((item) => (
                <div className="scaffold-row" key={item.path}>
                  <div className="scaffold-file">
                    <span>{item.path}</span>
                    <small>{scaffoldStatusText(item)}</small>
                  </div>
                  {item.kind === "file" ? (
                    <Dropdown
                      value={item.exists ? "none" : scaffoldFillModes[item.path] ?? "none"}
                      disabled={item.exists}
                      onChange={(v) =>
                        setScaffoldFillModes((current) => ({ ...current, [item.path]: v }))
                      }
                      options={SCAFFOLD_FILL_OPTIONS}
                    />
                  ) : (
                    <span className="scaffold-row-status">{t("projectDialog.statusOnly")}</span>
                  )}
                </div>
              ))}
              {!sourceDir && <div className="scaffold-empty">{t("projectDialog.chooseSourceToPreview")}</div>}
              {sourceDir && !scaffoldPreview.length && !scaffoldError && (
                <div className="scaffold-empty">{t("projectDialog.loadingScaffoldPreview")}</div>
              )}
              {scaffoldError && <div className="project-dialog-error">{scaffoldError}</div>}
            </div>
          </div>
        )}

        <div className="project-dialog-path">
          {isRemoteProject ? (
            remoteChosenPath ? (
              <span className="remote-chosen-summary">
                <span className="remote-chosen-text">
                  {kind === "new"
                    ? t("projectDialog.remoteDestinationLabel", { path: joinRemotePath(remoteChosenPath, safeName || "<name>") })
                    : t("projectDialog.remoteLocationLabel", { path: remoteChosenPath })}
                </span>
                {/* Wrong folder committed at the browse step? Jump straight back
                    to it (the browser keeps its place) to pick another — without
                    hunting for the footer's generic Back button. Windows manual
                    has no browse step, so Back lands on the connect path field. */}
                <button
                  type="button"
                  className="remote-change-folder-btn"
                  disabled={busy}
                  onClick={goBack}
                  title={
                    winManual
                      ? t("projectDialog.changeFolderTitleWinManual")
                      : t("projectDialog.changeFolderTitleBrowse")
                  }
                >
                  {t("projectDialog.changeFolderBtn")}
                </button>
              </span>
            ) : (
              ""
            )
          ) : kind === "new" || isCloneImport || mode !== "keep" ? (
            targetDir ? t("projectDialog.destinationLabel", { path: targetDir }) : ""
          ) : sourceDir ? (
            t("projectDialog.locationColonLabel", { path: sourceDir })
          ) : (
            ""
          )}
        </div>
        {error && <div className="project-dialog-error">{error}</div>}
        </>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{t("common.cancel")}</button>
          {isRemoteProject && stepIdx > 0 && (
            <button type="button" disabled={busy} onClick={goBack}>
              {t("common.back")}
            </button>
          )}
          {isRemoteProject && step !== "details" ? (
            <button type="button" disabled={!canNext || busy} onClick={goNext}>
              {t("common.next")}
            </button>
          ) : (
            <button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>
              {cloning
                ? isForkImport
                  ? t("projectDialog.forking")
                  : t("projectDialog.cloningEllipsis")
                : busy
                  ? t("projectDialog.working")
                  : kind === "new"
                    ? t("projectDialog.create")
                    : isForkImport
                      ? t("projectDialog.forkAndImport")
                      : isCloneImport
                        ? t("projectDialog.cloneAndImport")
                        : t("projectDialog.import")}
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
