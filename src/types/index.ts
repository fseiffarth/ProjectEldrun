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
export interface ViewerPref {
  /** Whether this native viewer is used at all. Absent/true → render in-app;
   *  false → the type opts out and its files open in the external default app. */
  enabled?: boolean;
  /** Whether Ctrl+Space local autocomplete is enabled for this type (#45). */
  autocomplete?: boolean;
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
  terminal_command?: string;
  workspace_management?: boolean;
  debug?: boolean;
  git_profile_url?: string;
  git_token?: string;
  color_scheme?: string;
  default_agent_cmd?: string;
  run_scripts_in_background?: boolean;
  /** When true, the right panel is docked open (reflows layout) instead of hover-revealed. */
  right_panel_pinned?: boolean;
  /** Minimum subwindow (split pane) width in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_width?: number;
  /** Minimum subwindow (split pane) height in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_height?: number;
  /** When true, in-app editors debounce-save edits automatically (#47). Default OFF. */
  autosave?: boolean;
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
  [key: string]: unknown;
}

export interface OpenVpnSpec {
  /** Absolute path to the local `.ovpn` client config file. */
  config: string;
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
 *  container that mounts only the project directory. Absent = run on host. */
export interface SandboxSpec {
  enabled: boolean;
  image?: string;
}

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
}

/** Availability of the external binaries remote (SSH) projects rely on. */
export interface SshTooling {
  /** `sshfs` — required to mount a remote project locally. */
  sshfs: boolean;
  /** `sshpass` — required only for password auth. */
  sshpass: boolean;
  /** `openvpn` + `pkexec` — required only for VPN-gated hosts. */
  openvpn: boolean;
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
  [key: string]: unknown;
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
  return project.local_file.endsWith("/project.json")
    ? project.local_file.slice(0, -"/project.json".length)
    : "";
}

export type Theme = "fancy_dark" | "dark" | "light" | "fancy_light";

export const THEMES: { value: Theme; label: string }[] = [
  { value: "fancy_dark", label: "Fancy Dark" },
  { value: "dark", label: "Plain Dark" },
  { value: "light", label: "Plain Light" },
  { value: "fancy_light", label: "Fancy Light" },
];
