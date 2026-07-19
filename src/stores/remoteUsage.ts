import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Remote-host resource snapshot taken right after a project's SSH connection
 * comes up (see `services::remote_usage` / `commands::remote::remote_connect`).
 *
 * Pushed, not pulled: `remote_connect` fires the probe fire-and-forget after
 * every connect (manual dialog and silent auto-connect alike) and emits it as
 * a `remote-usage-report` event, since a probe that could block or fail must
 * never delay activation. `RemoteUsageWarningDialog` listens for the event;
 * this store is just where the latest report per project lands.
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
}

interface RemoteUsageStore {
  /** Latest report per project id. */
  reports: Record<string, RemoteUsageReport>;
  /** Projects whose current report has been dismissed by the user. Cleared
   *  whenever a fresh report for that project arrives, so the next connect's
   *  usage report is shown again rather than staying silenced forever. */
  dismissed: Record<string, boolean>;
  setReport: (projectId: string, report: RemoteUsageReport) => void;
  dismiss: (projectId: string) => void;
  /** On-demand recheck (the dialog's "Recheck" action), awaited directly
   *  rather than round-tripped through the event. */
  recheck: (projectId: string) => Promise<void>;
}

export const useRemoteUsageStore = create<RemoteUsageStore>((set) => ({
  reports: {},
  dismissed: {},

  setReport: (projectId, report) =>
    set((s) => ({
      reports: { ...s.reports, [projectId]: report },
      dismissed: { ...s.dismissed, [projectId]: false },
    })),

  dismiss: (projectId) =>
    set((s) => ({ dismissed: { ...s.dismissed, [projectId]: true } })),

  recheck: async (projectId) => {
    try {
      const report = await invoke<RemoteUsageReport>("remote_usage_check", {
        projectId,
      });
      set((s) => ({
        reports: { ...s.reports, [projectId]: report },
        dismissed: { ...s.dismissed, [projectId]: false },
      }));
    } catch {
      // Best-effort, like the connect-time probe — a failed recheck just
      // leaves the previous report (or none) in place.
    }
  },
}));
