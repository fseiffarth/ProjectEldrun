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
  global_apps?: Record<string, GlobalAppEntry>;
  [key: string]: unknown;
}

export interface ProjectEntry {
  id: string;
  name: string;
  /** "current" | "active" | "inactive" */
  status: string;
  position: number;
  local_file: string;
  [key: string]: unknown;
}

export type Theme = "fancy_dark" | "dark" | "light" | "fancy_light";

export const THEMES: { value: Theme; label: string }[] = [
  { value: "fancy_dark", label: "Fancy Dark" },
  { value: "dark", label: "Plain Dark" },
  { value: "light", label: "Plain Light" },
  { value: "fancy_light", label: "Fancy Light" },
];
