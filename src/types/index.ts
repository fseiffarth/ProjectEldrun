export interface GlobalAppEntry {
  exec: string;
  visible: boolean;
  [key: string]: unknown;
}

/**
 * Per-file-type native-viewer preferences (#48). Keys are snake_case to match
 * the Rust `ViewerPref` serde serialization so settings.json round-trips. Keyed
 * by a viewer-type id (see VIEWER_PREF_TYPES in fileUtils).
 */
/**
 * Completion-length mode for local autocomplete (#45 modes), mirroring the Rust
 * `CompletionMode`: how much the model is asked to complete at the caret.
 *  - `"sentence"` — finish the current word/sentence/line (default).
 *  - `"block"` — finish the current code block / paragraph (multi-line).
 *  - `"scope"` — complete the whole enclosing function or scope.
 */
export type AutocompleteMode = "sentence" | "block" | "scope";

/**
 * Category of a local-model grammar/spelling issue, mirroring the Rust
 * `check_grammar` output. Drives the underline colour in the editor overlay.
 *  - `"spelling"` — a misspelled word / typo (red).
 *  - `"grammar"` — a grammar or punctuation mistake (blue).
 *  - `"style"` — a style/wording suggestion (green).
 */
export type GrammarCategory = "spelling" | "grammar" | "style";

/**
 * One proofreading issue returned by the local-model grammar check, mirroring the
 * Rust `GrammarIssue`. `bad` is the exact offending substring (the frontend
 * locates it in the draft to draw the underline); `line` is its 1-based line in
 * the checked text, used as a disambiguation hint when resolving the range.
 */
export interface GrammarIssue {
  line: number;
  bad: string;
  suggestion: string;
  category: GrammarCategory;
  message: string;
}

export interface ViewerPref {
  /** Whether this native viewer is used at all. Absent/true → render in-app;
   *  false → the type opts out and its files open in the external default app. */
  enabled?: boolean;
  /** Whether Ctrl+Space local autocomplete is enabled for this type (#45). */
  autocomplete?: boolean;
  /** Default completion-length mode for this type (#45 modes). Cycled live
   *  in-editor with Shift+Tab while a suggestion is showing; absent → "sentence". */
  autocomplete_mode?: AutocompleteMode;
  /** Whether the local-model grammar/spelling check is enabled for this type.
   *  Local-only (Ollama) and opt-in; default OFF. */
  grammar_check?: boolean;
  /** Editor font size in px for this type's in-app code editor. Adjusted from
   *  the viewer's A−/A+ controls (or Ctrl +/−/0); unset falls back to 12px. */
  font_size?: number;
}

/**
 * A serializable keyboard chord (Group L / #62). Mirrors the Rust `ChordDescriptor`
 * and `src/lib/shortcuts.ts`'s `ChordDescriptor`. `key` is a normalized
 * `KeyboardEvent.key`; modifier flags default to false when absent.
 */
