import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "./projects";

/** Highest-priority pending git state for a project, by the user's mental model:
 *  uncommitted working-tree changes ▸ staged-not-committed ▸ committed-not-pushed
 *  ▸ clean. Drives the colored dot on each project pill.
 *
 *  `"broken"` is the odd one out: it is NOT derived from a `git_status` count but
 *  from a *contradiction* — a project whose recorded `git_type` still names a repo
 *  while its working tree reports `is_repo:false` (an empty or missing `.git`).
 *  That decision needs the project's `git_type`, which `gitDirtyState` does not
 *  have, so it is made in `refresh` (see `expectsGitRepo`), not here. */
export type GitDirtyState = "clean" | "unpushed" | "staged" | "dirty" | "broken";

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

/** The combined backend probe: status plus the unpushed count, which the
 *  backend computes only when the tree is clean — the one case the dot ever
 *  consults it (see `gitDirtyState`'s priority order). One git spawn and one
 *  IPC round trip per project per poll tick instead of two each. */
interface GitDirtyProbe {
  status: GitStatus;
  unpushed: number;
}

/** Reduce a `git_status` probe plus the unpushed-commit count to a single dot
 *  level. Priority mirrors the file-tree markers (red ▸ orange ▸ green):
 *    "dirty"    – untracked or unstaged working-tree changes (not added) — red
 *    "staged"   – staged but not committed — orange
 *    "unpushed" – committed locally but not pushed — green
 *    "clean"    – nothing pending, or not a git repo (no dot) */
export function gitDirtyState(status: GitStatus, unpushed: number): GitDirtyState {
  // A non-repo is "clean" *by this function alone* — with only a status object we
  // cannot tell "this folder was never meant to have git" from "its repo is gone".
  // `refresh` upgrades the second case to "broken" using the project's git_type.
  if (!status.is_repo) return "clean";
  if (status.untracked > 0 || status.unstaged > 0) return "dirty";
  if (status.staged > 0) return "staged";
  if (unpushed > 0) return "unpushed";
  return "clean";
}

/** Does this project's recorded `git_type` claim it has a repo? A `git_type` that
 *  names a repo (`local` or a `remote-*`) contradicts an `is_repo:false` probe —
 *  the folder is tagged as version-controlled but its `.git` is empty/missing, so
 *  the pill must paint it "broken" rather than the silent folder-yellow "clean" it
 *  paints a genuinely git-less project (`git_type:"none"`, or a project that never
 *  recorded one). Mirrors the guard the old auto-disable used, so the two agree on
 *  what "a project that should have a repo" means. */
export function expectsGitRepo(gitType: unknown): boolean {
  return typeof gitType === "string" && gitType !== "" && gitType !== "none";
}

/** Consecutive probes that found NO `.git` for a project, keyed by id. A single
 *  `is_repo:false` must never flip a project to "broken": a transient absence —
 *  lockstep/sync rebuilding `.git`, a resolver blip, a dir momentarily unreadable
 *  — would otherwise flash a scary state on every churn. We require several
 *  *consecutive* confirmed misses (one poll cycle each) before painting "broken",
 *  so only a genuine, sustained `.git` removal (e.g. `rm -rf .git` in a terminal,
 *  or an empty `.git` a failed scaffold left behind) trips it. Module-level, not
 *  store state, so accumulating a streak never re-renders a pill.
 *
 *  This deliberately NO LONGER calls `setProjectGitDisabled` — that reaction was
 *  both DESTRUCTIVE (it deleted `.git` and rewrote `git_type:"none"`) and silent,
 *  so a project whose repo was missing quietly *became* a non-git project instead
 *  of showing that anything was wrong, and it could race a re-created `.git` into
 *  deletion. "broken" reports the contradiction and leaves the fix (re-init, or an
 *  explicit disable from the pill menu) to the user. */
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
      const { status, unpushed } = await invoke<GitDirtyProbe>("git_dirty_probe", {
        projectDir: dir,
      }).catch(async () => {
        // A running window whose backend predates the combined command (backend
        // edits don't reach a live window until a restart) still answers the
        // old two-command spelling.
        const [status, unpushedCommits] = await Promise.all([
          invoke<GitStatus>("git_status", { projectDir: dir }),
          invoke<string[]>("git_unpushed_commits", { projectDir: dir }).catch(
            () => [] as string[],
          ),
        ]);
        return { status, unpushed: unpushedCommits.length };
      });
      next = gitDirtyState(status, unpushed);
      // `.git` can be missing (deleted with `rm -rf .git` in a terminal tab, or an
      // empty `.git` left behind by a scaffold whose `git init` silently no-op'd).
      // A project still *tagged* as a repo (git_type local/remote-*) but reporting
      // is_repo:false is BROKEN, not clean — surface it instead of the resting
      // folder-yellow, which hid the contradiction (a confident "github private"
      // tag over a lamp that never lit). Gated on several *consecutive* misses so
      // transient lockstep/sync `.git` churn doesn't flash it. Non-destructive:
      // the user re-inits or disables git explicitly (see GIT_GONE_STREAK).
      if (!status.is_repo) {
        const streak = (GIT_GONE_STREAK.get(projectId) ?? 0) + 1;
        GIT_GONE_STREAK.set(projectId, streak);
        const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
        if (streak >= GIT_GONE_THRESHOLD && expectsGitRepo(project?.git_type)) {
          next = "broken";
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
