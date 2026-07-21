import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { TabLocation } from "./tabs";

/**
 * "Which machine should scripts and shells launched from this project run on"
 * preference, keyed by project id (`docs/multi_host_remote_plan.md`). Set from the
 * `RunHostPicker`, read at launch time by `lib/pythonRun`, `lib/shellScriptRun`,
 * and `stores/tabs`' new-shell-tab funnel so a Run/Debug or a "+" shell lands on
 * the chosen host (primary or a worker) instead of the shell default.
 *
 * The picker + this preference apply to EVERY remote project, including a
 * genuinely multi-machine one with a synced-code worker: a Run opens a fresh tab,
 * so the per-tab locality badge can't pre-target it — the project-wide picker is
 * the only control that can send a run to a worker.
 *
 * This live store is the read cache; the value is **persisted** per project (in
 * `project.json`'s `run_host`, mirrored into `projects.json`) so the choice
 * survives a relaunch. `set` writes through to the backend; `seed` re-hydrates the
 * cache from the loaded projects on startup (see `stores/projects` `load`). Unset ⇒
 * the tab's own kind default (a shell defaults to the primary on a remote project),
 * so a project that never touches the picker behaves exactly as before. A value is
 * a `TabLocation` (`"local" | "remote" | "host:<id>"`), the same axis a tab's
 * locality badge sets, so the run tab carries it verbatim.
 */
interface RunHostPrefStore {
  byProject: Record<string, TabLocation>;
  /** Set (and persist) the run host for a project. The store updates immediately;
   *  the disk write is fire-and-forget (a failure only means it won't survive a
   *  relaunch — never worth blocking the click or the run). */
  set: (projectId: string, location: TabLocation) => void;
  /** Re-hydrate the cache from the persisted per-project values on load. Merges
   *  (never clobbers a choice already made this session), so it is safe to call on
   *  every projects reload. */
  seed: (entries: { projectId: string; location: TabLocation | undefined }[]) => void;
}

export const useRunHostPrefStore = create<RunHostPrefStore>((set) => ({
  byProject: {},
  set: (projectId, location) => {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: location } }));
    void invoke("set_project_run_host", { projectId, location }).catch((e) =>
      console.error(`persist run host for ${projectId} failed`, e),
    );
  },
  seed: (entries) =>
    set((s) => {
      const byProject = { ...s.byProject };
      for (const { projectId, location } of entries) {
        // A choice already made this session wins over the persisted one (they
        // can only differ if the user just changed it before this reload).
        if (location && byProject[projectId] === undefined) {
          byProject[projectId] = location;
        }
      }
      return { byProject };
    }),
}));
