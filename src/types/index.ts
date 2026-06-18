export interface GlobalAppEntry {
  exec: string;
  visible: boolean;
  [key: string]: unknown;
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
  global_apps?: Record<string, GlobalAppEntry>;
  [key: string]: unknown;
}

export interface RemoteSpec {
  user?: string;
  host: string;
  port?: number;
  remote_path: string;
}

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
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
  [key: string]: unknown;
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
