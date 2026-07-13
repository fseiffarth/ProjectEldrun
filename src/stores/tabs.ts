import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type AgentMode, withAgentMode } from "../components/tabs/agentModes";
import type { InternalViewer } from "../lib/viewers/fileUtils";
import type { AutocompleteMode } from "../types";
import { forgetPty } from "../lib/promptCount";
import { METRIC, agentMetricLeaf, sub } from "../lib/usageMetrics";
import { useLinkRoutingStore } from "./linkRouting";
import { bumpUsage } from "./usage";

export type TabKind =
  | "agent"
  | "local_agent"
  | "shell"
  | "files"
  | "embed"
  | "projects3d"
  | "network"
  | "monitor"
  | "diskusage"
  | "calendar";

/**
 * SSH-sync Phase 0 — a PTY tab's locality on a REMOTE (SSH) project: does it run
 * locally (in the project's local mirror) or on the host over `ssh -tt`? Only
 * meaningful for `agent`/`shell` tabs (see {@link isLocatableKind}); `local_agent`
 * is always local and non-PTY kinds have no locality. On a LOCAL project the axis
 * is inert (everything is local — the backend gates the ssh-wrap on remoteness).
 * Plan: docs/ssh_sync_plan.md.
 */
export type TabLocation = "local" | "remote";

export const FILES_TAB_CMD = "__eldrun_files__";

/**
 * Sentinel `cmd` for the 3D project-blob tab (root scope only): a navigable 3D
 * cloud of every project (active + inactive) and box. Carries no PTY — like the
 * files tab it's a pure-frontend pane, identified by this command so cmdToKind
 * can recover its kind from a bare command string.
 */
export const BLOB_TAB_CMD = "__eldrun_blob__";

/** Sentinel command for the read-only local/SSH host traffic dashboard. */
export const NETWORK_TAB_CMD = "__eldrun_network__";

/**
 * Sentinel `cmd` for the native htop-like system monitor tab: a read-only,
 * whole-machine process/CPU/memory view. Carries no PTY — like the network pane
 * it's identified by this command so cmdToKind can recover its kind on restore.
 */
export const MONITOR_TAB_CMD = "__eldrun_monitor__";

/**
 * Sentinel `cmd` for the native disk usage analyzer tab: a baobab-like rings/
 * treemap view of what is filling a folder. Carries no PTY — like the monitor pane
 * it is identified by this command so cmdToKind can recover its kind on restore.
 */
export const DISKUSAGE_TAB_CMD = "__eldrun_diskusage__";

/**
 * Sentinel `cmd` for the native calendar tab: a local, self-contained month-grid
 * event calendar, offered in every scope (root and each project). The event store
 * is global — one `calendar.json`, one zustand store — so every calendar tab shows
 * the same events regardless of the project it was opened from, and edits in one
 * are seen live by the others. Carries no PTY — like the files pane it's identified
 * by this command so cmdToKind can recover its kind.
 */
export const CALENDAR_TAB_CMD = "__eldrun_calendar__";

/**
 * Synthetic group id for the empty-state placeholder subwindow (rendered by
 * CenterPanel when a scope has no layout yet). It is NOT a real group in the
 * store — a drop onto it creates the first tab (addTab builds the root group).
 */
export const EMPTY_GROUP_ID = "__empty__";

/**
 * Persisted per-tab view state for the in-app file viewers, so reopening a file —
 * or restarting Eldrun — restores the reader where they left it instead of
 * jumping back to the top/default zoom. All fields optional; each viewer fills
 * the ones it has: scroll offset (text + PDF), zoom `scale` (PDF + image), and
 * pan `offsetX/offsetY` (image). Travels with the embed tab in project.json.
 */
export interface ViewerState {
  scrollTop?: number;
  scrollLeft?: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  // Tab-local editor text size (#48). When set it overrides the per-type
  // `viewer_prefs[type].font_size` default for THIS tab only, so zooming one
  // text/markdown/TeX tab no longer resizes every other viewer of that type;
  // absent means the tab tracks the per-type default. Survives reopen/restart.
  fontSize?: number;
  // Tab-local AI-assist overrides (#45). When set, they override the per-type
  // `viewer_prefs` default for THIS tab only; when absent the editor falls back
  // to the per-type setting. Toggled from the in-tab AI-assist controls.
  autocomplete?: boolean;
  autocompleteMode?: AutocompleteMode;
  grammarCheck?: boolean;
}

// Detached windows render their tabs from a Tauri-event SEED into local React
// state; those tabs never enter `useTabsStore` (the main window owns the layout
// store — see DetachedApp/jumpToSource). Viewer hooks seed their per-tab state
// (scroll/zoom + the #45 autocomplete/grammar overrides) from
// `useTabsStore`, so in a detached window that probe misses and the editor falls
// back to the per-type default — e.g. a per-tab autocomplete toggle silently
// reverts to off. This per-window registry lets those hooks recover a detached
// tab's seeded `viewerState` by key. Populated by DetachedApp from each seed;
// lives only in the detached window's heap (no-op/empty in the main window).
const detachedViewerState = new Map<string, ViewerState>();

/** Register (or clear, when `vs` is undefined) a detached tab's seeded
 *  `viewerState` so viewer hooks can read it when `useTabsStore` has no entry. */
export function setDetachedViewerState(key: string, vs: ViewerState | undefined): void {
  if (vs) detachedViewerState.set(key, vs);
  else detachedViewerState.delete(key);
}

/** A detached tab's seeded `viewerState`, or undefined. See {@link setDetachedViewerState}. */
export function getDetachedViewerState(key: string): ViewerState | undefined {
  return detachedViewerState.get(key);
}

/**
 * Fallback minimum subwindow (split pane) size in px a divider drag may shrink a
 * pane to, per axis, when `settings.min_subwindow_width/height` is unset. Mirrors
 * the Rust schema note on those fields (schema/settings.rs).
 */
export const DEFAULT_MIN_SUBWINDOW_PX = 120;

export interface TabEntry {
  key: string; // globally-unique within a scope; doubles as PTY id suffix
  // The scope (project id or "root") that owns this tab. Set at addTab /
  // loadFromLayout time so the project→tab binding is EXPLICIT rather than
  // positional. writeScope drops any tab whose scope differs from the map key it
  // is being written under, making a cross-project leak structurally impossible
  // (see #55). Optional for back-compat with tabs built directly in tests.
  scope?: string;
  label: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  kind: TabKind;
  // For agents that support a deterministic session id (currently Claude, via
  // `--session-id <uuid>`), the UUID Eldrun minted and launched the agent with.
  // Surfaced on tab hover and intended to later drive session resume.
  sessionId?: string;
  // For "embed" tabs (a file dragged from the FileTree onto a tab bar): the
  // absolute path of the embedded file and the resolved executable that opens
  // it. Phase 1 opens the file externally; Phase 2 will reparent the app's
  // window into the tab. External-app embeds are NOT persisted (they would
  // relaunch the app on restart) — only in-app `viewer` embeds are restored.
  embedPath?: string;
  embedExec?: string;
  // When set, the embed tab renders the file in-app with a built-in viewer
  // (pdf/image/markdown/text/tex) instead of opening it externally — independent
  // of any external default app. These embeds re-render from `embedPath` on
  // relaunch (see isRestorableEmbedTab). See FileViewerPane.
  viewer?: InternalViewer;
  // For in-app `viewer` embeds: the reader's last scroll/zoom/pan, so reopening
  // the file (or restarting) restores the position instead of jumping to the top
  // (see ViewerState). Written by the viewer panes, persisted in project.json.
  viewerState?: ViewerState;
  // SSH-sync Phase 0: for `agent`/`shell` tabs on a remote project, whether this
  // tab runs locally (in the mirror) or on the host. Absent → the per-kind
  // default (agents local, shells remote — see effectiveTabLocation). Inert on a
  // local project. Persisted so the choice survives a restart.
  location?: TabLocation;
  // The tab's agent authority mode — the planner/doer split ("plan" proposes,
  // "auto" auto-accepts edits). Only meaningful for agents in the capability
  // table (currently Claude; see components/tabs/agentModes.ts) and only
  // surfaced when the experimental `agent_mode_toggle` setting is on. Absent →
  // no mode flag is passed and the agent runs in its own default (ask each
  // time), which is the behaviour of every tab predating this feature. The mode
  // rides in `args` as `--permission-mode <x>`; this field is the durable record
  // of it, since `args` are rebuilt from scratch on restore (loadFromLayout).
  agentMode?: AgentMode;
}

export type SplitDir = "row" | "column";
// "row"    = children laid out left-to-right, vertical dividers
// "column" = children stacked top-to-bottom, horizontal dividers

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[]; // length >= 2
  sizes: number[]; // fractions in (0,1), sum ~= 1, length === children.length
}

export interface GroupNode {
  type: "group";
  id: string;
  tabKeys: string[]; // order shown in this subwindow's tab bar
  activeKey: string | null; // active tab within this group
}

export type LayoutNode = SplitNode | GroupNode;

