import { useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";

/**
 * Non-headless remote-connection support: instead of Eldrun handling the
 * SSH/OpenVPN password itself, the actual connecting command is launched as an
 * interactive shell tab in the Eldrun **root** scope, where the user types the
 * password directly into the live terminal. Eldrun never sees or stores it.
 *
 * Gated by the `connections_headless` setting (default ON = old headless flow).
 */

/**
 * Configs/targets we've already opened a connection tab for this session, so a
 * project that is re-activated several times doesn't spawn a duplicate tab each
 * time. Keyed by an opaque caller-supplied string (the .ovpn path or the SSH
 * target). Session-only — cleared on reload like other transient state.
 */
const openedConnections = new Set<string>();

/** Reset the dedupe set (e.g. when a connection is torn down). */
export function forgetConnection(dedupeKey: string): void {
  openedConnections.delete(dedupeKey);
}

/**
 * Mark a connection as already opened WITHOUT spawning a root tab. The
 * non-headless project dialog uses this when it brings a VPN tunnel / SSH login
 * up in its own embedded terminal: pre-marking the same `dedupeKey` that
 * activation would use makes the later `openConnectionInRoot` call a no-op, so
 * the connection the user already authenticated in the dialog isn't duplicated
 * as a root-terminal tab.
 */
export function markConnectionOpened(dedupeKey: string): void {
  openedConnections.add(dedupeKey);
}

/**
 * Open `command` as an interactive shell tab in the **root** scope. `command` is
 * typed into the freshly-spawned shell via the tab's `initialInput` (see
 * TerminalView), so a password prompt it raises is answered in that visible
 * terminal — Eldrun never handles the password.
 *
 * The active project is deliberately NOT changed (this is called mid-activation,
 * where switching scope would undo the activation in progress); instead a brief
 * toast points the user at the root terminal. The user switches to root to
 * authenticate when ready; downstream sshfs mounts retry and ride the shared
 * master once it is up.
 *
 * `dedupeKey` suppresses a duplicate tab when the same connection is requested
 * again within the session; pass `null` to always open a new tab.
 */
export function openConnectionInRoot(opts: {
  label: string;
  command: string;
  dedupeKey?: string | null;
}): void {
  const { label, command, dedupeKey } = opts;
  if (dedupeKey != null) {
    if (openedConnections.has(dedupeKey)) return;
    openedConnections.add(dedupeKey);
  }
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  useTabsStore.getState().addTabToScope("root", {
    label,
    cmd: "", // empty → backend default_shell()
    cwd: rootDir, // empty resolves to ~/eldrun/root on the backend
    kind: "shell",
    initialInput: command,
  });
  // Surface it without stealing the active project: a transient toast (auto-clears
  // in AppShell) tells the user the connection is waiting in the root terminal.
  useProjectsStore.setState({ switchToast: `${label} — authenticate in root terminal` });
}
