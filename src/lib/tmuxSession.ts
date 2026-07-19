/**
 * Persistent remote sessions (TODO #85) — the frontend half of the tmux wrap.
 *
 * A remote shell/script tab can run inside a **tmux** session on the host, so a
 * long run survives an SSH drop, a laptop sleep, or Eldrun quitting: the session
 * keeps running and the tab reattaches on reconnect/relaunch. The backend
 * (`services::ssh_exec`) owns the actual wrap; these helpers decide *whether* a
 * tab persists and mirror the session-name derivation so the frontend can address
 * a session it did not just spawn (the Sessions view, the explicit-close kill).
 */

import type { RemoteSpec } from "../types";

/**
 * Mint a fresh, stable tmux session name for a shell tab. Minted **once** at tab
 * creation and **persisted** on the tab (`TabEntry.tmuxSession`), because the tab's
 * PTY id (`<scope>:<tab-key>`) is NOT stable — `loadFromLayout` regenerates the key
 * on every restart — so deriving the name from the id would create a *second*
 * session on relaunch instead of reattaching. A uuid is inherently tmux-safe
 * (`[0-9a-f-]`, no `:`/`.`), so it needs no sanitising.
 */
export function newTmuxSessionName(): string {
  return `eldrun-${crypto.randomUUID()}`;
}

/**
 * Whether persistent sessions are enabled for a remote project. **Default ON** —
 * `undefined`/`true` mean enabled; only an explicit `false` (the pill's toggle)
 * opts out. `undefined`/local projects → off (there is no host to persist on).
 */
export function persistSessionsEnabled(remote: RemoteSpec | undefined | null): boolean {
  return !!remote && remote.persist_sessions !== false;
}

/**
 * Whether THIS tab should be tmux-wrapped: a **shell** tab (interactive shells and
 * Python/script runs, which open a shell tab) running on a **remote host**
 * (`hostId` non-null) of a persist-enabled remote project. Agent tabs are excluded
 * — they resume via their own session — as are files/embed/monitor panes (no PTY).
 */
export function shouldPersistTab(
  kind: string,
  hostId: string | null,
  remote: RemoteSpec | undefined | null,
): boolean {
  return kind === "shell" && hostId !== null && persistSessionsEnabled(remote);
}

/**
 * Whether THIS tab should be tmux-wrapped **locally** (TODO #85): a **shell** tab
 * (interactive shells + Python/script runs) that runs on the **local machine** —
 * a local project's tab, or a remote project's local (mirror) tab — in a project
 * scope. `localEnabled` folds the `persist_local_sessions` setting **and** the
 * platform check (off on Windows, where there is no tmux). Keeps the run alive
 * across an Eldrun crash and reattaches on restart.
 */
export function shouldPersistLocalTab(
  kind: string,
  scopeKey: string,
  localRunning: boolean,
  localEnabled: boolean,
): boolean {
  return kind === "shell" && scopeKey !== "root" && localRunning && localEnabled;
}
