import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  joinRemotePath,
  sanitizeName,
  type ScaffoldPreviewItem,
} from "./scaffold";
import { useRemoteSession, type RemoteStep } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";

export function ProjectDialog({
  kind,
  onClose,
  onProject,
}: {
  kind: "new" | "import";
  onClose: () => void;
  onProject: (project: ProjectEntry) => void | Promise<void>;
}) {
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
  const [scaffoldPreview, setScaffoldPreview] = useState<ScaffoldPreviewItem[]>([]);
  const [scaffoldFillModes, setScaffoldFillModes] = useState<Record<string, string>>({});
  const [scaffoldError, setScaffoldError] = useState("");
  const [manualValidationConfirmed, setManualValidationConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  // "Push to GitHub/GitLab" was chosen, but no Eldrun connection is set up yet.
  // Here "remote" is the git push target (a hosting service), distinct from the
  // SSH host the files may live on — see the git-hosting hint below.
  const wantsRemoteGit = gitType === "remote-private" || gitType === "remote-public";
  const gitConnected = gitToken.trim() !== "";
  const needsGitConnection = wantsRemoteGit && !gitConnected;

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
    setRemoteChosenPath(remoteBrowsePath || "/");
    if (kind === "import" && !name.trim()) {
      const segs = (remoteBrowsePath || "").split("/").filter(Boolean);
      if (segs.length) setName(segs[segs.length - 1]);
    }
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
                // pass the (browsed or typed) remote path as a stand-in.
                sourceDir: isRemoteProject ? remoteChosenPath : sourceDir,
                name,
                description,
                gitType,
                mode: isRemoteProject ? "keep" : mode,
                scaffoldFillModes,
                manualValidationConfirmed,
                skipScaffold,
                remote: remoteSpec,
                // Remote only: chosen local mirror parent (ignored for local).
                mirrorParent: isRemoteProject ? mirrorParent : undefined,
              },
            });
      if (isRemoteProject) rememberChosenPath();
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
      Project name
      <input
        autoFocus
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
        <span>Project description</span>
        <select
          aria-label="Project description fill mode"
          value={descriptionFillMode}
          onChange={(e) => setDescriptionFillMode(e.target.value)}
        >
          <option value="manual">Manual</option>
          <option value="agent_choice">Agent choice</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini</option>
          <option value="vibe">Mistral</option>
        </select>
      </div>
      <textarea
        value={description}
        placeholder="What this project is for"
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
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{kind === "new" ? "New Project" : "Import Project"}</h2>

        <label className={`toggle-card${isRemoteProject ? " is-on" : ""}`}>
          <span className="toggle-card-body">
            <span className="toggle-card-title">Remote (SSH) project</span>
            <span className="toggle-card-desc">
              Work on a project that lives on another machine — terminals, files,
              and git all run on the host over SSH.
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
              Local location
              <div className="folder-picker-row">
                <span title={mirrorParent}>{mirrorParent || "No folder selected"}</span>
                <button type="button" onClick={chooseLocalMirrorLocation}>Browse...</button>
              </div>
              <span className="ssh-optional-hint">
                The synced local working copy lives here as {safeName || "<name>"}.
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
            Source folder
            <div className="folder-picker-row">
              <span title={sourceDir}>{sourceDir || "No folder selected"}</span>
              <button type="button" onClick={chooseFolder}>Browse...</button>
            </div>
          </label>
        )}

        {kind === "new" && !isRemoteProject && (
          <label>
            Location
            <div className="folder-picker-row">
              <span title={projectsRoot}>{projectsRoot || "No folder selected"}</span>
              <button type="button" onClick={chooseLocation}>Browse...</button>
            </div>
          </label>
        )}

        {/* For a remote project these live in the always-visible remote-basics
            block above; here they render only for a local project. */}
        {!isRemoteProject && nameField}
        {!isRemoteProject && descriptionField}

        <label>
          Git hosting
          <select value={gitType} onChange={(e) => setGitType(e.target.value)}>
            <option value="none">No git (plain files, no repo)</option>
            <option value="local">Local repo only (not pushed anywhere)</option>
            <option value="remote-private">Push to GitHub/GitLab · private</option>
            <option value="remote-public">Push to GitHub/GitLab · public</option>
          </select>
          <span className="ssh-optional-hint">
            “Push to GitHub/GitLab” publishes the repo to a hosting service
            {isRemoteProject
              ? " — unrelated to the SSH host above, which is just where the project files live."
              : "."}
          </span>
        </label>

        {needsGitConnection && (
          <div className="git-connect-notice" role="status">
            <span>
              No GitHub/GitLab connection set up in Eldrun yet. Add an access
              token in Settings → Git Hosting so the repo can be published.
            </span>
            <button type="button" onClick={openGitHostingSettings}>
              Set up GitHub/GitLab…
            </button>
          </div>
        )}

        {kind === "import" && !isRemoteProject && (
          <label>
            Import mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="keep">Keep location (register in place)</option>
              <option value="copy">Copy into Eldrun's projects folder</option>
              <option value="move">Move into Eldrun's projects folder</option>
            </select>
          </label>
        )}

        {kind === "import" && isRemoteProject && (
          <div className="project-dialog-path">
            Remote import keeps the folder in place on the remote host.
          </div>
        )}

        <label className="skip-scaffold-row">
          <input
            type="checkbox"
            checked={skipScaffold}
            onChange={(e) => setSkipScaffold(e.target.checked)}
          />
          Skip scaffolding (do not generate any scaffold files)
        </label>

        {kind === "import" && !isRemoteProject && !skipScaffold && (
          <div className="scaffold-popover" role="group" aria-label="Import scaffold guidance">
            <div className="scaffold-popover-title">Import guidance</div>
            <ol className="scaffold-steps">
              <li>Select the source folder and project metadata.</li>
              <li>
                {mode === "keep"
                  ? "Register the project in its current location."
                  : mode === "copy"
                    ? "Copy the project to the Eldrun projects folder after manual validation."
                    : "Move the project to the Eldrun projects folder after manual validation."}
              </li>
              <li>Create missing scaffold files and acknowledge files already there.</li>
              <li>Write project.json and add the project to the switcher.</li>
            </ol>

            {mode !== "keep" && (
              <label className="manual-validation-row">
                <input
                  type="checkbox"
                  checked={manualValidationConfirmed}
                  onChange={(e) => setManualValidationConfirmed(e.target.checked)}
                />
                I manually validated the {mode} destination and source folder.
              </label>
            )}

            <label className="scaffold-fill-all-row">
              <span>Fill all</span>
              <select
                value=""
                disabled={missingFillableScaffoldCount === 0}
                onChange={(e) => applyScaffoldFillAll(e.target.value)}
              >
                <option value="" disabled>
                  {missingFillableScaffoldCount === 0 ? "No missing files" : "Choose fill mode..."}
                </option>
                {SCAFFOLD_FILL_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <div className="scaffold-list">
              {scaffoldPreview.map((item) => (
                <div className="scaffold-row" key={item.path}>
                  <div className="scaffold-file">
                    <span>{item.path}</span>
                    <small>{scaffoldStatusText(item)}</small>
                  </div>
                  {item.kind === "file" ? (
                    <select
                      value={item.exists ? "none" : scaffoldFillModes[item.path] ?? "none"}
                      disabled={item.exists}
                      onChange={(e) =>
                        setScaffoldFillModes((current) => ({ ...current, [item.path]: e.target.value }))
                      }
                    >
                      {SCAFFOLD_FILL_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="scaffold-row-status">Status only</span>
                  )}
                </div>
              ))}
              {!sourceDir && <div className="scaffold-empty">Choose a source folder to preview scaffold files.</div>}
              {sourceDir && !scaffoldPreview.length && !scaffoldError && (
                <div className="scaffold-empty">Loading scaffold preview...</div>
              )}
              {scaffoldError && <div className="project-dialog-error">{scaffoldError}</div>}
            </div>
          </div>
        )}

        <div className="project-dialog-path">
          {isRemoteProject
            ? remoteChosenPath
              ? kind === "new"
                ? `Remote destination: ${joinRemotePath(remoteChosenPath, safeName || "<name>")}`
                : `Remote location: ${remoteChosenPath}`
              : ""
            : kind === "new" || mode !== "keep"
              ? targetDir
                ? `Destination: ${targetDir}`
                : ""
              : sourceDir
                ? `Location: ${sourceDir}`
                : ""}
        </div>
        {error && <div className="project-dialog-error">{error}</div>}
        </>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          {isRemoteProject && stepIdx > 0 && (
            <button type="button" disabled={busy} onClick={goBack}>
              Back
            </button>
          )}
          {isRemoteProject && step !== "details" ? (
            <button type="button" disabled={!canNext || busy} onClick={goNext}>
              Next
            </button>
          ) : (
            <button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>
              {busy ? "Working..." : kind === "new" ? "Create" : "Import"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
