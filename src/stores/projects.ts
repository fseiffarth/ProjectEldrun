import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  resolveProjectDirectory,
  type GitHostingInfo,
  type GitProvider,
  type ProjectEntry,
} from "../types";
import {
  cmdToKind,
  isRestorableTab,
  useTabsStore,
  type SavedLayoutTree,
  type TabKind,
} from "./tabs";
import { useTimerStore } from "./timer";
import { useVpnPromptStore } from "./vpnPrompt";
import { useSettingsStore } from "./settings";
import { openConnectionInRoot } from "../lib/remoteConnect";

/**
 * If `project` is VPN-gated, ensure its OpenVPN tunnel is up before any sshfs
 * mount / ssh runs. The password is prompted each time (never persisted). Best
 * effort: a cancelled prompt or a failed connect is logged and we proceed, so a
 * VPN hiccup degrades to the same "host unreachable" path as an offline host
 * rather than blocking activation.
 */
function connectionsHeadless(): boolean {
  return useSettingsStore.getState().settings?.connections_headless ?? true;
}

async function ensureVpnIfNeeded(project: ProjectEntry | undefined): Promise<void> {
  const config = project?.remote?.openvpn?.config;
  if (!config) return;
  // Non-headless: surface the tunnel as an interactive root-terminal tab instead
  // of prompting Eldrun for the passphrase. The passphrase is typed directly into
  // that terminal; Eldrun never handles it. Best-effort and non-blocking.
  if (!connectionsHeadless()) {
    try {
      const up = await invoke<boolean>("openvpn_status", { config }).catch(() => false);
      if (up) return;
      const command = await invoke<string>("openvpn_login_command", { config });
      openConnectionInRoot({
        label: `OpenVPN · ${project!.name}`,
        command,
        dedupeKey: `vpn:${config}`,
      });
    } catch (error) {
      console.warn("OpenVPN root-terminal connect skipped/failed", error);
    }
    return;
  }
  try {
    const up = await invoke<boolean>("openvpn_status", { config }).catch(() => false);
    if (up) return;
    // The prompt store now owns the connect, so a failed tunnel is shown in the
    // modal (with a retry) rather than failing silently here. `request` resolves
    // only once the tunnel is up; a cancel rejects and we fall through.
    await useVpnPromptStore.getState().request(config, project!.name);
  } catch (error) {
    console.warn("OpenVPN connect skipped/cancelled", error);
  }
}

/**
 * Non-headless SSH: open an interactive ssh login for `project`'s host as a
 * root-terminal tab so the user authenticates there (the password is never seen
 * by Eldrun). The login shares the multiplexing master socket with the sshfs
 * mount, so once it is authenticated the mount rides it with no second prompt.
 * No-op in headless mode (the backend mount handles auth via key/agent) and for
 * local projects. Best-effort.
 */
async function ensureRootSshLoginIfNeeded(project: ProjectEntry | undefined): Promise<void> {
  const remote = project?.remote;
  if (!remote || connectionsHeadless()) return;
  try {
    const command = await invoke<string>("remote_login_command", {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
    });
    const target = `${remote.user ? `${remote.user}@` : ""}${remote.host}`;
    openConnectionInRoot({
      label: `ssh · ${target}`,
      command,
      dedupeKey: `ssh:${target}:${remote.port ?? ""}`,
    });
  } catch (error) {
    console.warn("SSH root-terminal login skipped/failed", error);
  }
}

/**
 * Phase 0 (mount-free remote): open the pooled SSH/SFTP connection for a remote
 * project so authentication happens once on activation and every later channel
 * (file browse / I-O, agent tabs, git) rides the shared ControlMaster. Best-
 * effort and fire-and-forget: a failure (offline host, or password-only auth
 * with no live master) is logged and never blocks activation — later access
 * falls back to a one-shot session exactly as before. No-op for local projects
 * (the backend resolves remoteness and returns early). Passes no password (the
 * no-stored-password rule); password-auth hosts authenticate their master via
 * the interactive root-terminal login, which this connection then rides.
 */
function ensureRemotePool(projectId: string): void {
  void invoke("remote_connect", { projectId, password: null }).catch((error) =>
    console.warn("remote_connect failed", error),
  );
}

