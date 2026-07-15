import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  formatRemoteTarget,
  resolveLocalMirror,
  resolveProjectDirectory,
  type GitHostingInfo,
  type GitProvider,
  type ProjectEntry,
  type RemoteSpec,
  type SandboxSpec,
  type SshProbe,
} from "../types";
import {
  cmdToKind,
  isRestorableTab,
  useTabsStore,
  type SavedLayoutTree,
  type TabKind,
  type ViewerState,
} from "./tabs";
import { type AgentMode } from "../components/tabs/agentModes";
import { useTimerStore } from "./timer";
import { useVpnPromptStore } from "./vpnPrompt";
import { useSettingsStore } from "./settings";
import { useRemoteStatusStore } from "./remoteStatus";
import { markVpnConnected, markVpnConnecting, markVpnError, releaseVpn } from "./vpnStatus";
import { useConnectDialogStore } from "./connectDialog";
import { openConnectionInRoot } from "../lib/remoteConnect";
import { canConnectVpnSilently, connectVpnSilently } from "../lib/vpnConnect";
import { describeScaffoldRepair, type ProjectScaffoldRepair } from "../components/projects/scaffold";

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

/**
 * Toast text for a tunnel that just came up. It names the scope on purpose: a
 * bare "VPN connected · <project>" reads as though the tunnel belongs to the
 * project, when what actually happened is that the whole machine's routing (and
 * usually its DNS) moved — browser and all. That is worth one sentence, especially
 * on the auto-connect path, where this toast is the *only* thing the user sees.
 */
function vpnToast(name: string): string {
  return `VPN up · ${name} — this computer's traffic now routes through the tunnel`;
}

async function ensureVpnIfNeeded(project: ProjectEntry | undefined): Promise<void> {
  const config = project?.remote?.openvpn?.config;
  if (!config) return;
  const projectId = project!.id;
  // Non-headless: surface the tunnel as an interactive root-terminal tab instead
  // of prompting Eldrun for the passphrase. The passphrase is typed directly into
  // that terminal; Eldrun never handles it. Best-effort and non-blocking.
  if (!connectionsHeadless()) {
    try {
      const up = await invoke<boolean>("openvpn_status", { config }).catch(() => false);
      if (up) {
        markVpnConnected(projectId, config);
        return;
      }
      // Building the command also *arms* the tunnel: the backend picks a pidfile,
      // appends `--writepid`, and registers it — so this terminal-started tunnel is
      // as visible and as killable as a headless one (`openvpn_status` sees it, and
      // `pollVpnUp` below can therefore actually observe it come up).
      const command = await invoke<string>("openvpn_login_command", { config });
      markVpnConnecting(projectId, config);
      openConnectionInRoot({
        label: `OpenVPN · ${project!.name}`,
        command,
        dedupeKey: `vpn:${config}`,
      });
      // Eldrun never sees the passphrase (typed into the root terminal), so the
      // only signal the tunnel came up is polling openvpn_status. Fire-and-forget
      // and bounded so a never-authenticated tunnel doesn't poll forever.
      pollVpnUp(projectId, config, project!.name);
    } catch (error) {
      markVpnError(projectId, config);
      console.warn("OpenVPN root-terminal connect skipped/failed", error);
    }
    return;
  }
  try {
    const up = await invoke<boolean>("openvpn_status", { config }).catch(() => false);
    if (up) {
      markVpnConnected(projectId, config);
      return;
    }
    markVpnConnecting(projectId, config);
    // `auth-user-pass` configs need a username too; it's stored on the spec (not a
    // secret) and passed to both the silent connect and the prompt.
    const vpnUser = project!.remote?.openvpn?.username;
    // Silent auto-connect: if the user opted to save this VPN's credentials, the
    // backend brings the tunnel up from the OS keychain with no prompt.
    //
    // Ask *first* whether that can actually succeed, rather than trying and falling
    // back. A failed attempt is not free: `pkexec` authenticates the user before
    // OpenVPN even reads the config, so an attempt missing a credential still costs a
    // polkit dialog — and the modal below then costs a second one for the same tunnel.
    // `remember: null` = "no checkbox behind this call, leave the keychain alone";
    // passing `false` would delete the passphrase we just used.
    if (await canConnectVpnSilently(config, vpnUser)) {
      try {
        await connectVpnSilently(config, vpnUser);
        markVpnConnected(projectId, config);
        useProjectsStore.setState({ connToast: vpnToast(project!.name) });
        return;
      } catch {
        // Saved credentials the server no longer accepts — prompt for them.
      }
    }
    // The prompt store now owns the connect, so a failed tunnel is shown in the
    // modal (with a retry) rather than failing silently here. `request` resolves
    // only once the tunnel is up; a cancel rejects and we fall through.
    await useVpnPromptStore.getState().request(config, project!.name, projectId, vpnUser);
    markVpnConnected(projectId, config);
    useProjectsStore.setState({ connToast: vpnToast(project!.name) });
  } catch (error) {
    // A cancelled prompt or a failed tunnel both leave us not-connected (red).
    markVpnError(projectId, config);
    console.warn("OpenVPN connect skipped/cancelled", error);
  }
}