/**
 * #42: a detached popout window's last-known OS geometry, in physical pixels.
 * Streamed back from the window and persisted so a popout reopens where the user
 * left it after a restart.
 */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * #42: a tab group that has been popped out of the in-window layout tree into
 * its own detached OS window. The group's tab PAYLOADS stay in `tabsByScope`
 * (so PTYs never unmount and #55 scope-binding still holds) — only its
 * arrangement leaves `layoutByScope` and lives here. `label` is the Tauri window
 * label the backend keyed the detached `WebviewWindow` / `TrackedWindow` under,
 * used to close it on dock-back. v1 detaches exactly one `GroupNode` (not an
 * arbitrary split subtree), keeping the re-attach merge math simple.
 */
export interface DetachedGroup {
  id: string; // the detached popout's identity (window/registry label key)
  // The popout's layout. Usually a single GroupNode, but can be a SplitNode once
  // the user splits panes inside the popout (multi-pane popouts). The root node's
  // id need NOT equal `id` — `id` identifies the OS window, the subtree is its
  // content.
  subtree: LayoutNode;
  label: string; // backend window/registry label
  // Last-known OS geometry of the popout, streamed back by the window. Persisted
  // (via the saved tree) so the popout reopens at the same place/size on restart.
  bounds?: WindowBounds;
}

/**
 * A tab group that has been HIDDEN from the in-window layout tree. Mechanically
 * this is "detach minus the OS window": the group's node leaves
 * `layoutByScope[scope]` while its tab PAYLOADS stay in `tabsByScope` (so PTYs
 * never unmount — `CenterPanel`'s flat pane layer keeps them mounted but
 * `display:none`, since no live layout node references their keys). The user
 * brings it back from the right-panel Hidden list (`unhideGroup`). Unlike a
 * detached popout there is no OS window and thus no `bounds`/`label` handoff.
 */
export interface HiddenGroup {
  id: string; // the hidden group's identity (the original group's id)
  // The hidden subtree. Usually a single GroupNode, but can be a SplitNode when
  // a multi-pane split was hidden whole.
  subtree: LayoutNode;
  label: string; // debug/label tag, mirrors DetachedGroup.label
}

/**
 * The edit shape a detached window streams back. Defined here (not imported from
 * `detached.ts`) so `tabs.ts` stays free of a circular import; `detached.ts`'s
 * `DetachedEdit` is structurally identical.
 */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type DetachedEditPayload =
  | { kind: "activate"; key: string }
  | { kind: "rename"; key: string; label: string }
  | { kind: "close"; key: string }
  | { kind: "reorder"; tabKeys: string[] }
  // Multi-pane popouts: split `key` out into a new pane at `edge` of
  // `targetGroupId` (a group within the popout's subtree).
  | { kind: "split"; key: string; targetGroupId: string; edge: DropEdge }
  // Multi-pane popouts: resize the divider between children `dividerIndex`/
  // `dividerIndex+1` of the split `splitId` within the popout's subtree.
  | { kind: "resize"; splitId: string; dividerIndex: number; fraction: number }
  // Multi-pane popouts: move `key` into `targetGroupId` (at `index`, else append),
  // merging it across the popout's groups (collapses an emptied source pane).
  | { kind: "move"; key: string; targetGroupId: string; index?: number };

/** Flat tab shape as persisted in project.json's `tab_layout`. */
export interface SavedTabEntry {
  key: string;
  label: string;
  cmd: string;
  cwd: string;
  kind?: TabKind;
  type?: string;
  env?: Record<string, string>;
  sessionId?: string;
  // For restorable in-app "embed" tabs (a file dragged from the FileTree onto a
  // tab bar that renders via a built-in `viewer`): the absolute file path and
  // the viewer to re-render it with on restart. Only `viewer` embeds are
  // persisted; external-app embeds are dropped (see isRestorableEmbedTab).
  embedPath?: string;
  embedExec?: string;
  viewer?: InternalViewer;
  // Persisted reader position (scroll/zoom/pan) for in-app viewer embeds.
  viewerState?: ViewerState;
  // SSH-sync Phase 0: persisted per-tab local/remote locality (see TabEntry).
  location?: TabLocation;
  // Persisted planner/doer mode (see TabEntry.agentMode). Re-applied to the
  // launch args on restore, so a tab comes back in the mode it was left in.
  agentMode?: AgentMode;
}

/** Serialized layout tree as persisted in project.json's `tab_groups`. */
export type SavedLayoutTree =
  | {
      type: "split";
      dir: SplitDir;
      children: SavedLayoutTree[];
      sizes: number[];
      // #42: a MULTI-PANE popout's content is a split, so the detached tag can sit
      // on a split node too — restore re-opens the whole split subtree as one
      // floating popout (see withDetachedDocked / deserializeTree / detachGroup).
      detached?: boolean;
      bounds?: WindowBounds;
      // When true, this split subtree was HIDDEN (parked out of the tiled layout).
      // Persisted as a docked node so its tabs survive, but tagged so restore
      // routes it back into `hiddenGroupsByScope` instead of the live tree.
      // See withHiddenDocked / deserializeTree / loadFromLayout.
      hidden?: boolean;
    }
  | {
      type: "group";
      tabKeys: string[];
      activeKey: string | null;
      // #42: when true, this group was popped out into its own OS window. It is
      // persisted as a normal docked group (so the tabs survive even if respawn
      // is disabled) but tagged so restore can re-open it as a floating popout
      // at `bounds` instead of docking it. See withDetachedDocked / loadFromLayout.
      detached?: boolean;
      bounds?: WindowBounds;
      // When true, this group was HIDDEN (see the split variant's note). Restore
      // moves it into `hiddenGroupsByScope` rather than docking it live.
      hidden?: boolean;
    };

/**
 * Persist-ready snapshot of a scope's tabs + layout for a project switch,
 * produced by `snapshotScopeForSwitch`. `tabs` are the scope-owned, restorable
 * tab payloads (in tree order); `tabGroups` is the pruned, detached-docked
 * serialized layout tree; `activeTabIndex` indexes the active tab within `tabs`.
 */
export interface ScopeSwitchSnapshot {
  tabs: TabEntry[];
  tabGroups: SavedLayoutTree | null;
  activeTabIndex: number;
}

interface TabsStore {
  scope: string;

  // source of truth for tab payloads
  tabsByScope: Record<string, TabEntry[]>;
  // arrangement; root is always present once a scope has >=1 tab
  layoutByScope: Record<string, LayoutNode | null>;
  // which group is focused (its active tab is the "globally active" one)
  focusedGroupByScope: Record<string, string | null>;
  // #42: per-scope groups that have been popped out into detached OS windows.
  // Their tab payloads still live in `tabsByScope[scope]`; only their layout
  // node has left `layoutByScope[scope]`.
  detachedGroupsByScope: Record<string, DetachedGroup[]>;
  // Per-scope groups the user has HIDDEN (parked out of the tiled layout while
  // keeping their tabs/PTYs alive — detach minus the OS window). Like the
  // detached map, the payloads stay in `tabsByScope[scope]`; only the layout
  // node lives here. Surfaced by the right-panel Hidden list; restored via
  // `unhideGroup`. Persists across restart via the SavedLayoutTree `hidden` tag.
  hiddenGroupsByScope: Record<string, HiddenGroup[]>;
  // #42: per-scope groups that were detached when the scope was last saved and
  // must be re-opened as floating popouts once the scope's layout is live and its
  // panes (PTYs) have mounted. Populated by loadFromLayout, drained by
  // consumePendingRespawn (driven from CenterPanel after the panes render).
  pendingRespawnByScope: Record<string, RespawnTarget[]>;

  // flat mirrors of the CURRENT scope (kept for ergonomic consumers / tests)
  tabs: TabEntry[];
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  activeKey: string | null; // = active tab of the focused group

  // #62: app-internal fullscreen — when set, CenterPanel renders only this
  // group's body full-bleed (panes stay mounted; this just repositions). Cleared
  // on Escape, when the group vanishes, or by toggling the same group again.
  fullscreenGroupId: string | null;
  toggleFullscreen: (groupId: string | null) => void;

  setScope: (scope: string) => void;

  // focus / activation
  focusGroup: (groupId: string) => void;
  setActive: (key: string) => void; // activate tab + focus its group
  setGroupActive: (groupId: string, key: string) => void;

  // tab lifecycle
  // `seeded` marks a tab Eldrun opened by itself rather than one the user asked
  // for (the root scope's default 3D-blob tab). Such a tab must not be counted as
  // a tab the user opened — see `countTabOpen`.
  addTab: (tab: Omit<TabEntry, "key">, opts?: { seeded?: boolean }) => TabEntry; // into focused group
  // Add a tab into a SPECIFIC scope's focused group, regardless of which scope is
  // currently active. Used to surface remote SSH/OpenVPN connections in the root
  // scope without disturbing the active project. When `scope` is the current
  // scope this behaves exactly like `addTab`; otherwise the tab is written into
  // that scope's maps only (the user sees it after switching to it).
  addTabToScope: (scope: string, tab: Omit<TabEntry, "key">) => TabEntry;
  ensureTab: (
    tab: Omit<TabEntry, "key">,
    matches: (tab: TabEntry) => boolean,
  ) => TabEntry;
  renameTab: (key: string, label: string) => void;
  // Rewrite the embedPath (and label) of every in-app "embed" tab in the CURRENT
  // scope whose file was renamed/moved on disk — an exact match (`embedPath ===
  // oldAbs`) or, for a directory rename/move, any tab UNDER it (`embedPath`
  // starts with `oldAbs + "/"`, prefix-swapped to `newAbs`). Payload-only (keys
  // unchanged), so the main CenterPanel re-renders from the store and the updated
  // payloads are what a subsequent reseed ships to any detached popout. On an
  // exact match the label is refreshed to the new basename only when it still
  // equals the old basename (so a user-renamed tab keeps its label). No-op when
  // nothing matches. Delete/rename tab-sync lives in components/files/fileTabSync.
  /**
   * Re-point a project's tabs after it is detached from its SSH host, moving every cwd
   * out of the old remote-project state dir and into the promoted mirror.
   *
   * This is not cosmetic; without it a detach silently breaks every agent tab. While a
   * project is remote its `directory` is the **state dir**
   * (`~/.local/share/eldrun/remote-projects/<id>/`), and `loadFromLayout` stores exactly
   * that as each tab's `cwd` (agents unconditionally, others via `t.cwd || defaultCwd`).
   * Nothing noticed, because `localTabCwd` overrode it at render time to the real mirror —
   * an override gated on `isRemoteProject`. Detach flips that to false, the override stops
   * firing, and every tab falls back to the stored cwd it never should have had: the state
   * dir. Agents then launch inside `~/.local/share/eldrun/remote-projects/<id>/` — a
   * directory that detach has just emptied — so Claude asks for permissions there and
   * `--resume` finds no session, because Claude keys its history by cwd and the whole
   * conversation lives under the mirror's path instead.
   *
   * Host-located tabs are converted to local too: their cwd is a path on a machine this
   * project is no longer attached to.
   */
  detachScopeFromRemote: (scope: string, oldDir: string, newDir: string) => void;
  retargetTabs: (oldAbs: string, newAbs: string) => void;
  removeTab: (key: string) => void; // drop; collapse empty groups/splits
  closeGroup: (groupId: string) => void; // close a whole subwindow; siblings resize
  // Close EVERY tab/subwindow in a scope (defaults to the current scope),
  // leaving it empty (null layout → the +-placeholder). Each pane unmounts, so
  // its PTY dies. Non-current scopes are cleared in memory only; persist
  // explicitly at the call site if the scope isn't the active project.
  closeAllTabs: (scope?: string) => void;
  updateTabEnv: (key: string, env: Record<string, string>) => void;
  // SSH-sync Phase 0: set a tab's local/remote locality (agent/shell tabs on a
  // remote project). No-op when unchanged. The CenterPanel's localOnly/cwd
  // computation reads the result so the next mount spawns on the chosen side.
  setTabLocation: (key: string, location: TabLocation) => void;
  // Set an agent tab's planner/doer mode. Rewrites the tab's launch args, which
  // respawns its PTY (TerminalView's spawn effect keys on the args) — the agent
  // comes back on the same conversation via the backend's resume rewrite. No-op
  // when unchanged, or for an agent with no mode support.
  setAgentMode: (key: string, mode: AgentMode) => void;
  // Merge a patch into an embed tab's persisted viewer position (scroll/zoom/
  // pan). The viewer panes call this as the reader scrolls/zooms; the debounced
  // saveLayout effect then flushes it to project.json (see ViewerState).
  setViewerState: (key: string, patch: ViewerState) => void;

  // arrangement
  reorderInGroup: (groupId: string, from: number, to: number) => void;
  moveTab: (key: string, targetGroupId: string, index?: number) => void;
  splitWithTab: (key: string, targetGroupId: string, edge: DropEdge) => void;
  // Create a brand-new tab in a fresh group split off the target at `edge`
  // (or, for "center", added into the target group). Used by file drops from the
  // right panel to spawn a new subwindow holding the file directly. Returns the
  // created tab, or null if the target group no longer exists.
  splitWithNewTab: (
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
    edge: DropEdge,
  ) => TabEntry | null;
  resizeSplit: (splitId: string, dividerIndex: number, fraction: number) => void;

  // #42: detach / re-attach a subwindow (group) to/from its own OS window.
  // `detachGroup` removes the group from the in-window tree, records it in
  // `detachedGroupsByScope`, and (unless `skipBackend`) spawns the detached
  // OS window via the `detach_subwindow` command. Refuses to detach the lone
  // group (can't empty the in-window layout) UNLESS `allowLastGroup` is set —
  // used by the restart respawn path, where a popout may be the only group left
  // (its in-window siblings held only non-restorable tabs) yet must still re-open
  // as its own window, leaving the main center empty. Returns the detached
  // group's label, or null if refused / not found.
  detachGroup: (
    groupId: string,
    opts?: { skipBackend?: boolean; bounds?: WindowBounds; allowLastGroup?: boolean },
  ) => string | null;
  // Drag-a-tab-to-another-monitor: pop a SINGLE existing tab out of the in-window
  // layout into its own fresh detached OS window at `bounds` (screen px). Unlike
  // detachGroup (which moves a whole subwindow and refuses the lone group), this
  // is per-tab and never refuses: the tab is removed from its current group and
  // seeded into a brand-new single-tab detached group, even if that empties the
  // main center (which then shows the placeholder). Returns the window label, or
  // null if the tab/scope can't be resolved.
  detachTab: (key: string, bounds: WindowBounds) => string | null;
  // Drag-a-file-to-another-monitor: mint a brand-new tab (e.g. an embed/viewer
  // tab for a file dropped outside the window) straight into its own fresh
  // detached OS window at `bounds`, without ever touching the in-window layout.
  // Returns the window label.
  detachNewTab: (tab: Omit<TabEntry, "key">, bounds: WindowBounds) => string;
  // `attachGroup` pops the detached entry, regenerates its ids, re-injects it
  // (adjacent to `targetGroupId`/`edge`, or as root if the tree is empty), and
  // (unless `skipBackend`) closes the detached OS window via `attach_subwindow`.
  attachGroup: (
    detachedId: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // Hide a subwindow (group) from the tiled layout without killing it: strips its
  // node from `layoutByScope`, keeps its tab payloads in `tabsByScope` (PTYs stay
  // mounted-but-hidden), and parks the subtree in `hiddenGroupsByScope`. Unlike
  // `detachGroup` it allows hiding the LAST group (the scope then shows the
  // +-placeholder) and spawns no OS window. No-op if the group isn't found.
  hideGroup: (groupId: string) => void;
  // Restore a hidden group into the live layout (the reverse of `hideGroup`,
  // modeled on `attachGroup`): regenerates the subtree's ids, injects it as a new
  // pane (or as the root if the layout emptied), drops the hidden record, and
  // focuses it. `opts.activeKey` restores it focused on a specific tab (tab-chip
  // click in the Hidden list). No-op if the hidden entry is gone.
  unhideGroup: (hiddenId: string, opts?: { activeKey?: string }) => void;
  // Permanently close a hidden group: drops the hidden record AND its tab
  // payloads from `tabsByScope` (killing the PTYs, mirroring `closeGroup`). Used
  // by the ✕ on a Hidden-list row. No-op if the hidden entry is gone.
  closeHiddenGroup: (hiddenId: string) => void;
  // #42: dock a SINGLE tab out of a popout back into a scope's layout (the
  // per-tab analog of attachGroup, used when one tab — not the whole group — is
  // dragged onto the main window). Inserts the tab at `targetGroupId`/`edge`
  // (center merges, an edge splits) or as a default placement, removes it from
  // the detached group's subtree, and — if that empties the popout — drops the
  // detached record and closes its OS window. The tab payload already lives in
  // `tabsByScope`, so it survives the move. Works for the active scope (live
  // layout) and an inactive one (stored layout). No-op if the tab/group is gone.
  attachDetachedTab: (
    scope: string,
    detachedGroupId: string,
    tabKey: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // #42: pop a SINGLE tab OUT of an existing detached popout into its OWN brand
  // new detached OS window (the popout analog of TabBar's `popToNewWindow`),
  // fired when a tab dragged out of a popout is released in FREE SPACE — outside
  // both the main window and the popout. Removes `tabKey` from the source
  // popout's subtree and records a fresh single-tab detached entry at `bounds`,
  // then spawns its OS window. The tab payload stays in `tabsByScope[scope]`
  // (shared), so the new popout self-seeds and the PTY never dies. No-ops
  // (returns null) when the source/tab is gone OR when removing the tab would
  // empty the source popout — a lone-tab popout dragged whole is already its own
  // window, so re-detaching it would be needless churn. Returns the new label.
  detachTabToNewWindow: (
    scope: string,
    fromGroupId: string,
    tabKey: string,
    bounds: WindowBounds,
  ) => string | null;
  // #42 (main → detached): dock a SINGLE existing in-window tab INTO an already
  // open detached popout's group — the inverse of `attachDetachedTab`, fired when
  // a tab dragged out of the main window is released over a popout (so no new OS
  // window opens). Removes the tab from its source group in `scope`'s in-window
  // layout (its payload STAYS in `tabsByScope`, so the PTY never dies: the main
  // keeps the pane mounted-but-hidden and the popout re-attaches to it), appends
  // it to the detached group's subtree, and activates it there. The caller
  // re-seeds the popout so the new tab renders. No-op if the tab or detached
  // group is gone.
  dockTabIntoDetached: (
    scope: string,
    detachedGroupId: string,
    tabKey: string,
    // #42: where inside the popout to place the tab — a specific pane resolved
    // from the cursor (a body edge splits, center/a bar slot merges into that
    // group). Omitted → append to the popout's first pane (legacy behaviour).
    target?: DetachedDockTarget,
  ) => void;
  // #42 (detached → detached): move a SINGLE tab from one open popout INTO another
  // open popout of the SAME scope — fired when a tab dragged out of popout A is
  // released over popout B. Removes `tabKey` from the source popout's subtree
  // (dropping the source record + closing its OS window when it empties, mirroring
  // `attachDetachedTab`) and places it into the destination popout's subtree at
  // `target`. The payload STAYS in `tabsByScope` (shared), so the PTY the MAIN
  // window owns never dies and both popouts re-attach to it after the re-seed.
  // No-op if either popout is gone, the tab is absent from the source, or it is
  // already in the destination.
  moveTabBetweenDetached: (
    scope: string,
    fromGroupId: string,
    toGroupId: string,
    tabKey: string,
    target?: DetachedDockTarget,
    opts?: { skipBackend?: boolean },
  ) => void;
  // #42: apply an edit streamed back from a detached window to the main store's
  // record of that detached group (its subtree node + tab payloads). Keeps the
  // main window — the single persistence owner — in sync with the detached one.
  applyDetachedEdit: (
    scope: string,
    groupId: string,
    edit: DetachedEditPayload,
  ) => void;
  // #42: create a NEW tab inside a detached popout, from its own "+" menu. The
  // main window mints the key + owns the PTY, so this appends the payload to
  // `tabsByScope[scope]` (spawning its pane in the main window's flat pane layer)
  // and inserts the key into `targetGroupId` within the popout's subtree,
  // activating it. Returns the minted key (or null if the popout/group is gone),
  // so the caller can re-seed the popout to render + attach to the new tab.
  addDetachedTab: (
    scope: string,
    detachedGroupId: string,
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
  ) => string | null;
  // Multi-pane popouts: split a tab inside a detached popout's own subtree,
  // carving a new pane at `edge` of `targetGroupId` (a group WITHIN the
  // popout's subtree). Mirrors `splitWithTab` but mutates
  // `detachedGroupsByScope[scope][i].subtree` instead of the in-window layout.
  // The caller re-seeds the popout so it re-renders the new split.
  splitDetachedGroup: (
    scope: string,
    detachedGroupId: string,
    key: string,
    targetGroupId: string,
    edge: DropEdge,
  ) => void;
  // #42: dock-back for a group whose scope is NOT active. We re-inject the
  // detached subtree into that scope's STORED layout (`layoutByScope[scope]`,
  // not the live `layout`) so its tabs remain referenced by a layout node and
  // persist normally, then drop the detached record. The detached OS window is
  // closed via `attach_subwindow`. Used by the host's cross-scope
  // `DETACHED_DOCK` path; the active-scope path goes through `attachGroup`.
  dropDetachedGroup: (scope: string, groupId: string) => void;
  // #42: WM-close of a popout closes its tabs for good instead of docking them
  // back: kills each tab's PTY (the popout's panes are NOT mounted in the main
  // window and the detached viewer is attach-only, so nothing else tears them
  // down), drops their payloads from `tabsByScope`, and drops the detached
  // record. It does NOT re-inject the subtree into any layout, so the tabs are
  // gone — persist the scope afterwards (persistScope) so disk agrees and they
  // don't restore on next launch. Closes the OS window via `attach_subwindow`.
  closeDetachedGroup: (scope: string, groupId: string) => void;
  // #42: record a popout's latest OS geometry (streamed back from the window) so
  // it persists and the popout reopens where the user left it after a restart.
  setDetachedBounds: (scope: string, groupId: string, bounds: WindowBounds) => void;
  // #42: return and clear the scope's pending respawn targets (groups that were
  // detached at save time). Caller re-opens each via detachGroup once its pane
  // has mounted. Returns [] when there is nothing to respawn.
  consumePendingRespawn: (scope: string) => RespawnTarget[];

  // Struct #3 / Eff #13: produce the persist-ready snapshot of a scope's tabs +
  // layout for a project switch, WITHOUT the caller reaching into the store's
  // internal maps + tree helpers. Encapsulates the #55 ownership filter, the
  // restorable filter, the detached-group re-dock, and the prune-to-kept-keys —
  // the logic projects.ts used to inline by importing serializeTree /
  // pruneSavedTree / withDetachedDocked / allGroups / findGroup and grabbing
  // `getState()` directly. Pure read (no mutation); single tree walk for the
  // active-key resolution.
  snapshotScopeForSwitch: (scope: string) => ScopeSwitchSnapshot;

  // persistence
  loadFromLayout: (
    layout: SavedTabEntry[],
    defaultCwd: string,
    targetScope?: string,
    groups?: SavedLayoutTree,
  ) => void;
  // Persist an explicit scope's tabs+layout (incl. its detached groups) to its
  // project.json. `saveLayout` is the current-scope convenience over this; the
  // detached-close host path uses it to write a parked (non-active) scope, which
  // CenterPanel's current-scope save would otherwise never touch.
  persistScope: (scope: string, localFile: string) => Promise<void>;
  saveLayout: (localFile: string) => Promise<void>;
}

/**
 * Count a tab open for the usage recap.
 *
 * Deliberately here rather than at the backend's `pty_spawn`: that fires again
 * for every resumable agent tab respawned on relaunch, so counting there would
 * report a fresh "agent tab opened" each morning for tabs opened days ago.
 * `loadFromLayout` builds restored tabs directly and never calls `addTab`, so
 * these entry points see only tabs a person actually opened — with one exception,
 * the root scope's auto-seeded 3D-blob tab, which opts out via `{ seeded: true }`.
 */
function countTabOpen(scope: string, tab: TabEntry) {
  bumpUsage(scope, METRIC.TAB_OPENED);
  const agent = agentMetricLeaf(tab);
  if (agent) bumpUsage(scope, sub(agent.prefix, agent.leaf));
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

let _nodeCounter = 0;
function nextGroupId() {
  return `g-${++_nodeCounter}`;
}
function nextSplitId() {
  return `s-${++_nodeCounter}`;
}

// ── Pure tree helpers ───────────────────────────────────────────────────────

/** Find a group node by id anywhere in the tree. */
export function findGroup(node: LayoutNode | null, id: string): GroupNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
  return null;
}

/** Find a SPLIT node by id anywhere in the tree (#42: a multi-pane popout's root
 *  is a split, so its respawn detaches the whole split subtree by this id). */
export function findSplit(node: LayoutNode | null, id: string): SplitNode | null {
  if (!node || node.type !== "split") return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findSplit(child, id);
    if (found) return found;
  }
  return null;
}

/** Remove the subtree rooted at `id` (a group OR split) from `node`, collapsing
 *  single-child splits that result. Returns the remaining tree (null if it
 *  empties). Used to pop a whole multi-pane popout out of the in-window layout. */
export function removeNodeById(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.id === id) return null;
  if (node.type === "group") return node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const r = removeNodeById(child, id);
    if (r) {
      kept.push(r);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) };
}

