import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useGlobalMachinesStore, type ImportResult } from "../../stores/globalMachines";
import { useGlobalMachineMonitorStore } from "../../stores/globalMachineMonitor";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { useRemoteUsageStore } from "../../stores/remoteUsage";
import { useHostBusyStore, busyReading, busyLabel } from "../../stores/hostBusy";
import { parseSshAddress } from "../projects/scaffold";
import { TerminalSignInToggle } from "../projects/TerminalSignInToggle";
import { openConnectionInRoot } from "../../lib/remoteConnect";
import { isHpcHost, setHpcPatch, targetOfSpec } from "../../lib/hpcHost";
import type { ConnState } from "../../stores/remoteStatus";
import type { GlobalMachine, MachineImportEntry, ProjectEntry } from "../../types";

/** Lamp order — most-relevant state first, so a fleet with any error/connecting
 *  machine surfaces that colour ahead of the steady-state green/grey. Mirrors
 *  `RemoteConnMenu`'s per-project host lamps. */
const STATUS_ORDER: ConnState[] = ["error", "connecting", "connected", "off"];

const STATUS_WORD: Record<ConnState, string> = {
  error: "error",
  connecting: "connecting",
  connected: "connected",
  off: "off",
};

export function targetLabel(m: { user?: string; host: string; port?: number }): string {
  return `${m.user ? `${m.user}@` : ""}${m.host}${m.port ? `:${m.port}` : ""}`;
}

/**
 * Global worker machines, in the header — the VPN indicator's pattern applied
 * to SSH hosts a project doesn't own. Authenticated once via the ordinary
 * login mechanism, with no project/path attached, then handed to a project from
 * a row's "add to a project" picker: a remote project gains a `shared_fs`
 * compute host, a local one is offered "Extend to remote" with that machine as
 * its primary — deliberately a menu, not a drag: a machine's target lives
 * outside this list, and no drag can reach it (see below). Rows DO reorder by
 * dragging their grip, but on POINTER events, which is the difference that
 * makes it work — a native HTML5 drag out of a hover-menu is unworkable under
 * WebKitGTK (the menu closes or hangs mid-drag, and a drop that misses its
 * target never fires, stranding the row in its dimmed drag state).
 * Detaching a machine from a project never touches this list — see
 * `stores/globalMachines.ts` / `commands::global_machines`.
 */