/** Tear down a remote project's pooled connection on deactivation. Best-effort. */
function dropRemotePool(projectId: string): void {
  void invoke("remote_disconnect", { projectId }).catch(() => {});
}

interface ProjectRuntimeSwitchedPayload {
  projectId: string | null;
  tabLayout: Array<{
    key: string;
    label: string;
    cmd: string;
    cwd: string;
    kind?: TabKind;
    sessionId?: string;
    env?: Record<string, string>;
    embedPath?: string;
    embedExec?: string;
    viewer?: "pdf" | "image" | "markdown" | "text";
  }>;
  // Opaque split/group layout tree (camelCased by the backend's serde rename);
  // absent → restored as a single group.
  tabGroups: SavedLayoutTree | null;
  activeTabIndex: number;
  fileTabs: unknown[];
  rightPanelFolder: string | null;
  openedWindowIds: string[];
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  rootDir: string | null;
  switchToast: string | null;
  rightPanelFolderByProject: Record<string, string>;
  /** Incremented only on explicit setActive calls, never by load(). */
  switchGeneration: number;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  reorderProjects: (fromId: string, toId: string) => Promise<void>;
  setRightPanelFolder: (projectId: string, folder: string) => void;
  clearSwitchToast: () => void;
  addProject: (project: ProjectEntry) => Promise<void>;
  activateProject: (id: string) => Promise<void>;
  deactivateProject: (id: string) => Promise<void>;
  updateProjectDescription: (id: string, description: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  setProjectSandbox: (id: string, enabled: boolean) => Promise<void>;
  /** Replace a project's category tags (color/group it in the cloud + pills).
   * Backend cleans + dedupes; mirrors the cleaned list into local state. */
  setProjectCategories: (id: string, categories: string[]) => Promise<void>;
  /** Disable (delete .git → git_type "none") or re-enable (git init → "local")
   * git for an existing project. Destructive when disabling. */
  setProjectGitDisabled: (id: string, disabled: boolean) => Promise<void>;
  publishProject: (
    id: string,
    provider: GitProvider,
    visibility: "public" | "private",
  ) => Promise<string>;
  getProjectGitHosting: (id: string) => Promise<GitHostingInfo>;
  setProjectGitHosting: (
    id: string,
    args: { profileUrl?: string | null; token?: string | null; clearToken?: boolean },
  ) => Promise<GitHostingInfo>;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  loaded: false,
  rootDir: null,
  switchToast: null,
  rightPanelFolderByProject: {},
  switchGeneration: 0,

  load: async () => {
    const [raw, rootDir] = await Promise.all([
      invoke<ProjectEntry[]>("get_projects"),
      invoke<string>("root_work_dir").catch(() => null),
    ]);
    const projects = [...raw].sort((a, b) => a.position - b.position);
    const current = projects.find((p) => p.status === "current");
    const activeId = current?.id ?? projects[0]?.id ?? null;
    // Restore the active project's right-panel subfolder before any component
    // mounts, so the file tree opens straight to the saved folder on startup.
    // (Switching projects already restores via switch_project_runtime; this
    // covers the initially-active project, which never triggers a switch.)
    const rightPanelFolderByProject: Record<string, string> = {};
    const activeLocalFile = activeId
      ? projects.find((p) => p.id === activeId)?.local_file
      : undefined;
    if (activeId && activeLocalFile) {
      const folder = await invoke<string | null>("load_right_panel_folder", {
        localFile: activeLocalFile,
      }).catch(() => null);
      if (folder) rightPanelFolderByProject[activeId] = folder;
    }
    set({
      projects,
      loaded: true,
      rootDir,
      activeId,
      rightPanelFolderByProject,
    });
    // The initially-active project never fires a switch (which is what opens the
    // pooled connection on activation). If it is remote, bring up its VPN/login
    // and open the pooled SSH/SFTP connection so file browse / I-O / git ride the
    // shared master (mount-free remote — no sshfs). Best-effort and non-fatal: a
    // remote host may be offline at boot, which must not block or crash app start.
    if (activeId) {
      const active = projects.find((p) => p.id === activeId);
      if (active?.remote) {
        void (async () => {
          await ensureVpnIfNeeded(active);
          await ensureRootSshLoginIfNeeded(active);
          ensureRemotePool(activeId);
        })();
      }
    }
  },

  setActive: async (id) => {
    const previousId = get().activeId;
    // ── Snapshot the OUTGOING project's tabs SYNCHRONOUSLY ───────────────────
    // This MUST run before the set() / awaits below. Those yield to the event
    // loop, letting React re-render from the activeId change and CenterPanel's
    // effect call setScope(id) — which moves the tabs store to the NEW scope.
    // Reading tabs after that point snapshots the NEW project's tabs and would
    // persist them into the PREVIOUS project's project.json (a cross-project
    // leak). We therefore read straight from the scope-keyed maps for the
    // PREVIOUS scope (authoritative; never the drift-prone flat mirror) and drop
    // any tab not owned by that scope, so a foreign tab can NEVER be written
    // into the wrong file (#55 save-side enforcement; mirrors writeScope).
    // Ask the tabs store for the persist-ready snapshot of the OUTGOING scope.
    // This keeps the tab-tree walking + #55 ownership filter + restorable filter
    // + detached re-dock + prune behind a single tabs-store method, so this store
    // no longer reaches into the tabs store's internal maps / tree helpers
    // (Struct #3 decoupling; the walk also collapses per Eff #13).
    const prevScopeKey = previousId ?? "root";
    const { tabs, tabGroups, activeTabIndex } =
      useTabsStore.getState().snapshotScopeForSwitch(prevScopeKey);

    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = state.projects.map((project) => {
        const status =
          id === null
            ? project.status === "current"
              ? "active"
              : project.status
            : project.id === id
              ? "current"
              : project.status === "current"
                ? "active"
                : project.status;
        return status === project.status ? project : { ...project, status };
      });
      let toastPath: string | null = null;
      if (id === null) {
        toastPath = state.rootDir ?? "root";
      } else {
        const proj = state.projects.find((p) => p.id === id);
        if (proj) {
          toastPath = resolveProjectDirectory(proj) || proj.name;
        }
      }
      return {
        projects: nextProjects,
        activeId: id,
        switchToast: toastPath,
        switchGeneration: state.switchGeneration + 1,
      };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
    void useTimerStore.getState().setProject(id);
    // Bring up the VPN (if this project is VPN-gated) before the switch mounts
    // its sshfs filesystem. Prompts for the password each time; non-blocking on
    // failure (the mount then degrades like an offline host).
    if (id !== null) {
      const target = nextProjects.find((p) => p.id === id);
      await ensureVpnIfNeeded(target);
      await ensureRootSshLoginIfNeeded(target);
      // Open the pooled SSH/SFTP connection for a remote project (mount-free
      // remote, Phase 0). Fire-and-forget so a slow handshake never delays the
      // switch; the backend resolves remoteness and no-ops for local projects.
      // Re-check the active id: the awaits above (VPN prompt especially) can
      // yield long enough for the user to switch away or deactivate this project,
      // and we must not re-open a pool the deactivation just tore down.
      if (target?.remote && get().activeId === id) ensureRemotePool(id);
    }
    // Fire-and-forget: the switch runs on a backend worker thread and returns
    // immediately. The resulting tab layout / right-panel folder arrives via the
    // `project-runtime-switched` event, handled by listenProjectRuntimeSwitched.
    invoke("switch_project_runtime", {
      projectId: id,
      previousProjectId: previousId,
      previousSnapshot: {
        tabLayout: tabs.map((t) => ({
          key: t.key,
          label: t.label,
          cmd: t.cmd,
          cwd: t.cwd,
          kind: t.kind,
          env: t.env ?? {},
          sessionId: t.sessionId,
          embedPath: t.embedPath,
          embedExec: t.embedExec,
          viewer: t.viewer,
        })),
        tabGroups,
        activeTabIndex,
        fileTabs: [],
        rightPanelFolder: previousId ? get().rightPanelFolderByProject[previousId] ?? null : null,
        activeLayoutMetadata: null,
        flushSecs: 0.0,
      },
    }).catch((error) => {
      console.warn("switch_project_runtime failed", error);
    });
  },

  reorderProjects: async (fromId, toId) => {
    if (fromId === toId) return;
    const byPosition = (a: ProjectEntry, b: ProjectEntry) => a.position - b.position;
    let nextProjects: ProjectEntry[] = [];
    let changed = false;
    set((state) => {
      const active = state.projects
        .filter((p) => p.status !== "inactive")
        .sort(byPosition);
      const inactive = state.projects
        .filter((p) => p.status === "inactive")
        .sort(byPosition);
      const fromIdx = active.findIndex((p) => p.id === fromId);
      const toIdx = active.findIndex((p) => p.id === toId);
      if (fromIdx < 0 || toIdx < 0) return {};
      const reordered = [...active];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      // Renumber every project with gap-spaced positions so values stay unique:
      // active pills in their new drag order first, inactive ones after.
      const positionById = new Map(
        [...reordered, ...inactive].map((p, i) => [p.id, (i + 1) * 10]),
      );
      nextProjects = state.projects.map((p) => {
        const position = positionById.get(p.id);
        return position !== undefined && position !== p.position
          ? { ...p, position }
          : p;
      });
      changed = true;
      return { projects: nextProjects };
    });
    if (changed) {
      await invoke<void>("save_projects", { projects: nextProjects });
    }
  },

  setRightPanelFolder: (projectId, folder) => {
    set((state) => ({
      rightPanelFolderByProject: {
        ...state.rightPanelFolderByProject,
        [projectId]: folder,
      },
    }));
    // Persist immediately so the panel view survives a restart even if the user
    // quits without switching projects. Re-saving the same value on restore or
    // project switch is harmless and idempotent.
    const localFile = get().projects.find((p) => p.id === projectId)?.local_file;
    if (localFile) {
      void invoke("save_right_panel_folder", { localFile, folder }).catch(() => {});
    }
  },

  clearSwitchToast: () => set({ switchToast: null }),

  addProject: async (project) => {
    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = [...state.projects, project].sort((a, b) => a.position - b.position);
      return { projects: nextProjects };
    });
    await useProjectsStore.getState().setActive(project.id);
  },

  activateProject: async (id) => {
    // Promote an inactive project to "active" (available, but NOT the current
    // focused project). Leaves activeId/scope untouched — opening (making it
    // current) is a separate, explicit action via setActive.
    let nextProjects: ProjectEntry[] = [];
    let changed = false;
    set((state) => {
      nextProjects = state.projects.map((project) => {
        if (project.id === id && project.status === "inactive") {
          changed = true;
          return { ...project, status: "active" };
        }
        return project;
      });
      return changed ? { projects: nextProjects } : {};
    });
    if (changed) {
      await invoke<void>("save_projects", { projects: nextProjects });
    }
  },

  deactivateProject: async (id) => {
    let nextProjects: ProjectEntry[] = [];
    let nextActiveId: string | null = null;
    set((state) => {
      nextProjects = state.projects.map((project) =>
        project.id === id && project.status !== "inactive"
          ? { ...project, status: "inactive" }
          : project,
      );
      nextActiveId =
        state.activeId === id
          ? (nextProjects.find((p) => p.status === "active") ?? nextProjects[0])?.id ?? null
          : state.activeId;
      return { projects: nextProjects };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
    // Close the pooled SSH/SFTP connection for a deactivated remote project so no
    // ssh ControlMaster child lingers for a project no longer in use (Phase 0).
    if (nextProjects.find((p) => p.id === id)?.remote) dropRemotePool(id);
    if (useProjectsStore.getState().activeId !== nextActiveId) {
      await useProjectsStore.getState().setActive(nextActiveId);
    }
  },

  updateProjectDescription: async (id, description) => {
    // Backend cleans (trims, empties → null) and writes projects.json +
    // project.json; mirror the cleaned value into local state.
    const cleaned = await invoke<string | null>("set_project_description", {
      projectId: id,
      description,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, description: cleaned ?? undefined } : project,
      ),
    }));
  },

  renameProject: async (id, name) => {
    // Backend trims, rejects blank, and writes projects.json + project.json;
    // mirror the cleaned name into local state so the pill updates immediately.
    const cleaned = await invoke<string>("set_project_name", {
      projectId: id,
      name,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, name: cleaned } : project,
      ),
    }));
  },

  setProjectSandbox: async (id, enabled) => {
    // Backend writes projects.json + project.json and returns the resulting
    // enabled state; mirror it into local state so the pill toggle and the
    // spawn-time gate (CenterPanel) see it immediately.
    const result = await invoke<boolean>("set_project_sandbox", { projectId: id, enabled });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, sandbox: result ? { enabled: true } : undefined }
          : project,
      ),
    }));
  },

  setProjectCategories: async (id, categories) => {
    // Backend trims/dedupes and writes projects.json + project.json, returning
    // the cleaned list; mirror it so the pill bar and project cloud recolor
    // immediately.
    const cleaned = await invoke<string[]>("set_project_categories", {
      projectId: id,
      categories,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, categories: cleaned.length > 0 ? cleaned : undefined }
          : project,
      ),
    }));
  },

  setProjectGitDisabled: async (id, disabled) => {
    // Backend deletes/inits .git, writes projects.json + project.json, and
    // returns the resulting git_type ("none" or "local"); mirror it so the pill
    // label and context-menu state update immediately.
    const gitType = await invoke<string>("set_project_git_disabled", {
      projectId: id,
      disabled,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, git_type: gitType } : project,
      ),
    }));
  },

  publishProject: async (id, provider, visibility) => {
    // Backend runs the provider CLI (`gh`/`glab` repo create … then push,
    // locally or over ssh for a work-remote project) and writes the new push
    // target + provider into projects.json + project.json; mirror it into local
    // state. Returns the CLI's stdout (repo URL).
    const output = await invoke<string>("publish_project", {
      projectId: id,
      provider,
      visibility,
    });
    const gitType = `remote-${visibility}`;
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, git_type: gitType, git_provider: provider }
          : project,
      ),
    }));
    return output;
  },

  getProjectGitHosting: async (id) => {
    return invoke<GitHostingInfo>("get_project_git_hosting", { projectId: id });
  },

  setProjectGitHosting: async (id, args) => {
    // Backend writes the profile URL to project.json + projects.json and the
    // token to the OS keyring, then returns the resulting (token-free) info.
    // Mirror the profile URL into local pill state so it's visible immediately.
    const info = await invoke<GitHostingInfo>("set_project_git_hosting", {
      projectId: id,
      profileUrl: args.profileUrl ?? null,
      token: args.token ?? null,
      clearToken: args.clearToken ?? false,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, git_profile_url: info.profile_url ?? undefined }
          : project,
      ),
    }));
    return info;
  },
}));

