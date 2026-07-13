import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useConnectDialogStore } from "../../stores/connectDialog";
import type { ProjectEntry } from "../../types";

/**
 * A remote project's live SSH status, rendered on the project's pill.
 *
 * OpenVPN is machine-wide, not project-scoped, so its lamp lives only in the
 * header's `VpnIndicator` — this menu tracks SSH alone. Clicking opens the
 * centered Connect modal (`RemoteConnectDialog`) for this project — the single
 * place to (re)connect or disconnect its pooled SSH/SFTP connection.
 *
 * One-click logout deliberately does NOT live here — it sits beside the
 * Remote/Local switch in the right file panel (`RightPanel`), keeping the pill
 * to status + open-modal only (the modal keeps a Disconnect for the
 * connecting/error states, where an in-flight attempt still has to be
 * abandoned).
 *
 * Remote projects start DISCONNECTED — they are not auto-connected on launch or
 * switch (that raced the tab restore and hung). Local tabs still restore and
 * work on the mirror while disconnected; only remote panes wait for the pool,
 * which the modal brings up.
 */
export function RemoteConnMenu({ project, compact }: { project: ProjectEntry; compact?: boolean }) {
  const status = useRemoteStatusStore((s) => s.byProject[project.id]);
  const openDialog = useConnectDialogStore((s) => s.open);
  const ssh = status?.ssh ?? "off";
  const host = project.remote?.host ?? "";

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
          openDialog(project.id);
        }}
      >
        <ConnLamp status={ssh} label={`SSH · ${host}`} />
      </button>
    </div>
  );
}
