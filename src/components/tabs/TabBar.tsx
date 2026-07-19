import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  BLOB_TAB_CMD,
  CALENDAR_TAB_CMD,
  DISKUSAGE_TAB_CMD,
  NETWORK_TAB_CMD,
  MONITOR_TAB_CMD,
  EMPTY_GROUP_ID,
  effectiveTabLocation,
  remoteHostIdOf,
  isLocatableKind,
  isPtyTabKind,
  useTabsStore,
  useGroup,
  useGroupTabs,
  type TabLocation,
} from "../../stores/tabs";
import { useDragStore } from "../../stores/drag";
import { useTabLandStore } from "../../stores/tabLand";
import { useDetachAnimStore, flyVector } from "../../stores/detachAnim";
import { commitDrop } from "./commitDrop";
import { TabDropPlaceholder } from "./TabDropPlaceholder";
import {
  EMPTY_CUSTOM_AGENTS,
  SHELL_ITEMS,
  TAB_ACCENT,
  agentMenuEntries,
  buildStaticTabSpec,
  isFileTabKind,
  type StaticMenuItem,
} from "./newTabItems";
import { AddTabMenuList } from "./AddTabMenuList";
import { CustomAgentDialog } from "./CustomAgentDialog";
import { type AgentMode, supportsAgentMode } from "./agentModes";
import { reseedDetached, startDetachedDropSession } from "./detachedDropTargets";
import { TabHoverCard } from "./TabHoverCard";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { startCursorPoll, desktopCursor, type PhysPoint } from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { closeTabWithConfirm } from "../../lib/closeRemoteTab";
import { useActivityStore } from "../../stores/activity";
import { useFileSourcesStore } from "../../stores/fileSources";

/** Default fly-out card size when no live pane thumbnail is available (group
 *  detach via the bar drag carries no preview). */
const DETACH_CARD_W = 240;
const DETACH_CARD_H = 150;

/** Fire the one-shot detach send-off: a card at the exit point that lifts and
 *  fades toward the edge the content left through. Used by both detach paths. */
function playDetachFlyOut(
  clientX: number,
  clientY: number,
  label: string,
  previewW?: number,
  previewH?: number,
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { dx, dy } = flyVector(clientX, clientY, vw, vh);
  useDetachAnimStore.getState().flyOut({
    x: clientX,
    y: clientY,
    w: previewW && previewW > 0 ? Math.min(previewW, DETACH_CARD_W) : DETACH_CARD_W,
    h: previewH && previewH > 0 ? Math.min(previewH, DETACH_CARD_H) : DETACH_CARD_H,
    label,
    dx,
    dy,
  });
}

interface Props {
  groupId: string;
  projectCwd: string;
  /** Show the per-subwindow close (×) button. Only when >1 subwindow exists. */
  showGroupClose: boolean;
  /**
   * Width (px) the docked file viewer occupies below this bar, when open. The
   * bar reserves the same width on its right so the scrolling tab strip stops
   * at the pane's edge (tabs never run over the viewer, and overflow-scroll
   * engages there) while the ◫/hide/close controls stay pinned at the far
   * right, above the viewer. Undefined when no viewer is docked.
   */
  filesReserveWidth?: number;
}

