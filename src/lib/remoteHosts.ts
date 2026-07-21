import { PRIMARY_HOST } from "../stores/remoteStatus";
import type { ProjectEntry } from "../types";

export interface RemoteHostRef {
  id: string;
  label: string;
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
    { id: PRIMARY_HOST, label: project.remote.label || project.remote.host },
  ];
  for (const w of project.compute_hosts ?? []) {
    list.push({ id: w.id, label: w.label || w.host });
  }
  return list;
}
