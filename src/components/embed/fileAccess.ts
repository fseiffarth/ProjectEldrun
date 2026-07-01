import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * The project scope that absolute-path file commands are confined to.
 *
 * Backend confinement (`src-tauri/src/commands/fs.rs`, Security #1) isolates each
 * project's filesystem from the others: a file read/write/poll is allowed only
 * inside the *scope* project's tree (plus any box sibling's tree). The scope is
 * the project that OWNS the calling viewer — NOT whichever project is globally
 * "current" — so a viewer keeps working after you switch projects, are restored
 * on relaunch, or live in a detached window, instead of failing with a spurious
 * "path is not in the current project" error.
 *
 * `FileViewerPane` publishes its owning `projectId` here; every nested viewer and
 * hook reads it via {@link useFileScope} and threads it into the wrappers below.
 * `null` is the root scope (the backend then falls back to the current project).
 */
export const FileScopeContext = createContext<string | null>(null);

/** The owning project id of the surrounding viewer (null in the root scope). */
export function useFileScope(): string | null {
  return useContext(FileScopeContext);
}

/**
 * Where a viewer's bytes come from, for its remote/local source notice:
 *  - `"remote"` — a remote (SSH) project file served straight from the host over
 *                 SFTP (remote-native, no local copy).
 *  - `"local"`  — a remote project file under the local mirror, read on the local
 *                 fs (the paired working copy synced from the host).
 *  - `"none"`   — a local project: no remote/local distinction, so no badge.
 * Resolved by the `file_source` backend command, which mirrors the exact routing
 * the read commands use so the badge can never disagree with the bytes shown.
 */
export type FileSource = "remote" | "local" | "none";

/** The resolved source of the surrounding viewer's file (`"none"` = no badge). */
export const FileSourceContext = createContext<FileSource>("none");

/** The remote/local source classification published by the enclosing viewer. */
export function useFileSource(): FileSource {
  return useContext(FileSourceContext);
}

/** Classify a path's bytes as remote-native / local-mirror / not-applicable. */
export function fileSource(path: string, projectId: string | null): Promise<FileSource> {
  return invoke<FileSource>("file_source", { path, projectId });
}

// Thin wrappers over the confined file commands. They exist so the `project_id`
// scope argument is attached uniformly and can't be forgotten at a call site.

export function readFileText(path: string, projectId: string | null): Promise<string> {
  return invoke<string>("read_file_text", { path, projectId });
}

export function readFileBytes(path: string, projectId: string | null): Promise<number[]> {
  return invoke<number[]>("read_file_bytes", { path, projectId });
}

export function writeFileText(
  path: string,
  content: string,
  projectId: string | null,
): Promise<void> {
  return invoke("write_file_text", { path, content, projectId });
}

export function writeFileBytes(
  path: string,
  content: number[] | Uint8Array,
  projectId: string | null,
): Promise<void> {
  return invoke("write_file_bytes", { path, content: Array.from(content), projectId });
}

export function fileMtime(path: string, projectId: string | null): Promise<number> {
  return invoke<number>("file_mtime", { path, projectId });
}

export function detectMime(path: string, projectId: string | null): Promise<string> {
  return invoke<string>("detect_mime", { path, projectId });
}