export interface KeyboardChord {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * A user-defined "custom agent" — an arbitrary CLI the user wants offered in the
 * add-tab menu's Agents group alongside the built-in agents (Claude, Codex, …).
 * It is just a launch command: Eldrun spawns `cmd` (+ `args`, `env`) in the
 * project directory as an `agent` tab. Persisted in `Settings.custom_agents` and
 * added/removed from the "＋ Add agent…" dialog.
 *
 * Unlike a built-in agent it carries no install command and no session-capture
 * machinery. The one optional capability is `resumeArgs`: a "continue the most
 * recent session" flag (e.g. `["--continue"]`) that, when set, promotes the tab
 * to the *cwd-continue* resume tier — it survives a restart and respawns with
 * these args (exactly how Qwen/OpenCode resume). Unset ⇒ launch-only, dropped on
 * restart like Gemini/Aider.
 */
export interface CustomAgent {
  /** Stable id minted at creation; also the persisted map key / React key. */
  id: string;
  /** Display label in the Agents menu. */
  label: string;
  /** Binary/command to spawn. Probed on PATH (or as a file path when it contains
   *  a separator) for the menu's installed/greyed state. */
  cmd: string;
  /** Optional launch args, prepended before any resume args. */
  args?: string[];
  /** Optional environment variables set on the tab's process. */
  env?: Record<string, string>;
  /** Optional "continue last session" flag(s). When non-empty the tab is
   *  restart-resumable (see the interface note). */
  resumeArgs?: string[];
  /** Optional one-line install command (e.g. `npm install -g @scope/pkg`). When
   *  the agent's binary isn't found, the manage dialog offers a one-click button
   *  that runs this in a fresh root terminal tab (Eldrun's install-via-tab
   *  policy — never a copy-it-yourself step). */
  installCmd?: string;
}

export interface Settings {
  debug?: boolean;
  git_profile_url?: string;
  git_token?: string;
  color_scheme?: string;
  /** The MAIN window's UI zoom factor (helps on high-DPI/4K monitors). `1` (or
   *  unset) is 100% — the default look; applied as the webview's native zoom.
   *  Clamped to [0.5, 3]. Zoom is **per window**: a detached popout persists its
   *  own zoom on its layout entry (see `DetachedGroup.zoom`), not here. */
  ui_zoom?: number;
  /** Calendar: first column of the week — `0` = Sunday (default), `1` = Monday. */
  calendar_week_start?: 0 | 1;
  /** Calendar: the view a fresh calendar tab opens on. Default `"month"`. */
  calendar_default_view?: CalendarViewKind;
  /** Calendar: 24-hour clock instead of AM/PM. Default off. */
  calendar_time_format_24h?: boolean;
  /** Calendar: first/last hour the day and week grids scroll to. Default 8/20. */
  calendar_day_start_hour?: number;
  calendar_day_end_hour?: number;
  /** Calendar: minutes-before reminder pre-filled on a new event. `0` = none. */
  calendar_default_reminder_minutes?: number;
  default_agent_cmd?: string;
  /** User-defined custom agents offered in the add-tab menu's Agents group,
   *  added/removed from the "＋ Add agent…" dialog. Round-trips through the
   *  backend settings `extra` catch-all — no Rust field needed. See CustomAgent. */
  custom_agents?: CustomAgent[];
  /** The default local (Ollama) model. Used by any task without its own
   *  per-task assignment in `ollama_roles`, and as the legacy "active model".
   *  Chosen in the 🧠 menu (click a loaded model's name). Unset = none. */
  ollama_model?: string;
  /** Per-task local-model assignments (🧠 menu role chips). Maps a task key —
   *  `"autocomplete"`, `"grammar"`, or `"tabs"` — to the model name that should
   *  serve it, so several loaded models can run different jobs in parallel. A
   *  task absent here falls back to `ollama_model`, then to any loaded model. */
  ollama_roles?: Record<string, string>;
  /** Python Run/Debug arguments (#py), the raw `sys.argv` string typed into the
   *  Run button's right-click popover, keyed by the file's absolute path. Kept
   *  per file (not per tab) so every viewer of the same script shares one set of
   *  args, and here (global settings) so they survive closing the viewer and an
   *  Eldrun restart. Round-trips through the backend's `extra` catch-all — no Rust
   *  field needed. An entry set to "" means "cleared" and is pruned. */
  python_run_args?: Record<string, string>;
  run_scripts_in_background?: boolean;
  /** Header resource-monitor row toggles. Each defaults ON (undefined → shown).
   *  Independent of `debug`; the pill is available in every build. */
  show_cpu_usage?: boolean;
  show_ram_usage?: boolean;
  show_gpu_usage?: boolean;
  /** When true (the default), Claude agent tabs are spawned with `--remote-control`
   *  so the running session can be monitored/steered from the Claude app/web. Only
   *  Claude supports this flag; other agents ignore the setting. */
  agent_remote_control?: boolean;
  /** When true (the default), the usage recap opens by itself on the first launch
   *  of each day. Turning it off stops the popup, not the counting — the recap
   *  stays reachable from Settings. */
  daily_stats_recap?: boolean;
  /** UTC date ("YYYY-MM-DD") the recap was last auto-shown, so it opens once a day
   *  rather than once per window. Written by the recap host. */
  daily_stats_last_shown?: string;
  /** EXPERIMENTAL, default OFF. Shows a Plan/Auto badge on agent tabs whose agent
   *  supports an absolute mode flag AND resumes on respawn (currently Claude only —
   *  see components/tabs/agentModes.ts). Switching restarts the agent; the
   *  conversation is resumed, the terminal scrollback is not. */
  agent_mode_toggle?: boolean;
  /** EXPERIMENTAL, default OFF. Gives a Python file in the code viewer its Run/Debug
   *  buttons and the breakpoint gutter (#87). Off by default because Run *executes
   *  the file* — one click away from an editor — so it is opt-in. Go-to-definition
   *  is not gated: it reads, it never runs anything. */
  python_run_debug?: boolean;
  /** Persistent LOCAL (tmux) sessions (TODO #85): when true (the default on Unix),
   *  a local project's shell/script tabs run inside a tmux session on the machine,
   *  so a long run keeps going if Eldrun crashes and the tab reattaches on restart.
   *  `undefined`/`true` = on; `false` = off. No effect on Windows (no tmux). */
  persist_local_sessions?: boolean;
  /** When true (the default), remote SSH/OpenVPN connections are made headlessly
   *  in the background (Eldrun handles the password transiently). When false, they
   *  are launched as interactive terminal tabs in the Eldrun root scope, so the
   *  password is typed directly into the live terminal and Eldrun never handles
   *  it. Default ON (headless) preserves existing behaviour. */
  connections_headless?: boolean;
  /** Path of the stored `.ovpn` config brought up automatically **on launch** —
   *  armed from the header's VPN menu, with no project behind it. Unset/null = no
   *  tunnel starts by itself. Only one config can be armed: a tunnel reroutes the
   *  whole machine, so two would fight over the routing. */
  vpn_auto_connect?: string | null;
  /** Energy-saver mode. "off" never throttles; "battery" (the default) throttles
   *  only while running on battery; "always" throttles regardless of power. When
   *  active, Eldrun pauses the blob auto-spin, collapses idle animations, and
   *  widens always-on UI timers to reduce CPU/battery drain. */
  energy_saver?: "off" | "battery" | "always";
  /** When true, the right panel is docked open (reflows layout) instead of hover-revealed. */
  right_panel_pinned?: boolean;
  /** Width of the right (file/git) panel in px. Set by dragging the panel's left
   *  border; unset falls back to the default 280px. */
  right_panel_width?: number;
  /** Which edge the file panel docks against. Unset falls back to "right". Flipped
   *  by the ⇄ button in the panel header; round-trips through the settings `extra`
   *  catch-all, so no backend field is needed. */
  right_panel_side?: "left" | "right";
  /** Minimum subwindow (split pane) width in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_width?: number;
  /** Minimum subwindow (split pane) height in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_height?: number;
  /** When true, in-app editors debounce-save edits automatically (#47). Default OFF. */
  autosave?: boolean;
  /** When true (the default), the text/TeX editors tint recently typed runs with a
   *  sequential new→old colour trail that fades as you keep typing. Default ON;
   *  only an explicit `false` disables it. */
  change_tint?: boolean;
  /** Per-type native-viewer prefs (#48): opt-in local autocomplete (#45). */
  viewer_prefs?: Record<string, ViewerPref>;
  global_apps?: Record<string, GlobalAppEntry>;
  /**
   * User overrides for the rebindable navigation chords (Group L / #62), keyed
   * by `ShortcutAction` id (see `src/lib/shortcuts.ts`). Any action absent here
   * falls back to its built-in default; an empty/missing map preserves the
   * original hard-coded behaviour.
   */
  keyboard_shortcuts?: Record<string, KeyboardChord>;
  /** Download *source* folders scanned by the right-panel Downloads section
   *  (fast-copy of freshly downloaded files into a project). Machine-wide,
   *  read-only. Unset/empty → the frontend falls back to the OS Downloads dir. */
  download_sources?: string[];
  /** True once the first-run "How to start" welcome has been shown/dismissed, so
   *  it never re-opens automatically. Re-openable manually from Settings. */
  onboarding_seen?: boolean;
  /** Ids of contextual hints (see `src/lib/hints.ts`) the user has seen/dismissed
   *  or implicitly acted on, so each surfaces at most once. */
  hints_seen?: string[];
  /** Master switch for the contextual hint system; default ON when unset. */
  hints_enabled?: boolean;
  /** True once the guided "Take a tour" walkthrough has been completed or
   *  skipped. Cosmetic only (never auto-launches the tour); the tour is always
   *  replayable from the gear menu / Settings. */
  tour_completed?: boolean;
  /** Where the main window was when Eldrun last ran, so it reopens on the same
   *  monitor in the same place. Written by the debounced save in `AppShell`;
   *  consumed by the backend at startup, never rendered. */
  window_state?: WindowState;
  [key: string]: unknown;
}

/**
 * The main window's geometry in PHYSICAL desktop px — the canonical cross-window
 * space (`src/lib/coords.ts`), which is also what `outerPosition`/`outerSize`
 * report and what `setPosition`/`setSize` consume.
 *
 * `x`/`y`/`w`/`h` is the *restore* (non-maximized) rect: while the window is
 * maximized the rect is left alone and only `maximized` flips, so un-maximizing
 * after a restart lands on a real geometry instead of the full monitor.
 *
 * Mirrors `WindowState` in `src-tauri/src/schema/settings.rs`.
 */
export interface WindowState {
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
}

export interface OpenVpnSpec {
  /** Absolute path to the local `.ovpn` client config file. */
  config: string;
  /** Auth username for `auth-user-pass` configs (server-side username+password
   *  auth). Persisted (not a secret); the password is still prompted separately. */
  username?: string;
}

/** Verdict of `ssh_probe`: a silent, keychain-read-only reachability + auth check.
 *  `unreachable` distinguishes "this network can't reach the host" from "the host
 *  rejected the credential" — only the former warrants bringing a VPN tunnel up. */
export interface SshProbe {
  ok: boolean;
  unreachable: boolean;
  error: string;
}

/** A previously-used `.ovpn` config copied into Eldrun's store, offered for
 *  reuse so a config need only be browsed for once. */
export interface StoredVpnConfig {
  /** Absolute path to the stored copy (passed to `openvpn_connect`). */
  path: string;
  /** Friendly display name (the original `.ovpn` file name). */
  name: string;
}

/** A globally connected worker machine (`stores/globalMachines.ts`):
 *  authenticated once via the ordinary login mechanism, with no
 *  `remote_path` — project-free, unlike {@link ComputeHost}. Drag-and-dropped
 *  onto an SSH project to become a `shared_fs` compute host there (a value
 *  copy of this identity, not a reference). */
export interface GlobalMachine {
  id: string;
  user?: string;
  host: string;
  port?: number;
  label?: string;
}

/** Which secrets a `.ovpn` config needs from the user (`openvpn_auth_needs`), so
 *  the UI shows exactly the fields that config will be asked for. The two are
 *  independent — a config can need both, and OpenVPN prompts for them separately,
 *  so supplying only one hangs the handshake on the other prompt. The local root
 *  password is a third secret, but polkit/`pkexec` collects that one, not Eldrun. */
export interface VpnAuthNeeds {
  /** Bare `auth-user-pass`: server-side account auth, so a username is required. */
  username: boolean;
  /** An encrypted private key, whose passphrase OpenVPN asks for separately. */
  keyPassphrase: boolean;
}

/** Whether the config's key passphrase is a *separate* field from its password.
 *  When a config has an encrypted key but no `auth-user-pass` account, the single
 *  password field already *is* the key passphrase (it goes to `--askpass`), so a
 *  second field would be asking for the same secret twice. */
export const needsSeparateKeyPassphrase = (needs: VpnAuthNeeds): boolean =>
  needs.username && needs.keyPassphrase;

export interface RemoteSpec {
  user?: string;
  host: string;
  port?: number;
  remote_path: string;
  /** Optional OpenVPN tunnel brought up before reaching the host. */
  openvpn?: OpenVpnSpec;
  /** Opt-in: connect this project on launch/activation instead of waiting for the
   *  user to bring it up from the pill's connection lamp. Only offered when the
   *  connect can complete with no prompt (saved SSH password, or `key_auth`), and
   *  the connect path re-checks that — it never prompts. */
  auto_connect?: boolean;
  /** Recorded by the backend, not user-set: the last successful connect to this
   *  host used no password at all (key/agent auth). A passwordless host has nothing
   *  in the keychain, so this is the only way the UI can tell it is auto-connectable. */
  key_auth?: boolean;
  /** Display name for this machine, e.g. "gpu-2"; falls back to `host`. Shown
   *  wherever a project's hosts are listed side by side (System Monitor's source
   *  picker, the pill's connection lamps, `hostsForProject`). Distinct from the
   *  *project* name — this labels the machine, not the project. */
  label?: string;
  /** Persistent remote sessions (TODO #85): run this project's remote shell/script
   *  tabs inside a **tmux** session on the host, so a long run survives an SSH drop,
   *  a laptop sleep, or Eldrun quitting. **Default ON** — `undefined`/`true` mean
   *  enabled; only an explicit `false` (the pill's toggle) opts out. Agent tabs are
   *  excluded regardless. See `persistSessionsEnabled`. */
  persist_sessions?: boolean;
}

/** An extra SSH "worker" machine a project runs experiments on
 *  (`docs/multi_host_remote_plan.md`). Its code is kept one-way in sync from the
 *  canonical source (the primary's local mirror) and its files are read-only —
 *  edits are forbidden, so there is no divergence and no destructive local-loss.
 *  The primary remote (`ProjectEntry.remote`) is unchanged. Extends `RemoteSpec`
 *  (flattened on the backend), so it carries the same user/host/port/remote_path/
 *  openvpn/auto_connect fields. */
export interface ComputeHost extends RemoteSpec {
  /** Stable id (e.g. "h1"); referenced by tab locations, the pool key, and the
   *  fan-out state. The primary is the implicit id `"primary"`. */
  id: string;
  /** Keep this worker's tracked tree synced to the source HEAD (default true). */
  sync_code?: boolean;
  /** Pull this worker's experiment OUTPUTS back only on demand (default false —
   *  outputs stay on the worker). */
  pull_outputs?: boolean;
  /** This machine reaches the project over a **shared filesystem**: it already
   *  sees the primary's project folder at `remote_path`, so Eldrun copies no code
   *  to it and never runs git on it — shells just `cd` into the shared tree and
   *  run there. The default for a newly added machine (untick "Sync a copy" for
   *  the synced-copy worker instead). Schema default false for back-compat. */
  shared_fs?: boolean;
}

/** Per-project container config (TODO #38). When `enabled`, every terminal and
 *  agent tab of the project execs into ONE session-lived Docker container that
 *  mounts only the project directory (plus minimal agent auth/state paths) at
 *  its identical host path. Absent = run on host. The hardening fields below
 *  are optional overrides; unset means the built-in default (see
 *  `services::sandbox` in the backend). */
export interface SandboxSpec {
  enabled: boolean;
  image?: string;
  /** In-repo Dockerfile (relative to the project dir); when set, the container
   *  is built from it (`eldrun-<id>:latest`) instead of pulling `image`. */
  dockerfile?: string;
  /** `--pids-limit` (fork-bomb guard). Unset = generous built-in default. */
  pids_limit?: number;
  /** Hard memory cap, e.g. "4g" (`--memory`). Unset = unlimited. */
  memory?: string;
  /** CPU cap, e.g. "2" (`--cpus`). Unset = unlimited. */
  cpus?: string;
  /** Docker network, e.g. "none" for no egress (`--network`). Unset = bridge. */
  network?: string;
  /** Read-only root filesystem (`--read-only` + tmpfs /tmp). Default false. */
  readonly_rootfs?: boolean;
}

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
}