/** Find the group that currently holds `key` (and the key's index in it). */
export function findGroupOfTab(
  node: LayoutNode | null,
  key: string,
): { group: GroupNode; index: number } | null {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.tabKeys.indexOf(key);
    return index >= 0 ? { group: node, index } : null;
  }
  for (const child of node.children) {
    const found = findGroupOfTab(child, key);
    if (found) return found;
  }
  return null;
}

/** All group nodes in document order. */
export function allGroups(node: LayoutNode | null): GroupNode[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

/** Flat list of all tab keys, in stable left-to-right tree order. */
export function orderedTabKeys(node: LayoutNode | null): string[] {
  return allGroups(node).flatMap((g) => g.tabKeys);
}

/** Remove a tab key from whichever group holds it within a subtree, collapsing
 *  an emptied group / lone-child split. Returns the new (possibly null) subtree;
 *  returns the input unchanged if the key isn't present. Used by the detached
 *  subtree mutators, which (post-split) operate on a LayoutNode, not a single
 *  group. */
export function removeKeyFromTree(node: LayoutNode, key: string): LayoutNode | null {
  const found = findGroupOfTab(node, key);
  if (!found) return node;
  const removed = mapGroup(node, found.group.id, (g) => {
    const tabKeys = g.tabKeys.filter((k) => k !== key);
    return {
      ...g,
      tabKeys,
      activeKey: g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey,
    };
  });
  return collapse(removed);
}

/** Append a tab key to a subtree's FIRST group (depth-first) and activate it
 *  there. Mirrors the single-group append for a tree subtree. */
function appendKeyToTree(node: LayoutNode, key: string): LayoutNode {
  const g = firstGroup(node);
  return mapGroup(node, g.id, (grp) => ({
    ...grp,
    tabKeys: [...grp.tabKeys, key],
    activeKey: key,
  }));
}

/**
 * #42: where to place a NEW key inside a detached popout's subtree when docking a
 * tab/file INTO it from another window. `edge` carves a new pane at that side of
 * the target group (center merges into it); `index` inserts into the target
 * group's bar at that slot. Mirrors the within-popout drop semantics.
 */
export type DetachedDockTarget =
  | { groupId: string; edge: DropEdge }
  | { groupId: string; index: number };

/** Place a NEW key into a subtree at `target` (or the first group when no target,
 *  matching the legacy append). A non-center edge splits off a new pane beside the
 *  target group; center / a bar slot inserts into the target group. Falls back to
 *  an append when the target group is gone. Pure; activates the key. */
function placeKeyInTree(
  node: LayoutNode,
  key: string,
  target?: DetachedDockTarget,
): LayoutNode {
  if (!target || !findGroup(node, target.groupId)) return appendKeyToTree(node, key);
  if ("index" in target) {
    return mapGroup(node, target.groupId, (g) => {
      const at = Math.min(Math.max(target.index, 0), g.tabKeys.length);
      const tabKeys = [...g.tabKeys];
      tabKeys.splice(at, 0, key);
      return { ...g, tabKeys, activeKey: key };
    });
  }
  if (target.edge === "center") {
    return mapGroup(node, target.groupId, (g) => ({
      ...g,
      tabKeys: [...g.tabKeys, key],
      activeKey: key,
    }));
  }
  const newGroup: GroupNode = { type: "group", id: nextGroupId(), tabKeys: [key], activeKey: key };
  const dir: SplitDir = target.edge === "left" || target.edge === "right" ? "row" : "column";
  const before = target.edge === "left" || target.edge === "top";
  return insertAdjacent(node, target.groupId, newGroup, dir, before);
}

/** Move `key` out of its current group into `targetGroupId` at `index` (append
 *  when `index` is undefined), activating it there. Collapses the source group /
 *  lone-child split if the move empties it — so dragging a split pane's only tab
 *  onto the other pane's bar merges the two panes back into one. Pure; used by a
 *  detached popout to merge a tab across its own groups. Returns the input
 *  unchanged when the key isn't present, or null if removal empties the tree
 *  (can't happen for a cross-group move, which always leaves the target).
 *  No-ops (returns the input) when the target is the key's own group — that case
 *  is a within-group reorder, handled elsewhere. */
export function moveKeyInTree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  index?: number,
): LayoutNode | null {
  const source = findGroupOfTab(node, key);
  if (!source) return node;
  if (source.group.id === targetGroupId) return node;
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned) return null;
  // The target survives the removal (it's non-empty); bail if it somehow doesn't.
  if (!findGroup(cleaned, targetGroupId)) return node;
  return mapGroup(cleaned, targetGroupId, (g) => {
    const tabKeys = [...g.tabKeys];
    const at = index == null ? tabKeys.length : Math.min(Math.max(index, 0), tabKeys.length);
    tabKeys.splice(at, 0, key);
    return { ...g, tabKeys, activeKey: key };
  });
}

/** Split `key` out of its group into a new pane at `edge` of `targetGroupId`,
 *  within `node`. Pure; mirrors `splitWithTab`'s algorithm but on an arbitrary
 *  subtree so the in-window layout AND a detached popout's subtree share it.
 *  Returns the new subtree, or null if the split is a no-op / invalid. */
export function splitSubtree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  edge: DropEdge,
): LayoutNode | null {
  if (edge === "center") return null; // center merges, it isn't a split
  const source = findGroupOfTab(node, key);
  const target = findGroup(node, targetGroupId);
  if (!source || !target) return null;
  // Dropping a group's only tab onto its own edge would remove then re-add it.
  if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
    return null;
  }
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned || !findGroup(cleaned, targetGroupId)) return null;
  const newGroup: GroupNode = {
    type: "group",
    id: nextGroupId(),
    tabKeys: [key],
    activeKey: key,
  };
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  return insertAdjacent(cleaned, targetGroupId, newGroup, dir, before);
}

export type NavDirection = "left" | "right" | "up" | "down";

/** The split axis a direction navigates along ("row" = horizontal). */
function axisOf(dir: NavDirection): SplitDir {
  return dir === "left" || dir === "right" ? "row" : "column";
}

/**
 * Build the path of nodes from the root down to (and including) the group `id`.
 * Returns null if the group isn't in the tree.
 */
function pathToGroup(node: LayoutNode, id: string): LayoutNode[] | null {
  if (node.type === "group") return node.id === id ? [node] : null;
  for (const child of node.children) {
    const sub = pathToGroup(child, id);
    if (sub) return [node, ...sub];
  }
  return null;
}

/** The first group reached by descending `node` (depth-first, left-to-right). */
function firstGroup(node: LayoutNode): GroupNode {
  let cur = node;
  while (cur.type === "split") cur = cur.children[0];
  return cur;
}

/**
 * #62: the id of the subwindow (group) lying in `dir` from `fromGroupId`, by
 * walking the layout TREE (not pixel geometry) — find the nearest ancestor split
 * whose axis matches `dir`, then step to the adjacent child on that side and
 * descend to its first group. Returns null at an edge (no neighbour that way).
 * Pure: takes the tree, returns an id or null.
 */
export function neighborGroup(
  layout: LayoutNode | null,
  fromGroupId: string,
  dir: NavDirection,
): string | null {
  if (!layout) return null;
  const path = pathToGroup(layout, fromGroupId);
  if (!path) return null;
  const wantAxis = axisOf(dir);
  const towardNext = dir === "right" || dir === "down";
  // Walk up from the group: at each split ancestor on the matching axis, try to
  // step to the adjacent child in the requested direction.
  for (let i = path.length - 2; i >= 0; i--) {
    const split = path[i];
    if (split.type !== "split" || split.dir !== wantAxis) continue;
    const childIdx = split.children.indexOf(path[i + 1]);
    const nextIdx = towardNext ? childIdx + 1 : childIdx - 1;
    if (nextIdx >= 0 && nextIdx < split.children.length) {
      return firstGroup(split.children[nextIdx]).id;
    }
  }
  return null;
}

/**
 * Collapse a tree bottom-up:
 *  - a split with a single remaining child is replaced by that child;
 *  - empty groups inside a split are dropped (a lone empty root group is kept
 *    so an empty scope still has a root container, but callers may pass null).
 * Returns the new (possibly null) root.
 */
function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    return node;
  }
  // Recurse, drop emptied groups / null children.
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = collapse(child);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Renormalize sizes to sum to 1.
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return {
    ...node,
    children,
    sizes: sizes.map((s) => s / total),
  };
}

/**
 * Eff #5: prune-to-keys + collapse in a SINGLE bottom-up pass, also collecting
 * every surviving group into `groupsOut` (in document order) so `writeScope`
 * doesn't re-walk the tree to refind its focus / active / fullscreen groups.
 * Replaces the former `pruneLayoutToKeys` → `collapse` → repeated
 * `findGroup`/`allGroups` walks (4–5 traversals per mutation, one pass now).
 *
 * Behaviour matches running prune-to-keys then collapse: a group keeps only keys
 * in `keep` (its active repicked to the first survivor if it was dropped), empty
 * groups are dropped inside splits, single-child splits unwrap to their child,
 * and sibling sizes renormalize. `groupsOut` only ever receives groups that
 * survive into the returned tree.
 */
