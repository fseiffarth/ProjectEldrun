import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  FILES_TAB_CMD,
  useTabsStore,
  useGroup,
  useGroupTabs,
  TabKind,
  RESUMABLE_AGENTS,
} from "../../stores/tabs";
import { useDragStore } from "../../stores/drag";
import { useTabLandStore } from "../../stores/tabLand";
import { useDetachAnimStore, flyVector } from "../../stores/detachAnim";
import { commitDrop } from "./commitDrop";
import { TabDropPlaceholder } from "./TabDropPlaceholder";
import { reseedDetached, startDetachedDropSession } from "./detachedDropTargets";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useActivityStore } from "../../stores/activity";
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

const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  local_agent: "var(--warning)",
  shell: "var(--success)",
  files: "#888",
  embed: "var(--info, #4aa3df)",
};

interface StaticMenuItem {
  label: string;
  cmd: string;
  kind: TabKind;
  env?: Record<string, string>;
  // Optional template for a command typed into the agent on launch to name its
  // own session after the project. Only set for agents with a known
  // session-rename command; others are skipped to avoid typing junk into them.
  sessionRename?: (projectName: string) => string;
  // When set, Eldrun mints a UUID at launch and passes it to the agent so it
  // owns a deterministic session id (e.g. Claude's `--session-id <uuid>`). The
  // returned strings are appended to the spawn args. Lets us surface the
  // session id on hover and later resume the session.
  sessionIdArgs?: (uuid: string) => string[];
}