export function TabBar({ groupId, projectCwd, showGroupClose, filesReserveWidth }: Props) {
  // Fine-grained subscriptions (Eff #3/#4): this bar tracks ONLY its own group
  // node + that group's resolved tab payloads, so a tab change in another
  // subwindow no longer re-renders every bar, and the per-render Map-of-all-tabs
  // rebuild is gone (useGroupTabs does it once, behind a shallow guard).
  const group = useGroup(groupId);
  const tabs = useGroupTabs(groupId);
  // `Close all tabs` is only disabled when the WHOLE scope is empty; subscribe to
  // a single boolean rather than the full tab array so it doesn't widen the bar's
  // subscription back out to every tab.
  const hasAnyTabs = useTabsStore((s) => s.tabs.length > 0);
  // The 3D project-blob tab is a root-scope feature, offered only once at least
  // one project exists (it has nothing to show otherwise).
  const scope = useTabsStore((s) => s.scope);
  const hasProjects = useProjectsStore((s) => s.projects.length > 0);
  const showBlobItem = scope === "root" && hasProjects;
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const setGroupActive = useTabsStore((s) => s.setGroupActive);
  const renameTab = useTabsStore((s) => s.renameTab);
  const addTab = useTabsStore((s) => s.addTab);
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const removeTab = useTabsStore((s) => s.removeTab);
  const setTabLocation = useTabsStore((s) => s.setTabLocation);
  const setAgentMode = useTabsStore((s) => s.setAgentMode);
  // Experimental — off by default, on in debug mode: the Plan/Auto badge.
  const agentModeToggle = useExperimental("agent_mode_toggle");
  // Timestamp of the last mode flip, for the respawn debounce in handleAgentMode.
  const lastModeToggle = useRef(0);
  const closeGroup = useTabsStore((s) => s.closeGroup);
  const hideGroup = useTabsStore((s) => s.hideGroup);
  // Per-subwindow right file viewer: toggle state lives on the group node.
  const filesOpen = !!group?.filesOpen;
  const setGroupFiles = useTabsStore((s) => s.setGroupFiles);
  // SSH-sync Phase 0: the local/remote locality toggle is only meaningful for a
  // remote (SSH) project's agent/shell tabs. Subscribe to a single boolean so a
  // project edit elsewhere doesn't re-render every bar.
  const isRemoteScope = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
  // The scope project's primary host + extra worker hosts (multi-host remote),
  // for the tab locality menu (Local / Primary / each worker). Change rarely, so
  // subscribing to the references is fine.
  const primaryHost = useProjectsStore((s) => s.projects.find((p) => p.id === scope)?.remote?.host);
  const computeHosts = useProjectsStore((s) => s.projects.find((p) => p.id === scope)?.compute_hosts);
  // Per-tab file source (remote-native vs local mirror), published by the file
  // viewers. Lets the Remote/Local badge ride on the viewer tab itself rather
  // than costing a whole viewer header row. Only meaningful on remote projects.
  const fileSources = useFileSourcesStore((s) => s.byTab);
  const closeAllTabs = useTabsStore((s) => s.closeAllTabs);
  const detachGroup = useTabsStore((s) => s.detachGroup);
  const detachTab = useTabsStore((s) => s.detachTab);
  // Within-bar reorder visuals are driven by the pointer-drag store so the gap
  // tracks the live drop slot CenterPanel resolves; the dragged tab collapses.
  const dragKey = useDragStore((s) => (s.drag ? s.drag.key : null));
  const reorderGroup = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === groupId ? groupId : null,
  );
  const reorderIndex = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === groupId ? s.drag.reorderIndex : null,
  );
  // Label of whatever is being dragged, shown in the drop placeholder so the
  // target bar previews WHICH tab will land there (a tab's label, or a dragged
  // file's name). Only meaningful while this bar is the active reorder target.
  const dragLabel = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === groupId ? s.drag.label : "",
  );
  // One-shot "landing" flourish: the tab that was just dropped into THIS bar
  // (cross-group move / split) plays a drop-in animation as it mounts here.
  const landedKey = useTabLandStore((s) => s.landed?.key ?? null);
  const landedNonce = useTabLandStore((s) => s.landed?.nonce ?? 0);
  const clearLanded = useTabLandStore((s) => s.clear);
  // Per-tab "working" map: a tab whose PTY is actively producing output shows a
  // green status lamp so busy agents are visible even when not the active tab.
  // Both maps are keyed by the composed PTY id (`<scope>:<tabKey>`), since tab
  // keys alone can collide across projects.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  // Per-tab "needs attention" map: an agent tab that finished its turn, or that
  // is waiting on a decision, while not being looked at pulses until it's viewed.
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const clearAttention = useActivityStore((s) => s.clearAttention);
  // Active project's name, used to name an agent's own session on launch.
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId)?.name ?? "",
  );

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Tab currently hovered → drives the styled hover card (the tab-bar
  // counterpart to the project pill's hover popup). Anchored to the tab's
  // bottom-center; cleared on leave, drag, or when a menu opens.
  const [hoverTab, setHoverTab] = useState<
    { key: string; x: number; y: number } | null
  >(null);
  // Right-click on a tab opens this context menu (Close / Close others / Close to
  // the left / Close to the right / Rename). Shift+right-click bypasses it and
  // goes straight to inline rename (#56). Keyed to the clicked tab + its index so
  // the left/right-of splits resolve against this group's ordered `tabs`.
  // Multi-host: the open tab-locality menu (Local / Primary / each worker), keyed
  // by tab. Positioned like the tab context menu below.
  const [localityMenu, setLocalityMenu] = useState<{ key: string; x: number; y: number } | null>(
    null,
  );
  const [tabMenu, setTabMenu] = useState<
    { x: number; y: number; key: string; index: number } | null
  >(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  // #56: Shift+right-click on a tab enters inline rename mode for that key (no
  // menu, no prompt dialog). The label becomes a focused, text-selected <input>.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // The local (Ollama) model a "Local Model" tab launches: the model tagged for
  // the "tabs" task in the 🧠 menu, falling back to the default `ollama_model`.
  // The add menu offers ONE "Local Model" entry that launches it, rather than
  // listing every installed model.
  const localModel = useSettingsStore(
    (s) => s.settings?.ollama_roles?.tabs ?? s.settings?.ollama_model,
  );
  // Coding agents that can drive the active local model besides Mistral/vibe —
  // Claude Code, Codex, OpenCode, Droid via `ollama launch` (or a direct
  // fallback). Loaded once; only the currently-available ones are offered.
  const [localDrivers, setLocalDrivers] = useState<
    { id: string; label: string; available: boolean }[]
  >([]);
  useEffect(() => {
    invoke<{ id: string; label: string; available: boolean }[]>("list_local_drivers")
      .then(setLocalDrivers)
      .catch(() => {});
  }, []);
  // Installed agent CLIs (by id == cmd). The add menu only offers agents whose
  // binary is actually present, so it never lists ones the user can't launch.
  // `null` until the probe resolves; render nothing until then to avoid a flash
  // of the full list. Loaded once.
  const [installedAgents, setInstalledAgents] = useState<Set<string> | null>(null);
  useEffect(() => {
    invoke<{ id: string; installed: boolean }[]>("list_agents")
      .then((list) =>
        setInstalledAgents(new Set(list.filter((a) => a.installed).map((a) => a.id))),
      )
      .catch(() => setInstalledAgents(new Set()));
  }, []);
  // User-defined custom agents (Settings.custom_agents) + the manage-dialog it
  // opens. Their commands aren't in the built-in registry, so they're probed
  // separately (`probe_binaries`); `null` until resolved. See agentMenuEntries.
  const customAgents = useSettingsStore(
    (s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS,
  );
  const [installedCustom, setInstalledCustom] = useState<Set<string> | null>(null);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  useEffect(() => {
    const cmds = customAgents.map((a) => a.cmd);
    if (cmds.length === 0) {
      setInstalledCustom(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalledCustom(new Set(found)))
      .catch(() => setInstalledCustom(new Set()));
  }, [customAgents]);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  // The tabs live in their own horizontally-scrolling strip; chevrons flank it
  // and appear only when the strip overflows in that direction (the native
  // scrollbar is hidden — see `.tab-strip` in themes.css).
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const menuOpen = menuPos !== null;

  const updateScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Track overflow so the chevrons toggle with the strip's size/content. Resize
  // catches the strip shrinking; the tabs-length effect below catches scrollWidth
  // changes from adding/removing tabs (which don't alter the strip's own box).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateScrollState();
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [updateScrollState]);

  // Scroll one chevron-press worth (most of the visible width) toward `dir`.
  const scrollStrip = useCallback((dir: number) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  // Continuous scroll while a chevron is hovered: rAF loop nudges the strip each
  // frame until the pointer leaves (mirrors the project switcher's pill chevrons).
  const hoverScrollRef = useRef<number | null>(null);
  const stopHoverScroll = useCallback(() => {
    if (hoverScrollRef.current !== null) {
      cancelAnimationFrame(hoverScrollRef.current);
      hoverScrollRef.current = null;
    }
  }, []);
  const startHoverScroll = useCallback((dir: number) => {
    stopHoverScroll();
    const step = () => {
      const el = stripRef.current;
      if (!el) return;
      el.scrollLeft += dir * 6;
      // Unlike the switcher, these chevrons unmount at the edges (canScroll*),
      // so onMouseLeave may never fire — stop the loop once we can't scroll
      // further in `dir` rather than spinning forever.
      const atEdge =
        dir < 0
          ? el.scrollLeft <= 0
          : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if (atEdge) {
        hoverScrollRef.current = null;
        return;
      }
      hoverScrollRef.current = requestAnimationFrame(step);
    };
    hoverScrollRef.current = requestAnimationFrame(step);
  }, [stopHoverScroll]);
  useEffect(() => stopHoverScroll, [stopHoverScroll]);

  // Translate a vertical wheel into horizontal strip scrolling so the tabs can be
  // panned while hovering anywhere over them, not just via the (hidden) scrollbar.
  const onStripWheel = useCallback((e: React.WheelEvent) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
  }, []);

  const activeKey = group?.activeKey ?? null;

  // Looking at a tab clears its "needs attention" flag — activating a tab (click,
  // keyboard switch, or mounting with it already active) makes it the one on screen.
  // `recompute` would reach the same conclusion on its next tick; this just spares
  // the tab you just opened up to an interval's worth of leftover glow.
  useEffect(() => {
    if (activeKey) clearAttention(`${scope}:${activeKey}`);
  }, [scope, activeKey, clearAttention]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addBtnRef.current?.contains(t)) return;
      if (addMenuRef.current?.contains(t)) return;
      setMenuPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuPos(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Keep the add menu inside the viewport: it's positioned at the +'s left/bottom
  // and grows rightward/downward, so a + near the right (or bottom) edge would push
  // it past the window border and clip it off-screen.
  useClampToViewport(addMenuRef, menuPos, setMenuPos);

  // Dismiss the tab context menu on an outside click or Escape (mirrors the add
  // menu). Clicks inside the menu itself are ignored so its items can fire.
  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (e: MouseEvent) => {
      if (tabMenuRef.current?.contains(e.target as Node)) return;
      setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabMenu]);

  // Keep the tab context menu inside the viewport: it opens at the cursor and
  // grows right/down, so one near the right/bottom edge would clip.
  useClampToViewport(tabMenuRef, tabMenu, setTabMenu);

  // Drop inline-rename mode if the edited tab disappears (closed / moved away).
  useEffect(() => {
    if (editingKey && !tabs.some((t) => t.key === editingKey)) {
      setEditingKey(null);
    }
  }, [editingKey, tabs]);

  // Adding/removing tabs changes the strip's scrollWidth without resizing its box,
  // so refresh chevron visibility whenever the tab set changes.
  useEffect(() => {
    updateScrollState();
  }, [tabs, updateScrollState]);

  function openAddMenu() {
    if (menuPos) { setMenuPos(null); return; }
    const r = addBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Adding always targets THIS group, so focus it first.
    focusGroup(groupId);
    setMenuPos({ x: r.left, y: r.bottom + 4 });
  }

  function handleAdd(item: StaticMenuItem) {
    // addTab/ensureTab insert into the focused group; focus this one first.
    focusGroup(groupId);
    // Both file panes are one-per-cwd: a second identical view of the same
    // project is never what the click meant, so re-picking focuses the open one.
    // A Files (Project) tab opened ON A FOLDER (the tree's "Open in a new tab")
    // is not that tab, though — it is its own view — so it never absorbs this
    // click, which would otherwise leave no way to get the project root back.
    if (isFileTabKind(item.kind)) {
      ensureTab(
        { label: item.label, cmd: item.cmd, cwd: projectCwd, kind: item.kind },
        (tab) => tab.kind === item.kind && tab.cwd === projectCwd && !tab.folder,
      );
      setMenuPos(null);
      return;
    }
    // Build the full launch spec (session-id minting, ELDRUN_TAB_UID, args,
    // session-rename input) via the shared helper so the main and detached add
    // menus can never drift.
    addTab(buildStaticTabSpec(item, projectCwd, projectName));
    setMenuPos(null);
  }

  // Flip an agent tab between Plan and Auto. This rewrites the tab's launch args,
  // which respawns its PTY — the agent resumes onto the same conversation, but a
  // turn in flight is killed with it, so a busy tab asks first. The debounce keeps
  // a burst of clicks from tripping the backend's crash-loop guard (which refuses
  // to respawn a PTY that has spawned too often in 10s) and leaving a dead tab.
  function handleAgentMode(key: string, ptyId: string, current?: AgentMode) {
    const now = Date.now();
    if (now - lastModeToggle.current < 1000) return;
    if (
      busyByTab[ptyId] &&
      !window.confirm(
        "This agent is working. Switching mode restarts it — the conversation is " +
          "resumed, but the current turn is lost. Switch anyway?",
      )
    ) {
      return;
    }
    lastModeToggle.current = now;
    // Unset (the agent's own default) resolves to Plan on first click; after that
    // it is a straight two-way flip.
    setAgentMode(key, current === "plan" ? "auto" : "plan");
  }

  function handleAddNetwork() {
    focusGroup(groupId);
    addTab({
      label: "Network Traffic",
      cmd: NETWORK_TAB_CMD,
      cwd: projectCwd,
      kind: "network",
    });
    setMenuPos(null);
  }

  // Open (or focus, if already open) the 3D project-blob tab in this group.
  function handleAddBlob() {
    focusGroup(groupId);
    ensureTab(
      { label: "Projects", cmd: BLOB_TAB_CMD, cwd: projectCwd, kind: "projects3d" },
      (tab) => tab.kind === "projects3d",
    );
    setMenuPos(null);
  }

  // Open (or focus, if already open) the htop-like system monitor tab. The view
  // is whole-machine/global, so one per group is enough — ensureTab focuses an
  // existing one instead of stacking duplicates.
  function handleAddMonitor() {
    focusGroup(groupId);
    ensureTab(
      { label: "System Monitor", cmd: MONITOR_TAB_CMD, cwd: projectCwd, kind: "monitor" },
      (tab) => tab.kind === "monitor",
    );
    setMenuPos(null);
  }

  // Add a disk usage analyzer tab. Unlike the monitor/blob/calendar panes above,
  // this one is NOT a singleton: each tab holds its own independent scan root, and
  // comparing two folders side by side is the point — so it stacks (addTab) rather
  // than focusing an existing one (ensureTab, which matches across the whole scope).
  function handleAddDiskUsage() {
    focusGroup(groupId);
    addTab({ label: "Disk Usage", cmd: DISKUSAGE_TAB_CMD, cwd: projectCwd, kind: "diskusage" });
    setMenuPos(null);
  }

  // Open (or focus, if already open) the native calendar tab. The event store is
  // global, so a calendar tab in any scope shows the same events — one per scope
  // is enough, hence ensureTab rather than addTab.
  function handleAddCalendar() {
    focusGroup(groupId);
    ensureTab(
      { label: "Calendar", cmd: CALENDAR_TAB_CMD, cwd: projectCwd, kind: "calendar" },
      (tab) => tab.kind === "calendar",
    );
    setMenuPos(null);
  }

  async function handleOllamaModel(model: string) {
    setMenuPos(null);
    try {
      await invoke("ensure_ollama_running");
      const { vibe_home, alias } = await invoke<{ vibe_home: string; alias: string }>(
        "prepare_local_agent",
        { model },
      );
      focusGroup(groupId);
      addTab({
        label: model,
        cmd: "vibe",
        args: [],
        // ELDRUN_LOCAL_MODEL records WHICH model this tab is driving, so the
        // usage recap can break local agent tabs down by model. `VIBE_ACTIVE_MODEL`
        // carries the resolved alias, not necessarily the name the user picked.
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias, ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
      });
    } catch {
      // Ollama not running or agent prep failed — don't create a tab with no model config.
    }
  }

  // Drive the active local model through a non-vibe coding agent (Claude Code,
  // Codex, OpenCode, Droid). The backend resolves the spawn command — `ollama
  // launch <agent> --model <model>` when available, else a direct fallback — so
  // everything the tab needs is carried in cmd+args (no env to re-hydrate).
  async function handleLocalLaunch(agentId: string, label: string, model: string) {
    setMenuPos(null);
    try {
      await invoke("ensure_ollama_running");
      const { cmd, args } = await invoke<{ cmd: string; args: string[] }>(
        "prepare_local_launch",
        { agent: agentId, model },
      );
      focusGroup(groupId);
      addTab({
        label: `${model} · ${label}`,
        cmd,
        args,
        // Nothing else here names the model — cmd/args are the resolved launcher —
        // so record it for the usage recap's per-model breakdown.
        env: { ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
      });
    } catch {
      // ollama launch unavailable / agent prep failed — don't create a broken tab.
    }
  }

  // #56: enter inline rename mode for a tab (no menu). Reached via Shift+right-
  // click and the context menu's "Rename" item.
  function startInlineRename(event: React.MouseEvent, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenuPos(null);
    setTabMenu(null);
    focusGroup(groupId);
    setEditingKey(key);
  }

  function commitRename(key: string, value: string) {
    // renameTab trims and ignores empty input, so an empty value leaves the
    // label unchanged.
    renameTab(key, value);
    setEditingKey(null);
  }

  // Right-click a tab → context menu; Shift+right-click → straight to rename.
  function onTabContextMenu(event: React.MouseEvent, key: string, index: number) {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      startInlineRename(event, key);
      return;
    }
    setMenuPos(null); // close the add (+) menu if it was open
    setHoverTab(null); // and the hover card, so it doesn't sit atop the menu
    focusGroup(groupId);
    setTabMenu({ x: event.clientX, y: event.clientY, key, index });
  }

  // Bulk-close helpers built on the tested `removeTab` action over this group's
  // ordered `tabs`. Each removeTab reads fresh store state and repicks the active
  // tab / collapses empty groups, so looping over a render-time snapshot is safe.
  function closeToLeft(index: number) {
    tabs.slice(0, index).forEach((t) => removeTab(t.key));
  }
  function closeToRight(index: number) {
    tabs.slice(index + 1).forEach((t) => removeTab(t.key));
  }
  function closeOthers(key: string) {
    tabs.filter((t) => t.key !== key).forEach((t) => removeTab(t.key));
  }

  // Start a pointer-based tab drag once the pointer crosses a 5px threshold.
  // HTML5 native DnD is unreliable on WebKitGTK, so we drive the whole drag from
  // plain window listeners. CenterPanel owns the drop authority (its pointerup
  // commits + ends); this handler only seeds the drag and handles the click case.
  //
  // Cross-window position is POLL-DRIVEN: `startCursorPoll` reports the OS cursor
  // in physical desktop px (the only DPI-correct, cross-engine source — DOM
  // `screenX/Y` units diverge across WebKitGTK/WebView2/WKWebView). The in-window
  // ghost + the "outside this window" test stay on DOM `clientX/clientY` (reliable
  // CSS px on every engine). The terminal release is centralized through
  // `bindDragRelease`, which applies the engine-correct cancel-vs-commit policy.
  function onTabPointerDown(
    e: React.PointerEvent,
    tab: (typeof tabs)[number],
  ) {
    if (e.button !== 0) return;
    // Dismiss the hover card the moment a click/drag begins so it never lingers
    // over a drag ghost or the pane below.
    setHoverTab(null);
    // While this tab is being inline-renamed, the label is an <input>: don't
    // hijack its pointer into a tab drag (lets the caret/selection work).
    if (editingKey === tab.key) return;
    // Suppress the webview's native text-selection / drag gesture, which on
    // WebKitGTK hijacks the pointer stream and fires pointercancel instead of
    // pointerup mid-drag.
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    // Capture on the document root, NOT the dragged tab. When this tab is the
    // lone tab of its subwindow, CenterPanel collapses that subwindow LIVE the
    // moment the drag starts — which unmounts this tab's DOM node. Removing the
    // pointer-capture *target* mid-gesture drops the capture (and on Chromium/
    // WebView2 can fire a spurious pointercancel → abort). The root never
    // unmounts, so the capture — which on Win/mac is what keeps the terminal
    // pointerup landing on this window once the cursor leaves it — survives.
    const captureEl = document.documentElement;
    let dragging = false;

    // #42 (main → detached): an open popout of the current scope is a valid drop
    // target — releasing the dragged tab over one docks it there instead of
    // spawning a new window. The shared session resolves each popout's physical-px
    // frame (async), hit-tests the physical cursor against them, and toggles the
    // popout's drop-target highlight — the SAME logic the file drag uses (FileTree).
    const detached = startDetachedDropSession();

    // Latest in-window client coords (ghost + "outside this window" test) and the
    // latest physical desktop cursor (cross-window hit-test, poll-driven).
    let lastClient = { x: startX, y: startY };
    let lastPhys: PhysPoint | null = null;
    let stopPoll: (() => void) | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        // Clone the dragged tab's live pane so the ghost can preview its CONTENT.
        // The pane is rendered in CenterPanel's flat pane-layer, tagged with its
        // tab key; clone it once (cheap) and ship the node + measured size. Tab
        // keys can collide across scopes, so pick the VISIBLE pane (the hidden
        // duplicates have a zero-size rect) rather than the first match.
        const pane =
          Array.from(
            document.querySelectorAll<HTMLElement>(
              `.center-pane[data-tab-key="${CSS.escape(tab.key)}"]`,
            ),
          ).find((el) => el.getBoundingClientRect().width > 0) ?? null;
        let previewNode: HTMLElement | null = null;
        let previewW = 0;
        let previewH = 0;
        if (pane) {
          const r = pane.getBoundingClientRect();
          previewW = r.width;
          previewH = r.height;
          previewNode = pane.cloneNode(true) as HTMLElement;
          // Strip positioning/visibility so the clone lays out inside the ghost.
          previewNode.style.position = "static";
          previewNode.style.left = "";
          previewNode.style.top = "";
          previewNode.style.display = "flex";
          previewNode.style.width = `${previewW}px`;
          previewNode.style.height = `${previewH}px`;
        }
        useDragStore.getState().start({
          key: tab.key,
          fromGroup: groupId,
          label: tab.label,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          previewNode,
          previewW,
          previewH,
        });
        // Begin resolving popout drop targets now that a real drag is underway.
        void detached.resolve();
        // Capture the terminal pointer event on engines that don't keep delivering
        // it past the source window's HWND (Win/mac); WebKitGTK keeps the implicit
        // grab, so capturing there is unnecessary (and the flag leaves it off).
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is best-effort; the OS-cursor poll does not depend on it */
          }
        }
        // Poll the OS cursor (physical desktop px) to drive the popout hover past
        // the main viewport — DOM pointermove may not cross the OS window boundary.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
          detached.hover(detached.at(p), p, tab.label);
        });
      }
      lastClient = { x: ev.clientX, y: ev.clientY };
      useDragStore.getState().move(ev.clientX, ev.clientY);
    };

    // Tear down the move listener, poll, popout highlight, and pointer capture —
    // however the gesture resolves.
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      stopPoll?.();
      // Clear the popout highlight + tear down the panes listener. `targetAt`
      // still hit-tests the cached pane geometry for the commit below.
      detached.dispose();
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const onCommit = async (shiftKey: boolean) => {
      cleanup();
      if (!dragging) {
        // Never dragged → this was a click. Clicking an inactive tab activates
        // it; clicking the already-active tab enters inline rename (#56 flow).
        if (tab.key === activeKey) {
          focusGroup(groupId);
          setEditingKey(tab.key);
        } else {
          setGroupActive(groupId, tab.key);
        }
        return;
      }
      // Idempotency: if another committer already finished this drag (CenterPanel's
      // redundant pointerup path on non-WebKitGTK), the store is cleared — do
      // nothing rather than re-deciding a stale gesture (which could detach a tab
      // that was just integrated).
      const d = useDragStore.getState().drag;
      if (!d) return;
      // Claim ownership of the gesture SYNCHRONOUSLY, before the `await` below.
      // On Chromium/WebView2 (Windows) CenterPanel's window listeners DO see the
      // terminal pointer event and run their own `finish()` synchronously — which,
      // if the store were still populated during our await, would commit/end the
      // drag first and swallow the outside-detach / popout-dock decisions made
      // here. Emptying the store now makes that racing handler bail (its `d` is
      // null); we proceed using the local `d` snapshot captured above. (On
      // WebKitGTK only this handler ever fires, so clearing early is a harmless
      // no-op there. The later `end()` calls become redundant no-ops.)
      useDragStore.getState().end();
      // Final physical cursor at release (a fresh read; falls back to the last poll
      // reading if the IPC fails). Mirrors FileTree: the last poll tick can be up to
      // ~16 ms stale — or `null` if released before the first tick — which would
      // otherwise spawn the new window at the (−80,−8) corner.
      const phys = (await desktopCursor().catch(() => null)) ?? lastPhys;
      // Pop the dragged tab into its own standalone OS window at the cursor,
      // mirroring the bar-drag detach (onBarPointerDown). Reused by the Shift
      // override and the free-space (outside-the-window) release below. The new
      // window's bounds feed Rust `.position(x,y)`, which is PHYSICAL — so place it
      // at the physical cursor (the last poll reading), not DOM screen coords.
      const popToNewWindow = () => {
        const bounds = {
          x: Math.round((phys?.x ?? 0) - 80),
          y: Math.round((phys?.y ?? 0) - 8),
          w: 900,
          h: 640,
        };
        // Send-off animation toward the edge the tab exited through, before the
        // drag state (and its ghost) tears down.
        playDetachFlyOut(lastClient.x, lastClient.y, tab.label, d.previewW, d.previewH);
        detachTab(tab.key, bounds);
        useDragStore.getState().end();
      };
      // Shift ALWAYS pops a new window — overriding both docking into a popout and
      // integrating into a background subwindow. (May spawn the new window over a
      // popout the cursor happens to be on; that's the intended "always new".)
      if (shiftKey) {
        popToNewWindow();
        return;
      }
      // #42: released over an existing popout → dock the tab straight into it (no
      // new window). Hit-tested at the final physical cursor so it reflects exactly
      // where the cursor ended. The popout's panes attach-only to PTYs the main
      // keeps mounted, so the tab's terminal survives the move.
      //
      // But `detached.at()` is a PURE GEOMETRIC AABB against the popout's OUTER rect —
      // it matches a popout even when it sits BEHIND the main window at the same screen
      // coords (the press that started this drag raised the main window). Docking into
      // a popout the user can't see — while the split preview showed in the visible
      // main window — is exactly the reported bug. So confirm the popout is actually
      // FRONTMOST under the cursor before docking; an occluded one falls through to the
      // in-window integration below, so the visible main window always wins. Mirrors
      // FileTree's file-drag path (`detached_window_frontmost`).
      const overDetached = phys ? detached.at(phys) : null;
      const overFrontDetached =
        overDetached &&
        (await invoke<boolean>("detached_window_frontmost", {
          registryId: overDetached.label,
        }).catch(() => true));
      if (overDetached && overFrontDetached && phys) {
        // Dock into the SPECIFIC pane under the cursor (a body edge splits, a bar
        // merges) — resolved synchronously at the release coords, so no stale
        // cross-window cache and never always-the-first-pane.
        useTabsStore
          .getState()
          .dockTabIntoDetached(
            overDetached.scope,
            overDetached.groupId,
            tab.key,
            detached.targetAt(overDetached, phys),
          );
        // Re-seed the popout so it renders the newly-docked tab, tagged so it
        // plays the drop-in landing for this cross-window merge (mirrors the
        // dock-BACK re-seed in CenterPanel's DETACHED_DRAG_END handler).
        reseedDetached(overDetached.scope, overDetached.groupId, tab.key);
        // Send-off animation toward the edge the tab exited through.
        playDetachFlyOut(lastClient.x, lastClient.y, tab.label, d.previewW, d.previewH);
        useDragStore.getState().end();
        return;
      }
      // Released in FREE SPACE — outside the main window and not over a FRONT popout,
      // so no visible Eldrun window is under the cursor (e.g. dragged onto the desktop
      // or another monitor). Pop this tab into its own standalone OS window. Client
      // coords outside [0,inner) is the outside-the-window signal (DOM clientX/Y is
      // reliable CSS px on every engine). An OCCLUDED popout is deliberately NOT
      // "outside" here: the main window is what's actually under the cursor, so the
      // release falls through to the in-window integration below.
      const outside =
        lastClient.x < 0 ||
        lastClient.y < 0 ||
        lastClient.x >= window.innerWidth ||
        lastClient.y >= window.innerHeight;
      if (outside) {
        popToNewWindow();
        return;
      }
      // Released over THIS main window without Shift → integrate into the
      // background subwindow under the cursor. `bindDragRelease` binds the terminal
      // listeners synchronously at pointerdown — i.e. before the gesture's pointer
      // capture begins — so on WebKitGTK it is the ONLY release handler that
      // reliably fires. CenterPanel's window listeners are added mid-gesture (after
      // the `start()` → React re-render) and, on WebKitGTK, receive pointermove but
      // never the terminal pointerup, so they cannot be the committer. The target
      // was already resolved into the drag store by CenterPanel's pointermove
      // handler during the drag, so commit it verbatim. A null target (chrome /
      // split divider) is a no-op — the tab stays put. If CenterPanel's pointerup
      // DID fire first (other platforms), it already committed + ended, so the
      // top-of-handler guard already returned — no double-commit.
      commitDrop(d);
      useDragStore.getState().end();
    };

    // Escape / blur / a genuine pointercancel (Win/mac) aborts: tear down and drop
    // any in-flight drag without committing.
    const onAbort = () => {
      cleanup();
      if (dragging) useDragStore.getState().end();
    };

    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: (shiftKey) => void onCommit(shiftKey), onAbort });
  }

  // #42: drag the left-edge grip to pop the group into its own OS window. Focuses
  // on press; once the pointer crosses a small threshold a lightweight follow-ghost
  // appears (a DOM card — no per-frame IPC, so it tracks the cursor smoothly) and
  // the real detached OS window is created only on RELEASE, positioned where the
  // group is dropped. This replaces the old "spawn immediately, then hand the move
  // to the WM via `startDragging`" path, whose fragile grab after a heavy async
  // window spawn made the detach lag and often required a SECOND drag to move the
  // new window. Only the explicit `.tab-drag-grip` triggers this — grabbing empty
  // bar space can't accidentally pop a subwindow out.
  function onBarPointerDown(e: React.PointerEvent) {
    focusGroup(groupId);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".tab-drag-grip")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const activeLabel = tabs.find((t) => t.key === activeKey)?.label ?? "Subwindow";
    // Capture on the document root (not this bar): detaching removes the group's
    // node from the layout, so a capture anchored here would drop mid-gesture.
    const captureEl = document.documentElement;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let lastClient = { x: startX, y: startY };
    let lastPhys: PhysPoint | null = null;
    let stopPoll: (() => void) | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        dragging = true;
        // Build the follow-ghost (reuses the drag-ghost styling: fixed, z-topped,
        // pointer-events:none). No OS window yet — it is spawned on release.
        ghost = document.createElement("div");
        ghost.className = "tab-drag-ghost";
        const lbl = document.createElement("div");
        lbl.className = "tab-drag-ghost-label";
        lbl.textContent = activeLabel;
        ghost.appendChild(lbl);
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        document.body.appendChild(ghost);
        // Capture the terminal pointer event on engines that stop delivering it
        // once the cursor leaves the source window (Win/mac); WebKitGTK keeps the
        // implicit grab, so the flag leaves capture off there.
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* best-effort */
          }
        }
        // Poll the OS cursor (physical px) so the drop position is DPI-correct and
        // available even after the pointer leaves the main viewport.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
        });
      }
      lastClient = { x: ev.clientX, y: ev.clientY };
      if (ghost) {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      stopPoll?.();
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const onCommit = async () => {
      cleanup();
      if (!dragging) return; // a click on the grip (no drag) → nothing to detach.
      // Final physical cursor at release (fresh read; fall back to the last poll
      // tick). Bounds feed Rust `.position(x,y)` (PHYSICAL) — offset so the grab
      // point lands on the new window's top frame.
      const phys = (await desktopCursor().catch(() => null)) ?? lastPhys;
      const bounds = {
        x: Math.round((phys?.x ?? 0) - 80),
        y: Math.round((phys?.y ?? 0) - 8),
        w: 900,
        h: 640,
      };
      // Send-off animation at the grab point, then create the OS window at the drop
      // (no `startDragging`: the window appears already positioned, so there is no
      // handoff to miss and no second drag needed). `detachGroup` refuses a lone
      // group (returns null) — a harmless no-op here.
      playDetachFlyOut(lastClient.x, lastClient.y, activeLabel);
      detachGroup(groupId, { bounds });
    };

    const onAbort = () => cleanup();

    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: () => void onCommit(), onAbort });
  }

  // This bar is the live drop target of an in-flight drag: light up the whole
  // bar and render a placeholder slot at the insertion point.
  const isDropTarget = reorderGroup === groupId && reorderIndex != null;
  const dropPlaceholder = <TabDropPlaceholder label={dragLabel} />;

  return (
    <div
      className={`tab-bar${isDropTarget ? " drop-target" : ""}`}
      data-group-id={groupId}
      onPointerDown={onBarPointerDown}
    >
      {/* Explicit detach grip — the sole handle for popping this subwindow out.
          Always pinned at the far left (outside the scrolling strip) so it stays
          grabbable no matter how many tabs fill the bar. A plain (non-button)
          element, so its pointerdown bubbles to `onBarPointerDown`, which now
          fires only when the grip is the target. */}
      <div
        className="tab-drag-grip"
        title="Drag to pop this subwindow into its own window"
        aria-hidden="true"
      >
        ⠿
      </div>
      {canScrollLeft && (
        <button
          className="tab-scroll-btn left"
          title="Scroll tabs left"
          // Keep the chevron out of the bar's detach-drag and tab pointer flow.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(-1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(-1)}
        >
          ‹
        </button>
      )}
      <div className="tab-strip" ref={stripRef} onWheel={onStripWheel}>
      {/* Empty bar that's a drop target: the placeholder is the only slot. */}
      {isDropTarget && tabs.length === 0 && (
        <Fragment key="drop-marker">{dropPlaceholder}</Fragment>
      )}
      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;
        const isDragging = dragKey === tab.key;
        // The placeholder slot previewing where the dragged tab will land — shown
        // immediately before the tab occupying the resolved insertion index.
        const showMarkerBefore = isDropTarget && reorderIndex === index;
        // Whole-tab status glow (no dot, no width change):
        //  - working (green pulse): PTY producing sustained output.
        //  - needs-decision (orange pulse): an agent went quiet with a
        //    choice/permission prompt on its screen.
        //  - finished (green steady): an agent you're not looking at went quiet
        //    with no prompt — its turn is done and its result is unread.
        // Working wins. Working and finished are about output you HAVEN'T seen, so
        // they never show on the viewed tab — its screen says it better. A pending
        // decision is the exception: it's about an agent that is BLOCKED, and it
        // stays blocked whether or not you're looking at it. The lamp holds until
        // the prompt is answered, so a tab left on screen mid-prompt while you work
        // elsewhere in the window still says so.
        const ptyId = `${scope}:${tab.key}`;
        const working = isPtyTabKind(tab.kind) && !isActive && !!busyByTab[ptyId];
        const rawAttn =
          tab.kind === "agent" || tab.kind === "local_agent"
            ? attentionByTab[ptyId] ?? null
            : null;
        const attn = !isActive || rawAttn === "decision" ? rawAttn : null;
        const stateClass = working
          ? " working"
          : attn === "decision"
            ? " needs-decision"
            : attn === "done"
              ? " finished"
              : "";
        // Expose the kind colour to CSS on every tab (not just the active one)
        // so the top stripe reads as the tab-group colour consistently — plain
        // themes draw the rail above, fancy themes move it below. Inactive tabs
        // keep a transparent stripe slot; hover/active tint it with this colour.
        const style = { "--tab-accent": TAB_ACCENT[tab.kind] } as React.CSSProperties;
        const editing = editingKey === tab.key;
        // A tab freshly dropped into this bar plays the drop-in landing once.
        const landing = !isDragging && landedKey === tab.key;
        return (
          <Fragment key={tab.key}>
          {showMarkerBefore && dropPlaceholder}
          <div
            className={`tab ${isActive ? "active" : ""}${stateClass}${isDragging ? " dragging" : ""}${editing ? " editing" : ""}${landing ? " landing" : ""}`}
            style={style}
            data-tab-index={index}
            data-kind={tab.kind}
            onContextMenu={(e) => onTabContextMenu(e, tab.key, index)}
            onPointerDown={(e) => onTabPointerDown(e, tab)}
            // Styled hover card (mirrors the project pill's popup) anchored to
            // this tab's bottom-center. Skipped while inline-renaming.
            onMouseEnter={(e) => {
              if (editing) return;
              const r = e.currentTarget.getBoundingClientRect();
              setHoverTab({ key: tab.key, x: r.left + r.width / 2, y: r.bottom });
            }}
            onMouseLeave={() =>
              setHoverTab((h) => (h?.key === tab.key ? null : h))
            }
            // Clear the landing once it finishes so the class doesn't linger
            // (guard on currentTarget so a child's animationend never clears it
            // early; the status glow is an infinite ::after animation and emits
            // no animationend).
            onAnimationEnd={
              landing
                ? (e) => {
                    if (e.target === e.currentTarget) clearLanded(landedNonce);
                  }
                : undefined
            }
          >
            {editing ? (
              <input
                className="tab-label-edit"
                defaultValue={tab.label}
                autoFocus
                aria-label="Rename tab"
                // Mount focused with the whole label selected for a fast retype.
                ref={(el) => {
                  if (el) el.select();
                }}
                // Keep editing keystrokes / clicks out of drag + activation.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    commitRename(tab.key, (e.target as HTMLInputElement).value);
                  } else if (e.key === "Escape") {
                    setEditingKey(null);
                  }
                }}
                onBlur={(e) => commitRename(tab.key, e.target.value)}
              />
            ) : (
              <span className="tab-label">{tab.label}</span>
            )}
            {/* Viewer file-source badge — remote-native (host SFTP) vs local
                mirror — published by FileViewerPane. Rides on the tab so it
                costs no viewer header row; absent for local projects/tabs. */}
            {(() => {
              const src = fileSources[tab.key];
              if (src !== "remote" && src !== "local") return null;
              return (
                <span
                  className={`tab-source ${src}`}
                  title={
                    src === "remote"
                      ? "Remote-native: read directly from the host over SFTP (no local copy)."
                      : "Local mirror: read from this project's local synced copy of the host file."
                  }
                >
                  {src === "remote" ? "☁" : "⌂"}
                </span>
              );
            })()}
            {/* Planner/doer badge (experimental, off by default) — click to switch
                the agent between Plan and Auto. Only for agents that can actually
                be launched into a mode AND resume on the respawn that costs (see
                agentModes.ts); every other agent tab is untouched. */}
            {agentModeToggle && supportsAgentMode(tab.cmd) && (() => {
              const mode = tab.agentMode;
              const title =
                mode === "plan"
                  ? "Plan: reads and proposes, never edits — click to switch to Auto"
                  : mode === "auto"
                    ? "Auto: auto-accepts edits (shell/network still ask) — click to switch to Plan"
                    : "Agent default: asks before each action — click to switch to Plan";
              return (
                <button
                  className={`tab-agent-mode ${mode ?? "unset"}`}
                  title={`${title}. Switching restarts the agent; the conversation is resumed.`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAgentMode(tab.key, ptyId, mode);
                  }}
                >
                  {mode === "plan" ? "⏸" : mode === "auto" ? "⚡" : "◇"}
                </button>
              );
            })()}
            {/* Locality badge — click to choose where this agent/shell tab runs:
                the local mirror, the primary host, or (multi-host remote,
                docs/multi_host_remote_plan.md) any worker machine. Only shown for
                a remote project's locatable tabs. With no workers it is still a
                menu (Local / Primary). */}
            {isRemoteScope && isLocatableKind(tab.kind) && (() => {
              const loc = effectiveTabLocation(tab);
              const hostId = remoteHostIdOf(loc);
              const label =
                hostId === null
                  ? "Local (mirror)"
                  : hostId === "primary"
                    ? `Primary${primaryHost ? ` (${primaryHost})` : ""}`
                    : (() => {
                        const w = computeHosts?.find((h) => h.id === hostId);
                        return w?.label || w?.host || hostId;
                      })();
              return (
                <button
                  className={`tab-locality ${hostId === null ? "local" : "remote"}`}
                  title={`Runs on: ${label} — click to change where this tab runs`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setLocalityMenu({ key: tab.key, x: r.left, y: r.bottom + 2 });
                  }}
                >
                  {hostId === null ? "⌂" : "☁"}
                </button>
              );
            })()}
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); closeTabWithConfirm(tab.key); }}
              title="Close tab"
            >
              ×
            </button>
          </div>
          </Fragment>
        );
      })}
      {/* Insertion at the end of the bar (slot === tab count). */}
      {isDropTarget && reorderIndex === tabs.length && tabs.length > 0 && (
        <Fragment key="drop-marker-end">{dropPlaceholder}</Fragment>
      )}
      <div className="tab-new-wrap">
        <button
          ref={addBtnRef}
          // When this group has no tabs, the + is the only way to get started —
          // pulse it to draw the eye to it.
          className={`tab-new-btn${tabs.length === 0 ? " empty-hint" : ""}`}
          data-hint-anchor="tab-add"
          title="New tab"
          onClick={openAddMenu}
        >
          +
        </button>
      </div>
      </div>
      {canScrollRight && (
        <button
          className="tab-scroll-btn right"
          title="Scroll tabs right"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(1)}
        >
          ›
        </button>
      )}
      {/* The subwindow controls stay pinned at the far right of the bar. When a
          file viewer is docked below, this cluster reserves the viewer's width
          (`filesReserveWidth`) and right-aligns within it, so it sits directly
          above the viewer while the scrolling tab strip stops at the pane edge. */}
      <div
        className="tab-controls"
        style={filesReserveWidth != null ? { width: filesReserveWidth } : undefined}
      >
        {groupId !== EMPTY_GROUP_ID && (
          <button
            className={`subwindow-files-toggle${filesOpen ? " open" : ""}`}
            title={filesOpen ? "Close this subwindow's file viewer" : "Open a file viewer in this subwindow"}
            // Same self-contained interaction discipline as the hide/close buttons:
            // stop the bar's focusGroup mousedown and don't let the click bubble.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setGroupFiles(groupId, !filesOpen); }}
          >
            ◫
          </button>
        )}
        {groupId !== EMPTY_GROUP_ID && (
          <button
            className="subwindow-hide"
            title="Hide subwindow (bring it back from the right panel)"
            // Same self-contained interaction discipline as the close button below:
            // stop the bar's focusGroup mousedown and don't let the click bubble.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); hideGroup(groupId); }}
          >
            –
          </button>
        )}
        {showGroupClose && (
          <button
            className="subwindow-close"
            title="Close subwindow"
            // Stop the bar's onMouseDown focusGroup from running first (it isn't
            // harmful, but keeping the close interaction self-contained avoids any
            // focus/state churn racing the click) and ensure the click itself
            // isn't bubbled into a tab/pointer handler.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); closeGroup(groupId); }}
          >
            ×
          </button>
        )}
      </div>
      {menuOpen && menuPos && createPortal(
        <div
          className="tab-new-menu"
          ref={addMenuRef}
          style={{ position: "fixed", left: menuPos.x, top: menuPos.y }}
        >
          <AddTabMenuList
            groups={[
              {
                label: "Agents",
                entries: agentMenuEntries({
                  installedBuiltins: installedAgents,
                  installedCmds: installedCustom,
                  customAgents,
                  pick: handleAdd,
                  onAddCustom: () => {
                    setMenuPos(null);
                    setAgentDialogOpen(true);
                  },
                }),
              },
              // Only offer agents whose binary is actually installed: Mistral/vibe
              // (checked against `installedAgents`) and the drivers the backend
              // already marks `available` (which now includes an installed check).
              {
                label: localModel ? `Local Model · ${localModel}` : "Local Model",
                entries: localModel
                  ? [
                      // Mistral/vibe keeps its bespoke per-model VIBE_HOME path.
                      ...(installedAgents?.has("vibe")
                        ? [{
                            key: "vibe",
                            label: "Mistral",
                            color: TAB_ACCENT["local_agent"],
                            onPick: () => void handleOllamaModel(localModel),
                          }]
                        : []),
                      // Other agents drive the same model via `ollama launch` / fallback.
                      ...localDrivers.filter((d) => d.available).map((d) => ({
                        key: d.id,
                        label: d.label,
                        color: TAB_ACCENT["local_agent"],
                        onPick: () => void handleLocalLaunch(d.id, d.label, localModel),
                      })),
                    ]
                  : [],
                hint: localModel
                  ? "No local agent installed — install one in the 🧠 menu"
                  : "No local model set — pick one in the app bar",
              },
              {
                label: "Shell",
                entries: SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => ({
                  key: item.cmd || "shell",
                  label: item.label,
                  color: TAB_ACCENT[item.kind],
                  onPick: () => handleAdd(item),
                })),
              },
              {
                label: "Files",
                entries: SHELL_ITEMS.filter((i) => isFileTabKind(i.kind)).map((item) => ({
                  key: item.cmd,
                  label: item.label,
                  color: TAB_ACCENT[item.kind],
                  disabled: !projectCwd,
                  onPick: () => handleAdd(item),
                })),
              },
              // System Monitor is whole-machine and Disk Usage picks its own scan
              // root, so both are offered in every scope; Network Traffic is
              // per-project (host/SSH link), so root has none.
              {
                label: "Monitoring",
                entries: [
                  {
                    key: "monitor",
                    label: "System Monitor",
                    color: TAB_ACCENT.monitor,
                    onPick: handleAddMonitor,
                  },
                  {
                    key: "diskusage",
                    label: "Disk Usage",
                    dot: "◕",
                    color: TAB_ACCENT.diskusage,
                    onPick: handleAddDiskUsage,
                  },
                  ...(scope !== "root"
                    ? [{
                        key: "network",
                        label: "Network Traffic",
                        color: TAB_ACCENT.network,
                        onPick: handleAddNetwork,
                      }]
                    : []),
                ],
              },
              ...(showBlobItem
                ? [{
                    label: "Workspace",
                    entries: [{
                      key: "blob",
                      label: "Projects (3D)",
                      dot: "◍",
                      color: TAB_ACCENT["projects3d"],
                      onPick: handleAddBlob,
                    }],
                  }]
                : []),
              {
                label: "Calendar",
                entries: [{
                  key: "calendar",
                  label: "Calendar",
                  dot: "◆",
                  color: TAB_ACCENT.calendar,
                  onPick: handleAddCalendar,
                }],
              },
              {
                label: "Project",
                entries: [{
                  key: "close-all",
                  label: "Close all tabs",
                  dot: "×",
                  color: "var(--danger, #d9534f)",
                  disabled: !hasAnyTabs,
                  onPick: () => {
                    closeAllTabs();
                    setMenuPos(null);
                  },
                }],
              },
            ]}
          />
        </div>,
        document.body,
      )}
      {agentDialogOpen && (
        <CustomAgentDialog onClose={() => setAgentDialogOpen(false)} />
      )}
      {localityMenu && createPortal(
        <>
          {/* Click-away backdrop closing the locality menu. */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
            onPointerDown={() => setLocalityMenu(null)}
          />
          <div
            className="tab-new-menu"
            style={{ position: "fixed", left: localityMenu.x, top: localityMenu.y, zIndex: 41 }}
          >
            {(() => {
              const menuTab = tabs.find((t) => t.key === localityMenu.key);
              const cur = menuTab ? effectiveTabLocation(menuTab) : "local";
              const item = (loc: TabLocation, glyph: string, text: string) => (
                <button
                  key={loc}
                  className="tab-new-menu-item"
                  onClick={() => {
                    setTabLocation(localityMenu.key, loc);
                    setLocalityMenu(null);
                  }}
                >
                  <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>
                    {cur === loc ? "●" : glyph}
                  </span>
                  {text}
                </button>
              );
              return (
                <>
                  {item("local", "⌂", "Local (mirror)")}
                  {item("remote", "☁", `Primary${primaryHost ? ` (${primaryHost})` : ""}`)}
                  {(computeHosts ?? []).map((h) =>
                    item(`host:${h.id}`, "☁", h.label || h.host || h.id),
                  )}
                </>
              );
            })()}
          </div>
        </>,
        document.body,
      )}
      {tabMenu && createPortal(
        <div
          className="tab-new-menu"
          ref={tabMenuRef}
          style={{ position: "fixed", left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            className="tab-new-menu-item"
            onClick={() => {
              setEditingKey(tabMenu.key);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>✎</span>
            Rename
          </button>
          <button
            className="tab-new-menu-item"
            onClick={() => {
              closeTabWithConfirm(tabMenu.key);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger, #d9534f)" }}>×</span>
            Close
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabs.length <= 1}
            onClick={() => {
              closeOthers(tabMenu.key);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger, #d9534f)" }}>×</span>
            Close others
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabMenu.index === 0}
            onClick={() => {
              closeToLeft(tabMenu.index);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger, #d9534f)" }}>×</span>
            Close to the left
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabMenu.index === tabs.length - 1}
            onClick={() => {
              closeToRight(tabMenu.index);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger, #d9534f)" }}>×</span>
            Close to the right
          </button>
        </div>,
        document.body,
      )}
      {/* Styled tab hover card (matches the project pill popup). Suppressed
          mid-drag and while a menu is open so it never overlaps them. The card
          derives its own content from the tab + this window's stores. */}
      {hoverTab && dragKey === null && !menuOpen && !tabMenu && (() => {
        const tab = tabs.find((t) => t.key === hoverTab.key);
        if (!tab) return null;
        return (
          <TabHoverCard
            tab={tab}
            scope={scope}
            isRemote={isRemoteScope}
            anchorX={hoverTab.x}
            anchorY={hoverTab.y}
          />
        );
      })()}
    </div>
  );
}