function pruneCollapseCollect(
  node: LayoutNode | null,
  keep: Set<string>,
  groupsOut: GroupNode[],
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    const tabKeys = node.tabKeys.filter((k) => keep.has(k));
    const activeKey =
      node.activeKey && tabKeys.includes(node.activeKey)
        ? node.activeKey
        : (tabKeys[0] ?? null);
    const next: GroupNode = { ...node, tabKeys, activeKey };
    groupsOut.push(next);
    return next;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    // Collect each child's descendants into a scratch list first; only merge it
    // into groupsOut once we know the child survives (isn't an emptied group or
    // a fully-collapsed split) so groupsOut never lists a dropped group.
    const scratch: GroupNode[] = [];
    const c = pruneCollapseCollect(child, keep, scratch);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
    for (const g of scratch) groupsOut.push(g);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/**
 * Insert `newGroup` adjacent to the group `targetId` in the given direction.
 * `before` controls whether the new group goes before (left/top) or after
 * (right/bottom) the target. The target's slot is split 50/50 with the new
 * group. Returns the new root.
 */
function insertAdjacent(
  root: LayoutNode,
  targetId: string,
  // The node to inject beside the target. Usually a fresh GroupNode, but may be
  // a whole SplitNode (e.g. re-attaching a multi-pane detached popout's subtree).
  newGroup: LayoutNode,
  dir: SplitDir,
  before: boolean,
): LayoutNode {
  // Root itself is the target → wrap into a split.
  if (root.type === "group" && root.id === targetId) {
    return makeSplit(dir, before ? [newGroup, root] : [root, newGroup]);
  }

  function recurse(node: LayoutNode): LayoutNode {
    if (node.type === "group") return node;

    // Is the target a direct group child of this split?
    const childIdx = node.children.findIndex(
      (c) => c.type === "group" && c.id === targetId,
    );
    if (childIdx >= 0) {
      if (node.dir === dir) {
        // Same axis: insert the new group beside the target, splitting the
        // target's size slot 50/50.
        const children = [...node.children];
        const sizes = [...node.sizes];
        const targetSize = sizes[childIdx];
        const half = targetSize / 2;
        const insertAt = before ? childIdx : childIdx + 1;
        children.splice(insertAt, 0, newGroup);
        sizes.splice(childIdx, 1, half, half); // replace target slot with two halves
        // After splice the order of the two halves matches children order at
        // childIdx / childIdx+1; ensure the half list aligns with insertion.
        // We replaced 1 size with [half, half]; if `before`, the new group is
        // the first half — already correct since both halves are equal.
        return { ...node, children, sizes };
      }
      // Different axis: wrap just the target child in a nested split.
      const children = [...node.children];
      const target = children[childIdx] as GroupNode;
      children[childIdx] = makeSplit(
        dir,
        before ? [newGroup, target] : [target, newGroup],
      );
      return { ...node, children };
    }

    // Recurse into split children.
    return { ...node, children: node.children.map(recurse) };
  }

  return recurse(root);
}

function makeSplit(dir: SplitDir, children: LayoutNode[]): SplitNode {
  const n = children.length;
  return {
    type: "split",
    id: nextSplitId(),
    dir,
    children,
    sizes: children.map(() => 1 / n),
  };
}

/** Apply a resize to the divider between child i and i+1 of `splitId`. Exported
 *  so a detached popout's subtree can be resized through the same pure path. */
export function applyResize(
  node: LayoutNode,
  splitId: string,
  dividerIndex: number,
  fraction: number,
): LayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) {
    if (dividerIndex < 0 || dividerIndex >= node.children.length - 1) {
      return node;
    }
    const sizes = [...node.sizes];
    const pair = sizes[dividerIndex] + sizes[dividerIndex + 1];
    const min = 0.05;
    const left = Math.min(Math.max(fraction, min), pair - min);
    sizes[dividerIndex] = left;
    sizes[dividerIndex + 1] = pair - left;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => applyResize(c, splitId, dividerIndex, fraction)) };
}

/** Deep-clone a layout tree, regenerating all group/split ids. */
function regenIds(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    return { ...node, id: nextGroupId() };
  }
  return {
    ...node,
    id: nextSplitId(),
    children: node.children.map(regenIds),
  };
}

// ── Scope persistence helpers ───────────────────────────────────────────────

/** Persist a scope's tabs+layout+focus into the per-scope maps, mirroring the
 *  flat shortcuts when the scope is the current one. */
function writeScope(
  s: TabsStore,
  scope: string,
  tabs: TabEntry[],
  layout: LayoutNode | null,
  focusedGroupId: string | null,
): Partial<TabsStore> {
  // ── #55 invariant enforcement ───────────────────────────────────────────────
  // 1. Stamp/repair the owning scope on every tab and DROP any tab that already
  //    carries a different scope (a stray cross-project payload). This makes the
  //    project→tab binding explicit, so a leaked tab can never be written under
  //    the wrong scope.
  const ownedTabs = tabs
    .filter((t) => t.scope == null || t.scope === scope)
    .map((t) => (t.scope === scope ? t : { ...t, scope }));
  const ownedKeys = new Set(ownedTabs.map((t) => t.key));
  tabs = ownedTabs;

  // 2. Prune orphan layout keys AND collapse emptied groups/splits in one pass,
  //    collecting the surviving groups so the focus/active/fullscreen resolution
  //    below is index lookups against that list rather than fresh tree walks
  //    (Eff #5). `groups` is in document order, matching `allGroups`.
  const groups: GroupNode[] = [];
  let collapsed = pruneCollapseCollect(layout, ownedKeys, groups);
  // A lone empty root group means the scope has no tabs → drop to null so an
  // emptied scope has no layout (matches an uninitialized scope).
  if (collapsed && collapsed.type === "group" && collapsed.tabKeys.length === 0) {
    collapsed = null;
    groups.length = 0;
  }
  const byId = new Map(groups.map((g) => [g.id, g] as const));
  // If the focused group vanished (collapsed away), refocus the first group.
  let focus = focusedGroupId;
  if (!focus || !byId.has(focus)) {
    focus = groups[0]?.id ?? null;
  }
  const activeKey = focus ? (byId.get(focus)?.activeKey ?? null) : null;
  const isCurrent = s.scope === scope;
  // If the fullscreened group collapsed away (e.g. its subwindow was closed),
  // exit fullscreen so CenterPanel doesn't try to render a vanished group.
  const fullscreenGroupId =
    isCurrent && s.fullscreenGroupId && !byId.has(s.fullscreenGroupId)
      ? null
      : s.fullscreenGroupId;
  return {
    tabsByScope: { ...s.tabsByScope, [scope]: tabs },
    layoutByScope: { ...s.layoutByScope, [scope]: collapsed },
    focusedGroupByScope: { ...s.focusedGroupByScope, [scope]: focus },
    ...(isCurrent
      ? { tabs, layout: collapsed, focusedGroupId: focus, activeKey, fullscreenGroupId }
      : {}),
  };
}

/** Convenience accessor for the current scope's mutable state. */
function currentScopeState(s: TabsStore) {
  return {
    tabs: s.tabsByScope[s.scope] ?? [],
    layout: s.layoutByScope[s.scope] ?? null,
    focusedGroupId: s.focusedGroupByScope[s.scope] ?? null,
  };
}

// ── Tree (de)serialization ──────────────────────────────────────────────────

export function serializeTree(node: LayoutNode | null): SavedLayoutTree | null {
  if (!node) return null;
  if (node.type === "group") {
    return { type: "group", tabKeys: [...node.tabKeys], activeKey: node.activeKey };
  }
  return {
    type: "split",
    dir: node.dir,
    sizes: [...node.sizes],
    children: node.children
      .map(serializeTree)
      .filter((c): c is SavedLayoutTree => c != null),
  };
}

/** #42: a group restored from the saved tree that was tagged `detached`. */
export interface RespawnTarget {
  id: string; // the FRESH group id minted during deserialize
  bounds?: WindowBounds;
}

/**
 * Rebuild a layout tree from a serialized tree, remapping saved tab keys to the
 * freshly-minted keys. Drops keys not in `keyMap`. Returns null if nothing left.
 *
 * #42: when a group node is tagged `detached`, its freshly-minted id (+ bounds)
 * is pushed onto `detachedOut` so the caller can re-open it as a floating popout
 * after the layout is live (loadFromLayout). The node is still built into the
 * tree (docked) so its tabs mount and spawn their PTYs before the re-detach.
 *
 * A `hidden`-tagged node works the same way but pushes its fresh id onto
 * `hiddenOut`; the caller then strips it from the built tree into
 * `hiddenGroupsByScope` (see loadFromLayout).
 */
