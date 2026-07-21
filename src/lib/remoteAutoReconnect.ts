import { useVpnStatusStore } from "../stores/vpnStatus";
import { useGlobalMachinesStore } from "../stores/globalMachines";
import { retryAutoConnectAfterVpn } from "../stores/projects";

/**
 * Wire the two *event-driven* halves of remote auto-connect that the imperative
 * connect paths can't own by themselves. The launch-time half already lives where
 * it belongs — a project's active-project auto-connect fires from `projects.load()`
 * / `setActive`, the armed VPN tunnel from `autoConnectVpnOnLaunch`. What was
 * missing is a reaction to a **tunnel coming up**:
 *
 *  1. **On any tunnel becoming active**, re-attempt the things that were only
 *     unreachable *because* the routing wasn't there yet — the active remote
 *     project (`retryAutoConnectAfterVpn`) and every armed global machine. This is
 *     what makes a project reachable *only through the VPN* connect promptly the
 *     instant the tunnel is up, instead of sitting red until the user acts. It fires
 *     whoever brought the tunnel up — the armed launch tunnel, a header connect, or
 *     another project — because a tunnel is machine-wide.
 *  2. **At launch**, sweep the global machines armed for auto-connect (the project
 *     side already self-starts from its store).
 *
 * We subscribe to the machine-level VPN store rather than poll, so the retry is
 * immediate on the exact `→ connected` transition (an earlier poll-based reaction
 * lagged the tunnel by seconds). Idempotent by construction: the retry paths skip a
 * live/winning lamp, and `setState` collapses a no-op transition, so a tunnel that
 * comes up as a *side effect* of an auto-connect (a project bringing up its own
 * VPN) can't feed back into a loop.
 */

let installed = false;

export function initRemoteAutoReconnect(): void {
  if (installed) return;
  installed = true;

  // React to a tunnel becoming active. `refresh()` at launch seats a tunnel that
  // outlived a previous run (prev has no entry → this fires for it too), which is
  // exactly right: a remote reachable only through that tunnel should connect.
  useVpnStatusStore.subscribe((state, prev) => {
    const roseToConnected = Object.entries(state.byConfig).some(
      ([config, s]) => s === "connected" && prev.byConfig[config] !== "connected",
    );
    if (roseToConnected) onVpnTunnelUp();
  });

  // Launch-time global-machine sweep, decoupled from the header component so it runs
  // even before the Machines menu is ever opened.
  const gm = useGlobalMachinesStore.getState();
  void (gm.loaded ? gm.autoConnect() : gm.load().then(() => useGlobalMachinesStore.getState().autoConnect()));
}

function onVpnTunnelUp(): void {
  retryAutoConnectAfterVpn();
  void useGlobalMachinesStore.getState().autoConnect();
}