/** Availability of the remote-project capabilities that depend on the platform.
 * Remote projects are SSH/SFTP-native (no FUSE mount), so only password auth and
 * VPN-gated (`openvpn`) hosts need anything beyond a stock `ssh`. */
export interface SshTooling {
  /** Whether non-interactive password auth works without installing anything.
   * Always true on Unix (OpenSSH's `SSH_ASKPASS`); on Windows it needs either
   * OpenSSH ≥ 8.4 (same askpass mechanism) or `sshpass` as the legacy fallback. */
  password_auth: boolean;
  /** `openvpn` + `pkexec` — required only for VPN-gated hosts. */
  openvpn: boolean;
  /** `rsync` on the local machine — enables the SSH-sync bulk fast-path. */
  rsync: boolean;
}

export interface ProjectEntry {
  id: string;
  name: string;
  /** "current" | "active" | "inactive" */
  status: string;
  position: number;
  local_file: string;
  directory?: string;
  description?: string;
  remote?: RemoteSpec;
  /** Extra "worker" machines this project runs experiments on
   *  (`docs/multi_host_remote_plan.md`). One-way, read-only; the primary is
   *  `remote`. Mirrored from project.json into the pill list. */
  compute_hosts?: ComputeHost[];
  /** Docker sandbox config; when `enabled`, agent tabs run in a container. */
  sandbox?: SandboxSpec;
  /** The interpreter the code viewer's Run/Debug buttons use (#87). Absent =
   *  auto-detect, which is right for almost every project; pinning it is for the
   *  environments auto-detect cannot see (a conda env, a Poetry venv outside the
   *  tree, a second venv). Set from the pill's "Python interpreter…" dialog. */
  python_interpreter?: string;
  /** Denormalized inverse of `ProjectBox.member_ids` (the box this pill is in). */
  box_id?: string;
  /** Per-project git-hosting profile URL that overrides the global one. Mirrored
   *  from project.json into the pill list; the matching token lives in the OS
   *  keyring, never here. See `GitHostingInfo`. */
  git_profile_url?: string;
  /** Hosting provider this project was published to, recorded at publish time.
   *  Absent until published to a remote. */
  git_provider?: GitProvider;
  /** Provider sniffed from the local `origin` host at load time (host-only, no
   *  network). Decorates the pill badge for repos pushed to a host outside
   *  Eldrun's Publish flow. Transient — never persisted to projects.json. */
  detected_provider?: GitProvider;
  /** Raw `origin` remote URL sniffed alongside `detected_provider`. Shown as the
   *  git address in the project hover. Transient — never persisted. */
  git_origin_url?: string;
  /** User-assigned category tags. Group/color the project in the cloud + pills;
   *  set via the pill / blob-node right-click menu. Stored in the entry's
   *  flattened `extra` (mirrored into project.json). */
  categories?: string[];
  [key: string]: unknown;
}