function deserializeTree(
  saved: SavedLayoutTree,
  keyMap: Map<string, string>,
  detachedOut?: RespawnTarget[],
  hiddenOut?: string[],
): LayoutNode | null {
  if (saved.type === "group") {
    const tabKeys = saved.tabKeys
      .map((k) => keyMap.get(k))
      .filter((k): k is string => k != null);
    if (tabKeys.length === 0) return null;
    const activeKey =
      (saved.activeKey != null ? keyMap.get(saved.activeKey) : null) ??
      tabKeys[0] ??
      null;
    const id = nextGroupId();
    if (saved.detached && detachedOut) {
      detachedOut.push({ id, bounds: saved.bounds });
    }
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(id);
    }
    return { type: "group", id, tabKeys, activeKey };
  }
  const children = saved.children
    .map((c) => deserializeTree(c, keyMap, detachedOut, hiddenOut))
    .filter((c): c is LayoutNode => c != null);
  if (children.length === 0) return null;
  if (children.length === 1) {
    // Collapsed to a single child. If this split was a detached (multi-pane)
    // popout, the survivor inherits the respawn so the popout still re-opens.
    if (saved.detached && detachedOut) {
      detachedOut.push({ id: children[0].id, bounds: saved.bounds });
    }
    // Likewise inherit a hidden tag so the survivor is parked, not docked live.
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(children[0].id);
    }
    return children[0];
  }
  // Align sizes to surviving children where possible, else even split.
  let sizes: number[];
  if (saved.sizes.length === children.length) {
    const total = saved.sizes.reduce((a, b) => a + b, 0) || 1;
    sizes = saved.sizes.map((x) => x / total);
  } else {
    sizes = children.map(() => 1 / children.length);
  }
  const id = nextSplitId();
  // #42: a tagged split is a multi-pane popout — collect ONE respawn target for
  // the whole subtree (its children aren't individually tagged) so the respawn
  // path re-detaches the entire split as a single floating window.
  if (saved.detached && detachedOut) {
    detachedOut.push({ id, bounds: saved.bounds });
  }
  // A hidden split is parked whole by its root id (same one-target logic).
  if (saved.hidden && hiddenOut) {
    hiddenOut.push(id);
  }
  return { type: "split", id, dir: saved.dir, children, sizes };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useTabsStore = create<TabsStore>((set, get) => ({
  scope: "root",
  tabsByScope: {},
  layoutByScope: {},
  focusedGroupByScope: {},
  detachedGroupsByScope: {},
  hiddenGroupsByScope: {},
  pendingRespawnByScope: {},
  tabs: [],
  layout: null,
  focusedGroupId: null,
  activeKey: null,
  fullscreenGroupId: null,

  toggleFullscreen: (groupId) => {
    set((s) => ({
      fullscreenGroupId: s.fullscreenGroupId === groupId ? null : groupId,
    }));
  },

  setScope: (scope) => {
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const layout = s.layoutByScope[scope] ?? null;
      let focus = s.focusedGroupByScope[scope] ?? null;
      if (!focus || !findGroup(layout, focus)) {
        focus = allGroups(layout)[0]?.id ?? null;
      }
      const activeKey = focus
        ? (findGroup(layout, focus)?.activeKey ?? null)
        : null;
      // Fullscreen is scope-local (its group id belongs to the old scope's tree);
      // drop it on a scope change so a switch never leaves a stale group fullscreen.
      const fullscreenGroupId =
        s.fullscreenGroupId && findGroup(layout, s.fullscreenGroupId)
          ? s.fullscreenGroupId
          : null;
      return { scope, tabs, layout, focusedGroupId: focus, activeKey, fullscreenGroupId };
    });
  },

  focusGroup: (groupId) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!findGroup(layout, groupId)) return {};
      return writeScope(s, s.scope, tabs, layout, groupId);
    });
  },

  setActive: (key) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      const found = findGroupOfTab(layout, key);
      if (!found || !layout) return {};
      // Set the active tab within its group and focus that group.
      const next = mapGroup(layout, found.group.id, (g) => ({
        ...g,
        activeKey: key,
      }));
      return writeScope(s, s.scope, tabs, next, found.group.id);
    });
  },

  setGroupActive: (groupId, key) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      const group = findGroup(layout, groupId);
      if (!group || !group.tabKeys.includes(key) || !layout) return {};
      const next = mapGroup(layout, groupId, (g) => ({ ...g, activeKey: key }));
      return writeScope(s, s.scope, tabs, next, groupId);
    });
  },

  addTab: (tab, opts) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    const entry: TabEntry = { ...tab, key };
    if (!opts?.seeded) countTabOpen(get().scope, entry);
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = [...tabs, entry];

      // No layout yet → create a root group containing this tab.
      if (!layout) {
        const root: GroupNode = {
          type: "group",
          id: nextGroupId(),
          tabKeys: [key],
          activeKey: key,
        };
        return writeScope(s, s.scope, nextTabs, root, root.id);
      }

      // Add into the focused group (fall back to the first group).
      const target =
        (focusedGroupId && findGroup(layout, focusedGroupId)) ||
        allGroups(layout)[0];
      const next = mapGroup(layout, target.id, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, key],
        activeKey: key,
      }));
      return writeScope(s, s.scope, nextTabs, next, target.id);
    });
    return entry;
  },

  addTabToScope: (scope, tab) => {
    const key = nextKey(tab.kind);
    const entry: TabEntry = { ...tab, key, scope };
    countTabOpen(scope, entry);
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const layout = s.layoutByScope[scope] ?? null;
      const focusedGroupId = s.focusedGroupByScope[scope] ?? null;
      const nextTabs = [...tabs, entry];

      // No layout yet → create a root group containing this tab.
      if (!layout) {
        const root: GroupNode = {
          type: "group",
          id: nextGroupId(),
          tabKeys: [key],
          activeKey: key,
        };
        return writeScope(s, scope, nextTabs, root, root.id);
      }

      // Add into that scope's focused group (fall back to its first group).
      const target =
        (focusedGroupId && findGroup(layout, focusedGroupId)) ||
        allGroups(layout)[0];
      const next = mapGroup(layout, target.id, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, key],
        activeKey: key,
      }));
      return writeScope(s, scope, nextTabs, next, target.id);
    });
    return entry;
  },

  ensureTab: (tab, matches) => {
    const existing = get().tabs.find(matches);
    if (existing) {
      get().setActive(existing.key);
      return existing;
    }
    return get().addTab(tab);
  },

  renameTab: (key, label) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, label: nextLabel } : t,
      );
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  detachScopeFromRemote: (scope, oldDir, newDir) => {
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      if (!tabs.length || !oldDir || !newDir || oldDir === newDir) return {};
      let changed = false;
      const nextTabs = tabs.map((t) => {
        const wasRemoteLoc = t.location === "remote";
        const underOld = t.cwd === oldDir || t.cwd.startsWith(`${oldDir}/`);
        if (!wasRemoteLoc && !underOld) return t;
        changed = true;
        return {
          ...t,
          // A tab that ran ON THE HOST has a cwd in the host's filesystem, which means
          // nothing here — it can only land in the promoted mirror root.
          cwd: underOld ? `${newDir}${t.cwd.slice(oldDir.length)}` : newDir,
          // …and it must stop claiming to run on a host this project no longer has.
          location: wasRemoteLoc ? undefined : t.location,
        };
      });
      if (!changed) return {};
      const layout = s.layoutByScope[scope] ?? null;
      const focused = s.focusedGroupByScope[scope] ?? null;
      return writeScope(s, scope, nextTabs, layout, focused);
    });
  },

  retargetTabs: (oldAbs, newAbs) => {
    set((s) => {
      const scope = s.scope;
      const tabs = s.tabsByScope[scope] ?? [];
      const oldBase = oldAbs.slice(oldAbs.lastIndexOf("/") + 1);
      const newBase = newAbs.slice(newAbs.lastIndexOf("/") + 1);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.kind !== "embed" || !t.embedPath) return t;
        if (t.embedPath === oldAbs) {
          changed = true;
          // Refresh the label to the new basename only when it still shows the
          // old one — don't clobber a tab the user renamed.
          const label = t.label === oldBase ? newBase : t.label;
          return { ...t, embedPath: newAbs, label };
        }
        if (t.embedPath.startsWith(`${oldAbs}/`)) {
          // A tab under a renamed/moved directory: prefix-swap, keep the label.
          changed = true;
          return { ...t, embedPath: `${newAbs}${t.embedPath.slice(oldAbs.length)}` };
        }
        return t;
      });
      if (!changed) return {};
      const patch: Partial<TabsStore> = {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      // Keep the flat mirror in sync so the active scope's CenterPanel re-renders.
      patch.tabs = nextTabs;
      return patch;
    });
  },

  removeTab: (key) => {
    // Discard any session-only link routes that pointed FROM this tab (#50).
    useLinkRoutingStore.getState().purgeForTab(key);
    bumpUsage(get().scope, METRIC.TAB_CLOSED);
    // The PTY is gone; drop its half-typed-prompt state so a recycled id can
    // never inherit it.
    forgetPty(`${get().scope}:${key}`);
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.filter((t) => t.key !== key);
      if (!layout) return writeScope(s, s.scope, nextTabs, null, focusedGroupId);

      const found = findGroupOfTab(layout, key);
      if (!found) {
        return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
      }
      // Drop the key from its group, repick that group's active tab.
      const next = mapGroup(layout, found.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key
            ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
            : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // collapse() in writeScope drops the emptied group + lone splits.
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  closeGroup: (groupId) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!layout) return {};
      const group = findGroup(layout, groupId);
      if (!group) return {};
      // Drop the whole group's tabs from the flat payload list, then empty the
      // group node. collapse() in writeScope removes the emptied group and
      // renormalizes sibling sizes; the removed tabs' PTYs die as the flat pane
      // layer stops rendering their keys (TerminalView unmount → pty_kill).
      const removing = new Set(group.tabKeys);
      // Discard any session-only link routes from the closing tabs (#50).
      const purge = useLinkRoutingStore.getState().purgeForTab;
      group.tabKeys.forEach((k) => purge(k));
      const nextTabs = tabs.filter((t) => !removing.has(t.key));
      const next = mapGroup(layout, groupId, (g) => ({
        ...g,
        tabKeys: [],
        activeKey: null,
      }));
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  closeAllTabs: (scope) => {
    set((s) => {
      const target = scope ?? s.scope;
      const tabs = s.tabsByScope[target] ?? [];
      if (tabs.length === 0) return {};
      // Discard any session-only link routes from the closing tabs (#50).
      const purge = useLinkRoutingStore.getState().purgeForTab;
      tabs.forEach((t) => purge(t.key));
      // Empty the scope entirely: no tabs, no layout. writeScope mirrors the
      // flat shortcuts when target is current; the flat pane layer then unmounts
      // every pane for this scope, killing its PTYs (same path as closeGroup).
      return writeScope(s, target, [], null, null);
    });
  },

  updateTabEnv: (key, env) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, env } : t));
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  setTabLocation: (key, location) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.key !== key || t.location === location) return t;
        changed = true;
        return { ...t, location };
      });
      // No-op (stable array) when the value is unchanged, so an idle re-toggle
      // doesn't churn the tabs array / wake the saveLayout debounce.
      if (!changed) return {};
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  setAgentMode: (key, mode) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.key !== key || t.agentMode === mode) return t;
        const prev = t.args ?? [];
        const args = withAgentMode(t.cmd, prev, mode);
        // withAgentMode hands back the very same array for an agent with no mode
        // support — don't record a mode we didn't actually pass.
        if (args === prev) return t;
        changed = true;
        return {
          ...t,
          agentMode: mode,
          // The args change is what respawns the PTY (TerminalView keys its
          // spawn effect on them).
          args,
          // The respawn replays `initialInput` — for Claude that is the
          // `/rename <project>` launch command. Typing it again into a session
          // we are *resuming* would be junk, so retire it once the tab has
          // launched at least once.
          initialInput: undefined,
        };
      });
      // Stable array when nothing changed, so an idle re-toggle doesn't churn
      // the tabs array / wake the saveLayout debounce.
      if (!changed) return {};
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  setViewerState: (key, patch) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const tab = tabs.find((t) => t.key === key);
      if (!tab) return {};
      const merged = { ...tab.viewerState, ...patch };
      // No-op if nothing actually changed, so a redundant write doesn't churn
      // the tabs array (which would re-fire the saveLayout debounce for nothing).
      const cur = tab.viewerState ?? {};
      if (
        cur.scrollTop === merged.scrollTop &&
        cur.scrollLeft === merged.scrollLeft &&
        cur.scale === merged.scale &&
        cur.offsetX === merged.offsetX &&
        cur.offsetY === merged.offsetY &&
        cur.fontSize === merged.fontSize &&
        cur.autocomplete === merged.autocomplete &&
        cur.autocompleteMode === merged.autocompleteMode &&
        cur.grammarCheck === merged.grammarCheck
      ) {
        return {};
      }
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, viewerState: merged } : t,
      );
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  reorderInGroup: (groupId, from, to) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const group = findGroup(layout, groupId);
      if (!group || !layout) return {};
      if (
        from < 0 ||
        from >= group.tabKeys.length ||
        to < 0 ||
        to >= group.tabKeys.length
      ) {
        return {};
      }
      const next = mapGroup(layout, groupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const [moved] = tabKeys.splice(from, 1);
        tabKeys.splice(to, 0, moved);
        return { ...g, tabKeys };
      });
      return writeScope(s, s.scope, tabs, next, focusedGroupId);
    });
  },

  moveTab: (key, targetGroupId, index) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // Same group → treat as a reorder to `index`.
      if (source.group.id === targetGroupId) {
        const to =
          index == null
            ? source.group.tabKeys.length - 1
            : Math.min(index, source.group.tabKeys.length - 1);
        const next = mapGroup(layout, targetGroupId, (g) => {
          const tabKeys = [...g.tabKeys];
          const [moved] = tabKeys.splice(source.index, 1);
          tabKeys.splice(to, 0, moved);
          return { ...g, tabKeys, activeKey: key };
        });
        return writeScope(s, s.scope, tabs, next, targetGroupId);
      }

      // Remove from source, then insert into target.
      let next: LayoutNode = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      next = mapGroup(next, targetGroupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const at = index == null ? tabKeys.length : Math.min(index, tabKeys.length);
        tabKeys.splice(at, 0, key);
        return { ...g, tabKeys, activeKey: key };
      });
      // Source may have emptied → collapse handles it; focus the target.
      return writeScope(s, s.scope, tabs, next, targetGroupId);
    });
  },

  splitWithTab: (key, targetGroupId, edge) => {
    if (edge === "center") {
      get().moveTab(key, targetGroupId);
      return;
    }
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // A no-op split: dragging a group's only tab onto its own edge would
      // remove then re-add it; skip if it's the lone tab of the target group.
      if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
        return {};
      }

      // 1. Remove from source.
      const removed = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // Collapse so an emptied source group disappears before we inject.
      const cleaned = collapse(removed);
      if (!cleaned) return {};

      // The target group survives collapse (it still has tabs); re-find it.
      const stillThere = findGroup(cleaned, targetGroupId);
      if (!stillThere) return {};

      // 2. Build the new group and inject adjacent to the target.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir =
        edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(cleaned, targetGroupId, newGroup, dir, before);

      // Focus the freshly-split-off group.
      return writeScope(s, s.scope, tabs, next, newGroup.id);
    });
  },

  splitWithNewTab: (tab, targetGroupId, edge) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    const entry: TabEntry = { ...tab, key };
    let created = false;
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout || !findGroup(layout, targetGroupId)) return {};
      const nextTabs = [...tabs, entry];

      // Center → add into the existing target group (no split), mirroring a
      // drop on its tab bar.
      if (edge === "center") {
        const next = mapGroup(layout, targetGroupId, (g) => ({
          ...g,
          tabKeys: [...g.tabKeys, key],
          activeKey: key,
        }));
        created = true;
        return writeScope(s, s.scope, nextTabs, next, targetGroupId);
      }

      // Edge → build a new group holding the tab and inject it adjacent to the
      // target, leaving the target's own tabs untouched.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(layout, targetGroupId, newGroup, dir, before);
      created = true;
      return writeScope(s, s.scope, nextTabs, next, newGroup.id);
    });
    return created ? entry : null;
  },

  resizeSplit: (splitId, dividerIndex, fraction) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!layout) return {};
      const next = applyResize(layout, splitId, dividerIndex, fraction);
      return writeScope(s, s.scope, tabs, next, focusedGroupId);
    });
  },

  detachGroup: (groupId, opts) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    // The id is usually a GROUP (live drag-out), but on restart respawn it can be
    // a SPLIT node — a multi-pane popout re-detached as one whole subtree (#42).
    const group = findGroup(layout, groupId);
    const split = group ? null : findSplit(layout, groupId);
    if (!group && !split) return null;
    // Refuse to detach the only group: the in-window layout must keep a body —
    // except on restart respawn (`allowLastGroup`), where the popout legitimately
    // becomes the scope's only window and the main center is left empty.
    if (!opts?.allowLastGroup && allGroups(layout).length <= 1) return null;

    const label = `detached-${scope}-${groupId}`;
    // Snapshot the popout's subtree: a single GroupNode, or the whole split node
    // (multi-pane popout) verbatim — its ids are reused as the popout's content.
    const subtree: LayoutNode = group
      ? { type: "group", id: group.id, tabKeys: [...group.tabKeys], activeKey: group.activeKey }
      : (split as SplitNode);
    // Group ids that leave the in-window layout (one for a group, several for a
    // split) — used to drop focus if it pointed into the detached subtree.
    const detachedGroupIds = new Set(allGroups(subtree).map((g) => g.id));

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Remove the detached subtree from the in-window layout WITHOUT dropping its
      // tab payloads (they stay in tabsByScope — the detached window renders them).
      // A group is emptied in place (collapse drops it); a split subtree is pruned
      // out whole. Mirrors closeGroup's node-empty step, but keeps the payloads.
      const stripped = !layout
        ? null
        : group
          ? mapGroup(layout, groupId, (g) => ({ ...g, tabKeys: [], activeKey: null }))
          : removeNodeById(layout, groupId);
      // Re-pick focus off the detached subtree onto a surviving group.
      const nextFocus = focus && detachedGroupIds.has(focus) ? null : focus;
      const base = writeScope(s, scope, tabs, stripped, nextFocus);
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds: opts?.bounds }],
        },
      };
    });

    if (!opts?.skipBackend) {
      // Spawn the detached OS window. The store mutation + IPC live in one
      // action so they can't drift. Best-effort: a backend failure leaves the
      // group recorded as detached (the user can dock it back). `bounds` (when
      // restoring a popout on restart) reopens it at its prior place/size.
      const b = opts?.bounds;
      invoke("detach_subwindow", {
        projectId: scope,
        groupId,
        x: b?.x ?? null,
        y: b?.y ?? null,
        width: b?.w ?? null,
        height: b?.h ?? null,
      }).catch(() => {});
    }
    return label;
  },

  detachTab: (key, bounds) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    const found = findGroupOfTab(layout, key);
    if (!found) return null;

    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // The popped tab becomes the sole member of a fresh single-tab group; its
    // payload stays in tabsByScope (the detached subtree now references it).
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [key],
      activeKey: key,
    };

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Drop the key from its source group, then collapse via writeScope (which
      // keeps the payload in `tabs`). An emptied source group/layout is allowed —
      // the main center falls back to the placeholder subwindow.
      const stripped = layout
        ? mapGroup(layout, found.group.id, (g) => {
            const tabKeys = g.tabKeys.filter((k) => k !== key);
            const activeKey =
              g.activeKey === key
                ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
                : g.activeKey;
            return { ...g, tabKeys, activeKey };
          })
        : null;
      const base = writeScope(s, scope, tabs, stripped, focus);
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds }],
        },
      };
    });

    invoke("detach_subwindow", {
      projectId: scope,
      groupId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    }).catch(() => {});
    return label;
  },

  detachNewTab: (tab, bounds) => {
    const scope = get().scope;
    const key = nextKey(tab.kind);
    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // Spread first so a stray `key` on the payload can't shadow the minted one;
    // stamp the owning scope (writeScope isn't on this path since the layout is
    // untouched, so do its scope-stamp here).
    const entry: TabEntry = { ...tab, key, scope };
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [key],
      activeKey: key,
    };

    set((s) => {
      const nextTabs = [...(s.tabsByScope[scope] ?? []), entry];
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds }],
        },
        // Mirror the current-scope convenience copy (writeScope normally does
        // this, but this path leaves the layout untouched and skips it).
        ...(s.scope === scope ? { tabs: nextTabs } : {}),
      };
    });

    invoke("detach_subwindow", {
      projectId: scope,
      groupId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    }).catch(() => {});
    return label;
  },

  attachGroup: (detachedId, opts) => {
    const scope = get().scope;
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedId);
    if (!entry) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      let layout = s.layoutByScope[scope] ?? null;
      // Regenerate the subtree's ids so a docked-then-redetached group never
      // collides with a live node id. The subtree may be a split (multi-pane
      // popout), so keep it a LayoutNode.
      const fresh = regenIds(entry.subtree);
      if (!layout) {
        // The in-window tree emptied while detached → install as the root.
        layout = fresh;
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else {
          const edge = opts?.edge ?? "right";
          if (edge === "center" && fresh.type === "group") {
            // Merge a single-group popout's tabs into the target group.
            layout = mapGroup(layout, target.id, (g) => ({
              ...g,
              tabKeys: [...g.tabKeys, ...fresh.tabKeys],
              activeKey: fresh.activeKey ?? g.activeKey,
            }));
          } else {
            // Split popout (or a non-center edge): inject the whole subtree
            // adjacent to the target as its own pane(s).
            const e = edge === "center" ? "right" : edge;
            const dir: SplitDir =
              e === "left" || e === "right" ? "row" : "column";
            const before = e === "left" || e === "top";
            layout = insertAdjacent(layout, target.id, fresh, dir, before);
          }
        }
      }
      const remaining = entries.filter((d) => d.id !== detachedId);
      const base = writeScope(s, scope, tabs, layout, firstGroup(fresh).id);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: remaining,
        },
      };
    });

    if (!opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  hideGroup: (groupId) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    // Mirror detachGroup's node resolution: usually a GROUP, but can be a SPLIT
    // node (a multi-pane subtree hidden whole).
    const group = findGroup(layout, groupId);
    const split = group ? null : findSplit(layout, groupId);
    if (!group && !split) return;
    // Unlike detachGroup we DO allow hiding the only group: hiding everything
    // leaves the scope empty (the +-placeholder), a valid resting state.

    const label = `hidden-${scope}-${groupId}`;
    const subtree: LayoutNode = group
      ? { type: "group", id: group.id, tabKeys: [...group.tabKeys], activeKey: group.activeKey }
      : (split as SplitNode);
    const hiddenGroupIds = new Set(allGroups(subtree).map((g) => g.id));

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Strip the hidden subtree from the live layout WITHOUT dropping its tab
      // payloads (they stay in tabsByScope so the flat pane layer keeps their
      // PTYs mounted, just display:none). Mirrors detachGroup minus the OS window.
      const stripped = !layout
        ? null
        : group
          ? mapGroup(layout, groupId, (g) => ({ ...g, tabKeys: [], activeKey: null }))
          : removeNodeById(layout, groupId);
      const nextFocus = focus && hiddenGroupIds.has(focus) ? null : focus;
      const base = writeScope(s, scope, tabs, stripped, nextFocus);
      const existing = s.hiddenGroupsByScope[scope] ?? [];
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label }],
        },
      };
    });
  },

  unhideGroup: (hiddenId, opts) => {
    const scope = get().scope;
    const entries = get().hiddenGroupsByScope[scope] ?? [];
    const entry = entries.find((h) => h.id === hiddenId);
    if (!entry) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      let layout = s.layoutByScope[scope] ?? null;
      // Regenerate ids so a hidden-then-restored group never collides with a live
      // node id (mirrors attachGroup). regenIds rewrites GROUP ids but keeps tab
      // KEYS, so an activeKey maps straight through.
      let fresh = regenIds(entry.subtree);
      if (opts?.activeKey) {
        const target = findGroupOfTab(fresh, opts.activeKey);
        if (target) {
          fresh = mapGroup(fresh, target.group.id, (g) => ({ ...g, activeKey: opts.activeKey! }));
        }
      }
      if (!layout) {
        // The tree emptied while hidden → install the restored subtree as root.
        layout = fresh;
      } else {
        const target = allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else {
          // Inject the whole subtree as a new pane to the right of the first group.
          layout = insertAdjacent(layout, target.id, fresh, "row", false);
        }
      }
      const remaining = entries.filter((h) => h.id !== hiddenId);
      const base = writeScope(s, scope, tabs, layout, firstGroup(fresh).id);
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: remaining,
        },
      };
    });
  },

  closeHiddenGroup: (hiddenId) => {
    set((s) => {
      const scope = s.scope;
      const entries = s.hiddenGroupsByScope[scope] ?? [];
      const entry = entries.find((h) => h.id === hiddenId);
      if (!entry) return {};
      // Kill the hidden group's tabs for good: drop their payloads (the flat pane
      // layer then unmounts each pane → pty_kill) and purge their link routes,
      // mirroring closeGroup. The subtree may be a split, so collect every key.
      const removing = new Set(orderedTabKeys(entry.subtree));
      const purge = useLinkRoutingStore.getState().purgeForTab;
      removing.forEach((k) => purge(k));
      const nextTabs = (s.tabsByScope[scope] ?? []).filter((t) => !removing.has(t.key));
      const remaining = entries.filter((h) => h.id !== hiddenId);
      const { layout, focusedGroupId } = currentScopeState(s);
      const base = writeScope(s, scope, nextTabs, layout, focusedGroupId);
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: remaining,
        },
      };
    });
  },

  attachDetachedTab: (scope, detachedGroupId, tabKey, opts) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedGroupId);
    if (!entry || !orderedTabKeys(entry.subtree).includes(tabKey)) return;

    // The detached popout is emptied by this tab leaving → close the window.
    const willEmpty = orderedTabKeys(entry.subtree).filter((k) => k !== tabKey).length === 0;

    set((s) => {
      // 1. Insert the tab into the destination layout (the docked-into scope's,
      //    which is `scope` whether active or stored). The tab payload already
      //    lives in tabsByScope[scope], so we only place its key.
      let layout = s.layoutByScope[scope] ?? null;
      let destId: string;
      const fresh: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [tabKey],
        activeKey: tabKey,
      };
      if (!layout) {
        layout = fresh; // empty scope → the tab becomes the root group.
        destId = fresh.id;
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
          destId = fresh.id;
        } else if ((opts?.edge ?? "center") === "center") {
          // Merge into the target group (append + activate).
          layout = mapGroup(layout, target.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, tabKey],
            activeKey: tabKey,
          }));
          destId = target.id;
        } else {
          const edge = opts!.edge as DropEdge;
          const dir: SplitDir =
            edge === "left" || edge === "right" ? "row" : "column";
          const before = edge === "left" || edge === "top";
          layout = insertAdjacent(layout, target.id, fresh, dir, before);
          destId = fresh.id;
        }
      }

      // 2. Drop the tab from the detached subtree, or drop the whole record when
      //    it leaves the popout empty.
      const nextEntries = willEmpty
        ? entries.filter((d) => d.id !== detachedGroupId)
        : entries.map((d) => {
            if (d.id !== detachedGroupId) return d;
            const sub = removeKeyFromTree(d.subtree, tabKey);
            return sub ? { ...d, subtree: sub } : d;
          });

      // 3. Commit the layout (writeScope keeps the payload + updates the live
      //    mirrors for the active scope; it's a no-op on the mirrors otherwise),
      //    focusing the destination group so the docked tab shows.
      const tabs = s.tabsByScope[scope] ?? [];
      const base = writeScope(s, scope, tabs, layout, destId);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });

    if (willEmpty && !opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  detachTabToNewWindow: (scope, fromGroupId, tabKey, bounds) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const src = entries.find((d) => d.id === fromGroupId);
    // The source popout (and the tab within it) must still exist.
    if (!src || !orderedTabKeys(src.subtree).includes(tabKey)) return null;
    // A lone-tab popout dragged whole is already its own window — re-detaching it
    // would empty the source and churn for nothing, so refuse that case.
    const remaining = removeKeyFromTree(src.subtree, tabKey);
    if (!remaining || orderedTabKeys(remaining).length === 0) return null;

    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // The popped tab becomes the sole member of a fresh single-tab group; its
    // payload stays in tabsByScope (shared), so the new popout self-seeds and the
    // PTY never unmounts (mirrors `detachTab`).
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [tabKey],
      activeKey: tabKey,
    };

    set((s) => {
      const existing = s.detachedGroupsByScope[scope] ?? [];
      // One atomic update: strip the tab from the source popout's subtree AND
      // append the new detached entry. The payload in `tabsByScope` is untouched.
      const nextEntries = existing.map((d) =>
        d.id === fromGroupId ? { ...d, subtree: remaining } : d,
      );
      return {
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...nextEntries, { id: groupId, subtree, label, bounds }],
        },
      };
    });

    invoke("detach_subwindow", {
      projectId: scope,
      groupId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    }).catch(() => {});
    return label;
  },

  dockTabIntoDetached: (scope, detachedGroupId, tabKey, target) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedGroupId);
    // Reject a no-op: the tab must exist in this scope and not already be in the
    // target popout.
    if (!entry || orderedTabKeys(entry.subtree).includes(tabKey)) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      if (!tabs.some((t) => t.key === tabKey)) return {};
      const layout = s.layoutByScope[scope] ?? null;
      const focus = s.focusedGroupByScope[scope] ?? null;
      // 1. Drop the tab from its source in-window group (its payload stays in
      //    `tabs`, so writeScope keeps it and the pane stays mounted-but-hidden).
      //    An emptied source group/layout is fine — the main center falls back to
      //    the placeholder, exactly like `detachTab`.
      const found = findGroupOfTab(layout, tabKey);
      const stripped =
        found && layout
          ? mapGroup(layout, found.group.id, (g) => {
              const tabKeys = g.tabKeys.filter((k) => k !== tabKey);
              const activeKey =
                g.activeKey === tabKey
                  ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
                  : g.activeKey;
              return { ...g, tabKeys, activeKey };
            })
          : layout;
      const base = writeScope(s, scope, tabs, stripped, focus);
      // 2. Place the tab in the detached group's subtree at the resolved pane
      //    target (a body edge splits, center/a slot merges) + activate it there.
      //    No target → append to the first pane (legacy single-pane behaviour).
      const nextEntries = (s.detachedGroupsByScope[scope] ?? []).map((d) =>
        d.id === detachedGroupId
          ? { ...d, subtree: placeKeyInTree(d.subtree, tabKey, target) }
          : d,
      );
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });
  },

  moveTabBetweenDetached: (scope, fromGroupId, toGroupId, tabKey, target, opts) => {
    // A tab can't move onto itself, and both endpoints must exist.
    if (fromGroupId === toGroupId) return;
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const from = entries.find((d) => d.id === fromGroupId);
    const to = entries.find((d) => d.id === toGroupId);
    if (!from || !to) return;
    // The tab must live in the source and NOT already in the destination.
    if (!orderedTabKeys(from.subtree).includes(tabKey)) return;
    if (orderedTabKeys(to.subtree).includes(tabKey)) return;
    // The source popout is emptied by this tab leaving → close its OS window.
    const willEmpty =
      orderedTabKeys(from.subtree).filter((k) => k !== tabKey).length === 0;

    set((s) => {
      const list = s.detachedGroupsByScope[scope] ?? [];
      // One atomic pass: place the key in the destination subtree and strip it
      // from the source. The payload in `tabsByScope` is untouched (shared PTY).
      let next = list.map((d) => {
        if (d.id === toGroupId) {
          return { ...d, subtree: placeKeyInTree(d.subtree, tabKey, target) };
        }
        if (d.id === fromGroupId) {
          const sub = removeKeyFromTree(d.subtree, tabKey);
          return sub ? { ...d, subtree: sub } : d;
        }
        return d;
      });
      // Drop the source record entirely when the tab leaving emptied it.
      if (willEmpty) next = next.filter((d) => d.id !== fromGroupId);
      return {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next },
      };
    });

    // Close the emptied source popout's OS window (frees the registry slot). The
    // destination window is re-seeded by the caller so the moved tab renders.
    if (willEmpty && !opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: from.label }).catch(() => {});
    }
  },

  applyDetachedEdit: (scope, groupId, edit) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === groupId);
      if (idx < 0) return {};
      const entry = entries[idx];
      const sub = entry.subtree;
      // A subtree may be a split (multi-pane popout); each edit targets the group
      // that owns `edit.key` (or, for reorder, the group whose tabs it permutes).
      let nextSub: LayoutNode | null = sub;
      let nextTabs = s.tabsByScope[scope] ?? null;
      switch (edit.kind) {
        case "activate": {
          const g = findGroupOfTab(sub, edit.key);
          if (g) {
            nextSub = mapGroup(sub, g.group.id, (grp) => ({ ...grp, activeKey: edit.key }));
          }
          break;
        }
        case "rename": {
          const label = edit.label.trim();
          if (label && nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key ? { ...t, label } : t,
            );
          }
          break;
        }
        case "close": {
          nextSub = removeKeyFromTree(sub, edit.key);
          // Drop the closed tab's payload (its pane in the detached window
          // unmounted; the PTY is killed there by the spawning pane's lifetime).
          if (nextTabs) nextTabs = nextTabs.filter((t) => t.key !== edit.key);
          break;
        }
        case "reorder": {
          // Find the group whose tab set the reordered list permutes, then
          // reapply that order to it.
          const want = new Set(edit.tabKeys);
          const g = allGroups(sub).find(
            (grp) =>
              grp.tabKeys.length === edit.tabKeys.length &&
              grp.tabKeys.every((k) => want.has(k)),
          );
          if (g) {
            nextSub = mapGroup(sub, g.id, (grp) => ({ ...grp, tabKeys: edit.tabKeys }));
          }
          break;
        }
        case "split":
          // A pane split inside the popout: split the subtree, or no-op if the
          // split is invalid (keeps the popout unchanged).
          nextSub = splitSubtree(sub, edit.key, edit.targetGroupId, edit.edge) ?? sub;
          break;
        case "resize":
          // A divider drag inside a multi-pane popout: adjust the targeted
          // split's child fractions.
          nextSub = applyResize(sub, edit.splitId, edit.dividerIndex, edit.fraction);
          break;
        case "move":
          // Merge a tab across the popout's groups: null (removal emptied the
          // tree — impossible for a cross-group move) leaves the popout unchanged.
          nextSub = moveKeyInTree(sub, edit.key, edit.targetGroupId, edit.index) ?? sub;
          break;
      }
      const nextEntries = [...entries];
      // If the detached popout emptied, remove it entirely.
      if (!nextSub || orderedTabKeys(nextSub).length === 0) {
        nextEntries.splice(idx, 1);
      } else {
        nextEntries[idx] = { ...entry, subtree: nextSub };
      }
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
      if (nextTabs && nextTabs !== s.tabsByScope[scope]) {
        patch.tabsByScope = { ...s.tabsByScope, [scope]: nextTabs };
        if (s.scope === scope) patch.tabs = nextTabs;
      }
      return patch;
    });
  },

  addDetachedTab: (scope, detachedGroupId, tab, targetGroupId) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one;
    // stamp the owning scope (this path never touches the in-window layout, so it
    // does writeScope's scope-stamp itself).
    const entry: TabEntry = { ...tab, key, scope };
    let created: string | null = null;
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === detachedGroupId);
      if (idx < 0) return {};
      const rec = entries[idx];
      // Land the tab in the requested pane; fall back to the popout's first group
      // (a single-pane popout, or a stale target id).
      const target = findGroup(rec.subtree, targetGroupId) ?? allGroups(rec.subtree)[0];
      if (!target) return {};
      const nextSub = mapGroup(rec.subtree, target.id, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, key],
        activeKey: key,
      }));
      const nextEntries = [...entries];
      nextEntries[idx] = { ...rec, subtree: nextSub };
      // Append the payload so the MAIN window's pane layer mounts + owns the PTY;
      // the detached window attaches to it after the re-seed.
      const nextTabs = [...(s.tabsByScope[scope] ?? []), entry];
      created = key;
      return {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
        // Mirror the current-scope convenience copy (writeScope normally does
        // this, but this path leaves the in-window layout untouched and skips it).
        ...(s.scope === scope ? { tabs: nextTabs } : {}),
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });
    return created;
  },

  splitDetachedGroup: (scope, detachedGroupId, key, targetGroupId, edge) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === detachedGroupId);
      if (idx < 0) return {};
      const nextSub = splitSubtree(entries[idx].subtree, key, targetGroupId, edge);
      if (!nextSub) return {};
      const nextEntries = [...entries];
      nextEntries[idx] = { ...entries[idx], subtree: nextSub };
      return {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
    });
  },

  dropDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      // Re-inject the subtree into the inactive scope's STORED layout so its
      // tabs are referenced by a layout node (and thus persist) on next save.
      const fresh = regenIds(entry.subtree);
      const stored = s.layoutByScope[scope] ?? null;
      let nextLayout: LayoutNode;
      if (!stored) {
        nextLayout = fresh;
      } else {
        const target = allGroups(stored)[0];
        nextLayout = target
          ? insertAdjacent(stored, target.id, fresh, "row", false)
          : fresh;
      }
      return {
        layoutByScope: { ...s.layoutByScope, [scope]: nextLayout },
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
      };
    });

    // Close the detached OS window + drop the parkable override / registry entry.
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  closeDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    const keys = orderedTabKeys(entry.subtree);
    const byKey = new Map((get().tabsByScope[scope] ?? []).map((t) => [t.key, t] as const));
    // Tear down each tab BEFORE the store mutation: discard its session-only
    // link routes (#50) and kill its PTY. Files/embed tabs have no PTY; terminal
    // tabs (shell/agent/local_agent) do, and since the popout's pane isn't
    // mounted in the main window (it left the layout on detach) and the detached
    // viewer is attach-only, nothing else would ever kill it — do it explicitly.
    const purge = useLinkRoutingStore.getState().purgeForTab;
    for (const key of keys) {
      purge(key);
      const tab = byKey.get(key);
      if (tab && isPtyTabKind(tab.kind)) {
        invoke("pty_kill", { id: `${scope}:${key}` }).catch(() => {});
      }
    }

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      const removing = new Set(keys);
      const nextTabs = (s.tabsByScope[scope] ?? []).filter((t) => !removing.has(t.key));
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      // Mirror the flat tab list when this scope is the active one.
      if (s.scope === scope) patch.tabs = nextTabs;
      return patch;
    });

    // Close the detached OS window (best-effort; the window also self-destroys).
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  setDetachedBounds: (scope, groupId, bounds) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope];
      if (!entries) return {};
      let changed = false;
      const next = entries.map((d) => {
        if (d.id !== groupId) return d;
        if (
          d.bounds &&
          d.bounds.x === bounds.x &&
          d.bounds.y === bounds.y &&
          d.bounds.w === bounds.w &&
          d.bounds.h === bounds.h
        ) {
          return d;
        }
        changed = true;
        return { ...d, bounds };
      });
      if (!changed) return {};
      return { detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next } };
    });
  },

  consumePendingRespawn: (scope) => {
    const pending = get().pendingRespawnByScope[scope] ?? [];
    if (pending.length === 0) return [];
    set((s) => {
      const rest = { ...s.pendingRespawnByScope };
      delete rest[scope];
      return { pendingRespawnByScope: rest };
    });
    return pending;
  },

  snapshotScopeForSwitch: (scope) => {
    const s = get();
    const layout = s.layoutByScope[scope] ?? null;
    // Resolve the active tab key in one walk: prefer the focused group's active
    // key, falling back to the first group's (Eff #13 — projects.ts previously
    // ran findGroup + allGroups separately for this).
    const focus = s.focusedGroupByScope[scope] ?? null;
    const groups = allGroups(layout);
    const focusedGroup = focus ? groups.find((g) => g.id === focus) : undefined;
    const activeKey = focusedGroup?.activeKey ?? groups[0]?.activeKey ?? null;
    // #55 + restorable filter: keep only scope-owned, restorable tabs.
    const tabs = (s.tabsByScope[scope] ?? []).filter(
      (t) => (t.scope == null || t.scope === scope) && isRestorableTab(t),
    );
    const keepKeys = new Set(tabs.map((t) => t.key));
    const activeTabIndex = Math.max(
      0,
      tabs.findIndex((t) => t.key === activeKey),
    );
    // #42: re-dock detached groups into the persisted tree (detach is
    // session-only; a restart restores them docked), merge BEFORE pruning so
    // dropped tabs prune out consistently. Hidden groups are folded in the same
    // way but tagged `hidden` so they restore still-hidden (not docked live).
    const detached = s.detachedGroupsByScope[scope];
    const hidden = s.hiddenGroupsByScope[scope];
    const merged = withHiddenDocked(
      withDetachedDocked(serializeTree(layout), detached),
      hidden,
    );
    const tabGroups = pruneSavedTree(merged, keepKeys);
    return { tabs, tabGroups, activeTabIndex };
  },

  loadFromLayout: (layout, defaultCwd, targetScope, groups) => {
    // Map saved keys → fresh keys. Saved keys are only unique within the
    // session that wrote them — two projects can persist the same key. Keys
    // double as PTY ids, so always mint a fresh one on restore.
    const keyMap = new Map<string, string>();
    const tabs: TabEntry[] = layout.map((t) => {
      const kind =
        t.kind ??
        cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
      // Agent tabs always start in the current project dir so stale saved cwds
      // don't put the agent in the wrong directory after a project move/rename.
      const isAgent = kind === "agent" || kind === "local_agent";
      const freshKey = nextKey(kind);
      keyMap.set(t.key, freshKey);
      // Resumable agent tabs (Claude with a sessionId) respawn with their
      // resume flag so the prior conversation comes back; everyone else starts
      // fresh with no args.
      const tabShape = { kind, cmd: t.cmd, sessionId: t.sessionId };
      const base =
        isResumableAgentTab(tabShape) && t.sessionId
          ? RESUMABLE_AGENTS[t.cmd](t.sessionId)
          : [];
      // Args are rebuilt from scratch here, so a persisted planner/doer mode has
      // to be re-applied onto them or the tab would silently come back in the
      // agent's default mode — half the point of the toggle is that the split
      // survives a restart.
      const args = t.agentMode ? withAgentMode(t.cmd, base, t.agentMode) : base;
      return {
        key: freshKey,
        label: t.label,
        cmd: t.cmd,
        args,
        env: t.env ?? {},
        cwd: isAgent && defaultCwd ? defaultCwd : t.cwd || defaultCwd,
        kind,
        sessionId: t.sessionId,
        // Restored file embed tabs (kind === "embed") carry their durable path
        // and how to open it so the pane rebuilds exactly.
        embedPath: t.embedPath,
        embedExec: t.embedExec,
        viewer: t.viewer,
        viewerState: t.viewerState,
        // SSH-sync Phase 0: restore the persisted per-tab locality.
        location: t.location,
        // Restore the planner/doer mode (already folded into `args` above).
        agentMode: t.agentMode,
      };
    });

    // Build the layout tree. With `groups` provided, rebuild from the saved
    // tree; otherwise (legacy) put all tabs in a single root group. Groups tagged
    // `detached` are collected here (with their fresh ids) so the caller can
    // re-open them as floating popouts once their panes have mounted.
    let root: LayoutNode | null = null;
    const respawn: RespawnTarget[] = [];
    // Fresh ids of groups/splits tagged `hidden` in the saved tree. They are
    // built into the tree (so their tabs mint payloads/PTYs) then stripped out
    // into `hiddenGroupsByScope` below, so they restore parked, not docked.
    const hiddenIds: string[] = [];
    if (groups) {
      root = deserializeTree(groups, keyMap, respawn, hiddenIds);
    }
    if (!root && tabs.length > 0) {
      root = {
        type: "group",
        id: nextGroupId(),
        tabKeys: tabs.map((t) => t.key),
        activeKey: tabs[0]?.key ?? null,
      };
    }
    // Any tab not placed by the saved tree (e.g. tree out of sync) → append to
    // the first group so no tab is orphaned.
    if (root) {
      const placed = new Set(orderedTabKeys(root));
      const missing = tabs.filter((t) => !placed.has(t.key)).map((t) => t.key);
      if (missing.length > 0) {
        const first = allGroups(root)[0];
        if (first) {
          root = mapGroup(root, first.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, ...missing],
            activeKey: g.activeKey ?? missing[0],
          }));
        }
      }
    }
    root = collapse(root);

    // Extract hidden-tagged subtrees out of the live tree into parked
    // HiddenGroups (the restore-time mirror of `hideGroup`). Snapshot every node
    // first (ids are stable across sibling strips), then remove them so the tabs
    // stay in `tabsByScope` (payloads/PTYs mounted, hidden) but leave the layout.
    const hiddenGroups: HiddenGroup[] = [];
    for (const id of hiddenIds) {
      const g = findGroup(root, id);
      const sp = g ? null : findSplit(root, id);
      if (!g && !sp) continue;
      const subtree: LayoutNode = g
        ? { type: "group", id: g.id, tabKeys: [...g.tabKeys], activeKey: g.activeKey }
        : (sp as SplitNode);
      hiddenGroups.push({ id, subtree, label: `hidden-${targetScope ?? get().scope}-${id}` });
    }
    for (const h of hiddenGroups) {
      root = removeNodeById(root, h.id);
    }

    const focus = allGroups(root)[0]?.id ?? null;

    // Only respawn targets still present in the (possibly pruned/healed) tree: a
    // detached popout whose tabs were all dropped on restore won't exist. A target
    // id may be a GROUP (single-pane popout) or a SPLIT (multi-pane popout), so
    // check both — `allGroups` alone would drop every split target.
    const pending = respawn.filter(
      (r) => findGroup(root, r.id) != null || findSplit(root, r.id) != null,
    );

    set((s) => {
      // Use the explicitly requested scope when provided; this prevents a race
      // where a stale async resolve would write into whatever scope happens to
      // be current at the time the set() callback runs.
      const scope = targetScope ?? s.scope;
      const base = writeScope(s, scope, tabs, root, focus);
      return {
        ...base,
        pendingRespawnByScope:
          pending.length > 0
            ? { ...s.pendingRespawnByScope, [scope]: pending }
            : s.pendingRespawnByScope,
        hiddenGroupsByScope:
          hiddenGroups.length > 0
            ? { ...s.hiddenGroupsByScope, [scope]: hiddenGroups }
            : s.hiddenGroupsByScope,
      };
    });
  },

  persistScope: async (scope, localFile) => {
    const layout = get().layoutByScope[scope] ?? null;
    const scopeTabs = get().tabsByScope[scope] ?? [];
    // Whether an EMPTY layout may erase what's on disk. Saving empty is destructive —
    // it drops `tab_layout`/`tab_groups` AND overwrites the `.eldrun` session mirror,
    // taking a resumable agent tab's `sessionId` (the only handle on its conversation)
    // with them. So it must mean "the user closed every tab", and only two things here
    // can distinguish that from a caller with nothing loaded:
    //
    //   hydrated            — the scope has been restored from disk this session. An
    //                         ABSENT key is a scope we know nothing about; its emptiness
    //                         is ignorance, not intent. (A scope whose restore found no
    //                         restorable tabs never creates the key — see CenterPanel.)
    //   scopeTabs.length    — the scope really holds zero tabs. A scope holding tabs that
    //                         all get filtered out below (non-restorable, or belonging to
    //                         another scope) yields an empty list that looks identical to
    //                         a close-all and is nothing of the sort — that is how
    //                         DemoProj's four tabs were erased on detach.
    //
    // Anything else: the backend keeps what it has. Worst case we persist a layout one
    // save late; the alternative loses conversations.
    const hydrated = Object.prototype.hasOwnProperty.call(get().tabsByScope, scope);
    const allowClear = hydrated && scopeTabs.length === 0;
    // Order the flat tab union by the tree's stable left-to-right order so the
    // persisted `tabs` array and `groups` tree agree.
    const keyOrder = orderedTabKeys(layout);
    const byKey = new Map(scopeTabs.map((t) => [t.key, t] as const));
    const ordered = keyOrder
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    // Include any tabs missing from the tree at the end (defensive).
    for (const t of scopeTabs) {
      if (!keyOrder.includes(t.key)) ordered.push(t);
    }
    // Shell/files/network tabs, resumable agent tabs (Claude with a sessionId), and
    // in-app file-viewer embeds are persisted; other agent/embed tabs (including
    // external-app embeds) are dropped here and the saved tree is pruned to
    // match. See isRestorableTab. Defense-in-depth (#55): also drop any tab not
    // owned by this scope so a foreign tab can never be written into this
    // project's file — `localFile` belongs to `scope`'s project.
    const restorable = ordered.filter(
      (t) => (t.scope == null || t.scope === scope) && isRestorableTab(t),
    );
    const keep = new Set(restorable.map((t) => t.key));
    // Persist the session UUIDs of every open tab that has one (currently
    // Claude agents). Resumable agent tabs also carry their sessionId in
    // `tabLayout`; this separate array keeps UUIDs durable redundantly.
    const sessions = ordered
      .filter((t) => t.sessionId)
      .map((t) => ({ sessionId: t.sessionId, cmd: t.cmd, label: t.label }));
    try {
      const tabLayout = restorable.map((t) => ({
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        cwd: t.cwd,
        kind: t.kind,
        env: t.env ?? {},
        sessionId: t.sessionId,
        embedPath: t.embedPath,
        embedExec: t.embedExec,
        viewer: t.viewer,
        viewerState: t.viewerState,
        // SSH-sync Phase 0: persist the per-tab locality.
        location: t.location,
        // Persist the planner/doer mode so the tab comes back in it (the args
        // that carry it are NOT persisted — they're rebuilt in loadFromLayout).
        agentMode: t.agentMode,
      }));
      // #42: re-dock detached groups into the persisted tree so disk reflects a
      // restart-as-docked layout (their tabs are already in the flat list above
      // via get().tabs). Prune AFTER merging so dropped (non-restorable) tabs in
      // a detached group are pruned consistently.
      const detached = get().detachedGroupsByScope[scope];
      const merged = withDetachedDocked(serializeTree(layout), detached);
      const groups = pruneSavedTree(merged, keep);
      await invoke("save_tab_layout", {
        localFile,
        tabs: tabLayout,
        groups,
        sessions,
        allowClear,
      });
    } catch {
      // tab layout is non-critical
    }
  },

  saveLayout: async (localFile) => {
    await get().persistScope(get().scope, localFile);
  },
}));

