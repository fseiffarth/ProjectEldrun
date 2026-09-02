/**
 * Pure half of the agent-in-a-worktree story (#23) — see
 * `components/tabs/agentWorktrees.ts` for the why. Lives under `lib/` so the
 * tabs store can import it without pulling a component module (and the
 * store→component→store cycle that would make) into its graph.
 */
import type { TabKind } from "../stores/tabs";

/** Mirrors `commands::git::Worktree` (serde field names). */
export interface GitWorktree {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_locked: boolean;
  lock_reason: string;
  is_prunable: boolean;
  prunable_reason: string;
  is_bare: boolean;
  is_current: boolean;
}

/** The one place a worktree may live, relative to the project root. */
export const WORKTREES_SUBDIR = ".eldrun/worktrees";

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * Is `cwd` a linked worktree of the project at `projectDir` — i.e. exactly one
 * directory under `<projectDir>/.eldrun/worktrees/`? The name must be a single
 * plain segment: a `..` or an empty name is not a worktree, and neither is the
 * worktrees folder itself. Both separators are accepted so a Windows layout
 * round-trips.
 */
export function isProjectWorktreeCwd(cwd: string, projectDir: string): boolean {
  if (!cwd || !projectDir) return false;
  const root = stripTrailingSep(projectDir);
  if (!root) return false;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const c = norm(stripTrailingSep(cwd));
  const prefix = `${norm(root)}/${WORKTREES_SUBDIR}/`;
  if (!c.startsWith(prefix)) return false;
  const name = c.slice(prefix.length);
  return name.length > 0 && !name.includes("/") && name !== "." && name !== "..";
}

/**
 * The cwd a restored agent tab spawns in: its saved worktree cwd when it has
 * one under this project's root, else the project root. Pure — the seam
 * `loadFromLayout` goes through.
 */
export function restoredAgentCwd(savedCwd: string | undefined, defaultCwd: string): string {
  if (savedCwd && isProjectWorktreeCwd(savedCwd, defaultCwd)) return savedCwd;
  return defaultCwd;
}

/**
 * The worktrees an agent can be started in: bare entries have no checkout and
 * prunable ones have lost theirs. Main first, as git lists it. Returns an
 * empty list — "nothing to choose" — unless at least one *linked* worktree
 * survives the filter, so a project with only its main tree never sees the
 * dialog.
 */
export function agentWorktreeChoices(list: GitWorktree[]): GitWorktree[] {
  const usable = list.filter((w) => !w.is_bare && !w.is_prunable);
  return usable.some((w) => !w.is_main) ? usable : [];
}

/** The tab kinds the question applies to. */
export function isAgentMenuKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "local_agent";
}

/** The trailing path segment — what a worktree is *called* in the listing. */
export function worktreeName(path: string): string {
  const parts = stripTrailingSep(path).split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
