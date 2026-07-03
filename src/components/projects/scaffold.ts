import type { ProjectEntry } from "../../types";
import { resolveProjectDirectory } from "../../types";

export const TERMINAL_OPTIONS = ["claude", "codex", "gemini", "vibe"];

export interface ScaffoldPreviewItem {
  path: string;
  exists: boolean;
  kind: string;
}

export interface ScaffoldRepairReport {
  createdFiles: string[];
  gitignoreLinesAdded: string[];
  gitInitialized: boolean;
}

export interface ProjectScaffoldRepair {
  projectId: string;
  name: string;
  targetDir: string;
  report: ScaffoldRepairReport;
}

export function scaffoldRepairIsEmpty(report: ScaffoldRepairReport) {
  return (
    report.createdFiles.length === 0 &&
    report.gitignoreLinesAdded.length === 0 &&
    !report.gitInitialized
  );
}

/** Human-readable one-line summary of what a repair report changed. */
export function summarizeScaffoldRepair(report: ScaffoldRepairReport): string {
  const parts: string[] = [];
  if (report.createdFiles.length > 0) {
    parts.push(`added ${report.createdFiles.join(", ")}`);
  }
  if (report.gitignoreLinesAdded.length > 0) {
    parts.push(`.gitignore +${report.gitignoreLinesAdded.join(", ")}`);
  }
  if (report.gitInitialized) {
    parts.push("git init");
  }
  return parts.length > 0 ? parts.join("; ") : "already up to date";
}

/** Same summary, prefixed with the project name — for a toast/log covering
 *  multiple projects at once. */
export function describeScaffoldRepair(repair: ProjectScaffoldRepair): string {
  return `${repair.name}: ${summarizeScaffoldRepair(repair.report)}`;
}

export const SCAFFOLD_FILL_OPTIONS = [
  { value: "none", label: "No filling" },
  { value: "manual", label: "Manual" },
  { value: "validation", label: "Validation" },
  { value: "agent_choice", label: "Agent choice" },
  { value: "claude", label: "Fill by Claude" },
  { value: "codex", label: "Fill by Codex" },
  { value: "gemini", label: "Fill by Gemini" },
  { value: "vibe", label: "Fill by Mistral" },
];

export const AGENT_SCAFFOLD_FILL_MODES = new Set([
  "agent_choice",
  "claude",
  "codex",
  "gemini",
  "vibe",
]);

export function sanitizeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function projectDirectory(project: ProjectEntry) {
  return resolveProjectDirectory(project);
}

export function agentForScaffoldFillMode(fillMode: string, defaultAgentCmd: string) {
  return fillMode === "agent_choice" ? defaultAgentCmd : fillMode;
}

export function collectScaffoldAgentFills(
  preview: ScaffoldPreviewItem[],
  fillModes: Record<string, string>,
  defaultAgentCmd: string,
) {
  const filesByAgent = new Map<string, string[]>();
  for (const item of preview) {
    if (item.exists) continue;
    if (item.kind !== "file") continue;
    const fillMode = fillModes[item.path] ?? "none";
    if (!AGENT_SCAFFOLD_FILL_MODES.has(fillMode)) continue;
    const agent = agentForScaffoldFillMode(fillMode, defaultAgentCmd);
    const cmd = TERMINAL_OPTIONS.includes(agent) ? agent : "claude";
    filesByAgent.set(cmd, [...(filesByAgent.get(cmd) ?? []), item.path]);
  }
  return filesByAgent;
}

export function buildScaffoldFillPrompt(files: string[]) {
  const fileList = files.map((file) => `- ${file}`).join("\n");
  return [
    "Fill the Eldrun project scaffold files listed below.",
    "",
    "Instructions:",
    "- Inspect the project first so the files reflect the actual codebase and purpose.",
    "- Replace placeholder scaffold content with useful, project-specific guidance.",
    "- Preserve unrelated existing content and do not rewrite files outside this list.",
    "- Keep AGENTS.md practical for coding agents, including architecture, workflows, and constraints.",
    "",
    "Files to fill:",
    fileList,
  ].join("\n");
}

export function buildDescriptionFillPrompt(projectName: string) {
  return [
    `Write a concise Eldrun project description for "${projectName}".`,
    "",
    "Instructions:",
    "- Inspect the project first so the description reflects the actual codebase and purpose.",
    "- Update project.json by setting the top-level description field.",
    "- Keep it to one or two practical sentences suitable for a project switcher hover popup.",
    "- Preserve unrelated existing content and formatting where practical.",
  ].join("\n");
}

export interface ParsedSshAddress {
  user: string | null;
  host: string;
  port: number | null;
}

/**
 * Parse an SSH address of the form `[user@]host[:port]` (e.g. `me@box:2222`,
 * `box`, `me@box`). Returns null if no host can be extracted or the port is
 * not a valid number. The empty string yields null (= local, unchanged flow).
 */
export function parseSshAddress(raw: string): ParsedSshAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let user: string | null = null;
  let rest = trimmed;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at) || null;
    rest = rest.slice(at + 1);
  }
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const portStr = rest.slice(colon + 1);
    const parsed = Number(portStr);
    if (!portStr || !Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return null;
    }
    port = parsed;
    rest = rest.slice(0, colon);
  }
  const host = rest.trim();
  if (!host) return null;
  return { user, host, port };
}

/** Join a remote directory path with a child segment using POSIX separators. */
export function joinRemotePath(base: string, child: string): string {
  if (!base || base === "/") return `/${child}`;
  return `${base.replace(/\/+$/, "")}/${child}`;
}
