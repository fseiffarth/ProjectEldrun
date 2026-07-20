/**
 * Close (detach) of a persistent tab (TODO #85), plus the helpers that classify
 * which tmux session a tab owns.
 *
 * A shell/script tab can run inside a **tmux** session — remote (on the SSH host)
 * or local (on this machine) — so the run survives an SSH drop / laptop sleep /
 * Eldrun quit / crash. Closing a tab is therefore **non-destructive**: it detaches
 * (unmounts the pane, killing only the ssh/PTY client) and leaves the session alive
 * under its tmux daemon, reattachable from the Sessions view. The *only* way to
 * terminate a session is its × (kill) in the Sessions view (`remote_tmux_kill` /
 * `local_tmux_kill`); no tab close, quit, disconnect, or crash ends a run.
 *
 * `persistentSessionOf` / `localPersistentSessionOf` classify the tab (used by the
 * Sessions view to mark which rows an open tab owns). They live outside the stores
 * because they read BOTH the tabs and projects stores, and `stores/projects`
 * already imports `stores/tabs` — a store-level import back would be a cycle.
 */

import {
  useTabsStore,
  effectiveTabLocation,
  remoteHostIdOf,
  type TabEntry,
} from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { shouldPersistTab } from "./tmuxSession";
import { IS_WINDOWS } from "./platform";

/**
 * The persistent host tmux session a tab owns, or `null` if the tab is not a
 * persistent remote session (a local tab, a non-shell tab, a persistence-off
 * project). An **attach** tab (opened from the Sessions view) owns the named
 * session it attached to; an ordinary persistent shell tab owns its stable minted
 * `tmuxSession`. `hostId` is resolved like `CenterPanel` (a tab naming a removed
 * worker falls back to the primary).
 */
export function persistentSessionOf(
  scope: string,
  tab: TabEntry,
): { session: string; hostId: string } | null {
  if (scope === "root") return null;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  if (!project?.remote) return null;
  const rawHostId = remoteHostIdOf(effectiveTabLocation(tab));
  if (rawHostId === null) return null; // a local-running tab has no host session
  const hostId =
    rawHostId !== "primary" && !project.compute_hosts?.some((h) => h.id === rawHostId)
      ? "primary"
      : rawHostId;
  // A Sessions-view attach tab owns exactly the (possibly foreign) name it attached to.
  if (tab.tmuxAttach) return { session: tab.tmuxAttach, hostId };
  if (!shouldPersistTab(tab.kind, hostId, project.remote) || !tab.tmuxSession) return null;
  return { session: tab.tmuxSession, hostId };
}

/**
 * The persistent **local** tmux session a tab owns, or `null`. Mirrors
 * `shouldPersistLocalTab`: a shell tab in a project scope running on the local
 * machine (a local project, or a remote project's local/mirror tab) with the
 * `persist_local_sessions` setting on — and never on Windows (no tmux).
 */
export function localPersistentSessionOf(scope: string, tab: TabEntry): string | null {
  if (scope === "root" || IS_WINDOWS) return null;
  if (tab.kind !== "shell" || !tab.tmuxSession) return null;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  const localRunning = !project?.remote || effectiveTabLocation(tab) === "local";
  if (!localRunning) return null;
  if (useSettingsStore.getState().settings?.persist_local_sessions === false) return null;
  return tab.tmuxSession;
}

/**
 * Close a tab from an explicit user action (the × button, the tab context menu).
 *
 * Closing a tab **detaches** — it never terminates the underlying tmux session.
 * `removeTab` unmounts the pane (killing only the ssh/PTY *client*), so a persistent
 * session — remote (on an SSH host) or local (on this machine) — keeps running under
 * its tmux daemon and stays discoverable + reattachable in the Sessions view. The one
 * way to actually terminate a session is its × (kill) in the Sessions view; a tab
 * close, a quit, a disconnect, and a crash all leave it alive. (This function stays a
 * seam — rather than inlining `removeTab` at the call sites — so a future confirm/hook
 * has one home, and so `persistentSessionOf` keeps a co-located reader.)
 */
export function closeTabWithConfirm(key: string): void {
  useTabsStore.getState().removeTab(key);
}
