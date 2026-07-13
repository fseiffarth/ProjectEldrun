import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useConnectDialogStore } from "../../stores/connectDialog";
import type { ProjectEntry } from "../../types";

/**
 * A remote project's live SSH/VPN status, rendered on the project's pill.
 *
 * At rest it shows a single aggregate lamp; on hover it splits into the
 * individual SSH / OpenVPN lamps with labels. Clicking opens the centered
 * Connect modal (`RemoteConnectDialog`) for this project — the single place to
 * (re)connect or disconnect its pooled SSH/SFTP connection.
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
  const vpn = status?.vpn ?? "off";
  const host = project.remote?.host ?? "";
  const hasVpn = !!project.remote?.openvpn;

  const title = hasVpn
    ? `SSH · ${host} — ${ssh}\nOpenVPN — ${vpn}`
    : `SSH · ${host} — ${ssh}`;

  return (
    <div
      className={`header-conn-menu${compact ? " header-conn-menu-compact" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="header-conn-lamps no-drag"
        aria-label="Remote connection — click to manage (connect / disconnect)"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          openDialog(project.id);
        }}
      >
        {/* Resting view: one lamp that tracks SSH — the channel that makes the
            project usable. OpenVPN isn't always needed, so it never drags this
            lamp off green when SSH is connected. */}
        <span className="conn-collapsed">
          <ConnLamp status={ssh} label={`SSH · ${host}`} />
        </span>
        {/* Hover view: split into labeled channels. */}
        <span className="conn-expanded">
          <span className="conn-chan">
            <ConnLamp status={ssh} label={`SSH · ${host}`} />
            <span className="conn-chan-label">SSH</span>
          </span>
          {hasVpn && (
            <span className="conn-chan">
              <ConnLamp status={vpn} label="OpenVPN" />
              <span className="conn-chan-label">VPN</span>
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