// Only Claude and Gemini accept a caller-supplied session UUID at launch
// (both via `--session-id <uuid>`), so only those get `sessionIdArgs`. Codex
// (`codex resume <id>`) and Mistral/vibe (`--resume [id]`) mint their own ids
// and only accept one when resuming, so there's no deterministic id to capture
// up front — passing `--session-id` would just error and break the tab.
const AGENT_ITEMS: StaticMenuItem[] = [
  { label: "Claude",   cmd: "claude",       kind: "agent", sessionRename: (n) => `/rename ${n}`, sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Codex",    cmd: "codex",        kind: "agent" },
  { label: "Gemini",   cmd: "gemini",       kind: "agent", sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Mistral",  cmd: "vibe",         kind: "agent" },
  { label: "Aider",    cmd: "aider",        kind: "agent" },
  { label: "OpenCode", cmd: "opencode",     kind: "agent" },
  { label: "Cursor",   cmd: "cursor-agent", kind: "agent" },
  { label: "Copilot",  cmd: "copilot",      kind: "agent" },
  { label: "Grok",     cmd: "grok",         kind: "agent" },
  { label: "Qwen",     cmd: "qwen",         kind: "agent" },
];

const SHELL_ITEMS: StaticMenuItem[] = [
  { label: "Shell", cmd: "bash",          kind: "shell" },
  { label: "Files", cmd: FILES_TAB_CMD,   kind: "files" },
];

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
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const setGroupActive = useTabsStore((s) => s.setGroupActive);
  const renameTab = useTabsStore((s) => s.renameTab);
  const addTab = useTabsStore((s) => s.addTab);
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const removeTab = useTabsStore((s) => s.removeTab);
  const closeGroup = useTabsStore((s) => s.closeGroup);
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
  // The single active local (Ollama) model, set in the global app bar's Local
  // Model picker. The add menu offers ONE "Local Model" entry that launches it,
  // rather than listing every installed model.
  const localModel = useSettingsStore((s) => s.settings?.ollama_model);
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
    // For agents that support it, type their session-rename command on launch
    // so the agent's own session is named after the project.
    const initialInput =
      item.sessionRename && projectName ? item.sessionRename(projectName) : undefined;
    // Mint a per-tab UUID for any agent we can resume (`cmd` in RESUMABLE_AGENTS)
    // or that takes a deterministic launch id (`sessionIdArgs`). It is the tab's
    // stable key for the whole session-tracking machinery.
    const tracked = item.cmd in RESUMABLE_AGENTS;
    const sessionId = tracked || item.sessionIdArgs ? crypto.randomUUID() : undefined;
    // Launch args: only agents with `sessionIdArgs` (Claude, Gemini) pass the id
    // at launch (`--session-id`). Codex mints its own id, so it launches bare and
    // the backend injects `resume <live-id>` on a later restore.
    const args = sessionId && item.sessionIdArgs ? item.sessionIdArgs(sessionId) : [];
    // Resumable agents get `ELDRUN_TAB_UID` so the SessionStart hook records their
    // live session id under this tab's key (see services::agent_session). Persisted
    // in env, so it round-trips across restart.
    const env = {
      ...(item.env ?? {}),
      ...(tracked && sessionId ? { ELDRUN_TAB_UID: sessionId } : {}),
    };
    addTab({ label: item.label, cmd: item.cmd, args, env, cwd: projectCwd, kind: item.kind, initialInput, sessionId });
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
    let dragging = false;

    // #42 (main → detached): an open popout of the current scope is a valid drop
    // target — releasing the dragged tab over one docks it there instead of
    // spawning a new window. The shared session resolves each popout's on-screen
    // bounds (async), hit-tests the cursor against them, and toggles the popout's
    // drop-target highlight — the SAME logic the file drag uses (FileTree).
    const detached = startDetachedDropSession();

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
      }
      useDragStore.getState().move(ev.clientX, ev.clientY);
      // Drive the drop preview in the popout under the cursor (if any) — it
      // resolves the pane and renders the per-pane preview. screenX/Y stay valid
      // past the main viewport thanks to the pointer's implicit grab.
      detached.hover(detached.at(ev.screenX, ev.screenY), ev.screenX, ev.screenY, tab.label);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Clear the popout highlight + tear down the panes listener, however this
      // release resolves. `targetAt` still hit-tests the cached pane geometry.
      detached.dispose();
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
      // Pop the dragged tab into its own standalone OS window at the cursor,
      // mirroring the bar-drag detach (onBarPointerDown). Reused by the Shift
      // override and the free-space (outside-the-window) release below.
      const popToNewWindow = () => {
        const bounds = {
          x: Math.round(ev.screenX - 80),
          y: Math.round(ev.screenY - 8),
          w: 900,
          h: 640,
        };
        // Send-off animation toward the edge the tab exited through, before the
        // drag state (and its ghost) tears down.
        playDetachFlyOut(ev.clientX, ev.clientY, tab.label, d.previewW, d.previewH);
        detachTab(tab.key, bounds);
        useDragStore.getState().end();
      };
      // Shift ALWAYS pops a new window — overriding both docking into a popout and
      // integrating into a background subwindow. (May spawn the new window over a
      // popout the cursor happens to be on; that's the intended "always new".)
      if (ev.shiftKey) {
        popToNewWindow();
        return;
      }
      // #42: released over an existing popout → dock the tab straight into it (no
      // new window). Re-hit-test at the release coords so it reflects exactly
      // where the cursor ended. The popout's panes attach-only to PTYs the main
      // keeps mounted, so the tab's terminal survives the move.
      const overDetached = detached.at(ev.screenX, ev.screenY);
      if (overDetached) {
        // Dock into the SPECIFIC pane under the cursor (a body edge splits, a bar
        // merges) — resolved synchronously at the release coords, so no stale
        // cross-window cache and never always-the-first-pane.
        useTabsStore
          .getState()
          .dockTabIntoDetached(
            overDetached.scope,
            overDetached.groupId,
            tab.key,
            detached.targetAt(overDetached, ev.screenX, ev.screenY),
          );
        // Re-seed the popout so it renders the newly-docked tab, tagged so it
        // plays the drop-in landing for this cross-window merge (mirrors the
        // dock-BACK re-seed in CenterPanel's DETACHED_DRAG_END handler).
        reseedDetached(overDetached.scope, overDetached.groupId, tab.key);
        // Send-off animation toward the edge the tab exited through.
        playDetachFlyOut(ev.clientX, ev.clientY, tab.label, d.previewW, d.previewH);
        useDragStore.getState().end();
        return;
      }
      // Released in FREE SPACE — outside the main window and not over a popout, so
      // no Eldrun window is under the cursor (e.g. dragged onto the desktop or
      // another monitor). Pop this tab into its own standalone OS window. The
      // pointer's implicit capture keeps delivering coords beyond the viewport, so
      // client coords falling outside [0,inner) is the outside-the-window signal.
      const outside =
        ev.clientX < 0 ||
        ev.clientY < 0 ||
        ev.clientX >= window.innerWidth ||
        ev.clientY >= window.innerHeight;
      if (outside) {
        popToNewWindow();
        return;
      }
      // Released over THIS main window without Shift → integrate into the
      // background subwindow under the cursor. This handler is bound inside the
      // pointerdown handler — i.e. before the gesture's implicit pointer capture
      // begins — so on WebKitGTK it is the ONLY release handler that reliably
      // fires. CenterPanel's window listeners are added mid-gesture (after the
      // `start()` → React re-render) and, on WebKitGTK, receive pointermove but
      // never the terminal pointerup, so they cannot be the committer. The
      // target was already resolved into the drag store by CenterPanel's
      // pointermove handler during the drag, so commit it verbatim. A null target
      // (chrome / split divider) is a no-op — the tab stays put. If CenterPanel's
      // pointerup DID fire first (other platforms), it already committed + ended,
      // so the top-of-handler guard already returned — no double-commit.
      commitDrop(d);
      useDragStore.getState().end();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // #42: grab the subwindow's top frame (the empty tab-bar area) and drag it out
  // to pop the group into its own OS window — replacing the old ⧉ button. Focuses
  // immediately on press; once the pointer crosses a small threshold the group
  // detaches at the cursor and the window manager takes over the move
  // (`startDragging`), so the popout follows the cursor natively until release.
  function onBarPointerDown(e: React.PointerEvent) {
    focusGroup(groupId);
    if (e.button !== 0) return;
    // Only the empty bar area is a detach handle — not tabs, the +/close
    // controls, or an inline rename input.
    const target = e.target as HTMLElement;
    if (target.closest(".tab, .tab-new-wrap, button, .tab-label-edit")) return;
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
      // Spawn the popout under the cursor (offset so the grab point lands on its
      // top frame), then hand the move to the WM via startDragging — the still-
      // pressed pointer drives a native window move until release.
      const bounds = {
        x: Math.round(ev.screenX - 80),
        y: Math.round(ev.screenY - 8),
        w: 900,
        h: 640,
      };
      const label = detachGroup(groupId, { bounds });
      if (!label) return; // lone group can't detach — abort quietly.
      // Send-off animation at the grab point, flying toward the exit edge.
      const activeLabel = tabs.find((t) => t.key === activeKey)?.label;
      playDetachFlyOut(ev.clientX, ev.clientY, activeLabel ?? "Subwindow");
      WebviewWindow.getByLabel(label)
        .then((w) => w?.startDragging())
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
        // Files tabs have no PTY, so they never register output activity.
        const working = tab.kind !== "files" && !!busyByTab[tab.key];
        const style: React.CSSProperties = isActive
          ? { boxShadow: `inset 0 3px 0 ${TAB_ACCENT[tab.kind]}` }
          : {};
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
      <div className="tab-new-wrap">
        <button
          ref={addBtnRef}
          className="tab-new-btn"
          title="New tab"
          onClick={openAddMenu}
        >
          +
        </button>
      </div>
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
          {AGENT_ITEMS.map((item) => (
            <button
              key={item.cmd}
              className="tab-new-menu-item"
              onClick={() => handleAdd(item)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
              {item.label}
            </button>
          ))}

          <div className="tab-new-menu-group-label">Local Model</div>
          {localModel ? (
            <button
              className="tab-new-menu-item"
              onClick={() => handleOllamaModel(localModel)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
              {localModel}
            </button>
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
