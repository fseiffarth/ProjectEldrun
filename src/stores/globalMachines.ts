import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ConnState } from "./remoteStatus";
import type { GlobalMachine } from "../types";

/**
 * Globally connected worker machines — the VPN-tunnel pattern applied to SSH
 * hosts: authenticated once via the ordinary login mechanism
 * (`ssh_connect`), with no `remote_path`, so a machine is not tied to any one
 * project. Later dragged onto a project (`MachinesIndicator`'s rows are the
 * drag source) to become a `shared_fs` compute host there.
 *
 * Unlike `vpnStatus.ts`, there is no backend liveness registry to reconcile
 * against on focus: `ssh_connect` only *verifies* auth (it warms the shared
 * OpenSSH ControlMaster opportunistically but does not create/persist one —
 * see `ssh_common::ssh_base_args`'s `ControlMaster=no`), it doesn't leave a
 * pooled session running the way a project's `remote_connect` does. So
 * `status` here is set only by explicit actions (add, Connect, or the
 * on-menu-open `probeAll` reachability sweep), never polled.
 */
interface GlobalMachinesStore {
  machines: GlobalMachine[];
  /** Per-machine id; absent = "off". */
  status: Record<string, ConnState>;
  loaded: boolean;

  load: () => Promise<void>;
  add: (m: {
    user?: string;
    host: string;
    port?: number;
    label?: string;
    password?: string;
    remember?: boolean;
  }) => Promise<GlobalMachine>;
  remove: (id: string) => Promise<void>;
  connect: (id: string, password?: string) => Promise<void>;
  /** Read-only reachability sweep (`ssh_probe`, no keychain writes) — call when
   *  the header menu opens, mirroring `VpnIndicator`'s per-config silent check. */
  probeAll: () => Promise<void>;
  setStatus: (id: string, status: ConnState) => void;
}

export const useGlobalMachinesStore = create<GlobalMachinesStore>((set, get) => ({
  machines: [],
  status: {},
  loaded: false,

  load: async () => {
    const list = await invoke<GlobalMachine[]>("global_machines_list").catch(() => []);
    set({ machines: list, loaded: true });
  },

  add: async ({ user, host, port, label, password, remember }) => {
    await invoke("ssh_connect", { user, host, port, password, remember });
    const machine = await invoke<GlobalMachine>("global_machine_add", { user, host, port, label });
    set((s) => ({
      machines: [...s.machines, machine],
      status: { ...s.status, [machine.id]: "connected" },
    }));
    return machine;
  },

  remove: async (id) => {
    const list = await invoke<GlobalMachine[]>("global_machine_remove", { id }).catch(() => null);
    if (!list) return;
    set((s) => {
      const status = { ...s.status };
      delete status[id];
      return { machines: list, status };
    });
  },

  connect: async (id, password) => {
    const m = get().machines.find((x) => x.id === id);
    if (!m) return;
    set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
    try {
      await invoke("ssh_connect", {
        user: m.user,
        host: m.host,
        port: m.port,
        password,
        remember: null,
      });
      set((s) => ({ status: { ...s.status, [id]: "connected" } }));
    } catch {
      set((s) => ({ status: { ...s.status, [id]: "error" } }));
    }
  },

  probeAll: async () => {
    const machines = get().machines;
    const results = await Promise.all(
      machines.map((m) =>
        invoke<{ ok: boolean }>("ssh_probe", { user: m.user, host: m.host, port: m.port })
          .then((r) => [m.id, r.ok ? "connected" : "error"] as const)
          .catch(() => [m.id, "error"] as const),
      ),
    );
    set((s) => ({ status: { ...s.status, ...Object.fromEntries(results) } }));
  },

  setStatus: (id, status) => set((s) => ({ status: { ...s.status, [id]: status } })),
}));
