import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  FILES_TAB_CMD,
  useTabsStore,
  TabKind,
  findGroup,
  RESUMABLE_AGENTS,
} from "../../stores/tabs";
import { useDragStore } from "../../stores/drag";
import { commitDrop } from "./commitDrop";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { OrbitSpinner } from "../common/OrbitSpinner";

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
  { label: "Claude",  cmd: "claude", kind: "agent", sessionRename: (n) => `/rename ${n}`, sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Codex",   cmd: "codex",  kind: "agent" },
  { label: "Gemini",  cmd: "gemini", kind: "agent", sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Mistral", cmd: "vibe",   kind: "agent" },
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

// Fixed width of the gap that opens within the bar to receive a reordered tab.
const REORDER_GAP = 80;

export function TabBar({ groupId, projectCwd, showGroupClose }: Props) {
  // Subscribe to the layout + tab payloads so this group's bar re-renders on
  // any structural change. The flat `tabs` array is the source of payloads;
  // the group node owns tab order + the active key.
  const layout = useTabsStore((s) => s.layout);
  const allTabs = useTabsStore((s) => s.tabs);
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const setGroupActive = useTabsStore((s) => s.setGroupActive);
  const renameTab = useTabsStore((s) => s.renameTab);
  const addTab = useTabsStore((s) => s.addTab);
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const removeTab = useTabsStore((s) => s.removeTab);
  const closeGroup = useTabsStore((s) => s.closeGroup);
  // Within-bar reorder visuals are driven by the pointer-drag store so the gap
  // tracks the live drop slot CenterPanel resolves; the dragged tab collapses.
  const dragKey = useDragStore((s) => (s.drag ? s.drag.key : null));
  const reorderGroup = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === groupId ? groupId : null,
  );
  const reorderIndex = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === groupId ? s.drag.reorderIndex : null,
  );
  // Per-tab "working" map: a tab whose PTY is actively producing output shows a
  // spinner so busy agents/terminals are visible even when not the active tab.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  // Active project's name, used to name an agent's own session on launch.
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId)?.name ?? "",
  );

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuOpen = menuPos !== null;

  const group = findGroup(layout, groupId);
  // Resolve this group's tab keys to full payloads, preserving group order.
  const byKey = new Map(allTabs.map((t) => [t.key, t] as const));
  const tabs = (group?.tabKeys ?? [])
    .map((k) => byKey.get(k))
    .filter((t): t is NonNullable<typeof t> => t != null);
  const activeKey = group?.activeKey ?? null;

  useEffect(() => {
    if (!menuOpen && !tabMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addBtnRef.current?.contains(t)) return;
      if (addMenuRef.current?.contains(t)) return;
      if (tabMenuRef.current?.contains(t)) return;
      setMenuPos(null);
      setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuPos(null);
        setTabMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, tabMenu]);

  function openAddMenu() {
    if (menuPos) { setMenuPos(null); return; }
    const r = addBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Adding always targets THIS group, so focus it first.
    focusGroup(groupId);
    setMenuPos({ x: r.left, y: r.bottom + 4 });

    setOllamaLoading(true);
    setOllamaError(null);
    invoke<string[]>("list_ollama_models")
      .then((models) => setOllamaModels(models))
      .catch((e: string) => {
        setOllamaModels([]);
        setOllamaError(e === "not_running" ? "Ollama not running" : "Failed to load models");
      })
      .finally(() => setOllamaLoading(false));
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

  function showTabMenu(event: React.MouseEvent, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenuPos(null);
    setTabMenu({ key, x: event.clientX, y: event.clientY });
  }

  function renameFromMenu(key: string) {
    const tab = tabs.find((item) => item.key === key);
    if (!tab) return;
    const label = window.prompt("Rename tab:", tab.label);
    if (label?.trim()) renameTab(key, label);
    setTabMenu(null);
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
    // Suppress the webview's native text-selection / drag gesture, which on
    // WebKitGTK hijacks the pointer stream and fires pointercancel instead of
    // pointerup mid-drag.
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        useDragStore.getState().start({
          key: tab.key,
          fromGroup: groupId,
          label: tab.label,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
        });
      }
      useDragStore.getState().move(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragging) {
        // Never dragged → this was a click: activate the tab.
        setGroupActive(groupId, tab.key);
        return;
      }
      // A drag did start: commit the drop HERE. This handler is bound inside the
      // pointerdown handler — i.e. before the gesture's implicit pointer capture
      // begins — so on WebKitGTK it is the ONLY release handler that reliably
      // fires. CenterPanel's window listeners are added mid-gesture (after the
      // `start()` → React re-render) and, on WebKitGTK, receive pointermove but
      // never the terminal pointerup, so they cannot be the committer. The
      // target was already resolved into the drag store by CenterPanel's
      // pointermove handler during the drag, so commit it verbatim. If
      // CenterPanel's pointerup DID fire first (other platforms), it already
      // committed + ended, so we see drag=null and no-op — no double-commit.
      const d = useDragStore.getState().drag;
      if (d != null) {
        commitDrop(d);
        useDragStore.getState().end();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="tab-bar" data-group-id={groupId} onMouseDown={() => focusGroup(groupId)}>
      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;
        const isDragging = dragKey === tab.key;
        const isLast = index === tabs.length - 1;
        // Files tabs have no PTY, so they never register output activity.
        const working = tab.kind !== "files" && !!busyByTab[tab.key];
        // Open the gap by sliding the neighbouring tab away from the slot. A
        // dragging tab is collapsed to nothing, so it never carries a gap.
        const style: React.CSSProperties = isActive
          ? { boxShadow: `inset 0 3px 0 ${TAB_ACCENT[tab.kind]}` }
          : {};
        if (!isDragging && reorderGroup === groupId) {
          if (reorderIndex === index) style.marginLeft = REORDER_GAP;
          if (isLast && reorderIndex === tabs.length) style.marginRight = REORDER_GAP;
        }
        // Agent tabs launched with a deterministic session id show it on hover.
        // This is the launch id (`--session-id <uuid>`): stable and unique per
        // tab. It does NOT follow a `/clear` (which rolls onto a new id) — that
        // needs a different mechanism, see TODO #39c.
        const title = tab.sessionId
          ? `${tab.label} session\n${tab.sessionId}\ncwd: ${tab.cwd}`
          : undefined;
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}${working ? " working" : ""}${isDragging ? " dragging" : ""}`}
            style={style}
            data-tab-index={index}
            title={title}
            onContextMenu={(e) => showTabMenu(e, tab.key)}
            onPointerDown={(e) => onTabPointerDown(e, tab)}
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
            <span className="tab-label">{tab.label}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); removeTab(tab.key); }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
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

          <div className="tab-new-menu-group-label">Local Agents</div>
          {ollamaLoading && (
            <div className="tab-new-menu-hint">Loading…</div>
          )}
          {!ollamaLoading && ollamaError && (
            <div className="tab-new-menu-hint">{ollamaError}</div>
          )}
          {!ollamaLoading && !ollamaError && ollamaModels.length === 0 && (
            <div className="tab-new-menu-hint">No Ollama models found</div>
          )}
          {!ollamaLoading && ollamaModels.map((model) => (
            <button
              key={model}
              className="tab-new-menu-item"
              onClick={() => handleOllamaModel(model)}
            >
              <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
              {model}
            </button>
          ))}

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
        </div>,
        document.body,
      )}
      {tabMenu && createPortal(
        <div
          ref={tabMenuRef}
          className="context-menu tab-context-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
        >
          <button onClick={() => renameFromMenu(tabMenu.key)}>Rename tab</button>
          <button onClick={() => { removeTab(tabMenu.key); setTabMenu(null); }}>
            Close tab
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
