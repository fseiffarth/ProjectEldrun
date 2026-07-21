import { create } from "zustand";
import type { LocalityHost, TabLocation } from "./tabs";

/**
 * Whether the per-project run-host picker applies at all. It is meant for the
 * simple case (a lone primary, or shared-fs workers that are just one shared
 * tree). The moment a worker keeps its OWN **synced code copy** the project is
 * genuinely multi-machine, and the run target is chosen **per tab** (the locality
 * badge) — so the picker is hidden and a Run/Debug falls back to the tab's
 * locality (the primary by default) rather than a project-wide preference.
 * Shared-fs workers (`shared_fs`) don't trip this — they leave the picker in place.
 */
export function runHostPickerApplies(computeHosts?: LocalityHost[]): boolean {
  return !(computeHosts ?? []).some((h) => !h.shared_fs && h.sync_code !== false);
}

/**
 * Ephemeral, non-persisted "which machine should scripts and shells launched
 * from this project's file view run on" preference, keyed by project id
 * (`docs/multi_host_remote_plan.md`). Set from the file viewer's run-host picker
 * (`RunHostPicker`), read at launch time by `lib/pythonRun` so a Run/Debug lands
 * on the chosen host (primary or a worker) instead of the shell default.
 *
 * Unset ⇒ the tab's own kind default (a shell defaults to the primary on a remote
 * project) — so a project that never touches the picker behaves exactly as before.
 * A value is a `TabLocation` (`"local" | "remote" | "host:<id>"`), the same axis a
 * tab's locality badge sets, so the run tab carries it verbatim.
 */
interface RunHostPrefStore {
  byProject: Record<string, TabLocation>;
  set: (projectId: string, location: TabLocation) => void;
}

export const useRunHostPrefStore = create<RunHostPrefStore>((set) => ({
  byProject: {},
  set: (projectId, location) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: location } })),
}));
