import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../stores/projects";
import { useGlobalMachinesStore } from "../stores/globalMachines";
import {
  useRemoteStatusStore,
  hostStateOf,
  PRIMARY_HOST,
  type ConnState,
} from "../stores/remoteStatus";

/**
 * Keep a **global machine** (`stores/globalMachines`, header "Machines") and the
 * **project host** it also is (a project's primary `remote` or a `compute_hosts`
 * worker) in step, so connecting/disconnecting one reflects on the other.
 *
 * The two are never linked by id — a global machine dropped onto a project is
 * copied by *value* — so the only bridge is the **SSH target** (`user@host:port`).
 * `sameTarget` is that bridge, and the whole module keys off it.
 *
 * The physical connection really *is* shared (one OpenSSH ControlMaster per host
 * target), so "sync" is mostly reconciling the two separate status stores rather
 * than opening a second socket. Two rules keep it from looping or lying:
 *
 *  - **Global → project** is driven *imperatively* from the global store's
 *    explicit connect/disconnect actions (`syncGlobalConnected`/`syncGlobalDisconnected`)
 *    — never from `probeAll`, whose "connected" only means *reachable*, not that a
 *    pooled session is open. For the **active** project it opens/tears the real
 *    pool; for a loaded-but-inactive project it only mirrors the lamp (the pool
 *    opens on activation as always). This is the "drive loaded projects" contract.
 *  - **Project → global** is a *subscription* (`initMachineSync`) that only ever
 *    *upgrades* a matching machine's lamp to `connected` — a project deactivating
 *    (which clears its lamps) must never knock an independently-connected machine
 *    offline, so `off` is deliberately not propagated upward.
 *
 * No loop: the global store's `setStatus` never touches `remoteStatus`, so the
 * subscription can't re-enter the imperative path.
 */

export interface Target {
  user?: string;
  host: string;
  port?: number;
}

function norm(t: Target): { user: string | undefined; host: string; port: number } {
  return {
    user: t.user && t.user.trim() ? t.user.trim() : undefined,
    host: t.host.trim().toLowerCase(),
    // A host with no explicit port and one pinned to 22 are the same machine.
    port: t.port ?? 22,
  };
}

/** Whether two SSH targets are the same machine+login (host case-insensitive,
 *  default port 22, empty user ≡ absent). A different login on the same host is a
 *  *different* connection, so `user` is matched strictly. */
export function sameTarget(a: Target, b: Target): boolean {
  const x = norm(a);
  const y = norm(b);
  return x.host === y.host && x.port === y.port && x.user === y.user;
}

/** The canonical string form of an SSH target — `sameTarget` as a map key, so a
 *  store can index by machine identity without an id. Two targets share a key iff
 *  `sameTarget` holds for them, which is what lets a global machine and the
 *  project host that *is* it (copied by value, different ids) share one entry. */
export function targetKey(t: Target): string {
  const n = norm(t);
  return `${n.user ?? ""}@${n.host}:${n.port}`;
}

interface ProjectHostRef {
  projectId: string;
  hostId: string;
  target: Target;
}

/** Every project host (primary + workers) whose SSH target matches `target`. */
function projectHostsMatching(target: Target): ProjectHostRef[] {
  const { projects } = useProjectsStore.getState();
  const out: ProjectHostRef[] = [];
  for (const p of projects) {
    if (p.remote && sameTarget(p.remote, target)) {
      out.push({ projectId: p.id, hostId: PRIMARY_HOST, target: p.remote });
    }
    for (const h of p.compute_hosts ?? []) {
      if (sameTarget(h, target)) out.push({ projectId: p.id, hostId: h.id, target: h });
    }
  }
  return out;
}

// `viaLogin` is unconditional here and says what this function *is*: the machine was
// authenticated in the header's Machines list, and this connect only succeeds because
// it rides the master that left behind. Without it the backend reads the missing
// password as key/agent auth and stamps `key_auth: true` on a password host, which
// then advertises a promptless auto-connect it cannot deliver (`record_key_auth`).
function remoteConnectArgs(ref: ProjectHostRef): Record<string, unknown> {
  return ref.hostId === PRIMARY_HOST
    ? { projectId: ref.projectId, password: null, viaLogin: true }
    : { projectId: ref.projectId, hostId: ref.hostId, password: null, viaLogin: true };
}

/** A global machine connected — reflect it onto every project that also holds
 *  this host. The active project's pool is actually opened; inactive projects
 *  only get their lamp mirrored (their pool opens on activation regardless). */
export function syncGlobalConnected(target: Target): void {
  const { activeId } = useProjectsStore.getState();
  for (const ref of projectHostsMatching(target)) {
    const status = useRemoteStatusStore.getState();
    const cur = hostStateOf(status, ref.projectId, ref.hostId).ssh;
    if (cur === "connected" || cur === "connecting") continue;
    if (ref.projectId === activeId) {
      status.setSsh(ref.projectId, "connecting", ref.hostId);
      void invoke("remote_connect", remoteConnectArgs(ref))
        .then(() =>
          useRemoteStatusStore.getState().setSsh(ref.projectId, "connected", ref.hostId),
        )
        .catch(() =>
          useRemoteStatusStore.getState().setSsh(ref.projectId, "error", ref.hostId),
        );
    } else {
      status.setSsh(ref.projectId, "connected", ref.hostId);
    }
  }
}

/** A global machine actively disconnected (jobs ended, master closed) — tear the
 *  matching pool on the active project and drop every matching lamp to `off`. */
export function syncGlobalDisconnected(target: Target): void {
  const { activeId } = useProjectsStore.getState();
  for (const ref of projectHostsMatching(target)) {
    if (ref.projectId === activeId) {
      const t = ref.target;
      void invoke("remote_kill_all_jobs", { user: t.user, host: t.host, port: t.port }).catch(
        () => {},
      );
      void invoke("remote_disconnect", {
        projectId: ref.projectId,
        hostId: ref.hostId,
      }).catch(() => {});
    }
    useRemoteStatusStore.getState().setSsh(ref.projectId, "off", ref.hostId);
  }
}

/** Upgrade any global machine to `connected` when a project host with the same
 *  target is connected. Never downgrades — a machine's lamp is its own, and a
 *  project deactivating must not knock it offline. */
function reconcileGlobalsFromProjects(): void {
  const gm = useGlobalMachinesStore.getState();
  const status = useRemoteStatusStore.getState();
  for (const m of gm.machines) {
    const cur: ConnState = gm.status[m.id] ?? "off";
    if (cur === "connected") continue;
    const anyConnected = projectHostsMatching(m).some(
      (ref) => hostStateOf(status, ref.projectId, ref.hostId).ssh === "connected",
    );
    if (anyConnected) gm.setStatus(m.id, "connected");
  }
}

let inited = false;

/** Install the project → global-machine lamp mirror. Idempotent; call once at
 *  startup (`App`). The global → project direction is driven imperatively from
 *  the global store's connect/disconnect actions, so it needs no subscription. */
export function initMachineSync(): void {
  if (inited) return;
  inited = true;
  useRemoteStatusStore.subscribe(() => reconcileGlobalsFromProjects());
}
