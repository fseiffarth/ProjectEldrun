import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { useHostBusyStore, isBusy } from "../../stores/hostBusy";
import type { ConnState } from "../../stores/remoteStatus";
import type { ProjectEntry } from "../../types";

/**
 * A remote project's live SSH status, rendered on the project's pill.
 *
 * A project can reach many hosts (the primary plus extra "worker" machines,
 * multi-host remote, `docs/multi_host_remote_plan.md`). Rather than one lamp
 * per host — a long row of near-identical dots once a project has several
 * machines — the hosts are **aggregated by status**: one lamp per distinct
 * state (connected / connecting / error / off), each carrying the count of
 * hosts in that state, and a state with no hosts shows no lamp. So four
 * connected machines read as a single green lamp badged "4", and a mixed fleet
 * reads as one lamp per colour that is actually present. The count badge is
 * shown only when a group holds more than one host, so the common
 * single-primary project still shows a plain lamp.
 *
 * OpenVPN is machine-wide, not project-scoped, so its lamp lives only in the
 * header's `VpnIndicator` — this menu tracks SSH alone. Clicking opens the one
 * unified "Remote machines" hub (`RemoteMachinesWindow`), which lists every
 * host with an entry apiece plus Add-a-machine; the per-host Connect/Manage
 * there opens the centered Connect detail (`RemoteConnectDialog`). The pill
 * stays status + open-hub only.
 *
 * Remote projects start DISCONNECTED — they are not auto-connected on launch or
 * switch (that raced the tab restore and hung). Local tabs still restore and
 * work on the mirror while disconnected; only remote panes wait for the pool,
 * which the modal brings up.
 */

/** Lamp order — most-relevant state first, so a fleet with any error/connecting
 *  host surfaces that colour ahead of the steady-state green/grey. */
const STATUS_ORDER: ConnState[] = ["error", "connecting", "connected", "off"];

const STATUS_WORD: Record<ConnState, string> = {
  error: "error",
  connecting: "connecting",
  connected: "connected",
  off: "off",
};

export function RemoteConnMenu({ project, compact }: { project: ProjectEntry; compact?: boolean }) {
  const status = useRemoteStatusStore((s) => s.byProject[project.id]);
  const byHost = useRemoteStatusStore((s) => s.byHost[project.id]);
  const openHub = useRemoteMachinesStore((s) => s.open);
  const readings = useHostBusyStore((s) => s.readings);
  const primarySsh = status?.ssh ?? "off";
  const host = project.remote?.host ?? "";
  const hostLabel = project.remote?.label || host;
  const workers = project.compute_hosts ?? [];

  // Every host this project reaches, tagged with its live SSH state and whether
  // it is **working** (≥1 tmux session, `stores/hostBusy`) — the primary first,
  // then each worker.
  //
  // The busy half is read from the cache and never probed here: these lamps are
  // always on screen, so probing from them would be a background poll of every
  // host of every open project — exactly the traffic the busy reading is
  // designed not to cost. The sweeps live in the surfaces you deliberately open
  // (the header Machines menu, the Remote-machines hub this button opens), and a
  // reading goes stale rather than lying.
  const hosts: { label: string; ssh: ConnState; busy: boolean }[] = [
    {
      label: hostLabel,
      ssh: primarySsh,
      busy: isBusy({ readings }, project.remote, primarySsh === "connected"),
    },
    ...workers.map((w) => {
      const ssh = byHost?.[w.id]?.ssh ?? ("off" as ConnState);
      return {
        label: w.label || w.host || w.id,
        ssh,
        busy: isBusy({ readings }, w, ssh === "connected"),
      };
    }),
  ];

  // Group the hosts by state so each colour is drawn once, with a count. Busy
  // folds into the existing green lamp rather than adding a second one — the
  // pill's lamp strip is the tightest space in the UI and must not grow with the
  // fleet. The count of working hosts rides the tooltip; the per-host answer is
  // in the hub this button opens.
  const groups = STATUS_ORDER.map((st) => {
    const inState = hosts.filter((h) => h.ssh === st);
    return { st, hosts: inState, working: inState.filter((h) => h.busy) };
  }).filter((g) => g.hosts.length > 0);

  const title = groups
    .map(
      (g) =>
        `${g.hosts.length} ${STATUS_WORD[g.st]}: ${g.hosts.map((h) => h.label).join(", ")}` +
        (g.working.length > 0
          ? `\n${g.working.length} working: ${g.working.map((h) => h.label).join(", ")}`
          : ""),
    )
    .join("\n");

  return (
    <div
      className={`header-conn-menu${compact ? " header-conn-menu-compact" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="header-conn-lamps no-drag"
        aria-label="Remote machines — click to connect / manage this project's hosts"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          openHub(project.id);
        }}
      >
        {groups.map((g) => (
          <span key={g.st} className="conn-lamp-count">
            <ConnLamp
              status={g.st}
              busy={g.working.length > 0}
              label={
                `${g.hosts.length} ${STATUS_WORD[g.st]} — ${g.hosts.map((h) => h.label).join(", ")}` +
                (g.working.length > 0 ? ` (${g.working.length} working)` : "")
              }
            />
            {g.hosts.length > 1 && (
              <span className="conn-lamp-count-num">{g.hosts.length}</span>
            )}
          </span>
        ))}
      </button>
    </div>
  );
}
