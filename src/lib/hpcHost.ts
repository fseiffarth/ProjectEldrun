/**
 * **The HPC tag** — "this machine is a shared cluster login node."
 *
 * One tick, set on the login form and shown on the machine's row in the Machines
 * menu, behind which every behaviour a cluster's usage rules object to is gated:
 *
 * | Gated | Why |
 * |---|---|
 * | full stats collection | other users' account names / command lines are not ours to collect — a tagged host is careful whatever the Light/Detailed switch says |
 * | disk-usage scan, giant-folder census | a recursive `du` over a parallel filesystem is a metadata storm against a shared server |
 * | auto byte-sync (25 s), git lockstep poll (12 s) | the same walk, unasked for, forever |
 * | silent auto-connect at launch | an SSH master and a tmux server on a login node nobody asked for this session |
 * | login-node compute (shells, Python/script runs) | interactive compute belongs in `srun --pty`; a login node's rules reserve the right to kill it |
 *
 * **Why a user tag and not detection.** SLURM on `PATH` says a machine has a
 * scheduler, not that its operators mind — a compute node held through `srun` has
 * `sbatch` too, and there you own the machine outright for the length of the job.
 * The property being tagged is the machine's *politics*, and only the user knows
 * it. (The probes still detect SLURM for `careful` collection, which is a reading
 * question with a safe default. This is a behaviour question with no safe guess.)
 *
 * **Keyed by SSH target**, exactly as `carefulHost.ts` is, and for the same
 * reason: one login node is simultaneously a project's primary `remote`, another
 * project's `compute_hosts` worker, and a project-free global machine. Tagging it
 * once must tag it everywhere, so the identity is `user@host:port` rather than
 * any of the three record ids.
 */

import { targetKey, type Target } from "./machineSync";
import type { ProjectEntry, Settings } from "../types";

export { primaryTargetOf, targetOfSpec } from "./carefulHost";
export type { Target };

/** Whether `target` is tagged as a cluster login node. `false` for a local
 *  sample and for any host nobody has tagged — unlike careful mode there is no
 *  default to fall back to, because every gate here changes what Eldrun *does*
 *  and an untagged host must behave exactly as it always has. */
export function isHpcHost(
  settings: Settings | null | undefined,
  target: Target | null | undefined,
): boolean {
  if (!target?.host) return false;
  return settings?.hpc_hosts?.[targetKey(target)] === true;
}

/** The patch that tags (or untags) `target`, for `useSettingsStore.updateSettings`.
 *  Merges into the existing map — settings are saved whole, so a replace would
 *  drop every other machine's tag. Untagging writes `false` rather than deleting,
 *  so the two spellings a settings blob can carry stay one shape. */
export function setHpcPatch(
  settings: Settings | null | undefined,
  target: Target,
  hpc: boolean,
): Pick<Settings, "hpc_hosts"> {
  return { hpc_hosts: { ...(settings?.hpc_hosts ?? {}), [targetKey(target)]: hpc } };
}

/** Whether a project's **primary** host is tagged — the host that owns files,
 *  git, the mirror and therefore every walk the gates are about. */
export function projectIsOnHpc(
  settings: Settings | null | undefined,
  project: ProjectEntry | null | undefined,
): boolean {
  const r = project?.remote;
  if (!r?.host) return false;
  return isHpcHost(settings, { user: r.user || undefined, host: r.host, port: r.port ?? undefined });
}

/** Whether *any* host of this project — primary or a `compute_hosts` worker — is
 *  tagged. Used where the question is "may this project run background work
 *  against a cluster at all", rather than "is this particular host one". */
export function projectTouchesHpc(
  settings: Settings | null | undefined,
  project: ProjectEntry | null | undefined,
): boolean {
  if (projectIsOnHpc(settings, project)) return true;
  return (project?.compute_hosts ?? []).some((h) =>
    isHpcHost(settings, { user: h.user || undefined, host: h.host, port: h.port ?? undefined }),
  );
}
