import { invoke } from "@tauri-apps/api/core";

/**
 * The two questions every *silent* OpenVPN connect has to ask, in the order it has
 * to ask them.
 *
 * Bringing a tunnel up is elevated (`pkexec openvpn`), and **polkit authenticates
 * the user before OpenVPN has looked at the config at all**. So a connect attempt
 * is not a cheap thing to get wrong: an attempt that was always going to be
 * rejected — a missing `auth-user-pass` username, say — still costs the user a
 * system password dialog, and the modal that then opens to collect what was missing
 * costs them a *second* one. One tunnel, two system prompts, which is what the
 * header's VPN menu used to do on every reconnect: the username lives on a
 * project's spec, and a tunnel started from the header has no project.
 *
 * Hence [`canConnectVpnSilently`]: ask the backend whether the connect can be made
 * with no prompt of any kind, and only then [`connectVpnSilently`]. If the answer is
 * no, go straight to the password modal — one prompt, one elevation.
 *
 * These are deliberately free of store imports so `stores/projects` can use them
 * without closing an import cycle; the callers own the lamps (see `stores/vpnStatus`).
 */

/**
 * Whether `config` would come up with **no prompt** right now: every secret it needs
 * is in the keychain, and an `auth-user-pass` config has a username to go with them —
 * either the `username` passed here (a project's spec) or one saved beside the
 * password. Never throws; an unreachable backend answers "no", which degrades to the
 * modal rather than to a silent failure.
 */
export async function canConnectVpnSilently(
  config: string,
  username?: string | null,
): Promise<boolean> {
  return invoke<boolean>("vpn_can_connect_silently", {
    config,
    username: username || null,
  }).catch(() => false);
}

/**
 * Bring `config` up from the saved credentials. Throws if it fails, so the caller can
 * fall back to the modal.
 *
 * `remember: null` is load-bearing: there is no checkbox behind this call, so the
 * keychain must be left exactly as it was found. Passing `false` would delete the very
 * credentials the connect just authenticated with.
 */
export async function connectVpnSilently(
  config: string,
  username?: string | null,
): Promise<void> {
  await invoke("openvpn_connect", {
    config,
    username: username || null,
    password: null,
    keyPassphrase: null,
    remember: null,
  });
}
