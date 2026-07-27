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

/** Consecutive probes that found NO `.git` for a project, keyed by id. A single
 *  `is_repo:false` must never disable git: `setProjectGitDisabled(id, true)` is a
 *  DESTRUCTIVE, persisted action (deletes `.git`, writes `git_type:"none"`), and a
 *  transient absence — lockstep/sync rebuilding `.git`, a resolver blip, a dir
 *  momentarily unreadable — would otherwise persist "none" and could race a
 *  re-created `.git` into deletion. We require several *consecutive* confirmed
 *  misses (one poll cycle each) before acting, so only a genuine, sustained `.git`
 *  removal (e.g. `rm -rf .git` in a terminal) trips it. Module-level, not store
 *  state, so accumulating a streak never re-renders a pill. */
const GIT_GONE_STREAK = new Map<string, number>();
/** ~3 poll cycles (~36s at the 12s switcher poll) of confirmed absence. */
const GIT_GONE_THRESHOLD = 3;

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
      // `.git` can be deleted outside the app (e.g. `rm -rf .git` in a terminal
      // tab). Reflect that by flipping the project back to "none" — but only
      // after several *consecutive* confirmed misses (see GIT_GONE_STREAK): a
      // single is_repo:false during lockstep/sync `.git` churn must not persist
      // "none" or race a re-created `.git` into deletion.
      if (!status.is_repo) {
        const streak = (GIT_GONE_STREAK.get(projectId) ?? 0) + 1;
        GIT_GONE_STREAK.set(projectId, streak);
        const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
        if (
          streak >= GIT_GONE_THRESHOLD &&
          project &&
          typeof project.git_type === "string" &&
          project.git_type !== "none"
        ) {
          GIT_GONE_STREAK.delete(projectId);
          void useProjectsStore.getState().setProjectGitDisabled(projectId, true);
        }
      } else {
        // A repo is present again — clear the streak so a past blip can never
        // combine with a later one to cross the threshold.
        GIT_GONE_STREAK.delete(projectId);
      }
    } catch {
      next = "clean";
      // An errored probe (host down, git spawn failure) proves nothing about the
      // repo's existence, so it must not count toward disabling git.
      GIT_GONE_STREAK.delete(projectId);
    }
    set((s) =>
      s.byId[projectId] === next ? s : { byId: { ...s.byId, [projectId]: next } },
    );
  },
}));
