/**
 * Explicit close of a persistent remote tab (TODO #85).
 *
 * A remote shell/script tab can run inside a **tmux** session on the host, so the
 * run survives an SSH drop / laptop sleep / Eldrun quit. That makes *closing the
 * tab* the one genuinely destructive intent: unlike a quit or a disconnect (which
 * leave the session alive to reattach), an explicit close means "I'm done — end
 * the run." So closing such a tab confirms, then kills the host session before the
 * tab (and its ssh client) go away. The kill rides the pooled ControlMaster
 * (`remote_tmux_kill`), independent of the tab's own ssh channel, so it does not
 * race the pane-unmount `pty_kill`.
 *
 * Lives outside the stores because it reads BOTH the tabs and projects stores, and
 * `stores/projects` already imports `stores/tabs` — a store-level import back would
 * be a cycle.
 */

import { invoke } from "@tauri-apps/api/core";
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
 * If it owns a persistent tmux session — remote (on an SSH host) or local (on this
 * machine) — confirm and kill that session first; otherwise it is an ordinary
 * `removeTab`. Bulk closes deliberately do NOT route through here — they detach
 * (leave the session alive, discoverable in the Sessions view) rather than
 * terminate a run the user did not single out.
 */
export function closeTabWithConfirm(key: string): void {
  const tabsStore = useTabsStore.getState();
  const scope = tabsStore.scope;
  const tab = (tabsStore.tabsByScope[scope] ?? []).find((t) => t.key === key);
  const remote = tab ? persistentSessionOf(scope, tab) : null;
  const local = !remote && tab ? localPersistentSessionOf(scope, tab) : null;
  const session = remote?.session ?? local;
  if (session) {
    const where = remote ? "remote" : "local";
    const ok = window.confirm(
      `Close this tab and terminate the ${where} session “${session}”?\n\n` +
        `Any process running in it (e.g. a training run) will be stopped. To keep it ` +
        `running, leave the tab open — the session survives an Eldrun ${remote ? "quit, a disconnect, or a network drop" : "crash"}, ` +
        `and reattaches on restart.`,
    );
    if (!ok) return;
    if (remote) {
      invoke("remote_tmux_kill", {
        projectId: scope,
        hostId: remote.hostId,
        session: remote.session,
      }).catch(() => {});
    } else {
      invoke("local_tmux_kill", { session: local }).catch(() => {});
    }
  }
  tabsStore.removeTab(key);
}
