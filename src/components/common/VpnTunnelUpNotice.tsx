import { ConnLamp } from "./ConnLamp";
import { useT } from "../../lib/i18n";

/**
 * What a remote dialog shows in place of its "Connect via OpenVPN" section once a
 * tunnel is already up machine-wide (the gate is `useVpnSectionVisible`): a
 * project-scoped VPN control has nothing left to do — the computer is already
 * routing through a tunnel — and the header's `VpnIndicator` is where a
 * machine-wide tunnel is managed.
 */
export function VpnTunnelUpNotice() {
  const t = useT();
  return (
    <div className="vpn-up-card" role="group" aria-label={t("vpnNotice.ariaLabel")}>
      <span className="toggle-card-title">
        <ConnLamp status="connected" label="OpenVPN" />
        {t("vpnNotice.alreadyUp")}
      </span>
      <span className="toggle-card-desc">{t("vpnNotice.desc")}</span>
    </div>
  );
}
