import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  BLOB_TAB_CMD,
  CALENDAR_TAB_CMD,
  NETWORK_TAB_CMD,
  EMPTY_GROUP_ID,
  effectiveTabLocation,
  isLocatableKind,
  isPtyTabKind,
  useTabsStore,
  useGroup,
  useGroupTabs,
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
  buildStaticTabSpec,
  type StaticMenuItem,
} from "./newTabItems";
import { reseedDetached, startDetachedDropSession } from "./detachedDropTargets";
import { startCursorPoll, desktopCursor, type PhysPoint } from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useActivityStore } from "../../stores/activity";
import { useFileSourcesStore } from "../../stores/fileSources";
import { OrbitSpinner } from "../common/OrbitSpinner";

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
}

export function TabBar({ groupId, projectCwd, showGroupClose }: Props) {
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
  const closeGroup = useTabsStore((s) => s.closeGroup);
  const hideGroup = useTabsStore((s) => s.hideGroup);
  // SSH-sync Phase 0: the local/remote locality toggle is only meaningful for a
  // remote (SSH) project's agent/shell tabs. Subscribe to a single boolean so a
  // project edit elsewhere doesn't re-render every bar.
  const isRemoteScope = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
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
  // spinner so busy agents/terminals are visible even when not the active tab.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  // Active project's name, used to name an agent's own session on launch.
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId)?.name ?? "",
  );

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // #56: a right-click on a tab enters inline rename mode for that key (no menu,
  // no prompt dialog). The label becomes a focused, text-selected <input>.
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

  // Keep the add menu inside the viewport. It's positioned at the +'s left/bottom
  // and grows rightward/downward, so a + near the right (or bottom) edge would push
  // the menu past the window border and clip it off-screen. Once it's mounted we can
  // measure its real size and shift it back in. Guarded so the corrective setMenuPos
  // doesn't loop (it re-runs, finds nothing to fix, stops).
  useLayoutEffect(() => {
    if (!menuOpen || !menuPos) return;
    const el = addMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let nx = menuPos.x;
    let ny = menuPos.y;
    if (rect.right > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (rect.bottom > window.innerHeight - margin) {
      ny = Math.max(margin, window.innerHeight - margin - rect.height);
    }
    if (nx !== menuPos.x || ny !== menuPos.y) setMenuPos({ x: nx, y: ny });
  }, [menuOpen, menuPos]);

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
    if (item.kind === "files") {
      ensureTab(
        { label: item.label, cmd: item.cmd, cwd: projectCwd, kind: item.kind },
        (tab) => tab.kind === "files" && tab.cwd === projectCwd,
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

  // Open (or focus, if already open) the native calendar tab (root scope only).
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
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias },
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
        env: {},
        cwd: projectCwd,
        kind: "local_agent",
      });
    } catch {
      // ollama launch unavailable / agent prep failed — don't create a broken tab.
    }
  }

  // #56: right-click a tab → immediately enter inline rename mode (no menu).
  function startInlineRename(event: React.MouseEvent, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenuPos(null);
    focusGroup(groupId);
    setEditingKey(key);
  }

  function commitRename(key: string, value: string) {
    // renameTab trims and ignores empty input, so an empty value leaves the
    // label unchanged.
    renameTab(key, value);
    setEditingKey(null);
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
        // Never dragged → this was a click: activate the tab.
        setGroupActive(groupId, tab.key);
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
      const overDetached = phys ? detached.at(phys) : null;
      if (overDetached && phys) {
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
      // Released in FREE SPACE — outside the main window and not over a popout, so
      // no Eldrun window is under the cursor (e.g. dragged onto the desktop or
      // another monitor). Pop this tab into its own standalone OS window. Client
      // coords falling outside [0,inner) is the outside-the-window signal (DOM
      // clientX/Y is reliable CSS px on every engine).
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

  // #42: drag the left-edge grip to pop the group into its own OS window —
  // replacing the old ⧉ button. Focuses immediately on press; once the pointer
  // crosses a small threshold the group detaches at the cursor and the window
  // manager takes over the move (`startDragging`), so the popout follows the
  // cursor natively until release. Only the explicit `.tab-drag-grip` triggers
  // this — grabbing empty bar space no longer detaches, so a stray bar drag can't
  // accidentally pop a subwindow out.
  function onBarPointerDown(e: React.PointerEvent) {
    focusGroup(groupId);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".tab-drag-grip")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let detaching = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onMove = (ev: PointerEvent) => {
      if (detaching) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
      detaching = true;
      cleanup();
      const clientX = ev.clientX;
      const clientY = ev.clientY;
      const activeLabel = tabs.find((t) => t.key === activeKey)?.label;
      // Spawn the popout under the cursor (offset so the grab point lands on its
      // top frame), then hand the move to the WM via startDragging — the still-
      // pressed pointer drives a native window move until release. The bounds feed
      // Rust `.position(x,y)` (PHYSICAL), so read the OS cursor in physical px
      // (desktopCursor) rather than DOM screenX/Y, whose units diverge under DPI.
      void desktopCursor()
        .then((p) => {
          const bounds = {
            x: Math.round(p.x - 80),
            y: Math.round(p.y - 8),
            w: 900,
            h: 640,
          };
          const label = detachGroup(groupId, { bounds });
          if (!label) return; // lone group can't detach — abort quietly.
          // Send-off animation at the grab point, flying toward the exit edge.
          playDetachFlyOut(clientX, clientY, activeLabel ?? "Subwindow");
          WebviewWindow.getByLabel(label)
            .then((w) => w?.startDragging())
            .catch(() => {});
        })
        .catch(() => {});
    };
    const onUp = () => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
        // Only PTY-backed tabs can register terminal output activity.
        const working = isPtyTabKind(tab.kind) && !!busyByTab[tab.key];
        // Expose the kind colour to CSS on every tab (not just the active one)
        // so the top stripe reads as the tab-group colour consistently — plain
        // themes draw the rail above, fancy themes move it below. Inactive tabs
        // keep a transparent stripe slot; hover/active tint it with this colour.
        const style = { "--tab-accent": TAB_ACCENT[tab.kind] } as React.CSSProperties;
        // Agent tabs launched with a deterministic session id show it on hover.
        // This is the launch id (`--session-id <uuid>`): stable and unique per
        // tab. It does NOT follow a `/clear` (which rolls onto a new id) — that
        // needs a different mechanism, see TODO #39c.
        const title = tab.sessionId
          ? `${tab.label} session\n${tab.sessionId}\ncwd: ${tab.cwd}`
          : undefined;
        const editing = editingKey === tab.key;
        // A tab freshly dropped into this bar plays the drop-in landing once.
        const landing = !isDragging && landedKey === tab.key;
        return (
          <Fragment key={tab.key}>
          {showMarkerBefore && dropPlaceholder}
          <div
            className={`tab ${isActive ? "active" : ""}${working ? " working" : ""}${isDragging ? " dragging" : ""}${editing ? " editing" : ""}${landing ? " landing" : ""}`}
            style={style}
            data-tab-index={index}
            data-kind={tab.kind}
            title={editing ? undefined : title}
            onContextMenu={(e) => startInlineRename(e, tab.key)}
            onPointerDown={(e) => onTabPointerDown(e, tab)}
            // Clear the landing once it finishes so the class doesn't linger
            // (guard on currentTarget so a child's animationend — e.g. the
            // working-spinner pulse — never clears it early).
            onAnimationEnd={
              landing
                ? (e) => {
                    if (e.target === e.currentTarget) clearLanded(landedNonce);
                  }
                : undefined
            }
          >
            {working && (
              <span
                className="tab-working"
                style={{ color: TAB_ACCENT[tab.kind] }}
                title="Working…"
              >
                <OrbitSpinner className="tab-working-spinner" />
              </span>
            )}
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
            {/* SSH-sync Phase 0: local/remote locality badge — click to toggle
                whether this agent/shell tab runs in the local mirror or on the
                host. Only shown for a remote project's locatable tabs. */}
            {isRemoteScope && isLocatableKind(tab.kind) && (() => {
              const loc = effectiveTabLocation(tab);
              return (
                <button
                  className={`tab-locality ${loc}`}
                  title={
                    loc === "local"
                      ? "Runs locally in the project mirror — click to run on the host"
                      : "Runs on the host over SSH — click to run locally in the mirror"
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabLocation(tab.key, loc === "local" ? "remote" : "local");
                  }}
                >
                  {loc === "local" ? "⌂" : "☁"}
                </button>
              );
            })()}
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); removeTab(tab.key); }}
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
          onClick={() => scrollStrip(1)}
        >
          ›
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
      {menuOpen && menuPos && createPortal(
        <div
          className="tab-new-menu"
          ref={addMenuRef}
          style={{ position: "fixed", left: menuPos.x, top: menuPos.y }}
        >
          <div className="tab-new-menu-group-label">Agents</div>
          {AGENT_ITEMS.filter((item) => installedAgents?.has(item.cmd)).map((item) => (
            <button
              key={item.cmd}
              className="tab-new-menu-item"
              onClick={() => handleAdd(item)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
              {item.label}
            </button>
          ))}

          <div className="tab-new-menu-group-label">
            {localModel ? `Local Model · ${localModel}` : "Local Model"}
          </div>
          {localModel ? (
            (() => {
              // Only offer agents whose binary is actually installed: Mistral/vibe
              // (checked against `installedAgents`) and the drivers the backend
              // already marks `available` (which now includes an installed check).
              const vibeInstalled = installedAgents?.has("vibe") ?? false;
              const drivers = localDrivers.filter((d) => d.available);
              if (!vibeInstalled && drivers.length === 0) {
                return (
                  <div className="tab-new-menu-hint">
                    No local agent installed — install one in the 🧠 menu
                  </div>
                );
              }
              return (
                <>
                  {/* Mistral/vibe keeps its bespoke per-model VIBE_HOME path. */}
                  {vibeInstalled && (
                    <button
                      className="tab-new-menu-item"
                      onClick={() => handleOllamaModel(localModel)}
                    >
                      <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
                      Mistral
                    </button>
                  )}
                  {/* Other agents drive the same model via `ollama launch` / fallback. */}
                  {drivers.map((d) => (
                    <button
                      key={d.id}
                      className="tab-new-menu-item"
                      onClick={() => handleLocalLaunch(d.id, d.label, localModel)}
                    >
                      <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
                      {d.label}
                    </button>
                  ))}
                </>
              );
            })()
          ) : (
            <div className="tab-new-menu-hint">No local model set — pick one in the app bar</div>
          )}

          <div className="tab-new-menu-group-label">Shell</div>
          {SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => (
            <button
              key={item.cmd}
              className="tab-new-menu-item"
              onClick={() => handleAdd(item)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
              {item.label}
            </button>
          ))}

          <div className="tab-new-menu-group-label">Files</div>
          {SHELL_ITEMS.filter((i) => i.kind === "files").map((item) => (
            <button
              key={item.cmd}
              className="tab-new-menu-item"
              disabled={!projectCwd}
              onClick={() => handleAdd(item)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
              {item.label}
            </button>
          ))}

          {scope !== "root" && (
            <>
              <div className="tab-new-menu-group-label">Monitoring</div>
              <button className="tab-new-menu-item" onClick={handleAddNetwork}>
                <span
                  className="tab-new-menu-dot"
                  style={{ color: TAB_ACCENT.network }}
                >
                  ●
                </span>
                Network Traffic
              </button>
            </>
          )}

          {showBlobItem && (
            <>
              <div className="tab-new-menu-group-label">Workspace</div>
              <button className="tab-new-menu-item" onClick={handleAddBlob}>
                <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["projects3d"] }}>◍</span>
                Projects (3D)
              </button>
            </>
          )}

          {scope === "root" && (
            <>
              <div className="tab-new-menu-group-label">Calendar</div>
              <button className="tab-new-menu-item" onClick={handleAddCalendar}>
                <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT.calendar }}>◆</span>
                Calendar
              </button>
            </>
          )}

          <div className="tab-new-menu-group-label">Project</div>
          <button
            className="tab-new-menu-item"
            disabled={!hasAnyTabs}
            onClick={() => {
              closeAllTabs();
              setMenuPos(null);
            }}
          >
            <span className="tab-new-menu-dot" style={{ color: "var(--danger, #d9534f)" }}>×</span>
            Close all tabs
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
