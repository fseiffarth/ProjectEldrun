import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { useVpnStatusStore } from "../stores/vpnStatus";
import { canConnectVpnSilently, connectVpnSilently } from "./vpnConnect";
import { openConnectionInRoot } from "./remoteConnect";

/**
 * "Connect this tunnel on launch" — the machine-level twin of a project's
 * `remote.auto_connect`, armed per config in the header's VPN menu.
 *
 * It is armed on the *tunnel*, not on a project, because that is what a tunnel is:
 * it reroutes the whole computer for as long as it is up, and a VPN you always want
 * up is a property of where you work, not of which project happens to be open. So it
 * can be armed for a config no project uses at all.
 *
 * Two promises, both inherited from the project-side rule (see `autoConnectRemote`):
 *
 *  1. **It never prompts.** The opt-in is only offered when it can be kept — the
 *     credentials are saved — and it is *re-checked* here at launch rather than
 *     trusted, so an opt-in that went stale (the password was forgotten meanwhile)
 *     degrades to leaving the tunnel down, never to ambushing the user with a modal
 *     during startup.
 *  2. **It never elevates twice.** `pkexec` raises its polkit dialog before OpenVPN
 *     validates anything, so a doomed attempt is not free (see `lib/vpnConnect`).
 *
 * Non-headless mode is the deliberate exception to (1): with `connections_headless`
 * off, Eldrun handles no passwords at all, so "connect on launch" can only mean
 * "open the connect command in the root terminal" — one tab, waiting for the user,
 * which is exactly what activating a VPN-gated project does in that mode.
 */

/** Whether a tunnel is armed to come up on launch. */
export function isVpnAutoConnect(config: string): boolean {
  return useSettingsStore.getState().settings?.vpn_auto_connect === config;
}

/**
 * Arm `config` to connect on launch, or disarm it. Arming is exclusive: a tunnel owns
 * the machine's routing, so two armed configs would just be two tunnels fighting over
 * it — arming one disarms the other by construction (a single stored path, not a set).
 */
export async function setVpnAutoConnect(config: string, enabled: boolean): Promise<void> {
  const current = useSettingsStore.getState().settings?.vpn_auto_connect ?? null;
  if (enabled) {
    if (current === config) return;
  } else if (current !== config) {
    return;
  }
  await useSettingsStore.getState().updateSettings({ vpn_auto_connect: enabled ? config : null });
}

/**
 * The auth username for an `auth-user-pass` config, as far as the frontend knows one:
 * a project that uses this config carries it on its spec. It is not a secret, and the
 * backend also keeps a copy beside the saved password (which is the only way a
 * project-less tunnel can know it) — so `undefined` here is not "no username", it is
 * "none on this side"; the backend fills it in.
 */
export function vpnUsernameFor(config: string): string | undefined {
  return useProjectsStore
    .getState()
    .projects.find((p) => p.remote?.openvpn?.config === config)?.remote?.openvpn?.username;
}

/** Guards the launch connect against a second run (a re-mount, a second window). */
let launched = false;

/**
 * Bring the armed tunnel up, once, at startup. Call after settings and projects have
 * loaded (the username seed lives on a project's spec). Best-effort and silent: every
 * exit that isn't a live tunnel leaves the lamp dark and the machine's routing alone.
 */
export async function autoConnectVpnOnLaunch(): Promise<void> {
  if (launched) return;
  const settings = useSettingsStore.getState().settings;
  const config = settings?.vpn_auto_connect;
  if (!config) return;
  launched = true;

  const status = useVpnStatusStore.getState();
  // A tunnel can outlive the app (it is a root daemon, not our child), so the one we
  // are about to start may already be up from a previous run. Reconcile first.
  await status.refresh();
  if (useVpnStatusStore.getState().byConfig[config]) return;

  const username = vpnUsernameFor(config);

  // Non-headless: Eldrun handles no password, so "auto-connect" means the connect
  // command is waiting in the root terminal for the user to authenticate. Building it
  // also arms the tunnel backend-side (`--writepid`), so it stays visible and killable.
  if (settings?.connections_headless === false) {
    try {
      const command = await invoke<string>("openvpn_login_command", { config });
      useVpnStatusStore.getState().setState(config, "connecting");
      openConnectionInRoot({
        label: `OpenVPN · ${fileOf(config)}`,
        command,
        dedupeKey: `vpn:${config}`,
      });
      pollVpnUp(config);
    } catch (error) {
      useVpnStatusStore.getState().setState(config, "off");
      console.warn("VPN auto-connect (root terminal) skipped", error);
    }
    return;
  }

  // Headless: re-check the promise rather than trusting the toggle. A saved password
  // that has since been forgotten must leave the tunnel down — never open a modal the
  // user did not ask for while the app is still starting up.
  if (!(await canConnectVpnSilently(config, username))) {
    console.warn("VPN auto-connect skipped: credentials no longer allow a silent connect");
    return;
  }
  useVpnStatusStore.getState().setState(config, "connecting");
  try {
    await connectVpnSilently(config, username);
    useVpnStatusStore.getState().setState(config, "connected");
    useProjectsStore.setState({
      connToast: `VPN up · ${fileOf(config)} — this computer's traffic now routes through the tunnel`,
    });
  } catch (error) {
    useVpnStatusStore.getState().setState(config, "off");
    console.warn("VPN auto-connect failed", error);
  }
}

/**
 * Poll until the root-terminal tunnel is up (non-headless: the user authenticates in
 * that terminal, so `openvpn_status` is the only completion signal). Bounded, so a
 * tunnel that is never authenticated stops polling instead of spinning forever.
 */
function pollVpnUp(config: string): void {
  let attempts = 0;
  const maxAttempts = 40; // ~60s at 1.5s cadence
  const tick = () => {
    void invoke<boolean>("openvpn_status", { config })
      .then((up) => {
        if (up) {
          useVpnStatusStore.getState().setState(config, "connected");
          return;
        }
        if (++attempts >= maxAttempts) {
          useVpnStatusStore.getState().setState(config, "off");
          return;
        }
        setTimeout(tick, 1500);
      })
      .catch(() => {
        if (++attempts >= maxAttempts) useVpnStatusStore.getState().setState(config, "off");
        else setTimeout(tick, 1500);
      });
  };
  setTimeout(tick, 1500);
}

/** The config's file name — the whole path is a tooltip, not a label. */
export function fileOf(config: string): string {
  return config.split(/[\\/]/).pop() || config;
}
