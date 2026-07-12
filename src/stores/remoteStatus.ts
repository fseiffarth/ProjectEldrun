import { create } from "zustand";

/**
 * Live connection state of a remote (SSH) project's two channels:
 *  - `off`        — not a remote project, or torn down / never opened
 *  - `connecting` — handshake in flight (orange lamp)
 *  - `connected`  — channel is up (green lamp)
 *  - `error`      — the attempt failed (red lamp)
 */
export type ConnState = "off" | "connecting" | "connected" | "error";

interface RemoteStatusStore {
  /** Per-project status, keyed by project id. Keyed (not a single active slot)
   *  so an in-flight connect for a project the user just switched away from can
   *  never flip the lamp of the now-active project — the header reads only the
   *  active id's entry. */
  byProject: Record<string, { ssh: ConnState; vpn: ConnState }>;
  setSsh: (projectId: string, state: ConnState) => void;
  setVpn: (projectId: string, state: ConnState) => void;
  /** Forget a project's status entirely (on deactivation / switch-away). */
  clear: (projectId: string) => void;
}

export const useRemoteStatusStore = create<RemoteStatusStore>((set) => ({
  byProject: {},
  setSsh: (projectId, state) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? { ssh: "off" as ConnState, vpn: "off" as ConnState };
      return { byProject: { ...s.byProject, [projectId]: { ...prev, ssh: state } } };
    }),
  setVpn: (projectId, state) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? { ssh: "off" as ConnState, vpn: "off" as ConnState };
      return { byProject: { ...s.byProject, [projectId]: { ...prev, vpn: state } } };
    }),
  clear: (projectId) =>
    set((s) => {
      if (!(projectId in s.byProject)) return {};
      const next = { ...s.byProject };
      delete next[projectId];
      return { byProject: next };
    }),
}));
