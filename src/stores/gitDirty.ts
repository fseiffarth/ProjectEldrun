import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "./projects";

/** Highest-priority pending git state for a project, by the user's mental model:
 *  uncommitted working-tree changes ▸ staged-not-committed ▸ committed-not-pushed
 *  ▸ clean. Drives the colored dot on each project pill. */
export type GitDirtyState = "clean" | "unpushed" | "staged" | "dirty";

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

/** Reduce a `git_status` probe plus the unpushed-commit count to a single dot
 *  level. Priority mirrors the file-tree markers (red ▸ orange ▸ green):
 *    "dirty"    – untracked or unstaged working-tree changes (not added) — red
 *    "staged"   – staged but not committed — orange
 *    "unpushed" – committed locally but not pushed — green
 *    "clean"    – nothing pending, or not a git repo (no dot) */
export function gitDirtyState(status: GitStatus, unpushed: number): GitDirtyState {
  if (!status.is_repo) return "clean";
  if (status.untracked > 0 || status.unstaged > 0) return "dirty";
  if (status.staged > 0) return "staged";
  if (unpushed > 0) return "unpushed";
  return "clean";
}

interface GitDirtyStore {
  /** Per-project dot level. Absent until first probed (rendered as no dot). */
  byId: Record<string, GitDirtyState>;
  /** Apply an already-computed level (used by callers that have the data). */
  set: (projectId: string, state: GitDirtyState) => void;
  /** Probe a project's directory and store its dot level. No-ops on empty dir. */
  refresh: (projectId: string, dir: string) => Promise<void>;
}

export const useGitDirtyStore = create<GitDirtyStore>((set) => ({
  byId: {},
  set: (projectId, state) =>
    set((s) =>
      s.byId[projectId] === state ? s : { byId: { ...s.byId, [projectId]: state } },
    ),
  refresh: async (projectId, dir) => {
    if (!dir) return;
    let next: GitDirtyState = "clean";
    try {
      const [status, unpushed] = await Promise.all([
        invoke<GitStatus>("git_status", { projectDir: dir }),
        invoke<string[]>("git_unpushed_commits", { projectDir: dir }).catch(
          () => [] as string[],
        ),
      ]);
      next = gitDirtyState(status, unpushed.length);
      // `.git` can be deleted outside the app (e.g. `rm -rf .git` in a
      // terminal tab). Catch that here, on the same poll that already probes
      // the directory, and flip the project back to "none" so the pill menu
      // (Enable git / danger-zone Remove git) reflects reality.
      if (!status.is_repo) {
        const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
        if (project && typeof project.git_type === "string" && project.git_type !== "none") {
          void useProjectsStore.getState().setProjectGitDisabled(projectId, true);
        }
      }
    } catch {
      next = "clean";
    }
    set((s) =>
      s.byId[projectId] === next ? s : { byId: { ...s.byId, [projectId]: next } },
    );
  },
}));
