import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { ProjectEntry, SandboxToggleOutcome } from "../../types";
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
  describeDetectedSpecSource,
  isCloneUrl,
  joinRemotePath,
  providerFromCloneUrl,
  repoNameFromCloneUrl,
  sanitizeName,
  type ScaffoldPreviewItem,
} from "./scaffold";
import { useRemoteSession, type RemoteStep } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";
import {
  stashRemotePassword,
  stashRemoteViaLogin,
  useProjectsStore,
} from "../../stores/projects";
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

/** The already-registered project a new one would collide with, as the backend's
 *  `check_project_site` reports it. `kind` is a machine token so the wording can
 *  live in `i18n.ts` ×5 — the same split `lib/browser.ts` makes for the
 *  navigation gate's refusal reasons. */
interface ProjectConflict {
  id: string;
  name: string;
  kind: "directory" | "mirror" | "remote-path";
}

const CONFLICT_KEY = {
  directory: "projectDialog.conflictDirectory",
  mirror: "projectDialog.conflictMirror",
  "remote-path": "projectDialog.conflictRemotePath",
} as const;

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
  // Project container (#38) at creation time. `null` = untouched, so the row
  // tracks the source default until the user states a preference; an explicit
  // choice then sticks even if the import source changes under it.
  const [containerChoice, setContainerChoice] = useState<boolean | null>(null);
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
  // The project this one would land on top of, if any (see the pre-check effect).
  const [conflict, setConflict] = useState<ProjectConflict | null>(null);
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
  // The *site* this project would occupy — the same identity the backend's
  // `find_project_conflict` compares, so the warning here and the command's
  // refusal can never disagree about what "already imported" means. A remote
  // project is its host path; a local one is the folder it ends up in, which for
  // a copy import is the destination rather than the source it copies from.
  const checkedRemote = isRemoteProject ? buildRemoteSpec(safeName) : undefined;
  const checkedDir = isRemoteProject
    ? ""
    : kind === "new" || isCloneImport || mode === "copy"
      ? targetDir
      : sourceDir;
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
  // The container toggle, asked here rather than only in the pill menu, because
  // this is the one moment it is cheap: flipping it later restarts every tab of
  // the project (and costs a non-resumable agent its conversation). Same
  // availability gate as the menu item — a remote project's tabs already run on
  // its host, and the backend refuses on Windows (host paths mean nothing inside
  // a Linux container).
  const containerAvailable = !isRemoteProject && !IS_WINDOWS;
  // Default ON for code that arrived from somewhere else (a folder import, a
  // clone, a fork) and OFF for a project scaffolded from scratch: an import is
  // exactly the case where build scripts and agent-facing docs the user hasn't
  // read are about to be run, while a new project starts empty — there is
  // nothing to contain yet, and the image/toolchain cost would be paid for a
  // folder holding a README.
  const containerDefault = kind === "import";
  const runInContainer = containerAvailable && (containerChoice ?? containerDefault);
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

  // Is this folder / host path already a project? Asked as the user picks it,
  // so the answer arrives before the rest of the form is filled in — and, for a
  // clone or fork import, before a whole repository is downloaded into a
  // destination the backend is going to refuse. The backend re-runs the same
  // check when it writes; this one is advisory (the list can change underneath).
  //
  // Keyed on the serialized spec rather than on `buildRemoteSpec`, which is a new
  // closure every render and would re-fire the probe on every keystroke.
  const checkedRemoteKey = checkedRemote ? JSON.stringify(checkedRemote) : "";
  useEffect(() => {
    if (!checkedDir && !checkedRemoteKey) {
      setConflict(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<ProjectConflict | null>("check_project_site", {
        req: {
          directory: checkedDir || null,
          remote: checkedRemoteKey ? JSON.parse(checkedRemoteKey) : null,
        },
      })
        .then((found) => {
          if (!cancelled) setConflict(found ?? null);
        })
        // A backend that doesn't know the command (an older build) must not
        // block the dialog — the write-side gate is the real one.
        .catch(() => {
          if (!cancelled) setConflict(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkedDir, checkedRemoteKey]);

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

  /** Activate the project this one would have collided with, and close. The
   *  dialog's whole job was to get the user into a project; when it turns out to
   *  exist already, opening it is the thing they actually wanted. */
  const openExisting = async (found: ProjectConflict) => {
    await useProjectsStore.getState().setActive(found.id);
    onClose();
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
      // Turn the container on before the project reaches the store, so activation
      // (which warms the container up) already sees the flag and the pill's menu
      // renders it ticked. Advisory: a project that failed to become contained is
      // still a created project, and the toggle is one right-click away.
      let created = project;
      if (runInContainer) {
        try {
          let outcome = await invoke<SandboxToggleOutcome>("set_project_sandbox", {
            projectId: project.id,
            enabled: true,
            sourceDecision: null,
          });
          if (outcome.outcome === "needs_confirmation") {
            // O#143: the repo declares its own Dockerfile/devcontainer image —
            // never adopted silently, since `docker build` runs it as root.
            const { source } = outcome;
            const adopt = await confirm(describeDetectedSpecSource(source), {
              title: "Use this repo's own container?",
              kind: "warning",
            });
            outcome = await invoke<SandboxToggleOutcome>("set_project_sandbox", {
              projectId: project.id,
              enabled: true,
              sourceDecision: { hash: source.hash, adopt },
            });
          }
          const spec = outcome.outcome === "applied" ? outcome.spec : undefined;
          created = spec ? { ...project, sandbox: spec } : project;
          // Same preflight the pill's toggle runs: a missing image becomes a
          // one-click build in a fresh tab rather than an error at the first
          // spawn (house convention — never a copy-it-yourself message).
          const pf = await invoke<{ status: string; image: string; build_command: string | null }>(
            "sandbox_preflight",
            { projectId: project.id },
          );
          if (pf.status === "image_missing" && pf.build_command) {
            runInstallInTab(`container image ${pf.image}`, pf.build_command, "bash");
          }
        } catch {
          // Docker missing/down surfaces at the first tab spawn; not worth
          // failing a project creation that otherwise succeeded.
        }
      }
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
      await onProject(created);
      await openScaffoldAgentTabs(created, scaffoldAgentFills);
      await openDescriptionAgentTab(created, descriptionAgent);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    // The folder / host path is already a project. Blocked here so a clone never
    // downloads a repository the backend is going to refuse; the backend's own
    // check stays the gate, since this one can be answering a stale list.
    !conflict &&
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

        {containerAvailable && (
          <label className="skip-scaffold-row" title={t("pill.containerRunTitle")}>
            <Toggle
              size="sm"
              checked={runInContainer}
              onChange={(e) => setContainerChoice(e.target.checked)}
            />
            {t("projectDialog.runInContainerLabel")}
            <UntestedTag />
          </label>
        )}
        {containerAvailable && runInContainer && (
          <div className="project-dialog-path">
            {kind === "import"
              ? t("projectDialog.runInContainerImportHint")
              : t("projectDialog.runInContainerHint")}
          </div>
        )}

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
        {/* Already a project. A dead-end error would leave the user to find it
            themselves, so the notice names it and offers to open it instead. */}
        {conflict && (
          <div className="project-dialog-error project-dialog-conflict">
            <span>{t(CONFLICT_KEY[conflict.kind], { name: conflict.name })}</span>
            <button
              type="button"
              className="remote-change-folder-btn"
              onClick={() => void openExisting(conflict)}
            >
              {t("projectDialog.conflictOpen")}
            </button>
          </div>
        )}
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