/** A row in the Settings "Archived projects" list (from `list_archived_projects`).
 *  Archived projects live under `~/eldrun/archive/<id>/` until restored or
 *  permanently cleared. */
export interface ArchivedProject {
  id: string;
  name: string;
  /** ISO timestamp the project was archived (stamped at delete time). */
  archived_at: string;
  /** True for remote (SSH) projects — their host tree was never touched. */
  remote: boolean;
}

/** One local mirror branch carrying commits the host baseline lacks. */
export interface UnsyncedBranch {
  name: string;
  count: number;
}

/** Whether permanently deleting an archived remote project would discard
 * local-only mirror history. Computed offline from the archived files. */
export interface UnsyncedReport {
  /** Commits on the mirror's local branches not present on the host baseline. */
  total: number;
  branches: UnsyncedBranch[];
  /** False when there was no host baseline to compare against (the count is then
   * every local commit and should read as "could not verify"). */
  verified: boolean;
}

/** Supported git-hosting providers for publishing a project's repo. */
export type GitProvider = "github" | "gitlab";

/**
 * Per-project git-hosting config as returned by `get_project_git_hosting`. The
 * token is never sent to the renderer — only whether one is stored — and the
 * global values are surfaced so the editor can show what is inherited by default.
 */
export interface GitHostingInfo {
  /** Per-project profile URL override, if set (else inherits `global_profile_url`). */
  profile_url: string | null;
  /** Whether a per-project token is stored in the keyring. */
  has_token: boolean;
  /** Global fallback profile URL (from settings), shown as the inherited default. */
  global_profile_url: string | null;
  /** Whether a global token exists to fall back on. */
  has_global_token: boolean;
}