/** Replace the group `groupId` via `fn`, returning a new tree (structural). */
export function mapGroup(
  node: LayoutNode,
  groupId: string,
  fn: (g: GroupNode) => GroupNode,
): LayoutNode {
  if (node.type === "group") {
    return node.id === groupId ? fn(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => mapGroup(c, groupId, fn)),
  };
}

// Commands that launch an AI coding agent (mirrors TabBar's AGENT_ITEMS and the
// backend agent registry in commands::agents). Used to classify a tab by its cmd.
const AGENT_CMDS = new Set([
  "claude",
  "codex",
  "gemini",
  "vibe",
  "aider",
  "opencode",
  "cursor-agent",
  "copilot",
  "grok",
  "qwen",
  "openclaw",
]);

export function cmdToKind(cmd: string): TabKind {
  if (cmd === FILES_TAB_CMD) return "files";
  if (cmd === BLOB_TAB_CMD) return "projects3d";
  if (cmd === NETWORK_TAB_CMD) return "network";
  if (cmd === MONITOR_TAB_CMD) return "monitor";
  if (cmd === DISKUSAGE_TAB_CMD) return "diskusage";
  if (cmd === CALENDAR_TAB_CMD) return "calendar";
  if (AGENT_CMDS.has(cmd)) return "agent";
  return "shell";
}

