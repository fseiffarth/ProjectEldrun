import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  BLOB_TAB_CMD,
  BROWSER_TAB_CMD,
  PROJECT_FILES_TAB_CMD,
  PRINTING_TAB_CMD,
  DISKUSAGE_TAB_CMD,
  NETWORK_TAB_CMD,
  MONITOR_TAB_CMD,
  SKILLSLIBRARY_TAB_CMD,
  EMPTY_GROUP_ID,
  isPtyTabKind,
  useTabsStore,
  useGroup,
  useGroupTabs,
  type TabEntry,
  type TabKind,
} from "../../stores/tabs";
import { useDragStore } from "../../stores/drag";
import { useTabLandStore } from "../../stores/tabLand";
import { useDetachAnimStore, flyVector } from "../../stores/detachAnim";
import { commitDrop } from "./commitDrop";
import { TabDropPlaceholder } from "./TabDropPlaceholder";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  TAB_ACCENT,
  agentMenuEntries,
  buildStaticTabSpec,
  compactAgentMenuEntries,
  isFileTabKind,
  itemLabel,
  type StaticMenuItem,
} from "./newTabItems";
import { AddTabMenuList } from "./AddTabMenuList";
import { useAddTabMenuData } from "./useAddTabMenuData";
import { CustomAgentDialog } from "./CustomAgentDialog";
import { reseedDetached, startDetachedDropSession } from "./detachedDropTargets";
import { TabHoverCard } from "./TabHoverCard";
import { useFastMode } from "../../lib/fastMode";
import {
  TabSourceBadge,
  TabTexLinkBadge,
  TabLocalityBadge,
  LocalityMenu,
  tabLocation,
  type LocalityMenuState,
} from "./TabLocalityBadges";
import { texPdfPartner, useTexPdfCandidates } from "../../lib/texPdfLink";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { startCursorPoll, desktopCursor, type PhysPoint } from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { closeTabWithConfirm } from "../../lib/closeRemoteTab";
import { registerHostBoundTab } from "../../lib/hostBound";
import { useActivityStore } from "../../stores/activity";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { TRASH_PROJECT_ID } from "../../lib/trashProject";
import { AgentScheduleDialog } from "../agents/AgentScheduleDialog";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { nextScheduleOccurrence } from "../../lib/agentSchedule";

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

/**
 * The panes the "+" menu opens through `ensureTab` — one per scope by
 * construction, because each renders a machine-global or store-global list that
 * a second copy would repeat verbatim (see `handleAddMonitor` and friends).
 * There is nothing for "Duplicate" to produce, so the item is **hidden** rather
 * than disabled: no state makes it available, and a permanently dead entry in a
 * five-item menu is worse than one that isn't there.
 */
const SINGLETON_TAB_KINDS = new Set<TabKind>([
  "projects3d",
  "monitor",
  "calendar",
  "printing",
  "skillslibrary",
]);

/** Is a second tab like this one a thing that can exist? A Files (Project) tab
 *  counts as a singleton only at the project ROOT — one opened on a folder is
 *  its own view, exactly the distinction `handleAdd` draws. */