/**
 * A directed relation between two members of a box ("a change in `source` may
 * influence `target`"). Mirrors the Rust `BoxRelation` (#41 Phase 2: stored).
 */
export interface BoxRelation {
  source: string;
  target: string;
  kind?: string;
  hint?: string;
}

/**
 * A project box — meta-project grouping (#13 + #41). Mirrors the Rust
 * `ProjectBox` (serde-synced snake_case fields), persisted in `boxes.json`.
 */
export interface ProjectBox {
  id: string;
  name: string;
  member_ids: string[];
  position: number;
  /** Absolute box-folder path; filled lazily on first open (#41 Phase 2). */
  folder?: string;
  /** Directed inter-project relations (#41 Phase 2 stored, Phase 4 surfaced). */
  relations?: BoxRelation[];
}

/**
 * The native calendar's model, mirroring `src-tauri/src/schema/calendar.rs`.
 *
 * All timestamps are **local wall-clock**: `"YYYY-MM-DDTHH:MM"` when timed,
 * `"YYYY-MM-DD"` when all-day. Ends are **exclusive** (an all-day event on the
 * 8th ends `"2026-07-09"`). See `src/lib/calendarTime.ts` for the math.
 */

/** The views a calendar tab can show. */
export type CalendarViewKind =
  | "day"
  | "week"
  | "multiweek"
  | "month"
  | "agenda"
  | "tasks";

