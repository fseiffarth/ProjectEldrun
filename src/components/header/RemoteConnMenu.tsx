import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useConnectDialogStore } from "../../stores/connectDialog";
import type { ProjectEntry } from "../../types";

/**
 * A remote project's live SSH status, rendered on the project's pill — one lamp for
 * the primary host plus one per extra "worker" machine (multi-host remote,
 * `docs/multi_host_remote_plan.md`).
 *
 * OpenVPN is machine-wide, not project-scoped, so its lamp lives only in the
 * header's `VpnIndicator` — this menu tracks SSH alone. Clicking a lamp opens the
 * centered Connect modal (`RemoteConnectDialog`) for that host. The "Remote
 * machines" manager is reached from the file viewer's remote (SSH) tag right-click
 * menu (`ProjectFilesView`), not here — the pill stays status + open-modal only.
 *
 * Remote projects start DISCONNECTED — they are not auto-connected on launch or
 * switch (that raced the tab restore and hung). Local tabs still restore and
 * work on the mirror while disconnected; only remote panes wait for the pool,
 * which the modal brings up.
 */
export function RemoteConnMenu({ project, compact }: { project: ProjectEntry; compact?: boolean }) {
  const status = useRemoteStatusStore((s) => s.byProject[project.id]);
  const byHost = useRemoteStatusStore((s) => s.byHost[project.id]);
  const openDialog = useConnectDialogStore((s) => s.open);
  const ssh = status?.ssh ?? "off";
  const host = project.remote?.host ?? "";
  const workers = project.compute_hosts ?? [];

  return (
    <div
      className={`header-conn-menu${compact ? " header-conn-menu-compact" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="header-conn-lamps no-drag"
        aria-label="Remote connection — click to manage (connect / disconnect)"
        title={`SSH · ${host} — ${ssh}`}
        onClick={(e) => {
          e.stopPropagation();
          openDialog(project.id, "primary");
        }}
      >
        <ConnLamp status={ssh} label={`SSH · ${host}`} />
      </button>
      {workers.map((w) => {
        const wLabel = w.label || w.host || w.id;
        const wSsh = byHost?.[w.id]?.ssh ?? "off";
        return (
          <button
            key={w.id}
            type="button"
            className="header-conn-lamps no-drag"
            aria-label={`Worker ${wLabel} — click to manage`}
            title={`${wLabel} — ${wSsh}`}
            onClick={(e) => {
              e.stopPropagation();
              openDialog(project.id, w.id);
            }}
          >
            <ConnLamp status={wSsh} label={wLabel} />
          </button>
        );
      })}
    </div>
  );
}
