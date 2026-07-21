import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import type { ProjectEntry } from "../../types";

/**
 * A remote project's live SSH status, rendered on the project's pill — one lamp for
 * the primary host plus one per extra "worker" machine (multi-host remote,
 * `docs/multi_host_remote_plan.md`).
 *
 * OpenVPN is machine-wide, not project-scoped, so its lamp lives only in the
 * header's `VpnIndicator` — this menu tracks SSH alone. Clicking any lamp opens the
 * one unified "Remote machines" hub (`RemoteMachinesWindow`), which lists every host
 * — the primary and each worker — with an entry apiece plus Add-a-machine; the
 * per-host Connect/Manage there opens the centered Connect detail
 * (`RemoteConnectDialog`). The pill stays status + open-hub only.
 *
 * Remote projects start DISCONNECTED — they are not auto-connected on launch or
 * switch (that raced the tab restore and hung). Local tabs still restore and
 * work on the mirror while disconnected; only remote panes wait for the pool,
 * which the modal brings up.
 */
export function RemoteConnMenu({ project, compact }: { project: ProjectEntry; compact?: boolean }) {
  const status = useRemoteStatusStore((s) => s.byProject[project.id]);
  const byHost = useRemoteStatusStore((s) => s.byHost[project.id]);
  const openHub = useRemoteMachinesStore((s) => s.open);
  const ssh = status?.ssh ?? "off";
  const host = project.remote?.host ?? "";
  const hostLabel = project.remote?.label || host;
  const workers = project.compute_hosts ?? [];

  return (
    <div
      className={`header-conn-menu${compact ? " header-conn-menu-compact" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="header-conn-lamps no-drag"
        aria-label="Remote machines — click to connect / manage this project's hosts"
        title={`SSH · ${hostLabel} — ${ssh}`}
        onClick={(e) => {
          e.stopPropagation();
          openHub(project.id);
        }}
      >
        <ConnLamp status={ssh} label={`SSH · ${hostLabel}`} />
      </button>
      {workers.map((w) => {
        const wLabel = w.label || w.host || w.id;
        const wSsh = byHost?.[w.id]?.ssh ?? "off";
        return (
          <button
            key={w.id}
            type="button"
            className="header-conn-lamps no-drag"
            aria-label={`Worker ${wLabel} — click to manage remote machines`}
            title={`${wLabel} — ${wSsh}`}
            onClick={(e) => {
              e.stopPropagation();
              openHub(project.id);
            }}
          >
            <ConnLamp status={wSsh} label={wLabel} />
          </button>
        );
      })}
    </div>
  );
}
