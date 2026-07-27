import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Host usage reports — who's logged in, CPU/load, memory, GPU, top processes
 * (see `services::remote_usage` for the probe).
 *
 * **On demand only.** The dialog is opened by the header Machines menu's
 * "Remote host usage…" button and by nothing else — a connect no longer pops it
 * up. `remote_connect` still fires its probe fire-and-forget and emits a
 * `remote-usage-report` event per project host; this store keeps those reports
 * so the dialog has something to show the instant it opens, but receiving one
 * never puts it on screen.
 *
 * **Keyed by host, not by project.** The dialog lives in the *Machines* menu, so
 * its subject is the machine list: every global machine, in that list's order,
 * plus whichever of the active project's own hosts aren't already in it. A
 * project id can't key that, hence [`UsageTarget`] and its `key` — and hence two
 * probe commands behind one `recheck`: a global machine authenticates ad-hoc
 * (`global_machine_usage_check`), a project host rides its pooled ControlMaster
 * (`remote_usage_check`). Both run the same script through the same parser, so
 * the two kinds of section read identically.
 */

export interface UserSession {
  user: string;
  tty: string;
  detail: string;
}

export interface ProcInfo {
  user: string;
  pid: string;
  cpuPct: number;
  memPct: number;
  command: string;
}

/** One NVIDIA GPU's utilization + memory (NVIDIA-only — see backend doc). */
export interface GpuUsage {
  name: string;
  utilPct: number;
  memUsedMb: number;
  memTotalMb: number;
}

/** Mirrors `services::remote_usage::RemoteUsageReport` (camelCase). */
export interface RemoteUsageReport {
  users: UserSession[];
  /** Instantaneous CPU usage (0-100), measured via /proc/stat, not load average. */
  cpuPct: number;
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
  memTotalMb: number;
  memUsedMb: number;
  /** NVIDIA GPUs only; empty on a GPU-less/AMD/Intel-only host. */
  gpus: GpuUsage[];
  topProcs: ProcInfo[];
  busy: boolean;
  reasons: string[];
  /** The host reported itself an HPC node (SLURM on its `PATH`), so this report
   *  was taken carefully: `users` holds only this account's own sessions and
   *  `topProcs` only its own processes — a cluster's usage rules don't allow
   *  collecting other people's (`docs/context/hpc_careful_mode.md`). The
   *  aggregate CPU/memory/GPU figures are unaffected. On such a host the probe
   *  also stops firing automatically after the first connect; the report is
   *  on-demand from the Machines menu. */
  careful?: boolean;
}

/** One host the dialog shows a section for. `kind` decides which probe command
 *  reads it; `key` is how its report is stored and must be stable across
 *  reopens (so a cached report survives). */
export type UsageTarget =
  | {
      kind: "machine";
      key: string;
      label: string;
      user?: string;
      host: string;
      port?: number;
    }
  | { kind: "projectHost"; key: string; label: string; projectId: string; hostId: string };

/** Report key for a global machine (`stores/globalMachines` id). */
export const machineKey = (id: string) => `gm:${id}`;
/** Report key for one of a project's own hosts (`"primary"` or a worker id). */
export const projectHostKey = (projectId: string, hostId: string) =>
  `ph:${projectId}:${hostId}`;

interface RemoteUsageStore {
  /** Latest report per [`UsageTarget`] key. */
  reports: Record<string, RemoteUsageReport>;
  /** Whether the usage dialog is on screen. The ONLY thing that sets it is the
   *  Machines menu's "Remote host usage…" button — an arriving report never
   *  does, which is what makes the dialog on-demand rather than a connect-time
   *  popup. */
  isOpen: boolean;
  setReport: (key: string, report: RemoteUsageReport) => void;
  open: () => void;
  close: () => void;
  /** On-demand read of one host, awaited directly rather than round-tripped
   *  through the connect-time event. Best-effort: a failed probe (host down,
   *  credential gone) leaves whatever was cached, so a machine that can't be
   *  reached simply shows no reading instead of tearing down the dialog. */
  recheck: (target: UsageTarget) => Promise<void>;
}

export const useRemoteUsageStore = create<RemoteUsageStore>((set) => ({
  reports: {},
  isOpen: false,

  setReport: (key, report) => set((s) => ({ reports: { ...s.reports, [key]: report } })),

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),

  recheck: async (target) => {
    try {
      const report =
        target.kind === "machine"
          ? await invoke<RemoteUsageReport>("global_machine_usage_check", {
              user: target.user,
              host: target.host,
              port: target.port,
            })
          : await invoke<RemoteUsageReport>("remote_usage_check", {
              projectId: target.projectId,
              hostId: target.hostId,
            });
      set((s) => ({ reports: { ...s.reports, [target.key]: report } }));
    } catch {
      // Best-effort, like the connect-time probe — a failed recheck just
      // leaves the previous report (or none) in place.
    }
  },
}));
