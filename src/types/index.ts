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
   *  in-editor with Ctrl+Shift+Space; absent → "sentence". */
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

export interface Settings {
  workspace_management?: boolean;
  debug?: boolean;
  git_profile_url?: string;
  git_token?: string;
  color_scheme?: string;
  /** Global UI zoom factor for the whole interface (helps on high-DPI/4K
   *  monitors). `1` (or unset) is 100% — the default look; applied as a CSS
   *  `zoom` on the document root. Clamped to [0.5, 3]. */
  ui_zoom?: number;
  default_agent_cmd?: string;
  /** The default local (Ollama) model. Used by any task without its own
   *  per-task assignment in `ollama_roles`, and as the legacy "active model".
   *  Chosen in the 🧠 menu (click a loaded model's name). Unset = none. */
  ollama_model?: string;
  /** Per-task local-model assignments (🧠 menu role chips). Maps a task key —
   *  `"autocomplete"`, `"grammar"`, or `"tabs"` — to the model name that should
   *  serve it, so several loaded models can run different jobs in parallel. A
   *  task absent here falls back to `ollama_model`, then to any loaded model. */
  ollama_roles?: Record<string, string>;
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
  /** When true (the default), remote SSH/OpenVPN connections are made headlessly
   *  in the background (Eldrun handles the password transiently). When false, they
   *  are launched as interactive terminal tabs in the Eldrun root scope, so the
   *  password is typed directly into the live terminal and Eldrun never handles
   *  it. Default ON (headless) preserves existing behaviour. */
  connections_headless?: boolean;
  /** When true, the right panel is docked open (reflows layout) instead of hover-revealed. */
  right_panel_pinned?: boolean;
  /** Width of the right (file/git) panel in px. Set by dragging the panel's left
   *  border; unset falls back to the default 280px. */
  right_panel_width?: number;
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

/** A previously-used `.ovpn` config copied into Eldrun's store, offered for
 *  reuse so a config need only be browsed for once. */
export interface StoredVpnConfig {
  /** Absolute path to the stored copy (passed to `openvpn_connect`). */
  path: string;
  /** Friendly display name (the original `.ovpn` file name). */
  name: string;
}

export interface RemoteSpec {
  user?: string;
  host: string;
  port?: number;
  remote_path: string;
  /** Optional OpenVPN tunnel brought up before reaching the host. */
  openvpn?: OpenVpnSpec;
}

/** Per-project Docker sandbox config. When `enabled`, agent tabs run inside a
 *  container that mounts only the project directory (plus minimal agent
 *  auth/state paths). Absent = run on host. The hardening fields below are
 *  optional overrides; unset means the built-in default (see `services::sandbox`
 *  in the backend). */
export interface SandboxSpec {
  enabled: boolean;
  image?: string;
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
  /** Docker sandbox config; when `enabled`, agent tabs run in a container. */
  sandbox?: SandboxSpec;
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
 * One user-authored calendar event, mirroring `schema::calendar::CalendarEvent`.
 * `date` is `"YYYY-MM-DD"`; `time` is `"HH:MM"` or `""` for an all-day event.
 */
export interface CalendarEvent {
  id: string;
  date: string;
  time: string;
  title: string;
  notes?: string;
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
