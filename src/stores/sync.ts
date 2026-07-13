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
  /** Effective auto-sync (own entry or an ancestor auto folder marker). */
  auto_sync: boolean;
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
  /** Whether this path auto-syncs (own flag or an ancestor auto folder). */
  auto: boolean;
}

/** One side (local mirror or host) of a tracked file, from `sync_file_meta`. */
export interface SyncSideMeta {
  exists: boolean;
  size: number;
  /** Unix seconds, or null when the side reports none. */
  mtime: number | null;
}

/** Local + host metadata for a tracked file (backs the amber resolve popup). */
export interface SyncFileMeta {
  rel_path: string;
  local: SyncSideMeta;
  host: SyncSideMeta;
  base_size: number;
  base_mtime: number | null;
}

/** Size of the host subtree an auto-sync toggle would put in scope
 *  (`sync_auto_preview`). Byte-sync ignores `.gitignore`, so this is what stands
 *  between a right-click and a multi-GB experiment tree landing in the mirror. */
export interface AutoSyncPreview {
  files: number;
  bytes: number;
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
  /** Fetch local+host metadata for one file (backs the amber resolve popup). */
  fileMeta: (projectId: string, relPath: string) => Promise<SyncFileMeta>;
  /** Pull one file or a whole folder subtree into the mirror, then refresh. */
  pull: (projectId: string, relPath: string) => Promise<void>;
  /** Pull the whole project tree into the mirror. */
  syncWholeProject: (projectId: string) => Promise<void>;
  /** Push the whole local mirror to the host, skipping host-diverged (amber)
   *  files (force=false → conflicts are returned, not clobbered). */
  pushWholeProject: (
    projectId: string,
  ) => Promise<{ pushed: number; conflicts: string[] }>;
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
  /** Toggle auto-sync for paths (on a folder = its whole subtree). Turning on
   *  implies selected; the backend engine reconciles on its next pass. */
  setAuto: (
    projectId: string,
    relPaths: string[],
    auto: boolean,
    isDir: boolean,
  ) => Promise<void>;
  /** What auto-syncing `relPath` would start pulling from the host. Read-only —
   *  the caller confirms a large answer before committing to `setAuto`. */
  autoPreview: (projectId: string, relPath: string) => Promise<AutoSyncPreview>;
}

function indexStatus(rows: SyncStatusEntry[]): Record<string, SyncEntryStatus> {
  const out: Record<string, SyncEntryStatus> = {};
  for (const r of rows) {
    out[r.rel_path] = {
      state: r.state,
      selected: r.selected,
      isDir: r.is_dir,
      auto: r.auto_sync,
    };
  }
  return out;
}

/**
 * All project-relative paths currently diverged (amber/orange) for a project,
 * from the cached status. Backs the right-panel "orange files" list and the
 * toolbar count badge. Reads the passed-in map so callers subscribe to it.
 */
export function amberPaths(
  byPath: Record<string, SyncEntryStatus> | undefined,
): string[] {
  if (!byPath) return [];
  return Object.entries(byPath)
    .filter(([, s]) => s.state === "amber")
    .map(([rel]) => rel)
    .sort();
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

  fileMeta: async (projectId, relPath) =>
    invoke<SyncFileMeta>("sync_file_meta", { projectId, relPath }),

  pull: async (projectId, relPath) => {
    await invoke("sync_pull", { projectId, relPath });
    await get().refreshStatus(projectId);
  },

  syncWholeProject: async (projectId) => {
    await invoke("sync_whole_project", { projectId });
    await get().refreshStatus(projectId);
  },

  // Whole-mirror push counterpart to `syncWholeProject`. Reuses `push` with an
  // empty rel (the whole mirror) and force=false, so host-diverged (amber) files
  // come back in `conflicts` and are never overwritten — the toolbar caller just
  // fires it and lets the tree overlay show what stayed orange.
  pushWholeProject: async (projectId) => get().push(projectId, "", false),

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

  setAuto: async (projectId, relPaths, auto, isDir) => {
    await invoke("sync_set_auto", { projectId, relPaths, auto, isDir });
    await get().refreshStatus(projectId);
  },

  autoPreview: async (projectId, relPath) =>
    invoke<AutoSyncPreview>("sync_auto_preview", { projectId, relPath }),
}));

/** Payload of the backend `auto-sync` event (one per reconcile pass that moved
 *  files). We only need the project id to refresh; counts are informational. */
interface AutoSyncEvent {
  project_id: string;
  pulled: number;
  pushed: number;
  skipped_amber: number;
}

let progressUnlisten: Promise<() => void> | null = null;

/**
 * Subscribe to the backend `sync-progress` and `auto-sync` streams (idempotent —
 * registers once). `sync-progress` updates `progressByProject` as files transfer
 * and refreshes the cached status when a transfer completes; `auto-sync` refreshes
 * the cached status after a background reconcile pass so the tree/orange list stay
 * live. Call once at app startup.
 */
export function listenSyncProgress(): Promise<() => void> {
  if (progressUnlisten) return progressUnlisten;
  progressUnlisten = Promise.all([
    listen<SyncProgress>("sync-progress", (ev) => {
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
    }),
    listen<AutoSyncEvent>("auto-sync", (ev) => {
      void useSyncStore.getState().refreshStatus(ev.payload.project_id);
    }),
  ]).then((unlisteners) => () => unlisteners.forEach((u) => u()));
  return progressUnlisten;
}