/**
 * Whether a tab KIND alone survives a restart. Shell/files/network tabs are
 * restorable by kind; agent / local-agent and embed tabs are not, because the
 * kind alone carries no session to resume. Prefer the tab-level `isRestorableTab` at call
 * sites that have the full tab — a resumable agent tab (Claude with a sessionId)
 * IS restorable even though its kind is not. This kind-only check stays for the
 * places that only have a `TabKind`.
 *
 * Embed tabs are not restorable by kind alone — only in-app `viewer` embeds
 * survive (external-app embeds would relaunch on startup), so restorability for
 * them is decided at the tab level (see isRestorableEmbedTab / isRestorableTab),
 * not here.
 */
export function isRestorableKind(kind: TabKind): boolean {
  return (
    kind === "shell" ||
    kind === "files" ||
    kind === "network" ||
    kind === "monitor" ||
    // The tab comes back, but on its home screen — a scan is far too expensive to
    // replay on every launch, so the pane never auto-rescans.
    kind === "diskusage" ||
    kind === "calendar"
  );
}

/** Whether a tab owns a backend PTY. Pure frontend panes must never be sent
 * through terminal spawn/kill/activity paths merely because they are not files. */
export function isPtyTabKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "local_agent" || kind === "shell";
}

/**
 * Agents whose prior session can be resumed, mapping `cmd` → the launch args to
 * relaunch with that session. Two resume styles are wired:
 *
 *  - id-based: Claude (`--resume <id>`) and Codex (`codex resume`, args injected
 *    by the backend) resume a *specific* captured session.
 *  - cwd "continue last": Qwen, OpenCode, Copilot, Cursor and Grok have no
 *    caller-supplied launch id, so Eldrun re-launches with their "continue the
 *    most recent session" flag. Because each agent tab launches in the project
 *    directory, that most-recent session IS the tab's prior conversation. These
 *    ignore the minted id (it only satisfies the persistence gate below and is
 *    set as ELDRUN_TAB_UID). Caveat: two tabs of the same agent in one project
 *    both resume that project's single latest session, so they can't be told
 *    apart on restore. Gemini/Vibe stay excluded until their path is confirmed
 *    (39d); Aider has no per-session resume (only `--restore-chat-history`).
 */