/** One named, colored calendar in the sidebar list. */
export interface Calendar {
  id: string;
  name: string;
  /** CSS color its events render in. */
  color: string;
  /** Unchecked in the sidebar → its events drop out of every view. */
  visible: boolean;
  readonly: boolean;
}

/** How often a recurring event repeats. */
export type Freq = "daily" | "weekly" | "monthly" | "yearly";

/** A recurrence rule. `until` and `count` are mutually exclusive ends. */
export interface Rrule {
  freq: Freq;
  /** Repeat every N periods. */
  interval: number;
  /** Weekly only: weekdays to fire on, `0` = Sunday … `6` = Saturday. */
  byweekday?: number[];
  /** Monthly only: day of month (1-31). Absent → the event's own day. */
  bymonthday?: number | null;
  /** Inclusive last date (`"YYYY-MM-DD"`) the rule may fire on. */
  until?: string | null;
  /** Total occurrences, counting the first. */
  count?: number | null;
}

/** A single occurrence edited away from its master ("this event only"). */
export interface EventOverride {
  /** The occurrence's start as the rule generated it — the key. */
  occurrence_start: string;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  location?: string | null;
  notes?: string | null;
}

/** A reminder, fired `minutes_before` the occurrence starts. */
export interface Alarm {
  minutes_before: number;
}

