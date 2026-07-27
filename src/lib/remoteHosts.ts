import { PRIMARY_HOST } from "../stores/remoteStatus";
import { targetOfSpec, type Target } from "./carefulHost";
import type { ProjectEntry } from "../types";

export interface RemoteHostRef {
  id: string;
  label: string;
  /** The host's SSH target (`user@host:port`) — the identity the **careful**
   *  flag is keyed by (`lib/carefulHost.ts`), since one physical machine can be
   *  this project's worker, another's primary and a global machine at once. The
   *  host id cannot serve: it is per-record, the flag is per-machine. */
  target: Target | null;
}

/**
 * Every host a project's remote spans: the primary, then each `compute_hosts`
 * worker (multi-host remote, `docs/multi_host_remote_plan.md`) — the same host
 * set the System Monitor's source picker and the combined usage dialog both
 * need. Empty for a non-remote project.
 */
export function hostsForProject(project: ProjectEntry | undefined): RemoteHostRef[] {
  if (!project?.remote) return [];
  const list: RemoteHostRef[] = [
    {
      id: PRIMARY_HOST,
      label: project.remote.label || project.remote.host,
      target: targetOfSpec(project.remote),
    },
  ];
  for (const w of project.compute_hosts ?? []) {
    list.push({ id: w.id, label: w.label || w.host, target: targetOfSpec(w) });
  }
  return list;
}