/**
 * Poll `openvpn_status` until the tunnel comes up (non-headless: the user
 * authenticates in a root terminal, so this is the only completion signal).
 * Bounded (~60s) so a tunnel that is never authenticated stops polling and goes
 * red rather than spinning forever. Bails if the project is switched away from.
 */
function pollVpnUp(projectId: string, config: string, name: string): void {
  let attempts = 0;
  const maxAttempts = 40; // ~60s at 1.5s cadence
  const tick = () => {
    if (useProjectsStore.getState().activeId !== projectId) return;
    void invoke<boolean>("openvpn_status", { config })
      .then((up) => {
        if (up) {
          markVpnConnected(projectId, config);
          useProjectsStore.setState({ connToast: vpnToast(name) });
          return;
        }
        if (++attempts >= maxAttempts) {
          markVpnError(projectId, config);
          return;
        }
        setTimeout(tick, 1500);
      })
      .catch(() => {
        if (++attempts >= maxAttempts) markVpnError(projectId, config);
        else setTimeout(tick, 1500);
      });
  };
  setTimeout(tick, 1500);
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
 * The password a create/extend dialog authenticated its SSH session with, handed
 * over for that project's **first** pooled connect and forgotten the moment it is
 * used (or the connect gives up). Never persisted — persisting is what the dialog's
 * "Save password" toggle is for, and a user who declined it must not have the
 * secret written anywhere.
 *
 * Without this, the first `remote_connect` for a just-created remote project ran
 * with `password: null` and only succeeded because the dialog's ControlMaster was
 * still up. Two things came out wrong: the pool depended on a master it doesn't own,
 * and the backend — which reads "no password given, none saved" as *key* auth —
 * recorded `key_auth: true` on a host that in fact needs a password, so the project
 * then advertised itself as auto-connect-eligible and the auto-connect failed on the
 * next launch.
 */
const pendingRemotePassword = new Map<string, string>();

/** Hand `projectId`'s first pooled connect the password the dialog just used. */
export function stashRemotePassword(projectId: string, password: string): void {
  if (password) pendingRemotePassword.set(projectId, password);
}

/**
 * Phase 0 (mount-free remote): open the pooled SSH/SFTP connection for a remote
 * project so authentication happens once on activation and every later channel
 * (file browse / I-O, agent tabs, git) rides the shared ControlMaster. Best-
 * effort and fire-and-forget: a failure (offline host, or password-only auth
 * with no live master) is logged and never blocks activation — later access
 * falls back to a one-shot session exactly as before. No-op for local projects
 * (the backend resolves remoteness and returns early).
 *
 * The password, in order: the one the create/extend dialog just authenticated with
 * (`stashRemotePassword`, single-use), else none — in which case the backend falls
 * back to a saved credential for the host, then to key/agent auth, and finally to
 * the master an interactive root-terminal login left behind.
 */
function ensureRemotePool(projectId: string): void {
  const status = useRemoteStatusStore.getState();
  status.setSsh(projectId, "connecting");
  // In non-headless mode the pooled connection can only ride the master once the
  // user has authenticated the root-terminal login, which takes a moment; retry a
  // few times before going red so the lamp turns green when the login completes
  // rather than flashing an error the login then resolves. Idempotent: a second
  // remote_connect on an already-open pool is a no-op.
  let attempts = 0;
  const maxAttempts = 6;
  const tryConnect = () => {
    if (useProjectsStore.getState().activeId !== projectId) return;
    // Kept across retries (an early attempt can lose to a still-starting host) and
    // dropped once the attempt is settled either way.
    const password = pendingRemotePassword.get(projectId) ?? null;
    void invoke("remote_connect", { projectId, password })
      .then(() => {
        pendingRemotePassword.delete(projectId);
        useRemoteStatusStore.getState().setSsh(projectId, "connected");
      })
      .catch((error) => {
        if (++attempts >= maxAttempts) {
          pendingRemotePassword.delete(projectId);
          console.warn("remote_connect failed", error);
          useRemoteStatusStore.getState().setSsh(projectId, "error");
          return;
        }
        setTimeout(tryConnect, 4000);
      });
  };
  tryConnect();
}

/** Projects with an auto-connect attempt in flight, so a switch away and back
 *  (or a launch racing an activation) can't start a second one. */
const autoConnecting = new Set<string>();

/**
 * Connect a remote project that has opted into **auto-connect** (launch and
 * activation), and do it *silently* — this path never prompts. That is the whole
 * contract of the toggle: it is only offered once the connection can complete with
 * no user input (a saved SSH password, or a host recorded as `key_auth`), so an
 * automatic connect can never ambush the user with a modal. Everything else keeps
 * the old default: the project surfaces disconnected and the user brings it up from
 * the pill's connection lamp.
 *
 * The tricky part is the VPN, because the *same* project is often reachable
 * directly on one network and only through the tunnel on another — so whether the
 * tunnel is needed is a property of the current network, not of the project, and
 * can't be stored. We therefore probe rather than assume:
 *
 *  1. `ssh_probe` the host (read-only; it reuses the saved credential but, unlike
 *     `ssh_connect`, never rewrites the keychain).
 *  2. Reachable → open the pooled connection (`remote_connect`, which falls back to
 *     the keychain itself). The tunnel is left alone — on the network that doesn't
 *     need it, it is never brought up.
 *  3. *Unreachable* (not "credential rejected" — see the backend's `ssh_unreachable`;
 *     no tunnel fixes a wrong password) and the project has an `.ovpn` whose
 *     passphrase is saved → bring the tunnel up from the keychain and re-probe.
 *  4. Anything else → red lamp and stop. No prompt, no retry loop.
 *
 * Fire-and-forget: it never blocks a switch. Local tabs restore and work on the
 * mirror regardless, and remote panes stay held until the pool is actually up.
 */
async function autoConnectRemote(projectId: string): Promise<void> {
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  const remote = project?.remote;
  if (!remote?.auto_connect) return;
  // Skip unless the lamp is disconnected: never fight an in-flight attempt, never
  // re-attack a host that already failed this session (switching back and forth
  // would otherwise re-probe an unreachable host every time), and never re-connect
  // a live pool.
  const state = useRemoteStatusStore.getState().byProject[projectId];
  if ((state?.ssh ?? "off") !== "off" || autoConnecting.has(projectId)) return;
  // Claim the project BEFORE the first await: the lamp only turns "connecting" once
  // the eligibility round-trip is back, so two rapid activations (switch away and
  // straight back) would otherwise both sail past the guard above.
  autoConnecting.add(projectId);

  const stillActive = () => useProjectsStore.getState().activeId === projectId;
  const status = () => useRemoteStatusStore.getState();
  // Hand the lamp back to "disconnected" when we abandon a connect we started (the
  // user switched away mid-probe). A lamp left stuck on "connecting" would lie in
  // the header *and* wedge the project shut: the guard above only re-attempts from
  // "off". Only ever resets our own "connecting" — never a lamp someone else owns.
  const abandon = () => {
    if (status().byProject[projectId]?.ssh === "connecting") status().setSsh(projectId, "off");
  };
  try {
    // Re-check eligibility against the backend rather than trusting the toggle: the
    // saved password may have been forgotten since it was ticked, and a stale opt-in
    // must degrade to "stay disconnected", never to a prompt.
    const sshArgs = {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
    };
    const eligible =
      remote.key_auth === true ||
      (await invoke<boolean>("remote_has_saved_password", sshArgs).catch(() => false));
    if (!eligible || !stillActive()) return;

    status().setSsh(projectId, "connecting");
    let probe = await invoke<SshProbe>("ssh_probe", sshArgs);

    const config = remote.openvpn?.config;
    if (!probe.ok && probe.unreachable && config && stillActive()) {
      const vpnSaved = await invoke<boolean>("vpn_has_saved_password", { config }).catch(
        () => false,
      );
      if (vpnSaved) {
        markVpnConnecting(projectId, config);
        try {
          await invoke("openvpn_connect", {
            config,
            username: remote.openvpn?.username ?? null,
            password: null,
            keyPassphrase: null,
            // No checkbox behind an auto-connect: authenticate from the keychain,
            // and leave it exactly as we found it.
            remember: null,
          });
          markVpnConnected(projectId, config);
          // The only disclosure on this path: auto-connect never prompts, so this
          // toast (and the header indicator it lights) is the whole of what the user
          // is told before their machine's routing changes under them.
          useProjectsStore.setState({ connToast: vpnToast(project!.name) });
          probe = await invoke<SshProbe>("ssh_probe", sshArgs);
        } catch (error) {
          markVpnError(projectId, config);
          console.warn("auto-connect: VPN tunnel failed", error);
        }
      }
    }

    if (!stillActive()) return abandon();
    if (!probe.ok) {
      console.warn("auto-connect: host not reachable/authenticating", probe.error);
      status().setSsh(projectId, "error");
      return;
    }
    await invoke("remote_connect", { projectId, password: null });
    if (!stillActive()) return abandon();
    status().setSsh(projectId, "connected");
  } catch (error) {
    console.warn("auto-connect failed", error);
    if (stillActive()) status().setSsh(projectId, "error");
    else abandon();
  } finally {
    autoConnecting.delete(projectId);
  }
}

/** Tear down a remote project's pooled connection on deactivation. Best-effort. */
function dropRemotePool(projectId: string): void {
  useRemoteStatusStore.getState().clear(projectId);
  void invoke("remote_disconnect", { projectId }).catch(() => {});
}

/**
 * Programmatic one-shot (re)connect for a remote project: bring its OpenVPN
 * tunnel up (if any), open the interactive SSH login (non-headless), then open
 * the pooled SSH/SFTP connection. The interactive Connect UI is now the
 * `RemoteConnectDialog` modal (opened from the pill's connection lamp), which
 * drives the same building blocks with visible progress; this remains as a
 * headless programmatic entry point. No-op for local projects or if the user
 * switched away mid-connect.
 */
export async function reconnectRemote(projectId: string): Promise<void> {
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  if (!project?.remote) return;
  await ensureVpnIfNeeded(project);
  if (useProjectsStore.getState().activeId !== projectId) return;
  await ensureRootSshLoginIfNeeded(project);
  if (useProjectsStore.getState().activeId !== projectId) return;
  ensureRemotePool(projectId);
}

/** Tear a remote project's connection down on demand (header lamp menu): drop the
 *  pooled SSH/SFTP connection and reset its lamps to disconnected. The restored
 *  tabs stay open (their sessions just go dead) until the user reconnects. */
export function disconnectRemote(projectId: string): void {
  dropRemotePool(projectId);
}

/**
 * One-click log out of a *connected* remote project (the pill's logout button):
 * drop the pooled SSH/SFTP connection and release its claim on the OpenVPN tunnel,
 * without routing through the Connect modal. The modal's Disconnect does the same
 * plus cancels an in-flight connect via `useRemoteReconnect`'s generation counters
 * — unreachable from here, and unnecessary: this button only shows once SSH is
 * `connected`, so there is no attempt left to abandon.
 *
 * *Release*, not disconnect: the tunnel is machine-wide and shared by config path,
 * so it only actually comes down if no other project is still holding it (see
 * `releaseVpn`). To bring a tunnel down regardless, the header's VPN indicator is
 * the place — that acts on the tunnel, not on a project.
 */
export function logoutRemote(project: ProjectEntry): void {
  releaseVpn(project.id, project.remote?.openvpn?.config);
  dropRemotePool(project.id);
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
    viewerState?: ViewerState;
    location?: "local" | "remote";
    agentMode?: AgentMode;
    /** A "projectfiles" tab's browsed folder (see TabEntry.folder). */
    folder?: string;
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
  /** A transient one-off action notice (e.g. "VPN connected · proj", a scaffold
   *  repair summary). Kept separate from `switchToast` so a project switch
   *  doesn't clobber it (and vice-versa). */
  connToast: string | null;
  rightPanelFolderByProject: Record<string, string>;
  /** Incremented only on explicit setActive calls, never by load(). */
  switchGeneration: number;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  reorderProjects: (fromId: string, toId: string) => Promise<void>;
  setRightPanelFolder: (projectId: string, folder: string) => void;
  clearSwitchToast: () => void;
  clearConnToast: () => void;
  addProject: (project: ProjectEntry) => Promise<void>;
  activateProject: (id: string) => Promise<void>;
  deactivateProject: (id: string) => Promise<void>;
  /** Delete a project: tear down all its Eldrun-side connections/state and move
   * it into the archive (`~/eldrun/archive/<id>/`). Reversible from Settings; the
   * remote host tree of an SSH project is never touched. */
  archiveProject: (id: string) => Promise<void>;
  updateProjectDescription: (id: string, description: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  /** Relocate a remote (SSH) project's local mirror folder into `parentDir`
   * (the folder is moved to `<parentDir>/<name>`). Returns the new mirror path. */
  moveRemoteMirror: (id: string, name: string, parentDir: string) => Promise<string>;
  /** Attach a remote (SSH) spec to an existing local project. The project's
   * current local directory becomes its local mirror in place (no data upload);
   * the empty remote root is created on the host. Returns the updated entry,
   * which is a disconnected remote project (user reconnects via the pill lamp). */
  extendProjectToRemote: (id: string, remote: RemoteSpec) => Promise<void>;
  setProjectSandbox: (id: string, enabled: boolean) => Promise<void>;
  /** Replace a project's container spec (the Container settings dialog's save).
   *  Backend normalizes blank fields away and stores it in both projects.json
   *  and project.json; the stored spec is mirrored into local state. */
  setProjectSandboxSpec: (id: string, spec: SandboxSpec) => Promise<void>;
  /** Pin the project's Python interpreter, or `null` to restore auto-detect (#87). */
  setProjectPython: (id: string, interpreter: string | null) => Promise<void>;
  /** Opt a remote project in/out of auto-connect (connect it silently on launch
   *  and activation). Only offered once the connect can complete with no prompt —
   *  a saved SSH password, or a host recorded as `key_auth`; `autoConnectRemote`
   *  re-checks that, so a stale opt-in degrades to staying disconnected. */
  setProjectAutoConnect: (id: string, enabled: boolean) => Promise<void>;
  /** Attach (or clear) an OpenVPN config on a remote project's SSH spec, so a
   *  project created without a VPN can gain one later when reconnecting from a
   *  VPN-gated network. `config = null`/"" clears it. Mirrors the stored path
   *  into local state so the Connect dialog picks it up immediately. */
  setProjectOpenvpn: (id: string, config: string | null, username?: string | null) => Promise<void>;
  /** Replace a project's category tags (color/group it in the cloud + pills).
   * Backend cleans + dedupes; mirrors the cleaned list into local state. */
  setProjectCategories: (id: string, categories: string[]) => Promise<void>;
  /** Disable (delete .git → git_type "none") or re-enable (git init → "local")
   * git for an existing project. Destructive when disabling. */
  setProjectGitDisabled: (id: string, disabled: boolean) => Promise<void>;
  /** Fill in any scaffold file/`.gitignore` pattern this project is missing
   * relative to current defaults (e.g. it predates that default). Additive
   * only — never overwrites existing content. Surfaces the result as a
   * transient toast. */
  repairProjectScaffold: (id: string) => Promise<ProjectScaffoldRepair>;
  publishProject: (
    id: string,
    provider: GitProvider,
    visibility: "public" | "private",
  ) => Promise<string>;
  /** Detach a remote (SSH) project back to a plain local project: its mirror
   * becomes the project directory in place. The host's files are never touched. */
  detachProjectFromRemote: (id: string) => Promise<void>;
  /** Forget a published project's push target without deleting the hosted repo
   * or local history: removes `origin`, resets git_type → "local". */
  unpublishProject: (id: string) => Promise<void>;
  /** Flip a published project's visibility (public ↔ private) in place via the
   * provider's `repo edit`. Returns the CLI stdout. */
  setProjectVisibility: (id: string, visibility: "public" | "private") => Promise<string>;
  /** Migrate a published project to the other provider (old repo left intact as
   * `origin-old`). Returns the create CLI stdout (new repo URL). */
  switchProjectProvider: (
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
  connToast: null,
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
    // Fire-and-forget: sniff each local repo's `origin` host so pills can badge
    // a hosting provider (GitHub/GitLab) and the hover can show the git address,
    // even when the repo was pushed outside Eldrun's Publish flow. Host-only, no
    // network — must not block the list.
    void invoke<Record<string, { provider: string; url: string }>>("detect_git_providers")
      .then((map) =>
        set((state) => ({
          projects: state.projects.map((p) => {
            const hit = map[p.id];
            if (hit?.provider === "github" || hit?.provider === "gitlab") {
              return { ...p, detected_provider: hit.provider as GitProvider, git_origin_url: hit.url };
            }
            return p;
          }),
        })),
      )
      .catch(() => {});
    // The initially-active remote project is NOT connected on launch unless it opted
    // into auto-connect. Its saved tabs DO restore either way (local tabs run on the
    // mirror offline), but any REMOTE pane is held until the pool is up — without the
    // opt-in it starts DISCONNECTED (no status entry → "off" lamp) and the user brings
    // it up from the pill's connection lamp (the `RemoteConnectDialog` modal).
    if (activeId) void autoConnectRemote(activeId);
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
          if (proj.remote) {
            // A remote (SSH) project lives in two places — show both: the
            // paired local working copy ("mirror", ~/eldrun/projects/ssh/…) and
            // the remote target (user@host:remote_path). Rendered as two lines
            // (AppShell adds a `multiline` class when it sees the newline).
            const local =
              resolveLocalMirror(proj) || resolveProjectDirectory(proj) || proj.name;
            toastPath = `local   ${local}\nremote  ${formatRemoteTarget(proj.remote)}`;
          } else {
            toastPath = resolveProjectDirectory(proj) || proj.name;
          }
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
    // Switching TO a remote project does NOT bring it up by default: it surfaces
    // disconnected (local tabs restore and work on the mirror; remote panes are held
    // until the pool is up) and the user connects it from the pill's connection lamp.
    // The one exception is a project that opted into auto-connect, which is connected
    // here silently — see `autoConnectRemote`. Fire-and-forget; never blocks the switch.
    const activated = nextProjects.find((p) => p.id === id);
    if (activated?.remote) void autoConnectRemote(activated.id);
    // Fire-and-forget: the switch runs on a backend worker thread and returns
    // immediately. The resulting tab layout / right-panel folder arrives via the
    // `project-runtime-switched` event, handled by listenProjectRuntimeSwitched.
    invoke("switch_project_runtime", {
      projectId: id,
      previousProjectId: previousId,
      previousSnapshot: {
        // Keep in step with the canonical persist in `tabs.ts` (persistScope):
        // this snapshot OVERWRITES the previous project's project.json on switch,
        // so any field dropped here is lost on a switch even though the debounced
        // save wrote it. That is how a Files (Project) tab's browsed `folder` (and
        // a viewer's scroll position / an agent's plan-mode) went missing on
        // switch-away.
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
          viewerState: t.viewerState,
          location: t.location,
          agentMode: t.agentMode,
          folder: t.folder,
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

  clearConnToast: () => set({ connToast: null }),

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

  archiveProject: async (id) => {
    const entry = get().projects.find((p) => p.id === id);
    if (!entry) return;

    // ── Tear down all Eldrun-side connections/state for this project ──────────
    // Drop the pooled SSH/SFTP ControlMaster + reset its lamps (remote only).
    if (entry.remote) dropRemotePool(id);
    // Close its Connect modal if it happens to be targeting this project.
    if (useConnectDialogStore.getState().projectId === id) {
      useConnectDialogStore.getState().close();
    }
    // Release its claim on the OpenVPN tunnel — which comes down only if no other
    // project is still holding it. (This used to scan the project list for another
    // project *configured* with the same config, which is a different question: it
    // kept the tunnel up for projects that weren't even connected. `releaseVpn`
    // counts actual holders.)
    releaseVpn(id, entry.remote?.openvpn?.config);
    // Drop its tabs/PTYs/sessions (in memory; the folder move discards the file).
    useTabsStore.getState().closeAllTabs(id);
    // Remove it from any box (clears box_id on it + dissolves a now-singleton box).
    if (entry.box_id) {
      const { useBoxesStore } = await import("./boxes");
      await useBoxesStore.getState().assignToBox(id, null);
    }

    // ── Move it into the archive + drop it from projects.json ────────────────
    await invoke("archive_project", { projectId: id, archivedAt: new Date().toISOString() });

    // ── Update the store: remove the pill, re-focus if it was active ──────────
    let nextActiveId: string | null = null;
    set((state) => {
      const projects = state.projects.filter((p) => p.id !== id);
      nextActiveId =
        state.activeId === id
          ? (projects.find((p) => p.status === "active") ?? projects[0])?.id ?? null
          : state.activeId;
      return { projects };
    });
    if (get().activeId !== nextActiveId) {
      await get().setActive(nextActiveId);
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

  moveRemoteMirror: async (id, name, parentDir) => {
    // Backend moves the mirror folder + its bytes to `<parentDir>/<name>` and
    // persists the new pointer (projects.json `extra["mirror"]`). The mirror IS
    // held on the entry (flattened `mirror`, read by resolveLocalMirror), so patch
    // it in memory too — otherwise the switch toast, the disconnected file-browser
    // pane, and local tab titles keep the old path until the next reload.
    const newPath = await invoke<string>("move_remote_mirror", { projectId: id, name, parentDir });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, mirror: newPath } : project,
      ),
    }));
    return newPath;
  },

  extendProjectToRemote: async (id, remote) => {
    // Backend attaches the remote spec, creates the empty host root, and moves
    // the project into the mount-free remote layout (its old local dir becomes
    // the mirror). No data is uploaded — the returned entry is a disconnected
    // remote project. Replace the whole entry so `remote`/`mirror`/`directory`
    // (and thus the pill lamp + file tree) update immediately.
    const updated = await invoke<ProjectEntry>("extend_project_to_remote", {
      req: { projectId: id, remote },
    });
    set((state) => ({
      projects: state.projects.map((project) => (project.id === id ? updated : project)),
    }));
  },

  setProjectSandbox: async (id, enabled) => {
    // Backend flips `enabled` on the stored spec (preserving hand-tuned
    // image/network/… fields, auto-detecting in-repo sources on first enable)
    // and returns the resulting spec; mirror it into local state so the pill
    // toggle and the spawn-time gate (CenterPanel) see it immediately.
    const spec = await invoke<SandboxSpec>("set_project_sandbox", { projectId: id, enabled });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, sandbox: spec } : project,
      ),
    }));
  },

  setProjectSandboxSpec: async (id, spec) => {
    const saved = await invoke<SandboxSpec>("set_project_sandbox_spec", {
      projectId: id,
      spec,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, sandbox: saved } : project,
      ),
    }));
  },

  setProjectPython: async (id, interpreter) => {
    // Backend writes both stores (projects.json mirror + project.json) and returns
    // what it stored — null when cleared back to auto-detect.
    const saved = await invoke<string | null>("set_project_python", {
      projectId: id,
      interpreter,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, python_interpreter: saved ?? undefined }
          : project,
      ),
    }));
  },

  setProjectAutoConnect: async (id, enabled) => {
    // Backend patches `auto_connect` on the remote spec in both projects.json and
    // project.json and returns the resulting state; mirror it into local state so
    // both surfaces (pill menu + Connect dialog) reflect it at once.
    const result = await invoke<boolean>("set_project_auto_connect", {
      projectId: id,
      enabled,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id && project.remote
          ? { ...project, remote: { ...project.remote, auto_connect: result || undefined } }
          : project,
      ),
    }));
  },

  setProjectOpenvpn: async (id, config, username) => {
    // Backend patches the `openvpn` field on the remote spec in both projects.json
    // and project.json and returns the stored config path (""=cleared); mirror it
    // into the entry's `remote.openvpn` so the Connect dialog reflects it at once.
    // `username` (for `auth-user-pass` configs) is stored alongside; undefined
    // leaves it untouched here by re-sending the current value.
    const cleanUser = username?.trim() || undefined;
    const stored = await invoke<string>("set_project_openvpn", {
      projectId: id,
      config: config && config.trim() ? config : null,
      username: cleanUser ?? null,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id && project.remote
          ? {
              ...project,
              remote: {
                ...project.remote,
                openvpn: stored ? { config: stored, username: cleanUser } : undefined,
              },
            }
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

  repairProjectScaffold: async (id) => {
    const repair = await invoke<ProjectScaffoldRepair>("repair_project_scaffold", { projectId: id });
    useProjectsStore.setState({ connToast: describeScaffoldRepair(repair) });
    return repair;
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

  detachProjectFromRemote: async (id) => {
    // Backend promotes the local mirror back to the project directory and drops
    // the remote/mirror pointers (host files untouched), returning the updated
    // local entry. Replace the whole entry so the pill lamp + file tree update.
    const oldDir = get().projects.find((p) => p.id === id)?.directory ?? "";
    const updated = await invoke<ProjectEntry>("detach_project_from_remote", { projectId: id });
    set((state) => ({
      projects: state.projects.map((project) => (project.id === id ? updated : project)),
    }));

    // Re-point the tabs. `directory` just changed out from under them: it was the remote
    // state dir, and it is now the promoted mirror. Every tab still holds the old one as
    // its cwd — harmless while the project was remote (localTabCwd rewrote it at render),
    // instantly wrong the moment it isn't, because that override is gated on the project
    // BEING remote. Left alone, agents relaunch inside the state dir this detach just
    // emptied, and Claude — which keys its session history by cwd — can no longer find the
    // conversation to `--resume`. See `detachScopeFromRemote`.
    if (oldDir && updated.directory) {
      useTabsStore.getState().detachScopeFromRemote(id, oldDir, updated.directory);
    }

    // The SSH/VPN lamp lives in its own store, keyed by project — nothing about replacing
    // the project entry clears it, so a detached project would keep showing a connection
    // to a host it no longer has.
    useRemoteStatusStore.getState().clear(id);
  },

  unpublishProject: async (id) => {
    // Backend removes the `origin` remote (locally or over ssh) and resets the
    // push target to local, leaving history + the hosted repo intact. Mirror the
    // git_type/provider reset into local state.
    await invoke("unpublish_project", { projectId: id });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, git_type: "local", git_provider: undefined } : project,
      ),
    }));
  },

  setProjectVisibility: async (id, visibility) => {
    // Backend flips visibility in place via the provider CLI (`gh/glab repo
    // edit`), locally or over ssh, and writes the new remote-<vis> git_type.
    const output = await invoke<string>("set_project_visibility", { projectId: id, visibility });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, git_type: `remote-${visibility}` } : project,
      ),
    }));
    return output;
  },

  switchProjectProvider: async (id, provider, visibility) => {
    // Backend moves the old origin aside (old repo left intact) and re-publishes
    // to the new provider, writing the new git_type + git_provider. Returns the
    // create CLI stdout (new repo URL); mirror the new provider/type into state.
    const output = await invoke<string>("switch_project_provider", {
      projectId: id,
      provider,
      visibility,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, git_type: `remote-${visibility}`, git_provider: provider }
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
    // Keep shell/files/network tabs, resumable agent tabs (Claude with a sessionId), and
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
    // Mount-free remote: defer restoring a remote project's tabs until its pooled
    // SSH/SFTP connection is up. Restoring them while disconnected spawns `ssh -tt`
    // PTYs and SFTP listings that block on the dead pool (the "hang"). The
    // CenterPanel restore effect — gated on the SSH status reaching "connected" —
    // performs the restore once the user reconnects via the header lamp.
    const switchedProject = payload.projectId
      ? useProjectsStore.getState().projects.find((p) => p.id === payload.projectId) ?? null
      : null;
    if (
      switchedProject?.remote &&
      useRemoteStatusStore.getState().byProject[payload.projectId ?? ""]?.ssh !== "connected"
    ) {
      return;
    }
    // Only restore from disk if this scope was never initialized this session.
    // An existing (possibly empty) entry means the user's in-memory tabs win.
    if (restorable.length > 0 && !(scopeKey in tabsStore.tabsByScope)) {
      const project = switchedProject;
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