/** `"confirmed"` (default) | `"tentative"` | `"cancelled"`. */
export type EventStatus = "confirmed" | "tentative" | "cancelled";

/** A calendar event. `end` is exclusive. */
export interface CalendarEvent {
  id: string;
  calendar_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location?: string;
  notes?: string;
  category?: string;
  status?: EventStatus | "";
  rrule?: Rrule | null;
  /** Occurrence starts deleted from the series. */
  exdates?: string[];
  overrides?: EventOverride[];
  alarms?: Alarm[];
}

/** A to-do (VTODO). */
export interface CalendarTask {
  id: string;
  calendar_id: string;
  title: string;
  notes?: string;
  due?: string | null;
  start?: string | null;
  /** iCalendar priority: `0` = unset, `1` = highest … `9` = lowest. */
  priority: number;
  /** 0-100; `100` implies done. */
  percent: number;
  completed?: string | null;
  category?: string;
  alarms?: Alarm[];
}

/** The whole of `calendar.json`. */
export interface CalendarData {
  version: number;
  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
}

/**
 * One materialized instance of an event on the timeline. A non-recurring event
 * yields exactly one; a recurring one yields many, all sharing `eventId`.
 * `occurrenceStart` is the start the *rule* generated — the stable key used for
 * exdates and overrides, which survives the occurrence being moved.
 */
export interface Occurrence {
  eventId: string;
  occurrenceStart: string;
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location: string;
  notes: string;
  category: string;
  status: EventStatus | "";
  calendarId: string;
  /** True when it came from a recurring master (so the UI can offer this/all). */
  recurring: boolean;
  alarms: Alarm[];
}

/**
 * Sanitize a box name into a folder segment. Mirrors the backend
 * `commands::projects::sanitize_name` so the frontend can preview the box-folder
 * path consistently.
 */
export function boxFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveProjectDirectory(project: ProjectEntry | null | undefined): string {
  if (!project) return "";
  if (project.directory) return project.directory;
  const match = /^(.*)[/\\]project\.json$/i.exec(project.local_file);
  return match?.[1] ?? "";
}

/**
 * Format a remote project's location as `user@host:remote_path` (the `user@`
 * prefix is dropped when no user is set). Port is intentionally omitted — this
 * is an at-a-glance display string, and `host:port:path` would be ambiguous.
 */
export function formatRemoteTarget(remote: RemoteSpec): string {
  return `${remote.user ? `${remote.user}@` : ""}${remote.host}:${remote.remote_path}`;
}

/**
 * The paired local working-copy ("mirror") path for a remote project, read from
 * the flattened `extra["mirror"]` field mirrored onto the entry. Returns null
 * when unset (legacy remote projects created before the mirror was persisted).
 */
export function resolveLocalMirror(project: ProjectEntry | null | undefined): string | null {
  const mirror = project?.mirror;
  return typeof mirror === "string" && mirror.trim() ? mirror : null;
}

export type Theme =
  | "fancy_dark"
  | "dark"
  | "light"
  | "fancy_light"
  | "light_lavender";

export const THEMES: { value: Theme; label: string }[] = [
  { value: "fancy_dark", label: "Fancy Dark" },
  { value: "dark", label: "Plain Dark" },
  { value: "light", label: "Plain Light" },
  { value: "fancy_light", label: "Fancy Light" },
  { value: "light_lavender", label: "Light Lavender" },
];