function canDuplicateTab(tab: TabEntry): boolean {
  if (SINGLETON_TAB_KINDS.has(tab.kind)) return false;
  return !(isFileTabKind(tab.kind) && !tab.folder);
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
  const t = useT();
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
  // The scope's `.tex`/`.pdf` viewer tabs, for the TeX ⇄ PDF coupling mark. A
  // pair very often straddles two subwindows (the workspace here, its compiled
  // PDF beside it), so the search runs over the scope rather than this group —
  // behind a shallow guard that keeps the bar's subscription narrow (see
  // lib/texPdfLink).
  const texPdfTabs = useTexPdfCandidates();
  // The 3D project-blob tab is a root-scope feature, offered only once at least
  // one project exists (it has nothing to show otherwise).
  const scope = useTabsStore((s) => s.scope);
  const trashScope = scope === TRASH_PROJECT_ID;
  const hasProjects = useProjectsStore((s) => s.projects.length > 0);
  const showBlobItem = scope === "root" && hasProjects;
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const setGroupActive = useTabsStore((s) => s.setGroupActive);
  // Cross-group activation, for the TeX ⇄ PDF jump: the partner tab usually
  // lives in ANOTHER subwindow, so this uses the store's `setActive` (activate
  // in whatever group owns it, and focus that group) rather than this bar's
  // group-scoped `setGroupActive`.
  const setActive = useTabsStore((s) => s.setActive);
  const renameTab = useTabsStore((s) => s.renameTab);
  const addTab = useTabsStore((s) => s.addTab);
  const duplicateTab = useTabsStore((s) => s.duplicateTab);
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const removeTab = useTabsStore((s) => s.removeTab);
  const setTabLocation = useTabsStore((s) => s.setTabLocation);
  // Experimental — off for users, on in debug: the in-app browser (#61). This is
  // the entry-point half of the gate; the other half is the withdrawal
  // (`lib/experimentalSweep`), which closes any browser tab already open when the
  // flag goes off, so hiding the menu entry here is never the whole story.
  const webBrowser = useExperimental("web_browser");
  // Where a fresh browser tab opens. Empty/unset = the built-in start page, not
  // a remote request.
  const browserHome = useSettingsStore((s) => s.settings?.browser_home_url);
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
  // All the "+"-menu data plumbing (agent registry probe, enabled/compact/
  // custom agents, local-model drivers, box-member rows) is the shared hook —
  // one implementation with the popout's NewTabMenu, so the two cannot drift.
  const {
    localModel,
    localDrivers,
    enabledAgents,
    compactAgentBins,
    customAgents,
    installedCustom,
    boxMembers,
  } = useAddTabMenuData(scope);

  // Active project's name, used to name an agent's own session on launch.
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId)?.name ?? "",
  );

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Tab currently hovered → drives the styled hover card (the tab-bar
  // counterpart to the project pill's hover popup). Anchored to the tab's
  // bottom-center; cleared on leave, drag, or when a menu opens.
  // Fast mode drops the hover card: it carries its own ticking clock and
  // store subscriptions per hover, for detail the tab strip and the pane
  // itself already show.
  const fastMode = useFastMode();
  const [hoverTab, setHoverTab] = useState<
    { key: string; x: number; y: number } | null
  >(null);
  // Right-click on a tab opens this context menu (Close / Close others / Close to
  // the left / Close to the right / Rename). Shift+right-click bypasses it and
  // goes straight to inline rename (#56). Keyed to the clicked tab + its index so
  // the left/right-of splits resolve against this group's ordered `tabs`.
  // Multi-host: the open tab-locality menu, keyed by tab. Two-level — `view`
  // starts at "root" (Local ↔ Remote) and drills into "machines" (primary +
  // each worker) when Remote is chosen. Positioned like the tab context menu.
  const [localityMenu, setLocalityMenu] = useState<LocalityMenuState | null>(null);
  const [tabMenu, setTabMenu] = useState<
    { x: number; y: number; key: string; index: number } | null
  >(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  // #56: Shift+right-click on a tab enters inline rename mode for that key (no
  // menu, no prompt dialog). The label becomes a focused, text-selected <input>.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // The manage-custom-agents dialog the "+" menu's "Add custom…" opens.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [scheduleDialogKey, setScheduleDialogKey] = useState<string | null>(null);
  const schedulesByTarget = useAgentSchedulesStore((s) => s.byTarget);
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
    if (editingKey && !tabs.some((tb) => tb.key === editingKey)) {
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
        { label: itemLabel(item, t), cmd: item.cmd, cwd: projectCwd, kind: item.kind },
        (tab) => tab.kind === item.kind && tab.cwd === projectCwd && !tab.folder,
      );
      setMenuPos(null);
      return;
    }
    // Build the full launch spec (session-id minting, ELDRUN_TAB_UID, args,
    // session-rename input) via the shared helper so the main and detached add
    // menus can never drift.
    addTab(buildStaticTabSpec(item, projectCwd, projectName, t));
    setMenuPos(null);
  }

  /** Box "+" menu: a Files (Project) tab rooted at ONE member (the viewer
   *  resolves the member's identity from the cwd — see ProjectFilesTab). */
  function handleAddBoxMemberFiles(m: { id: string; name: string; dir: string }) {
    focusGroup(groupId);
    addTab({
      label: t("newTabMenu.boxMemberFiles", { name: m.name }),
      cmd: PROJECT_FILES_TAB_CMD,
      args: [],
      env: {},
      cwd: m.dir,
      kind: "projectfiles",
    });
    setMenuPos(null);
  }

  /** Box "+" menu: a shell rooted in ONE member's tree (legal after the spawn
   *  gate's box branch; cwd = the member root, so tools/paths resolve there). */
  function handleAddBoxMemberShell(m: { id: string; name: string; dir: string }) {
    focusGroup(groupId);
    addTab({
      label: t("newTabMenu.boxMemberShell", { name: m.name }),
      cmd: "",
      args: [],
      env: {},
      cwd: m.dir,
      kind: "shell",
    });
    setMenuPos(null);
  }

  /** Box "+" menu: an agent tab rooted in ONE member's tree — resume-safe,
   *  since Claude keys its per-cwd history by that root. */
  function handleAddBoxMemberAgent(m: { id: string; name: string; dir: string }) {
    focusGroup(groupId);
    const claude = AGENT_ITEMS.find((i) => i.cmd === "claude");
    if (!claude) return;
    addTab({
      ...buildStaticTabSpec(claude, m.dir, m.name, t),
      label: t("newTabMenu.boxMemberAgent", { name: m.name }),
    });
    setMenuPos(null);
  }

  function handleAddNetwork() {
    focusGroup(groupId);
    addTab({
      label: t("newTabMenu.itemNetworkTraffic"),
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
      { label: t("newTabMenu.tabLabelProjects"), cmd: BLOB_TAB_CMD, cwd: projectCwd, kind: "projects3d" },
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
      { label: t("newTabMenu.itemSystemMonitor"), cmd: MONITOR_TAB_CMD, cwd: projectCwd, kind: "monitor" },
      (tab) => tab.kind === "monitor",
    );
    setMenuPos(null);
  }

  // Add a disk usage analyzer tab. Unlike the monitor/blob panes above,
  // this one is NOT a singleton: each tab holds its own independent scan root, and
  // comparing two folders side by side is the point — so it stacks (addTab) rather
  // than focusing an existing one (ensureTab, which matches across the whole scope).
  function handleAddDiskUsage() {
    focusGroup(groupId);
    addTab({ label: t("newTabMenu.itemDiskUsage"), cmd: DISKUSAGE_TAB_CMD, cwd: projectCwd, kind: "diskusage" });
    setMenuPos(null);
  }

  // Open (or focus, if already open) the native print manager. Printers belong
  // to the machine, so a second tab in this scope would list the same ones —
  // hence ensureTab, the bargain mail makes for the same reason.
  function handleAddPrinting() {
    focusGroup(groupId);
    ensureTab(
      { label: t("printing.title"), cmd: PRINTING_TAB_CMD, cwd: projectCwd, kind: "printing" },
      (tab) => tab.kind === "printing",
    );
    setMenuPos(null);
  }

  // Open (or focus, if already open) the Skills Library tab. Its catalog is
  // machine state and its install scopes are this project plus the personal
  // one, so a second tab in this scope would show exactly the same lists —
  // hence ensureTab, the printing bargain, rather than addTab.
  function handleAddSkills() {
    focusGroup(groupId);
    ensureTab(
      {
        label: t("skillsLibrary.title"),
        cmd: SKILLSLIBRARY_TAB_CMD,
        cwd: projectCwd,
        kind: "skillslibrary",
      },
      (tab) => tab.kind === "skillslibrary",
    );
    setMenuPos(null);
  }

  // Open an in-app browser tab. Unlike the print manager this is NOT a singleton:
  // each tab holds its own page, and two browser tabs never show the same thing —
  // so it stacks (addTab), the way diskusage does. The tab starts on the
  // configured home address, or on its start page when there is none: an empty
  // setting means the built-in start page, never a remote request.
  function handleAddBrowser() {
    focusGroup(groupId);
    addTab({
      label: t("newTabMenu.browser"),
      cmd: BROWSER_TAB_CMD,
      cwd: projectCwd,
      kind: "browser",
      url: browserHome || undefined,
    });
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
        // usage recap can break local agent tabs down by model — and ONLY that
        // (#150): the right to run outside the project's container is granted by
        // `hostBoundUid` below, registered as a file in the state dir, so a
        // display-only change here can no longer hand out a container escape.
        // `VIBE_ACTIVE_MODEL` carries the resolved alias, not necessarily the
        // name the user picked.
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias, ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
        hostBoundUid: await registerHostBoundTab(scope),
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
        // so record it for the usage recap's per-model breakdown. It is a label,
        // not an authority: see the `hostBoundUid` note above (#150).
        env: { ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
        hostBoundUid: await registerHostBoundTab(scope),
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

  // Open a second tab like this one, landing immediately to its right. The spec
  // (what is copied, what is re-minted) is the store's `duplicateSpec`; the one
  // thing it cannot do itself is the host-bound marker, which the backend has to
  // register (#150) — so a local-model tab's copy gets its OWN uid here rather
  // than inheriting the original's, the same way every such tab is created.
  async function handleDuplicate(key: string) {
    const source = tabs.find((tab) => tab.key === key);
    setTabMenu(null);
    if (!source) return;
    focusGroup(groupId);
    const overrides = source.hostBoundUid
      ? { hostBoundUid: await registerHostBoundTab(scope) }
      : undefined;
    duplicateTab(key, overrides);
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
    tabs.slice(0, index).forEach((tb) => removeTab(tb.key));
  }
  function closeToRight(index: number) {
    tabs.slice(index + 1).forEach((tb) => removeTab(tb.key));
  }
  function closeOthers(key: string) {
    tabs.filter((tb) => tb.key !== key).forEach((tb) => removeTab(tb.key));
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
    const activeLabel = tabs.find((tb) => tb.key === activeKey)?.label ?? t("tabBar.subwindowFallback");
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
      // handoff to miss and no second drag needed).
      //
      // `allowLastGroup` because popping out the ONLY subwindow is a thing people
      // do — it is how a single-subwindow scope gets onto a second monitor — and
      // without it this gesture was a silent no-op: `detachGroup` returned null
      // while the fly-out (played one line above, before the call) still ran, so
      // the send-off animation reported a detach that never happened. The
      // refusal's stated reason, that the in-window layout must keep a body, is
      // not an invariant this codebase actually holds: `hideGroup` permits the
      // identical end state in as many words ("a valid resting state"), and the
      // restart-respawn path already reaches it whenever a popout is the scope's
      // only group. What is left behind is the empty subwindow's own "+" bar, or
      // the center placeholder — both recoverable, and both what hiding the last
      // subwindow has always produced.
      playDetachFlyOut(lastClient.x, lastClient.y, activeLabel);
      detachGroup(groupId, { bounds, allowLastGroup: true });
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
        title={t("tabBar.dragGripTitle")}
        aria-hidden="true"
      >
        ⠿
      </div>
      {canScrollLeft && (
        <button
          className="tab-scroll-btn left"
          title={t("tabBar.scrollLeftTitle")}
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
        // Whole-tab status ring (no dot, no width change, nothing animated —
        // see `--status-*` in themes.css):
        //  - working (green, dotted): PTY producing sustained output.
        //  - finished (green, solid): an agent you're not looking at went quiet
        //    with no prompt — the same work as above, done, its result unread.
        //  - needs-decision (amber, solid): an agent went quiet with a
        //    choice/permission prompt on its screen. Its own colour because it
        //    is the one state that is about you rather than about the agent.
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
            // Fast mode has no card, so the label becomes a plain tooltip —
            // otherwise a tab whose name is ellipsized would have no way at all
            // to read it out.
            title={fastMode ? tab.label : undefined}
            // Styled hover card (mirrors the project pill's popup) anchored to
            // this tab's bottom-center. Skipped while inline-renaming.
            onMouseEnter={(e) => {
              if (editing || fastMode) return;
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
                aria-label={t("tabBar.renameAriaLabel")}
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
            {(tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId && (() => {
              const enabled = (schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)] ?? [])
                .filter((schedule) => schedule.enabled);
              const count = enabled.length;
              const next = enabled
                .map((schedule) => nextScheduleOccurrence(schedule, new Date())?.at)
                .filter((at): at is Date => !!at)
                .sort((a, b) => a.getTime() - b.getTime())[0];
              return count > 0 ? (
                <span
                  className="tab-schedule-indicator"
                  title={next
                    ? t("agentSchedule.indicatorNext", { count, value: next.toLocaleString() })
                    : t("agentSchedule.indicator", { count })}
                >
                  ◷
                </span>
              ) : null;
            })()}
            {/* Viewer file-source badge — remote-native (host SFTP) vs local
                mirror, a clickable toggle when the file exists on both sides.
                Shared with the detached strip (see TabLocalityBadges). */}
            <TabSourceBadge tabKey={tab.key} />
            {/* TeX ⇄ PDF coupling mark: this tab's other half (the compiled PDF,
                or the LaTeX source that produces it) when that tab is open —
                click to jump to it. Derived from the paths, so it needs nothing
                persisted on the tab; see lib/texPdfLink. */}
            <TabTexLinkBadge
              partner={texPdfPartner(texPdfTabs, tab)}
              onFocus={setActive}
            />
            {/* There is deliberately no Plan/Auto badge here. An agent's
                permission mode is the agent's own to set, through its own CLI
                (Claude's shift+tab, Codex's mode picker) — Eldrun launches the
                plain command and injects no mode flag. The badge that used to
                sit here rewrote the tab's launch args, which respawned the PTY
                on every flip; the mode a user sets inside the session still
                survives a restart, because `services::agent_session` re-applies
                the mode Claude's own hook recorded. */}
            {/* Locality badge — click to choose where this agent/shell tab runs:
                the local mirror, the primary host, or (multi-host remote,
                docs/multi_host_remote_plan.md) any worker machine. Only shown for
                a remote project's locatable tabs. Shared with the detached strip. */}
            {isRemoteScope && (
              <TabLocalityBadge
                tab={tab}
                primaryHost={primaryHost}
                computeHosts={computeHosts}
                onOpen={(r, startOnMachines) =>
                  setLocalityMenu({
                    key: tab.key,
                    x: r.left,
                    y: r.bottom + 2,
                    view: startOnMachines ? "machines" : "root",
                  })
                }
              />
            )}
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); closeTabWithConfirm(tab.key); }}
              title={t("tabBar.closeTabTitle")}
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
      </div>
      {canScrollRight && (
        <button
          className="tab-scroll-btn right"
          title={t("tabBar.scrollRightTitle")}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(1)}
        >
          ›
        </button>
      )}
      {/* The + lives OUTSIDE the scrolling strip, beside the grip, the chevrons
          and the controls cluster — and for their reason: it is the only way to
          add a tab to this group, so it must stay reachable no matter how many
          tabs fill (and overflow) the bar. Inside the strip it scrolled away
          with the tabs, and a narrow subwindow hid the one control that opens a
          new one. It sits after the right chevron so the chevrons keep flanking
          the strip they scroll; with no overflow there is no chevron, so it
          still renders flush after the final tab. */}
      <div className="tab-new-wrap">
        <button
          ref={addBtnRef}
          // When this group has no tabs, the + is the only way to get started —
          // pulse it to draw the eye to it.
          className={`tab-new-btn${tabs.length === 0 ? " empty-hint" : ""}`}
          data-hint-anchor="tab-add"
          title={t("tabBar.newTabTitle")}
          onClick={openAddMenu}
        >
          +
        </button>
      </div>
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
            title={filesOpen ? t("tabBar.filesToggleOpenTitle") : t("tabBar.filesToggleClosedTitle")}
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
            title={t("tabBar.hideSubwindowTitle")}
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
            title={t("tabBar.closeSubwindowTitle")}
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
                label: t("newTabMenu.groupAgents"),
                moreLabel: t("newTabMenu.moreAgents"),
                entries: agentMenuEntries({
                  installedBuiltins: enabledAgents,
                  installedCmds: installedCustom,
                  customAgents,
                  allowCustom: !trashScope,
                  pick: handleAdd,
                  onAddCustom: () => {
                    setMenuPos(null);
                    setAgentDialogOpen(true);
                  },
                  t,
                }),
                compactEntries: compactAgentMenuEntries(
                  agentMenuEntries({
                    installedBuiltins: enabledAgents,
                    installedCmds: installedCustom,
                    customAgents,
                    allowCustom: !trashScope,
                    pick: handleAdd,
                    onAddCustom: () => {
                      setMenuPos(null);
                      setAgentDialogOpen(true);
                    },
                    t,
                  }),
                  compactAgentBins,
                ),
              },
              // Box scope: one row-trio per member — files view, shell, and a
              // (resume-safe, member-cwd) Claude tab. Empty members list (or a
              // non-box scope) contributes no group at all.
              ...(boxMembers.length > 0
                ? [{
                    label: t("newTabMenu.groupBoxMembers"),
                    entries: boxMembers.flatMap((m) => [
                      {
                        key: `boxfiles:${m.id}`,
                        label: t("newTabMenu.boxMemberFiles", { name: m.name }),
                        dot: "▤",
                        color: TAB_ACCENT.projectfiles,
                        untested: true,
                        onPick: () => handleAddBoxMemberFiles(m),
                      },
                      {
                        key: `boxshell:${m.id}`,
                        label: t("newTabMenu.boxMemberShell", { name: m.name }),
                        color: TAB_ACCENT.shell,
                        untested: true,
                        onPick: () => handleAddBoxMemberShell(m),
                      },
                      ...(enabledAgents?.has("claude")
                        ? [{
                            key: `boxagent:${m.id}`,
                            label: t("newTabMenu.boxMemberAgent", { name: m.name }),
                            color: TAB_ACCENT.agent,
                            untested: true,
                            onPick: () => handleAddBoxMemberAgent(m),
                          }]
                        : []),
                    ]),
                  }]
                : []),
              // Only offer agents whose binary is actually installed: Mistral/vibe
              // (checked against `enabledAgents`) and the drivers the backend
              // already marks `available` (which now includes an installed check).
              ...(!trashScope ? [{
                label: localModel
                  ? t("newTabMenu.groupLocalModelWithName", { model: localModel })
                  : t("newTabMenu.groupLocalModel"),
                entries: localModel
                  ? [
                      // Mistral/vibe keeps its bespoke per-model VIBE_HOME path.
                      ...(enabledAgents?.has("vibe")
                        ? [{
                            key: "vibe",
                            label: "Mistral",
                            color: TAB_ACCENT["local_agent"],
                            onPick: () => void handleOllamaModel(localModel),
                          }]
                        : []),
                      // Other agents drive the same model via `ollama launch` / fallback.
                      // `heavy_harness` cautions, it never withholds — see
                      // lib/localDrivers.ts. The row stays pickable because
                      // which local models cope is not something the backend
                      // can probe.
                      ...localDrivers.filter((d) => d.available).map((d) => ({
                        key: d.id,
                        label: d.label,
                        color: TAB_ACCENT["local_agent"],
                        caution: d.heavy_harness
                          ? t("newTabMenu.localDriverHeavyHarness", { agent: d.label })
                          : undefined,
                        onPick: () => void handleLocalLaunch(d.id, d.label, localModel),
                      })),
                    ]
                  : [],
                // Two causes, two sentences — see NewTabMenu: an empty list
                // because the model can't drive tool-calling agents must not
                // read as "you have no agents installed".
                hint: !localModel
                  ? t("newTabMenu.noLocalModelHint")
                  : localDrivers.some((d) => d.needs_tools_unsupported)
                    ? t("newTabMenu.localModelNoToolsHint", { model: localModel })
                    : t("newTabMenu.noLocalAgentHint"),
              }] : []),
              ...(!trashScope ? [{
                label: t("newTabMenu.groupShell"),
                entries: SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => ({
                  key: item.cmd || "shell",
                  label: itemLabel(item, t),
                  color: TAB_ACCENT[item.kind],
                  onPick: () => handleAdd(item),
                })),
              }] : []),
              ...(!trashScope ? [{
                label: t("newTabMenu.groupFiles"),
                entries: SHELL_ITEMS.filter((i) => isFileTabKind(i.kind)).map((item) => ({
                  key: item.cmd,
                  label: itemLabel(item, t),
                  color: TAB_ACCENT[item.kind],
                  disabled: !projectCwd,
                  onPick: () => handleAdd(item),
                })),
              }] : []),
              // System Monitor is whole-machine and Disk Usage picks its own scan
              // root, so both are offered in every scope; Network Traffic is
              // per-project (host/SSH link), so root has none.
              ...(!trashScope ? [{
                label: t("newTabMenu.groupMonitoring"),
                entries: [
                  {
                    key: "monitor",
                    label: t("newTabMenu.itemSystemMonitor"),
                    color: TAB_ACCENT.monitor,
                    onPick: handleAddMonitor,
                  },
                  {
                    key: "diskusage",
                    label: t("newTabMenu.itemDiskUsage"),
                    dot: "◕",
                    color: TAB_ACCENT.diskusage,
                    onPick: handleAddDiskUsage,
                  },
                  ...(scope !== "root"
                    ? [{
                        key: "network",
                        label: t("newTabMenu.itemNetworkTraffic"),
                        color: TAB_ACCENT.network,
                        onPick: handleAddNetwork,
                      }]
                    : []),
                ],
              }] : []),
              ...(!trashScope && showBlobItem
                ? [{
                    label: t("newTabMenu.groupWorkspace"),
                    entries: [{
                      key: "blob",
                      label: t("newTabMenu.itemProjects3d"),
                      dot: "◍",
                      color: TAB_ACCENT["projects3d"],
                      onPick: handleAddBlob,
                    }],
                  }]
                : []),
              ...(!trashScope ? [{
                label: t("printing.title"),
                entries: [{
                  key: "printing",
                  label: t("printing.title"),
                  dot: "⎙",
                  color: TAB_ACCENT.printing,
                  untested: true,
                  onPick: handleAddPrinting,
                }],
              }] : []),
              // Offered at the root scope too since the personal install scope
              // exists: the catalog is machine state and a skill can be
              // installed for every project here without one being open. See
              // `NewTabMenu`, which carries the same entry.
              ...(!trashScope ? [{
                label: t("skillsLibrary.title"),
                entries: [{
                  key: "skillslibrary",
                  label: t("skillsLibrary.title"),
                  dot: "◧",
                  color: TAB_ACCENT.skillslibrary,
                  untested: true,
                  onPick: handleAddSkills,
                }],
              }] : []),
              ...(!trashScope && webBrowser
                ? [{
                    label: t("newTabMenu.browser"),
                    entries: [{
                      key: "browser",
                      label: t("newTabMenu.browser"),
                      dot: "🌐",
                      color: TAB_ACCENT.browser,
                      untested: true,
                      onPick: handleAddBrowser,
                    }],
                  }]
                : []),
              {
                label: t("newTabMenu.groupProject"),
                entries: [{
                  key: "close-all",
                  label: t("newTabMenu.itemCloseAllTabs"),
                  dot: "×",
                  color: "var(--danger)",
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
      {worktreePicker.dialogs}
      {scheduleDialogKey && (() => {
        const tab = tabs.find((item) => item.key === scheduleDialogKey);
        return tab ? (
          <AgentScheduleDialog scope={scope} tab={tab} onClose={() => setScheduleDialogKey(null)} />
        ) : null;
      })()}
      {localityMenu && (
        <LocalityMenu
          menu={localityMenu}
          current={tabLocation(tabs.find((tb) => tb.key === localityMenu.key))}
          primaryHost={primaryHost}
          computeHosts={computeHosts}
          onClose={() => setLocalityMenu(null)}
          onChangeView={(view) => setLocalityMenu((m) => (m ? { ...m, view } : m))}
          onChoose={(key, loc) => setTabLocation(key, loc)}
        />
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
            {t("common.rename")}
          </button>
          {tabs.some((tab) => tab.key === tabMenu.key && canDuplicateTab(tab)) && (
            <button
              className="tab-new-menu-item"
              onClick={() => void handleDuplicate(tabMenu.key)}
            >
              <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>⧉</span>
              {t("tabBar.duplicate")}
              <UntestedTag />
            </button>
          )}
          {tabs.some((tab) => tab.key === tabMenu.key && (tab.kind === "agent" || tab.kind === "local_agent")) && (
            <button
              className="tab-new-menu-item"
              onClick={() => {
                setScheduleDialogKey(tabMenu.key);
                setTabMenu(null);
              }}
            >
              <span className="tab-new-menu-dot" style={{ color: "var(--accent)" }}>◷</span>
              {t("agentSchedule.menu")}
              <UntestedTag />
            </button>
          )}
          <button
            className="tab-new-menu-item"
            onClick={() => {
              closeTabWithConfirm(tabMenu.key);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger)" }}>×</span>
            {t("common.close")}
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabs.length <= 1}
            onClick={() => {
              closeOthers(tabMenu.key);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger)" }}>×</span>
            {t("tabBar.closeOthers")}
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabMenu.index === 0}
            onClick={() => {
              closeToLeft(tabMenu.index);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger)" }}>×</span>
            {t("tabBar.closeToLeft")}
          </button>
          <button
            className="tab-new-menu-item"
            disabled={tabMenu.index === tabs.length - 1}
            onClick={() => {
              closeToRight(tabMenu.index);
              setTabMenu(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger)" }}>×</span>
            {t("tabBar.closeToRight")}
          </button>
        </div>,
        document.body,
      )}
      {/* Styled tab hover card (matches the project pill popup). Suppressed
          mid-drag and while a menu is open so it never overlaps them. The card
          derives its own content from the tab + this window's stores. */}
      {hoverTab && !fastMode && dragKey === null && !menuOpen && !tabMenu && (() => {
        const tab = tabs.find((tb) => tb.key === hoverTab.key);
        if (!tab) return null;
        return (
          <TabHoverCard
            tab={tab}
            scope={scope}
            isRemote={isRemoteScope}
            primaryHost={primaryHost}
            computeHosts={computeHosts}
            anchorX={hoverTab.x}
            anchorY={hoverTab.y}
          />
        );
      })()}
    </div>
  );
}
