import { ConnLamp } from "./ConnLamp";

/**
 * What a remote dialog shows in place of its "Connect via OpenVPN" section once a
 * tunnel is already up machine-wide (the gate is `useVpnSectionVisible`): a
 * project-scoped VPN control has nothing left to do — the computer is already
 * routing through a tunnel — and the header's `VpnIndicator` is where a
 * machine-wide tunnel is managed.
 */
export function VpnTunnelUpNotice() {
  return (
    <div className="vpn-up-card" role="group" aria-label="OpenVPN tunnel">
      <span className="toggle-card-title">
        <ConnLamp status="connected" label="OpenVPN" />
        OpenVPN tunnel already up
      </span>
      <span className="toggle-card-desc">
        This computer already routes through a tunnel, so this project needs no
        second one. Manage tunnels from the VPN control in the header.
      </span>
    </div>
  );
}