export const RESUMABLE_AGENTS: Record<string, (id: string) => string[]> = {
  // Claude: `--resume <launch-id>`; the backend upgrades the id to the live one
  // after `/clear`.
  claude: (id) => ["--resume", id],
  // Codex mints its own session id, so the tab's `sessionId` is only the
  // ELDRUN_TAB_UID key (not a Codex id) → no frontend resume args. The backend
  // reads the hook-recorded live id and injects `codex resume <live-id>` at spawn
  // (terminal::resolve_codex_session).
  codex: () => [],
  // cwd "continue last session" — no captured id needed (see note above).
  qwen: () => ["--continue"],
  opencode: () => ["--continue"],
  copilot: () => ["--continue"],
  "cursor-agent": () => ["--continue"],
  grok: () => ["--session", "latest"],
};

/**
 * Whether a tab is a resumable agent: an agent/local-agent tab that minted a
 * session id AND whose `cmd` is in `RESUMABLE_AGENTS`. Such tabs survive a
 * restart (their conversation is resumed); other agent tabs are still dropped.
 */
export function isResumableAgentTab(
  tab: { kind: TabKind; cmd: string; sessionId?: string },
): boolean {
  return (
    (tab.kind === "agent" || tab.kind === "local_agent") &&
    !!tab.sessionId &&
    tab.cmd in RESUMABLE_AGENTS
  );
}

/**
 * Whether a tab is a restorable embed: a file dragged from the FileTree onto a
 * tab bar that renders IN-APP via a built-in `viewer` (pdf/image/markdown/text).
 * These re-render the file from its durable `embedPath` on restart with no side
 * effects. Embed tabs that instead open an EXTERNAL app (`embedExec`, no
 * `viewer`) are NOT restorable — re-creating one would relaunch the external app
 * at startup — so they are dropped like other live-process tabs.
 */
export function isRestorableEmbedTab(
  tab: { kind: TabKind; viewer?: TabEntry["viewer"] },
): boolean {
  return tab.kind === "embed" && !!tab.viewer;
}

/**
 * Tab-level restorability (supersedes bare `isRestorableKind` at call sites that
 * have the full tab): a tab survives a restart if its kind is restorable, it is
 * a resumable agent tab, or it is an in-app file-viewer embed.
 */
export function isRestorableTab(
  tab: {
    kind: TabKind;
    cmd: string;
    sessionId?: string;
    viewer?: TabEntry["viewer"];
  },
): boolean {
  return (
    isRestorableKind(tab.kind) ||
    isResumableAgentTab(tab) ||
    isRestorableEmbedTab(tab)
  );
}

/**
 * Drop every tab key not in `keep` from a serialized layout tree, collapsing
 * groups/splits that empty out. Returns null when nothing survives. Used when
 * persisting so the on-disk tree never references tabs we won't restore.
 */
export function pruneSavedTree(
  tree: SavedLayoutTree | null,
  keep: Set<string>,
): SavedLayoutTree | null {
  if (!tree) return null;
  if (tree.type === "group") {
    const tabKeys = tree.tabKeys.filter((k) => keep.has(k));
    if (tabKeys.length === 0) return null;
    const activeKey =
      tree.activeKey && tabKeys.includes(tree.activeKey)
        ? tree.activeKey
        : tabKeys[0];
    // #42: carry the detached tag + bounds through pruning. withDetachedDocked
    // sets these so restore re-opens the group as a floating popout; dropping
    // them here would persist the group as a plain docked node and the popout
    // would restore inside the main panel instead.
    return {
      type: "group",
      tabKeys,
      activeKey,
      ...(tree.detached ? { detached: true, bounds: tree.bounds } : {}),
      // Carry the hidden tag through pruning so a hidden group stays parked on
      // restore rather than docking live (mirrors the detached tag).
      ...(tree.hidden ? { hidden: true } : {}),
    };
  }
  const kept = tree.children
    .map((c, i) => ({ child: pruneSavedTree(c, keep), size: tree.sizes[i] ?? 1 }))
    .filter((e): e is { child: SavedLayoutTree; size: number } => e.child != null);
  if (kept.length === 0) return null;
  // #42: carry a multi-pane popout's detached tag + bounds through pruning, just
  // like the group branch — else the split would persist as a plain docked node
  // and the popout would restore inside the main panel.
  const tag = tree.detached
    ? { detached: true as const, bounds: tree.bounds }
    : tree.hidden
      ? { hidden: true as const }
      : {};
  if (kept.length === 1) {
    // Collapsed to a single surviving child: it inherits the popout's detached
    // tag (so it respawns floating) or the hidden tag (so it stays parked).
    return tree.detached || tree.hidden ? { ...kept[0].child, ...tag } : kept[0].child;
  }
  const total = kept.reduce((a, e) => a + e.size, 0) || 1;
  return {
    type: "split",
    dir: tree.dir,
    children: kept.map((e) => e.child),
    sizes: kept.map((e) => e.size / total),
    ...tag,
  };
}

export function isLocalAgentKind(kind: TabKind): kind is "local_agent" {
  return kind === "local_agent";
}

/**
 * SSH-sync Phase 0: whether a tab kind has a user-toggleable local/remote
 * locality. Only `agent` and `shell` tabs run a PTY that can sit on either side;
 * `local_agent` is fixed-local and the non-PTY kinds
 * (files/embed/projects3d/network)
 * have no locality.
 */
export function isLocatableKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "shell";
}

/**
 * SSH-sync Phase 0: the default locality for a kind on a remote project (product
 * decision 1): **agents default LOCAL** (cwd = the local mirror), **shells
 * default REMOTE** (run remote scripts on the host). `local_agent` and the
 * non-PTY kinds resolve local. See docs/ssh_sync_plan.md.
 */
export function defaultLocationForKind(kind: TabKind): TabLocation {
  return kind === "shell" ? "remote" : "local";
}

/**
 * SSH-sync Phase 0: a tab's effective locality — its explicit `location`, or the
 * per-kind default when unset. `local_agent` is always local regardless of any
 * stored value. Consumed by CenterPanel/DetachedCenterPanel to decide `localOnly`
 * and resolve the local `cwd` (mirror root) for a local-on-remote tab.
 */
export function effectiveTabLocation(
  tab: { kind: TabKind; location?: TabLocation },
): TabLocation {
  if (isLocalAgentKind(tab.kind)) return "local";
  return tab.location ?? defaultLocationForKind(tab.kind);
}

/**
 * SSH-sync Phase 1: the local working directory a PTY tab should run in when it
 * runs LOCALLY on a REMOTE project. A local-on-remote tab can't cwd into the
 * remote tree, so it runs in the project's local **mirror** — the synced twin.
 * This is the value shown in the tab title (and the path the disconnected file
 * browser lists); the backend resolves the same path authoritatively at spawn
 * (and guarantees it exists).
 *
 * The mirror can be relocated to a custom folder ("Move project…"), so prefer the
 * project's persisted override (`opts.mirror`, from resolveLocalMirror) when set;
 * fall back to the default `<state dir>/mirror` for legacy projects with none.
 * Returns `fallback` (the tab's own cwd) unchanged for a local project or a tab
 * that runs on the host (remote locality).
 */
export function localTabCwd(
  tab: { kind: TabKind; location?: TabLocation },
  opts: { isRemoteProject: boolean; projectDirectory: string; fallback: string; mirror?: string | null },
): string {
  if (!opts.isRemoteProject || effectiveTabLocation(tab) !== "local") {
    return opts.fallback;
  }
  const override = opts.mirror?.trim();
  if (override) return override.replace(/[/\\]+$/, "");
  if (!opts.projectDirectory) return opts.fallback;
  return `${opts.projectDirectory.replace(/[/\\]+$/, "")}/mirror`;
}

/**
 * #42: build the saved layout tree that should be PERSISTED for a scope that has
 * detached groups. Each detached group's serialized subtree is appended to the
 * in-window tree as a sibling (row split) — so `project.json` always reflects "if
 * you restarted now, this group would dock here" and the tabs survive even if
 * respawn is unavailable — but its root group is TAGGED `detached: true` (with its
 * last-known `bounds`). On restore, a tagged group is re-opened as a floating
 * popout at `bounds` rather than docked (see loadFromLayout). With no detached
 * groups it returns the in-window tree unchanged.
 *
 * Pure: takes the serialized in-window tree + the scope's detached groups,
 * returns a serialized tree. Pruning to `keep` is the caller's job.
 */
export function withDetachedDocked(
  inWindow: SavedLayoutTree | null,
  detached: DetachedGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const d of detached ?? []) {
    const t = serializeTree(d.subtree);
    if (!t) continue;
    // Tag the popout's root (a single GroupNode, or a SplitNode for a multi-pane
    // popout) so restore respawns the WHOLE subtree as one floating window rather
    // than docking it into the main panel. `detachGroup` re-detaches either shape
    // by the tagged node's id (see deserializeTree → pendingRespawn).
    docked.push({ ...t, detached: true, bounds: d.bounds });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

/** #42: the tab keys held by a scope's detached groups (for owned-keys unions). */
export function detachedTabKeys(detached: DetachedGroup[] | undefined): string[] {
  return (detached ?? []).flatMap((d) => orderedTabKeys(d.subtree));
}

/**
 * Fold a scope's HIDDEN groups back into its serialized tree, each tagged
 * `hidden: true`, so a restart persists them (their tabs survive) and restore
 * re-parks them into `hiddenGroupsByScope` rather than docking them live. Mirrors
 * `withDetachedDocked`, minus bounds (a hidden group has no OS window).
 */
export function withHiddenDocked(
  inWindow: SavedLayoutTree | null,
  hidden: HiddenGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const h of hidden ?? []) {
    const t = serializeTree(h.subtree);
    if (!t) continue;
    docked.push({ ...t, hidden: true });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

/** The tab keys held by a scope's hidden groups (for owned-keys unions). */
export function hiddenTabKeys(hidden: HiddenGroup[] | undefined): string[] {
  return (hidden ?? []).flatMap((h) => orderedTabKeys(h.subtree));
}

// Re-export the id regeneration helper so consumers / tests that build trees
// manually can mint ids consistently.
export { regenIds as _regenLayoutIds };

/**
 * #42: is the PTY `id` (`<scope>:<tabKey>`) currently owned by a DETACHED group?
 *
 * The main window's `TerminalView` is NOT attach-only, so on unmount it kills its
 * PTY. But detaching a group unmounts that pane in the main window — and we must
 * NOT kill the PTY then, because the detached window's attach-only viewer has
 * just attached to it (killing it leaves the popped-out terminal a dead black
 * pane). `detachGroup` records the group in `detachedGroupsByScope` *before* the
 * unmount commit, so this read sees the detached state at kill time.
 */
export function isDetachedPtyId(id: string): boolean {
  const idx = id.indexOf(":");
  if (idx < 0) return false;
  const scope = id.slice(0, idx);
  const tabKey = id.slice(idx + 1);
  const groups = useTabsStore.getState().detachedGroupsByScope[scope] ?? [];
  return groups.some((g) => orderedTabKeys(g.subtree).includes(tabKey));
}

// ── Fine-grained per-group selectors (Eff #3/#4/#7 + Struct #3) ───────────────
// These let a TabBar / pane subscribe to JUST its own group instead of the whole
// `layout` + `tabs` slices, which forced a re-render on any tab change anywhere
// and rebuilt a Map of every tab per render. writeScope rebuilds the layout
// immutably along the changed path only (mapGroup), so an unchanged group node
// keeps its reference identity — meaning these selectors return the SAME value
// across an unrelated group's mutation and React bails out of the re-render.
// Modelled on stores/drag.ts's coarse-selector discipline.

/**
 * The current scope's `GroupNode` for `groupId`, or null if it isn't in the live
 * layout. Reference-stable while this group is unchanged, so a subscriber only
 * re-renders when THIS group's node (its tabKeys / activeKey) actually changes.
 */
export function useGroup(groupId: string): GroupNode | null {
  return useTabsStore((s) => findGroup(s.layout, groupId));
}

/**
 * The full tab payloads held by `groupId`, in group order. Subscribes with a
 * shallow array comparison so the bar re-renders only when this group's resolved
 * payloads change — not when another group's tabs (or the `tabsByScope` array
 * identity) churn. Returns [] when the group is absent.
 */
export function useGroupTabs(groupId: string): TabEntry[] {
  return useTabsStore(
    useShallow((s) => {
      const group = findGroup(s.layout, groupId);
      if (!group) return EMPTY_TABS;
      const byKey = new Map(s.tabs.map((t) => [t.key, t] as const));
      return group.tabKeys
        .map((k) => byKey.get(k))
        .filter((t): t is TabEntry => t != null);
    }),
  );
}

// Shared empty sentinel so the no-group path returns a stable reference (an
// inline `[]` would be a fresh array each call and defeat the shallow bail-out).
const EMPTY_TABS: TabEntry[] = [];