/// Listen for the backend's `project-runtime-switched` event and apply the
/// restored tab layout + right-panel folder. The switch runs on a backend
/// worker thread (see `switch_project_runtime`), so its result arrives here
/// asynchronously rather than as the return value of the invoke in setActive.
/// Register once at app startup; returns an unlisten function.
export function listenProjectRuntimeSwitched(): Promise<() => void> {
  return listen<ProjectRuntimeSwitchedPayload>("project-runtime-switched", (ev) => {
    const payload = ev.payload;
    const scopeKey = payload.projectId ?? "root";
    const tabsStore = useTabsStore.getState();
    // Keep shell/files tabs, resumable agent tabs (Claude with a sessionId), and
    // in-app file-viewer embeds; other agent tabs (and external-app embeds) are
    // dropped (no session to restore). Newer snapshots carry `kind`/`sessionId`;
    // fall back to deriving the kind from the command. The saved groups tree
    // self-heals — loadFromLayout drops any tree key absent from the (filtered)
    // tab list.
    const restorable = payload.tabLayout.filter((t) =>
      isRestorableTab({
        kind: t.kind ?? cmdToKind(t.cmd),
        cmd: t.cmd,
        sessionId: t.sessionId,
        viewer: t.viewer,
      }),
    );
    // Only restore from disk if this scope was never initialized this session.
    // An existing (possibly empty) entry means the user's in-memory tabs win.
    if (restorable.length > 0 && !(scopeKey in tabsStore.tabsByScope)) {
      const project = payload.projectId
        ? useProjectsStore.getState().projects.find((p) => p.id === payload.projectId) ?? null
        : null;
      tabsStore.loadFromLayout(
        restorable,
        resolveProjectDirectory(project),
        scopeKey,
        payload.tabGroups ?? undefined,
      );
    }
    if (payload.projectId && payload.rightPanelFolder !== null) {
      useProjectsStore.getState().setRightPanelFolder(payload.projectId, payload.rightPanelFolder);
    }
  });
}