export function MachinesIndicator() {
  // Off by default (Settings' "Remote features") — most projects are local-only,
  // so this fleet-wide SSH list stays out of the header until asked for.
  const enabled = useSettingsStore((s) => s.settings?.machines_enabled ?? false);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  // The whole settings object (not one flag) because the HPC tag is a map keyed
  // by SSH target: the row reads its own machine's entry, and writing one has to
  // merge into the rest rather than replace them.
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const machines = useGlobalMachinesStore((s) => s.machines);
  const status = useGlobalMachinesStore((s) => s.status);
  const errors = useGlobalMachinesStore((s) => s.errors);
  const load = useGlobalMachinesStore((s) => s.load);
  const probeAll = useGlobalMachinesStore((s) => s.probeAll);
  const connect = useGlobalMachinesStore((s) => s.connect);
  const disconnect = useGlobalMachinesStore((s) => s.disconnect);
  const retryAll = useGlobalMachinesStore((s) => s.retryAll);
  // Busy readings are keyed by SSH target, so this one subscription lights both
  // the aggregate strip and every row.
  const readings = useHostBusyStore((s) => s.readings);
  const disconnectAll = useGlobalMachinesStore((s) => s.disconnectAll);
  const remove = useGlobalMachinesStore((s) => s.remove);
  // Persist-without-authenticating: the terminal sign-in has already logged in,
  // so `add`'s `ssh_connect` would be a second login (and a password prompt this
  // mode exists to avoid).
  const register = useGlobalMachinesStore((s) => s.register);
  const add = useGlobalMachinesStore((s) => s.add);
  const update = useGlobalMachinesStore((s) => s.update);
  const setAutoConnect = useGlobalMachinesStore((s) => s.setAutoConnect);
  const reorder = useGlobalMachinesStore((s) => s.reorder);
  const exportMachines = useGlobalMachinesStore((s) => s.exportMachines);
  const importMachines = useGlobalMachinesStore((s) => s.importMachines);
  const openMonitor = useGlobalMachineMonitorStore((s) => s.open);
  // The projects a machine can be added to: the ACTIVE ones only — exactly the
  // set `ProjectSwitcher` renders as pills (`status !== "inactive"`), which is
  // both what the old drag gesture could reach and what the handoff needs, since
  // `requestExtend` is picked up by the target's mounted `ProjectPill`.
  const projects = useProjectsStore((s) => s.projects).filter((p) => p.status !== "inactive");
  const openUsage = useRemoteUsageStore((s) => s.open);
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const requestExtend = useRemoteMachinesStore((s) => s.requestExtend);

  /** Hand this machine to a project: a remote project gets it as a (shared-fs)
   *  compute host via the Remote machines window; a local-only one gets it as
   *  its primary host via the extend-to-remote flow. The same two branches the
   *  pill's drop target used to pick between. */
  const attachToProject = (p: ProjectEntry, m: { id: string; host: string; user?: string; port?: number; label?: string }) => {
    const machine = { id: m.id, host: m.host, user: m.user, port: m.port, label: m.label };
    if (p.remote) openRemoteMachines(p.id, machine);
    else requestExtend(p.id, machine);
  };

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  // While an import/export panel is up — or a native file dialog is open, which
  // moves the pointer off the trigger and would otherwise fire mouseleave — the
  // menu must NOT auto-close under the user mid-flow. A ref (read synchronously
  // by `scheduleClose`) rather than state, so the guard is live the instant a
  // dialog opens, before any re-render.
  const keepOpenRef = useRef(false);
  // Per-row DOM nodes (keyed by machine id) + their last-measured positions,
  // for the FLIP slide animation when the list reorders.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRects = useRef<Map<string, number>>(new Map());
  // Which row's "Add to a project" picker is open, if any. This is the ONLY way
  // a global machine reaches a project — the drag-onto-a-pill gesture it
  // replaced could not be made to work (see the component doc), and a picker
  // says which of the two ways the machine would join, which a drop could only
  // imply.
  const [attachId, setAttachId] = useState<string | null>(null);

  // Reorder-by-drag, on POINTER events — not HTML5 DnD, which is what broke the
  // first attempt (a native drag out of a hover-menu hangs under WebKitGTK, and
  // a drop outside a target never fires, stranding the row mid-drag). Same
  // choice `tabs/TabBar` and `embed/YamlTree` already made. The gesture starts
  // on the row's grip only, so the row's buttons stay clickable; the grip takes
  // a pointer capture, so `pointerup`/`pointercancel` are guaranteed to arrive
  // there and end the drag — there is no state a missed event can strand.
  //
  // `to` is the slot the dragged row would land in, as an index into the list
  // WITHOUT it. The other rows part to open that slot — but they part by
  // `transform` only, which changes no layout, so the rects measured at
  // pointerdown stay true for the whole gesture. Re-measuring a moved row
  // against the cursor that moved it is the feedback loop this avoids.
  const [reorderDrag, setReorderDrag] = useState<
    { id: string; dy: number; to: number } | null
  >(null);
  const dragRects = useRef<{ id: string; top: number; height: number }[]>([]);
  const dragStartY = useRef(0);
  const reorderDragRef = useRef(false);

  /** Where the dragged row would land, from the pointer's Y: the number of OTHER
   *  rows whose midpoint the cursor has passed — i.e. an index into the list
   *  without the dragged row, which is exactly what `commitMove` splices at. */
  const dropSlot = (id: string, clientY: number) => {
    const rest = dragRects.current.filter((r) => r.id !== id);
    return rest.filter((r) => clientY > r.top + r.height / 2).length;
  };

  const [removeArm, setRemoveArm] = useState<string | null>(null);
  const [disconnectArm, setDisconnectArm] = useState<string | null>(null);
  // Fleet-wide actions (retry all / disconnect all). `disconnectAllArm` gates the
  // destructive one behind a confirm, exactly as the per-row `disconnectArm` does.
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const [disconnectAllArm, setDisconnectAllArm] = useState(false);
  const [retryId, setRetryId] = useState<string | null>(null);
  // Prefilled from the machine's stored username in `startRetry` — a retry is a
  // re-authenticate of the SAME target, so the login it should default to is the
  // one already on file, not a blank field the user has to remember to refill.
  // Editing it here and reconnecting persists the correction (`submitEdit`'s
  // `update` path), since a login that was wrong is wrong for next time too.
  const [retryUser, setRetryUser] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  // Only for a `global_machine_update` validation failure (e.g. the edited
  // username collides with another row's target) — an auth failure instead
  // lands in the store's `errors` map and is shown from there, alongside the
  // aggregate lamp state.
  const [retryError, setRetryError] = useState("");
  // Rows render compact by default (lamp + label + actions only) — target
  // address, usage meters and the auto-connect toggle are behind a per-row
  // expand so a long machine list stays scannable.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  // Arm the new machine for the launch / VPN-up sweep straight from the add form,
  // so a machine you connect once can silently reconnect on relaunch without
  // opening its row to flip the per-row toggle. Off by default: arming is opt-in
  // (matches a fresh machine's `auto_connect`), and safe either way — the sweep
  // probes first, so an armed host that can't connect silently just stays dark.
  const [addAuto, setAddAuto] = useState(false);
  // "This is a cluster login node", ticked on the login form. Written to
  // `settings.hpc_hosts` the moment the machine exists (both add paths), so the
  // very first connect already has every background behaviour gated off.
  const [addHpc, setAddHpc] = useState(false);
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  // ── "Sign in in a terminal" (see `TerminalSignInToggle`) ─────────────────────
  // Same escape hatch as the connect dialogs', for the same reason: this form has
  // one password field, so a host that asks anything else — a challenge code, a
  // one-time code, an expired-password change — cannot be added from it at all.
  // Default **on** in non-headless mode, where a password field was never supposed
  // to be. Unlike the dialogs, the login goes to the **root terminal** rather than
  // an embedded one: this is a hover menu that closes 250ms after the pointer
  // leaves it, which is no place to keep a live PTY — and it is exactly what the
  // VPN indicator beside it already does in that mode.
  const [addViaTerminal, setAddViaTerminal] = useState(!headless);
  // A login is open in the root terminal and we are waiting for its ControlMaster.
  const [addWaiting, setAddWaiting] = useState(false);
  const addPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live mirrors of the two fields the poll writes onto the machine (see
  // `finishTerminalAdd`), which outlives the render that scheduled it.
  const labelRef = useRef(label);
  const addAutoRef = useRef(addAuto);
  const addHpcRef = useRef(addHpc);
  useEffect(() => {
    labelRef.current = label;
    addAutoRef.current = addAuto;
    addHpcRef.current = addHpc;
  }, [label, addAuto, addHpc]);

  // Per-row inline edit of an existing machine's connection identity. `editId`
  // is the row being edited; the fields are prefilled from it in `startEdit`.
  // The password field is blank ("keep the saved credential") unless the user
  // wants to change it — see `submitEdit`.
  const [editId, setEditId] = useState<string | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editUser, setEditUser] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editSave, setEditSave] = useState(false);
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  // Import / export sub-flows. `ioMode` picks which panel replaces the normal
  // machine list + add-form; both are one-off modal flows within the menu.
  const [ioMode, setIoMode] = useState<"idle" | "export" | "import">("idle");
  // Export: which machines (by id) go into the file — all ticked by default.
  const [exportSel, setExportSel] = useState<Set<string>>(new Set());
  const [ioBusy, setIoBusy] = useState(false);
  const [ioError, setIoError] = useState("");
  // Import: the entries read from the picked file, plus the ONE shared
  // credential the whole batch connects with (a file carries no username/
  // password by design). `importResult` holds the per-host outcome once the run
  // finishes, so the panel switches from form to summary.
  const [importEntries, setImportEntries] = useState<MachineImportEntry[]>([]);
  const [importUser, setImportUser] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [importSave, setImportSave] = useState(false);
  // Arm every imported machine for the launch / VPN-up sweep. Default ON: an
  // imported fleet is one the user wants available, and arming can't misfire —
  // `autoConnect` probes before it connects, so a row that can't come up
  // silently stays dark rather than prompting. Untick to import them inert.
  const [importAuto, setImportAuto] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult[] | null>(null);

  const closeIo = () => {
    keepOpenRef.current = false;
    setIoMode("idle");
    setIoBusy(false);
    setIoError("");
    setImportEntries([]);
    setImportUser("");
    setImportPassword("");
    setImportSave(false);
    setImportResult(null);
  };

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [load, enabled]);

  useEffect(() => {
    if (!open) {
      // A genuinely-closed menu (keepOpenRef already gates a mid-flow close)
      // drops any half-finished import/export so it can't reappear on reopen.
      closeIo();
      return;
    }
    setRemoveArm(null);
    setDisconnectArm(null);
    setDisconnectAllArm(false);
    setEditId(null);
    setAttachId(null);
    // Reachability first, then the busy sweep over whatever came back connected
    // — a machine that isn't up has nothing to ask about, and asking would cost
    // a doomed SSH round trip per host. On-open only: the busy reading is never
    // polled (see `stores/hostBusy`), so a fleet of sixteen costs sixteen cheap
    // `tmux ls`es when you look at it and nothing at all when you don't.
    void probeAll().then(() => {
      const gm = useGlobalMachinesStore.getState();
      const probeBusy = useHostBusyStore.getState().probeGlobal;
      for (const m of gm.machines) {
        if ((gm.status[m.id] ?? "off") === "connected") void probeBusy(m);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeAll]);

  const orderKey = machines.map((m) => m.id).join("|");

  /** Commit a reorder: pull `id` out of the list and splice it back in at `to`
   *  (an index into the list WITHOUT it). The FLIP pass below animates the
   *  result, so both the drop and the keyboard nudge read as movement. */
  const commitMove = (id: string, to: number) => {
    const ids = machines.map((m) => m.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to > ids.length - 1) return;
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void reorder(ids);
  };

  // Keyboard equivalent of the drag, on the focused grip: a reorder must not be
  // pointer-only.
  const nudgeMachine = (id: string, delta: number) =>
    commitMove(id, machines.findIndex((m) => m.id === id) + delta);

  const startReorderDrag = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    // Measure every row ONCE, up front: the DOM order is frozen for the duration
    // of the drag precisely so these stay true.
    dragRects.current = machines.map((mm) => {
      const rect = rowRefs.current.get(mm.id)?.getBoundingClientRect();
      return { id: mm.id, top: rect?.top ?? 0, height: rect?.height ?? 0 };
    });
    reorderDragRef.current = true;
    setReorderDrag({ id, dy: 0, to: dropSlot(id, e.clientY) });
  };

  const moveReorderDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!reorderDrag) return;
    const dy = e.clientY - dragStartY.current;
    const to = dropSlot(reorderDrag.id, e.clientY);
    if (dy !== reorderDrag.dy || to !== reorderDrag.to) setReorderDrag({ ...reorderDrag, dy, to });
  };

  const endReorderDrag = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (!reorderDrag) return;
    const { id } = reorderDrag;
    reorderDragRef.current = false;
    setReorderDrag(null);
    if (commit) commitMove(id, dropSlot(id, e.clientY));
  };

  // FLIP: after the reordered rows paint, translate each card from where it was
  // to where it now is (0ms), then release the transform on the next frame so it
  // slides into place. WebKitGTK animates `transform` cheaply, and comparing top
  // offsets tolerates the rows' variable height (an expanded row is taller).
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rowRefs.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const prev = prevRects.current.get(id);
      if (prev !== undefined) {
        const dy = prev - top;
        if (Math.abs(dy) > 0.5) {
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
          // Force a reflow so the pre-slide transform is committed before release.
          void el.offsetHeight;
          requestAnimationFrame(() => {
            el.style.transition = "transform 160ms ease";
            el.style.transform = "";
          });
        }
      }
    });
    prevRects.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    // A reorder drag can carry the pointer off the menu's bounds (the grip holds
    // a pointer capture, so the gesture continues regardless) — closing under it
    // would unmount the rows mid-drag. Read from a ref, not `reorderDrag`, so
    // the guard is live in the same tick the gesture starts.
    if (keepOpenRef.current || reorderDragRef.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 250);
  };

  // Group the machines by SSH state so each colour is drawn once, with a count —
  // exactly like a project pill's `RemoteConnMenu` aggregates its hosts. No
  // machines at all still shows one grey "off" lamp so the indicator is never
  // blank.
  //
  // Busy is folded into the EXISTING green lamp — it never adds one. The header
  // strip is a fixed, tiny budget of dots (one per state present) and splitting
  // "connected" into working/idle would grow it exactly when the fleet is most
  // active. So the one green lamp pulses when ANY connected machine is working,
  // and its tooltip carries the count and the names. The per-machine answer
  // belongs one level down, on the rows, where each lamp is its own host.
  const lampGroups = (() => {
    const grouped = STATUS_ORDER.map((st) => {
      const inState = machines.filter((m) => (status[m.id] ?? "off") === st);
      const working =
        st === "connected" ? inState.filter((m) => busyReading({ readings }, m) !== null) : [];
      return { st, machines: inState, working };
    }).filter((g) => g.machines.length > 0);
    return grouped.length > 0
      ? grouped
      : [{ st: "off" as ConnState, machines: [] as GlobalMachine[], working: [] as GlobalMachine[] }];
  })();

  const startRetry = (id: string) => {
    const m = machines.find((mm) => mm.id === id);
    setRetryId(id);
    setRetryUser(m?.user ?? "");
    setRetryPassword("");
    setRetryError("");
  };
  const submitRetry = async (id: string) => {
    const m = machines.find((mm) => mm.id === id);
    const user = retryUser.trim() || undefined;
    setRetryError("");
    try {
      // A username edited here is a correction to the stored login, not a
      // one-shot override — route through `update` (which also reconnects) so
      // it sticks for next time; leave the plain `connect` path alone when it
      // is unchanged, to avoid an extra `global_machine_update` round trip on
      // the common case.
      if (m && user !== (m.user ?? undefined)) {
        await update(id, { user, host: m.host, port: m.port, label: m.label }, {
          password: retryPassword || undefined,
          connect: true,
        });
      } else {
        await connect(id, retryPassword || undefined);
      }
      setRetryId(null);
      setRetryPassword("");
    } catch (e) {
      setRetryError(String(e));
    }
  };

  const connectedCount = machines.filter((m) => (status[m.id] ?? "off") === "connected").length;
  const runRetryAll = async () => {
    setRetryAllBusy(true);
    try {
      await retryAll();
    } finally {
      setRetryAllBusy(false);
    }
  };

  // ── Terminal sign-in: log in in the root terminal, then adopt that session ───
  // Eldrun sees no password here. The login's **ControlMaster** is the only signal,
  // so a credential-less `ssh_connect` is polled until it starts succeeding (it can
  // only succeed by riding that master), and the machine is then `register`ed —
  // the store action that deliberately does *not* re-authenticate, precisely
  // because the caller already did. Bounded (~2 min); a login the user never
  // completes stops polling and says so rather than spinning forever.
  const clearAddPoll = () => {
    if (addPoll.current) {
      clearTimeout(addPoll.current);
      addPoll.current = null;
    }
  };

  const finishTerminalAdd = async (target: {
    user: string | null;
    host: string;
    port: number | null;
  }) => {
    const machine = await register({
      user: target.user ?? undefined,
      host: target.host,
      port: target.port ?? undefined,
      // Through refs: the poll re-schedules itself through the closure of the
      // render that started it, so reading these directly would freeze them at the
      // click — and a label typed while the login is still open (which is exactly
      // when there is time to type one) would be dropped.
      label: labelRef.current.trim() || undefined,
    });
    if (!machine) {
      setAddError("Logged in, but the machine couldn't be saved.");
      return;
    }
    // Same order as the headless path: tag first, and never arm a silent
    // launch-time connect for a machine the user just called a cluster.
    if (addHpcRef.current) {
      await updateSettings(
        setHpcPatch(
          useSettingsStore.getState().settings,
          { user: machine.user, host: machine.host, port: machine.port },
          true,
        ),
      );
    }
    if (addAutoRef.current && !addHpcRef.current) await setAutoConnect(machine.id, true);
    setAddress("");
    setUsername("");
    setPassword("");
    setLabel("");
    setSavePassword(false);
    setAddAuto(false);
    setAddHpc(false);
    setAdding(false);
  };

  const pollAddLogin = (
    target: { user: string | null; host: string; port: number | null },
    attempt = 0,
  ) => {
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: target.user,
      host: target.host,
      port: target.port,
      password: null,
    })
      .then(async () => {
        clearAddPoll();
        setAddWaiting(false);
        await finishTerminalAdd(target).catch((e) => setAddError(String(e)));
      })
      .catch(() => {
        if (attempt + 1 >= maxAttempts) {
          clearAddPoll();
          setAddWaiting(false);
          setAddError(
            "No login detected yet. Finish logging in in the root terminal, then click “I've logged in — add”.",
          );
          return;
        }
        addPoll.current = setTimeout(() => pollAddLogin(target, attempt + 1), 3000);
      });
  };

  const startTerminalAdd = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError("Enter a host as [user@]host[:port]");
      return;
    }
    const target = {
      user: parsed.user ?? (username.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    };
    setAddError("");
    try {
      const command = await invoke<string>("remote_login_command", {
        user: target.user,
        host: target.host,
        port: target.port,
      });
      const tabLabel = `ssh · ${target.user ? `${target.user}@` : ""}${target.host}`;
      openConnectionInRoot({
        label: tabLabel,
        command,
        dedupeKey: `ssh:${target.user ? `${target.user}@` : ""}${target.host}:${target.port ?? ""}`,
      });
      setAddWaiting(true);
      clearAddPoll();
      pollAddLogin(target);
    } catch (e) {
      setAddError(String(e));
    }
  };

  /** Re-arm the poll — for a login finished after the bound ran out. */
  const retryTerminalAdd = () => {
    const parsed = parseSshAddress(address);
    if (!parsed) return;
    setAddError("");
    setAddWaiting(true);
    clearAddPoll();
    pollAddLogin({
      user: parsed.user ?? (username.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    });
  };

  // The menu unmounts on close; a timer firing into it afterwards is nobody's.
  // The root-terminal tab is deliberately left alone — it is the user's login.
  useEffect(() => clearAddPoll, []);

  const submitAdd = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError("Enter a host as [user@]host[:port]");
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      const machine = await add({
        user: parsed.user ?? (username.trim() || undefined),
        host: parsed.host,
        port: parsed.port ?? undefined,
        label: label.trim() || undefined,
        password: password || undefined,
        remember: savePassword,
      });
      // The tag is written first: everything else keyed off it (the monitor's
      // reading, the census, auto-connect) should already see it by the time this
      // machine is anything but a row.
      if (addHpc) {
        await updateSettings(
          setHpcPatch(useSettingsStore.getState().settings, { user: machine.user, host: machine.host, port: machine.port }, true),
        );
      }
      // Arm the launch/VPN-up sweep in the same step if the user asked — the add
      // already connected it now; this only persists the future intent. Never for
      // a tagged cluster: silent connects are one of the things the tag is for.
      if (addAuto && !addHpc) await setAutoConnect(machine.id, true);
      setAddress("");
      setUsername("");
      setPassword("");
      setLabel("");
      setSavePassword(false);
      setAddAuto(false);
      setAddHpc(false);
      setAdding(false);
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const startEdit = (m: (typeof machines)[number]) => {
    setEditId(m.id);
    setEditAddress(`${m.host}${m.port ? `:${m.port}` : ""}`);
    setEditUser(m.user ?? "");
    setEditPassword("");
    setEditLabel(m.label ?? "");
    setEditSave(false);
    setEditError("");
  };
  const submitEdit = async (id: string) => {
    const orig = machines.find((m) => m.id === id);
    const parsed = parseSshAddress(editAddress);
    if (!parsed) {
      setEditError("Enter a host as [user@]host[:port]");
      return;
    }
    const user = parsed.user ?? (editUser.trim() || undefined);
    const port = parsed.port ?? undefined;
    // Reconnect only when a connection-relevant field changed, or the user typed
    // a new password / asked to (re)save it — a label-only edit must not force an
    // SSH round trip (which could prompt or be slow).
    const targetChanged =
      user !== (orig?.user ?? undefined) ||
      parsed.host !== orig?.host ||
      port !== (orig?.port ?? undefined);
    const doConnect = targetChanged || !!editPassword || editSave;
    setEditBusy(true);
    setEditError("");
    try {
      await update(
        id,
        { user, host: parsed.host, port, label: editLabel.trim() || undefined },
        { password: editPassword || undefined, remember: editSave, connect: doConnect },
      );
      setEditId(null);
      setEditPassword("");
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditBusy(false);
    }
  };

  const startExport = () => {
    setAdding(false);
    setIoError("");
    setExportSel(new Set(machines.map((m) => m.id))); // all ticked by default
    keepOpenRef.current = true;
    setIoMode("export");
  };
  const toggleExportSel = (id: string) => {
    setExportSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Select-all/none for the export list: one toggle instead of N unticks when
  // the user wants to share a single machine out of a large fleet. "All ticked"
  // is the checked state, so the first click always *clears* — which is the
  // direction that's tedious by hand, since opening the panel ticks everything.
  const allExportSelected = machines.length > 0 && exportSel.size === machines.length;
  const toggleExportSelAll = () => {
    setExportSel(allExportSelected ? new Set() : new Set(machines.map((m) => m.id)));
  };
  const doExport = async () => {
    const ids = machines.map((m) => m.id).filter((id) => exportSel.has(id));
    if (ids.length === 0) return;
    setIoBusy(true);
    setIoError("");
    try {
      // The dialog moves the pointer off the menu; `keepOpenRef` (already set)
      // keeps it from closing while the native picker is up.
      const path = await saveDialog({
        title: "Export machines",
        defaultPath: "eldrun-machines.json",
        filters: [{ name: "Machines JSON", extensions: ["json"] }],
      });
      if (!path) {
        setIoBusy(false);
        return; // cancelled — stay on the export panel
      }
      await exportMachines(ids, path);
      closeIo();
    } catch (e) {
      setIoError(String(e));
      setIoBusy(false);
    }
  };

  const startImport = async () => {
    setAdding(false);
    setIoError("");
    keepOpenRef.current = true;
    setIoMode("import");
    setIoBusy(true);
    try {
      const picked = await openDialog({
        title: "Import machines",
        multiple: false,
        directory: false,
        filters: [{ name: "Machines JSON", extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) {
        closeIo(); // nothing picked — leave the menu as it was
        return;
      }
      const entries = await invoke<MachineImportEntry[]>("global_machines_import_read", {
        path,
      });
      setImportEntries(entries);
      setImportResult(null);
    } catch (e) {
      setIoError(String(e));
    } finally {
      setIoBusy(false);
    }
  };
  const doImport = async () => {
    if (importEntries.length === 0) return;
    setIoBusy(true);
    setIoError("");
    try {
      const result = await importMachines(importEntries, {
        user: importUser.trim() || undefined,
        password: importPassword || undefined,
        remember: importSave,
        autoConnect: importAuto,
      });
      setImportResult(result);
    } catch (e) {
      setIoError(String(e));
    } finally {
      setIoBusy(false);
    }
  };

  if (!enabled) return null;

  return (
    <div className="global-apps-menu header-status-menu-anchor no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn machines-indicator-btn"
        aria-label="Global machines — connect or drag onto a project"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Global worker machines — connect once, then drag onto any SSH project to add it there."
        onClick={reveal}
        onFocus={reveal}
      >
        <span className="header-conn-lamps">
          {lampGroups.map((g) => (
            <span key={g.st} className="conn-lamp-count">
              <ConnLamp
                status={g.st}
                busy={g.working.length > 0}
                label={
                  g.machines.length > 0
                    ? `${g.machines.length} ${STATUS_WORD[g.st]} — ${g.machines.map((m) => m.label || m.host).join(", ")}` +
                      (g.working.length > 0
                        ? `\n${g.working.length} working: ${g.working.map((m) => m.label || m.host).join(", ")}`
                        : "")
                    : "Machines"
                }
              />
              {g.machines.length > 1 && (
                <span className="conn-lamp-count-num">{g.machines.length}</span>
              )}
            </span>
          ))}
        </span>
        <span className="vpn-indicator-label">Machines</span>
      </button>
      {open && (
        <div className="tab-new-menu vpn-indicator-menu machines-indicator-menu" role="menu">
          {/* Pinned title: stays put while the region below it scrolls, so the
              scrollbar starts beneath the header (unified `.menu-scroll-region`
              shape). Keeping it OUT of the scroller also spares the accent rail /
              rounded top from the native scrollbar running over them. */}
          <div className="tab-new-menu-group-label">Global machines</div>
          <div className="menu-scroll-region">
          {ioMode === "export" ? (
            <div className="vpn-indicator-row menu-form machines-io-panel">
              <div className="vpn-indicator-note">
                Choose which machines to write to a shareable JSON file. Only the
                host, port and label are saved — never a username or password.
                <UntestedTag />
              </div>
              {machines.length === 0 ? (
                <div className="vpn-indicator-empty">No machines to export.</div>
              ) : (
                <>
                <label
                  className="vpn-indicator-auto machines-io-pick machines-io-pick-all"
                  title={allExportSelected ? "Deselect every machine" : "Select every machine"}
                >
                  <Toggle checked={allExportSelected} onChange={toggleExportSelAll} size="sm" />
                  <span>{allExportSelected ? "Deselect all" : "Select all"}</span>
                </label>
                {machines.map((m) => (
                  <label
                    key={m.id}
                    className="vpn-indicator-auto machines-io-pick"
                    title={targetLabel(m)}
                  >
                    <Toggle
                      checked={exportSel.has(m.id)}
                      onChange={() => toggleExportSel(m.id)}
                      size="sm"
                    />
                    <span>
                      {m.label || m.host}
                      <span className="machines-io-addr">
                        {`${m.host}${m.port ? `:${m.port}` : ""}`}
                      </span>
                    </span>
                  </label>
                ))}
                </>
              )}
              {ioError && <div className="vpn-indicator-error">{ioError}</div>}
              <div className="vpn-indicator-actions">
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={ioBusy || exportSel.size === 0}
                  onClick={() => void doExport()}
                >
                  {ioBusy ? "Saving…" : `Export ${exportSel.size}…`}
                </button>
                <button type="button" className="vpn-indicator-remove" onClick={closeIo}>
                  Cancel
                </button>
              </div>
            </div>
          ) : ioMode === "import" ? (
            <div className="vpn-indicator-row menu-form machines-io-panel">
              {importResult ? (
                <>
                  <div className="vpn-indicator-note">
                    Added {importResult.length} machine
                    {importResult.length === 1 ? "" : "s"}.{" "}
                    {importResult.filter((r) => r.ok).length} connected,{" "}
                    {importResult.filter((r) => !r.ok).length} need attention.
                  </div>
                  <div className="machines-io-results">
                    {importResult.map((r, i) => (
                      <div key={`${r.host}-${i}`} className="machines-io-result-row">
                        <ConnLamp status={r.ok ? "connected" : "error"} label={r.host} />
                        <span>{r.label || r.host}</span>
                      </div>
                    ))}
                  </div>
                  <div className="vpn-indicator-actions">
                    <button type="button" className="vpn-indicator-connect" onClick={closeIo}>
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="vpn-indicator-note">
                    {ioBusy && importEntries.length === 0
                      ? "Reading file…"
                      : `${importEntries.length} machine${importEntries.length === 1 ? "" : "s"} from the file. They'll all be connected with the one username & password below, then added to your list.`}
                    <UntestedTag />
                  </div>
                  {importEntries.length > 0 && (
                    <div className="machines-io-preview">
                      {importEntries.map((e, i) => (
                        <div key={`${e.host}-${i}`} className="machines-io-addr">
                          {`${e.user ? `${e.user}@` : ""}${e.host}${e.port ? `:${e.port}` : ""}`}
                          {e.label ? ` — ${e.label}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  <label>
                    Username
                    <input
                      placeholder="Shared SSH user for all imported machines"
                      value={importUser}
                      onChange={(e) => setImportUser(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    Password
                    <PasswordInput
                      placeholder="Shared SSH password — leave blank for key auth"
                      value={importPassword}
                      autoComplete="off"
                      onChange={(e) => setImportPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void doImport();
                      }}
                    />
                  </label>
                  <label className="vpn-indicator-auto">
                    <Toggle
                      checked={importSave}
                      onChange={(e) => setImportSave(e.target.checked)}
                      size="sm"
                    />
                    <span>
                      Save password
                      <UntestedTag />
                    </span>
                  </label>
                  <label
                    className="vpn-indicator-auto"
                    title="Silently connect every imported machine on Eldrun launch and whenever a VPN tunnel comes up. Never prompts — each host is probed first, so one that needs a password you didn't save simply stays off."
                  >
                    <Toggle
                      checked={importAuto}
                      onChange={(e) => setImportAuto(e.target.checked)}
                      size="sm"
                    />
                    <span>
                      Connect on launch &amp; VPN-up
                      <UntestedTag />
                    </span>
                  </label>
                  {ioError && <div className="vpn-indicator-error">{ioError}</div>}
                  <div className="vpn-indicator-actions">
                    <button
                      type="button"
                      className="vpn-indicator-connect"
                      disabled={ioBusy || importEntries.length === 0}
                      onClick={() => void doImport()}
                    >
                      {ioBusy ? "Connecting…" : "Connect & import"}
                    </button>
                    <button type="button" className="vpn-indicator-remove" onClick={closeIo}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
          <div className="vpn-indicator-note">
            <strong>Drag a machine onto a project</strong> to add it as a shared-folder
            worker. Drag a row onto another to reorder.
            <UntestedTag />
          </div>

          {machines.length > 0 && disconnectAllArm ? (
            <div className="vpn-indicator-row machines-fleet-actions">
              <div className="vpn-indicator-hint">
                Ends <strong>all tmux jobs</strong> on every connected machine and
                disconnects them. Can't be undone.
                <UntestedTag />
              </div>
              <div className="vpn-indicator-actions">
                <button
                  type="button"
                  className="vpn-indicator-remove"
                  onClick={() => {
                    setDisconnectAllArm(false);
                    void disconnectAll();
                  }}
                >
                  Disconnect all &amp; end jobs
                </button>
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  onClick={() => setDisconnectAllArm(false)}
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            /* One icon bar for every fleet-wide action, in the same glyph
               vocabulary a machine row uses for the same verbs (↻ retry, ⏻
               disconnect) — so "all machines" reads as the row action applied
               to the list, not as a different feature with its own wording.
               The usage report joins it (▥, the system-monitor glyph): it used
               to open itself after every remote connect, putting a modal in
               front of someone who had asked for something else. It is on
               demand now, and this is the only thing that opens it. Its subject
               is THIS list — a section per machine, in this menu's order — plus
               the active project's own hosts that aren't in it
               (`RemoteUsageWarningDialog`); each is read afresh as the dialog
               appears. */
            <div className="vpn-indicator-row vpn-indicator-actions machines-fleet-actions machines-fleet-icons">
              {machines.length > 0 && (
                <button
                  type="button"
                  className="machines-row-action is-accent"
                  disabled={retryAllBusy}
                  aria-label="Retry all"
                  title="Retry all — connect every machine that isn't already connected. A host that needs a password we don't have stays red to retry on its own row."
                  onClick={() => void runRetryAll()}
                >
                  {retryAllBusy ? "⋯" : "↻"}
                </button>
              )}
              {machines.length > 0 && connectedCount > 0 && (
                <button
                  type="button"
                  className="machines-row-action is-danger"
                  aria-label="Disconnect all"
                  title="Disconnect all — actively disconnect every connected machine: end all their tmux jobs and close each SSH connection. Jobs are killed only on this click — never on an Eldrun restart."
                  onClick={() => setDisconnectAllArm(true)}
                >
                  ⏻
                </button>
              )}
              <button
                type="button"
                className="machines-row-action"
                aria-label="Remote host usage"
                title="Remote host usage — check who's logged in and what's running on every machine here: CPU, memory, GPU and top processes, read right now."
                onClick={() => {
                  setOpen(false);
                  openUsage();
                }}
              >
                ▥
              </button>
              <UntestedTag />
            </div>
          )}

          {machines.length === 0 && (
            <div className="vpn-indicator-row">
              <div className="vpn-indicator-empty">No global machines yet.</div>
            </div>
          )}
          {/* While a row is dragged, the others PART to open its landing slot: a
              row the dragged one has passed slides back by exactly the dragged
              row's height (removing it from above lifts them; inserting it above
              drops them — the same distance either way, whatever their own
              heights). It is a `transform`, so no layout moves and the rects
              measured at pointerdown stay valid. */}
          {machines.map((m, idx) => {
            const st = status[m.id] ?? "off";
            // Only a connected machine pulses: a reading taken before it dropped
            // says nothing about it now.
            const busy = st === "connected" ? busyReading({ readings }, m) : null;
            const dragH = reorderDrag
              ? (dragRects.current.find((r) => r.id === reorderDrag.id)?.height ?? 0)
              : 0;
            const dragFrom = reorderDrag ? machines.findIndex((mm) => mm.id === reorderDrag.id) : -1;
            const shift =
              !reorderDrag || idx === dragFrom
                ? 0
                : idx > dragFrom && idx <= reorderDrag.to
                  ? -dragH
                  : idx < dragFrom && idx >= reorderDrag.to
                    ? dragH
                    : 0;
            // A row shows its icon actions only while nothing has taken the row
            // over: an armed confirm (remove/disconnect), the retry password
            // field, or the edit form each replace them with worded buttons.
            const rowFormOpen =
              retryId === m.id ||
              removeArm === m.id ||
              disconnectArm === m.id ||
              editId === m.id ||
              attachId === m.id;
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(m.id, el);
                  else rowRefs.current.delete(m.id);
                }}
                className={`vpn-indicator-row machines-indicator-row${
                  reorderDrag?.id === m.id ? " reorder-dragging" : reorderDrag ? " reorder-parting" : ""
                }`}
                style={
                  reorderDrag?.id === m.id
                    ? { transform: `translateY(${reorderDrag.dy}px)` }
                    : shift
                      ? { transform: `translateY(${shift}px)` }
                      : undefined
                }
              >
                <div className="vpn-indicator-head">
                  <button
                    type="button"
                    className="machines-row-grip"
                    aria-label="Reorder machine"
                    title="Drag to reorder this machine — or focus it and use ↑/↓."
                    onPointerDown={(e) => startReorderDrag(m.id, e)}
                    onPointerMove={moveReorderDrag}
                    onPointerUp={(e) => endReorderDrag(e, true)}
                    onPointerCancel={(e) => endReorderDrag(e, false)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                      e.preventDefault();
                      nudgeMachine(m.id, e.key === "ArrowUp" ? -1 : 1);
                    }}
                  >
                    ⠿
                  </button>
                  <ConnLamp
                    status={st}
                    busy={busy !== null}
                    label={busy ? `${m.label || m.host} — ${busyLabel(busy)}` : m.label || m.host}
                  />
                  <span className="vpn-indicator-config" title={targetLabel(m)}>
                    {m.label || m.host}
                  </span>
                  {/* The HPC tag, on the row itself — the whole point of a tag
                      that switches off background work is being able to see, at a
                      glance over the machine list, which machines it is off for. */}
                  {isHpcHost(settings, targetOfSpec(m)) && (
                    <span
                      className="hpc-badge"
                      title="Tagged as a shared cluster login node: read lightly, no disk-usage scan or folder census, no background sync or lockstep polling, no silent auto-connect, and a warning before anything runs in a login-node shell."
                    >
                      HPC
                    </span>
                  )}
                  {!rowFormOpen && (
                    <div className="machines-row-actions">
                      <button
                        type="button"
                        className="machines-row-action is-accent"
                        aria-label={st === "connected" ? "Reconnect" : st === "error" ? "Retry" : "Connect"}
                        title={
                          st === "connected"
                            ? "Reconnect"
                            : st === "error"
                              ? "Retry — re-enter the SSH password"
                              : "Connect"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (st === "error") startRetry(m.id);
                          else void connect(m.id);
                        }}
                        disabled={st === "connecting"}
                      >
                        {st === "connected" || st === "error" ? "↻" : "▷"}
                      </button>
                      {st === "connected" && (
                        <button
                          type="button"
                          className="machines-row-action is-danger"
                          aria-label="Disconnect"
                          title="Actively disconnect: end every running tmux job on this host and close the SSH connection. Jobs are killed only on this click — never on an Eldrun restart."
                          onClick={(e) => {
                            e.stopPropagation();
                            setDisconnectArm(m.id);
                          }}
                        >
                          ⏻
                        </button>
                      )}
                      <button
                        type="button"
                        className="machines-row-action"
                        aria-label="Add this machine to a project"
                        title="Add this machine to one of the open projects — as a compute host on a remote project, or as the primary host of a local one."
                        onClick={(e) => {
                          e.stopPropagation();
                          setAttachId(m.id);
                        }}
                      >
                        ⇥
                      </button>
                      <button
                        type="button"
                        className="machines-row-action"
                        aria-label="Edit machine"
                        title="Edit this machine's host, username, password or label."
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(m);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="machines-row-action is-danger"
                        aria-label="Remove machine"
                        title="Remove this machine from the list — actively disconnecting it (and ending its tmux jobs) first if it is connected."
                        onClick={(e) => {
                          e.stopPropagation();
                          setRemoveArm(m.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="machines-row-expand-btn"
                    aria-label={expandedIds.has(m.id) ? "Hide details" : "Show details"}
                    aria-expanded={expandedIds.has(m.id)}
                    title={expandedIds.has(m.id) ? "Hide address, usage & auto-connect" : "Show address, usage & auto-connect"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(m.id);
                    }}
                  >
                    {expandedIds.has(m.id) ? "▾" : "▸"}
                  </button>
                </div>
                {/* Why the lamp is red — shown as soon as a connect fails, not only
                    once the user opens Retry. This is what tells apart a stale
                    saved password from an unknown host key from the host simply
                    being off the network, none of which "error" says on its own
                    (see `stores/globalMachines`' `errors`). Also the only place an
                    auto-connect failure at launch explains itself: `autoConnect`
                    never opens a modal, so this row-level line is the one surface
                    that can. */}
                {st === "error" && errors[m.id] && !rowFormOpen && (
                  <div className="vpn-indicator-error machines-row-error">{errors[m.id]}</div>
                )}
                {expandedIds.has(m.id) && (
                  <>
                    <div className="vpn-indicator-holders">{targetLabel(m)}</div>
                    <button
                      type="button"
                      className="vpn-indicator-connect machines-monitor-btn"
                      title="Open the full system monitor (CPU, memory, GPU, processes) for this machine."
                      onClick={(e) => {
                        e.stopPropagation();
                        openMonitor({ id: m.id, user: m.user, host: m.host, port: m.port, label: m.label });
                      }}
                    >
                      System monitor…
                    </button>
                    <label className="vpn-indicator-auto" title="Silently connect this machine on Eldrun launch and whenever a VPN tunnel comes up. Never prompts — it only connects when the host is reachable without a password.">
                      <Toggle
                        checked={m.auto_connect === true}
                        onChange={(e) => void setAutoConnect(m.id, e.target.checked)}
                        size="sm"
                        disabled={isHpcHost(settings, targetOfSpec(m))}
                      />
                      <span>
                        Connect on launch &amp; VPN-up
                        {isHpcHost(settings, targetOfSpec(m)) && (
                          <span className="machines-auto-blocked"> — off while tagged HPC</span>
                        )}
                        <UntestedTag />
                      </span>
                    </label>
                    {/* Where the tag is set for a machine already in the list. The
                        login form has the same tick, so a cluster can be tagged as
                        it is added; this is for one that is already here — and it
                        is per machine, because that is the only scope at which the
                        question ("is this a shared cluster?") has an answer. */}
                    <label
                      className="vpn-indicator-auto"
                      title="Tag this machine as a shared cluster login node. Eldrun then reads it lightly (no other user's names or commands), never scans or measures its filesystem by itself, never runs background sync or lockstep polling against it, never connects to it silently at launch, and asks before anything runs in its login-node shell."
                    >
                      <Toggle
                        checked={isHpcHost(settings, targetOfSpec(m))}
                        onChange={(e) => {
                          const target = targetOfSpec(m);
                          if (target) void updateSettings(setHpcPatch(settings, target, e.target.checked));
                        }}
                        size="sm"
                      />
                      <span>
                        HPC cluster (login node)
                        <UntestedTag />
                      </span>
                    </label>
                  </>
                )}
                {attachId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-attach-form">
                    <div className="vpn-indicator-hint">
                      Add <strong>{m.label || m.host}</strong> to which project?
                      <UntestedTag />
                    </div>
                    {projects.length === 0 && (
                      <div className="vpn-indicator-empty">No active project.</div>
                    )}
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="vpn-indicator-connect machines-attach-project"
                        title={
                          p.remote
                            ? "Add it as a compute host on this remote project."
                            : "Make it this local project's primary remote host (extend to remote)."
                        }
                        onClick={() => {
                          setAttachId(null);
                          setOpen(false);
                          attachToProject(p, m);
                        }}
                      >
                        {p.name}
                        <span className="machines-attach-kind">
                          {p.remote ? "compute host" : "extend to remote"}
                        </span>
                      </button>
                    ))}
                    <button type="button" className="vpn-indicator-remove" onClick={() => setAttachId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : retryId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-retry-form">
                    {errors[m.id] && <div className="vpn-indicator-error">{errors[m.id]}</div>}
                    <input
                      placeholder="SSH username"
                      value={retryUser}
                      onChange={(e) => setRetryUser(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRetry(m.id);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <PasswordInput
                      placeholder="SSH password"
                      value={retryPassword}
                      autoComplete="off"
                      onChange={(e) => setRetryPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRetry(m.id);
                      }}
                    />
                    {retryError && <div className="vpn-indicator-error">{retryError}</div>}
                    <div className="vpn-indicator-actions">
                      <button type="button" className="vpn-indicator-connect" onClick={() => void submitRetry(m.id)}>
                        Retry
                      </button>
                      <button type="button" className="vpn-indicator-remove" onClick={() => setRetryId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : removeArm === m.id ? (
                  <div className="vpn-indicator-actions">
                    <div className="vpn-indicator-hint">
                      {(status[m.id] ?? "off") === "connected" || (status[m.id] ?? "off") === "connecting" ? (
                        <>
                          Disconnects it first — ending <strong>all tmux jobs</strong> here — then
                          removes it from the list. Projects it was added to keep their own copy.
                          <UntestedTag />
                        </>
                      ) : (
                        "Removes this machine from the list. Projects it was added to keep their own copy."
                      )}
                    </div>
                    <button type="button" className="vpn-indicator-remove" onClick={() => void remove(m.id)}>
                      Remove
                    </button>
                    <button type="button" className="vpn-indicator-connect" onClick={() => setRemoveArm(null)}>
                      Keep
                    </button>
                  </div>
                ) : disconnectArm === m.id ? (
                  <div className="vpn-indicator-actions">
                    <div className="vpn-indicator-hint">
                      Ends <strong>all tmux jobs</strong> here and disconnects. Can't be undone.
                      <UntestedTag />
                    </div>
                    <button
                      type="button"
                      className="vpn-indicator-remove"
                      onClick={() => {
                        setDisconnectArm(null);
                        void disconnect(m.id);
                      }}
                    >
                      Disconnect &amp; end jobs
                    </button>
                    <button type="button" className="vpn-indicator-connect" onClick={() => setDisconnectArm(null)}>
                      Keep
                    </button>
                  </div>
                ) : editId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-edit-form">
                    <label>
                      SSH address
                      <input
                        placeholder="[user@]host[:port]"
                        value={editAddress}
                        onChange={(e) => setEditAddress(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitEdit(m.id);
                        }}
                        spellCheck={false}
                        autoFocus
                      />
                    </label>
                    <label>
                      Username
                      <input
                        placeholder="SSH login user — or include as user@ above"
                        value={editUser}
                        onChange={(e) => setEditUser(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      Password
                      <PasswordInput
                        placeholder="Leave blank to keep the saved password"
                        value={editPassword}
                        autoComplete="off"
                        onChange={(e) => setEditPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitEdit(m.id);
                        }}
                      />
                    </label>
                    <label className="vpn-indicator-auto">
                      <Toggle checked={editSave} onChange={(e) => setEditSave(e.target.checked)} size="sm" />
                      <span>
                        Save password
                        <UntestedTag />
                      </span>
                    </label>
                    <label>
                      Label (optional)
                      <input
                        placeholder="e.g. gpu-2"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    {editError && <div className="vpn-indicator-error">{editError}</div>}
                    <div className="vpn-indicator-actions">
                      <button
                        type="button"
                        className="vpn-indicator-connect"
                        disabled={editBusy}
                        onClick={() => void submitEdit(m.id)}
                      >
                        {editBusy ? "Saving…" : "Save changes"}
                      </button>
                      <button type="button" className="vpn-indicator-remove" onClick={() => setEditId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="tab-new-menu-group-label">Add a machine</div>
          {adding ? (
            <div className="vpn-indicator-row menu-form">
              <label>
                SSH address
                <input
                  placeholder="[user@]host[:port]"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitAdd();
                  }}
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <label>
                Username
                <input
                  placeholder="SSH login user — or include as user@ above"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {!addViaTerminal && (
                <label>
                  Password
                  <PasswordInput
                    placeholder="SSH password — leave blank for key auth"
                    value={password}
                    autoComplete="off"
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitAdd();
                    }}
                  />
                </label>
              )}
              {/* Kept on screen in the terminal path, and *disabled* rather than
                  hidden: a saved password belongs to the host, and a row that
                  vanishes reads as one that was discarded. It has nothing to act on
                  there — the flag only reaches the keychain through `ssh_connect`'s
                  `remember`, which a terminal login never calls — so an existing
                  credential is left exactly as it was found. */}
              <label
                className="vpn-indicator-auto"
                title={
                  addViaTerminal
                    ? "A terminal login is one Eldrun never sees, so it stores nothing new — and deletes nothing either. Any saved password for this host stays as it is."
                    : "Save this machine's SSH password in your OS keychain, keyed by host."
                }
              >
                <Toggle
                  checked={savePassword}
                  disabled={addViaTerminal}
                  onChange={(e) => setSavePassword(e.target.checked)}
                  size="sm"
                />
                <span>
                  Save password
                  <UntestedTag />
                </span>
              </label>
              <label
                className="vpn-indicator-auto"
                title="Silently connect this machine on Eldrun launch and whenever a VPN tunnel comes up. Never prompts — it only connects when the host is reachable without a password, so an armed machine that can't connect silently simply stays off."
              >
                <Toggle
                  checked={addAuto && !addHpc}
                  disabled={addHpc}
                  onChange={(e) => setAddAuto(e.target.checked)}
                  size="sm"
                />
                <span>
                  Connect on launch &amp; VPN-up
                  {addHpc && <span className="machines-auto-blocked"> — off for an HPC cluster</span>}
                  <UntestedTag />
                </span>
              </label>
              {/* The tag, at the moment it is actually known: logging in is when
                  the user knows what they are logging in to. Everything Eldrun
                  would otherwise do to this machine on its own is gated behind it
                  (`lib/hpcHost.ts`), so ticking it here means the very first
                  connect already behaves — nothing scans, nothing polls, and the
                  monitor reads it lightly from its first sample. */}
              <label
                className="vpn-indicator-auto"
                title="Tag this machine as a shared cluster login node. Eldrun then reads it lightly (never other users' names or command lines), never scans or measures its filesystem by itself, runs no background sync or lockstep polling against it, never connects to it silently at launch, and asks before anything runs in its login-node shell."
              >
                <Toggle checked={addHpc} onChange={(e) => setAddHpc(e.target.checked)} size="sm" />
                <span>
                  HPC cluster (login node)
                  <UntestedTag />
                </span>
              </label>
              <label>
                Label (optional)
                <input
                  placeholder="e.g. gpu-2"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <TerminalSignInToggle
                channel="ssh"
                checked={addViaTerminal}
                busy={addWaiting}
                onChange={setAddViaTerminal}
              />
              {/* The login is a root-terminal tab, not something in this menu — which
                  closes the moment the pointer leaves it — so say where it went. */}
              {addViaTerminal && addWaiting && (
                <div className="settings-help" role="status">
                  Log in in the <strong>root terminal</strong> — this machine is added by
                  itself once you're through. You can close this menu.
                </div>
              )}
              {addError && <div className="vpn-indicator-error">{addError}</div>}
              <div className="vpn-indicator-actions">
                {addViaTerminal ? (
                  <button
                    type="button"
                    className="vpn-indicator-connect"
                    disabled={addWaiting}
                    title="Open this host's SSH login in the root terminal. Eldrun never sees the password, and adds the machine once the login is through."
                    onClick={() => void startTerminalAdd()}
                  >
                    {addWaiting ? "Waiting for the login…" : "Log in in terminal"}
                  </button>
                ) : (
                  <button type="button" className="vpn-indicator-connect" disabled={addBusy} onClick={() => void submitAdd()}>
                    {addBusy ? "Connecting…" : "Connect & add"}
                  </button>
                )}
                {/* Only after the poll has given up: a login finished late is still a
                    login, and re-arming beats retyping the whole form. */}
                {addViaTerminal && !addWaiting && addError && (
                  <button type="button" className="vpn-indicator-connect" onClick={retryTerminalAdd}>
                    I've logged in — add
                  </button>
                )}
                <button
                  type="button"
                  className="vpn-indicator-remove"
                  onClick={() => {
                    clearAddPoll();
                    setAddWaiting(false);
                    setAdding(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="vpn-indicator-row vpn-indicator-browse machines-io-buttons">
              <button type="button" className="vpn-indicator-connect" onClick={() => setAdding(true)}>
                Add machine…
              </button>
              <button
                type="button"
                className="vpn-indicator-connect"
                title="Import machines from a JSON file — connect them all with one shared username & password, then add them to this list."
                onClick={() => void startImport()}
              >
                Import…
              </button>
              <button
                type="button"
                className="vpn-indicator-connect"
                disabled={machines.length === 0}
                title="Write selected machines to a shareable JSON file (host, port & label only — no credentials)."
                onClick={startExport}
              >
                Export…
              </button>
            </div>
          )}
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
