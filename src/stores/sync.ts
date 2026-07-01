import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

/**
 * SSH-sync Phase 1 — frontend cache of each remote project's sync manifest plus a
 * subscription to the backend `sync-progress` stream. The remote file view reads
 * `byProject[projectId][relPath]` to overlay green/amber beside the git marker and
 * to drive the "sync this / stop syncing" affordance; `progressByProject` drives
 * the in-flight transfer indicator. The backend (`commands::sync`) is the source
 * of truth — every action here calls it, then refreshes the cached status.
 * Plan: docs/ssh_sync_plan.md.
 */

export type SyncFileState = "green" | "amber" | "none";

/** One status row as returned by the `sync_status` command. */
interface SyncStatusEntry {
  rel_path: string;
  is_dir: boolean;
  selected: boolean;
  state: SyncFileState;
}

/** Payload of the backend `sync-progress` event. */
interface SyncProgress {
  project_id: string;
  /** "start" | "file" | "done" */
  phase: string;
  rel_path: string;
  done: number;
  total: number;
}

/** Cached per-path status (the shape consumers read). */
export interface SyncEntryStatus {
  state: SyncFileState;
  selected: boolean;
  isDir: boolean;
}

/** Live transfer progress for a project (null when idle). */
export interface SyncProgressState {
  rel: string;
  done: number;
  total: number;
}

interface SyncStore {
  /** projectId → (project-relative path → status). */
  byProject: Record<string, Record<string, SyncEntryStatus>>;
  /** projectId → in-flight transfer progress, or null when idle. */
  progressByProject: Record<string, SyncProgressState | null>;

  /** Re-stat the host for the project's selected files and refresh the cache. */
  refreshStatus: (projectId: string) => Promise<void>;
  /** Pull one file or a whole folder subtree into the mirror, then refresh. */
  pull: (projectId: string, relPath: string) => Promise<void>;
  /** Pull the whole project tree into the mirror. */
  syncWholeProject: (projectId: string) => Promise<void>;
  /** Re-pull every selected file (reconcile; clears amber). */
  syncNow: (projectId: string) => Promise<void>;
  /** Push a local mirror file/folder to the host. Blocks stale files (returned in
   *  `conflicts`) unless `force`; the caller prompts and re-calls per conflict. */
  push: (
    projectId: string,
    relPath: string,
    force?: boolean,
  ) => Promise<{ pushed: number; conflicts: string[] }>;
  /** Toggle the selected flag for paths without transferring (deselect = stop). */
  markSelected: (
    projectId: string,
    relPaths: string[],
    selected: boolean,
    isDir: boolean,
  ) => Promise<void>;
}

function indexStatus(rows: SyncStatusEntry[]): Record<string, SyncEntryStatus> {
  const out: Record<string, SyncEntryStatus> = {};
  for (const r of rows) {
    out[r.rel_path] = { state: r.state, selected: r.selected, isDir: r.is_dir };
  }
  return out;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  byProject: {},
  progressByProject: {},

  refreshStatus: async (projectId) => {
    try {
      const rows = await invoke<SyncStatusEntry[]>("sync_status", { projectId });
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: indexStatus(rows) },
      }));
    } catch (e) {
      // A disconnected/local project just has no sync status — don't surface it.
      console.debug("sync_status failed", e);
    }
  },

  pull: async (projectId, relPath) => {
    await invoke("sync_pull", { projectId, relPath });
    await get().refreshStatus(projectId);
  },

  syncWholeProject: async (projectId) => {
    await invoke("sync_whole_project", { projectId });
    await get().refreshStatus(projectId);
  },

  syncNow: async (projectId) => {
    await invoke("sync_now", { projectId });
    await get().refreshStatus(projectId);
  },

  push: async (projectId, relPath, force = false) => {
    const result = await invoke<{ pushed: number; conflicts: string[] }>("sync_push", {
      projectId,
      relPath,
      force,
    });
    await get().refreshStatus(projectId);
    return result;
  },

  markSelected: async (projectId, relPaths, selected, isDir) => {
    await invoke("sync_mark_selected", { projectId, relPaths, selected, isDir });
    await get().refreshStatus(projectId);
  },
}));

let progressUnlisten: Promise<() => void> | null = null;

/**
 * Subscribe to the backend `sync-progress` stream (idempotent — registers once).
 * Updates `progressByProject` as files transfer and refreshes the cached status
 * when a transfer completes. Call once at app startup.
 */
export function listenSyncProgress(): Promise<() => void> {
  if (progressUnlisten) return progressUnlisten;
  progressUnlisten = listen<SyncProgress>("sync-progress", (ev) => {
    const p = ev.payload;
    if (p.phase === "done") {
      useSyncStore.setState((s) => ({
        progressByProject: { ...s.progressByProject, [p.project_id]: null },
      }));
      void useSyncStore.getState().refreshStatus(p.project_id);
      return;
    }
    useSyncStore.setState((s) => ({
      progressByProject: {
        ...s.progressByProject,
        [p.project_id]: { rel: p.rel_path, done: p.done, total: p.total },
      },
    }));
  });
  return progressUnlisten;
}
