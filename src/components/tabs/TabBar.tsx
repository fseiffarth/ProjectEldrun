import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { FILES_TAB_CMD, useTabsStore, TabKind } from "../../stores/tabs";

const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  local_agent: "var(--warning)",
  shell: "var(--success)",
  files: "#888",
};

interface StaticMenuItem {
  label: string;
  cmd: string;
  kind: TabKind;
  env?: Record<string, string>;
}

const AGENT_ITEMS: StaticMenuItem[] = [
  { label: "Claude",  cmd: "claude", kind: "agent" },
  { label: "Codex",   cmd: "codex",  kind: "agent" },
  { label: "Gemini",  cmd: "gemini", kind: "agent" },
  { label: "Mistral", cmd: "vibe",   kind: "agent" },
];

const SHELL_ITEMS: StaticMenuItem[] = [
  { label: "Shell", cmd: "bash",          kind: "shell" },
  { label: "Files", cmd: FILES_TAB_CMD,   kind: "files" },
];

interface Props {
  projectCwd: string;
}

export function TabBar({ projectCwd }: Props) {
  const { tabs, activeKey, grid, setActive, renameTab, addTab, ensureTab, removeTab, reorder, toggleGrid } = useTabsStore();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // Source index lives in a ref too: dataTransfer.getData() is unreadable during
  // dragover (only drop), and reading React state inside the drag closures can be
  // stale, so the ref is the source of truth for the actual reorder on drop.
  const dragIndexRef = useRef<number | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuOpen = menuPos !== null;

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
    if (item.kind === "files") {
      ensureTab(
        { label: item.label, cmd: item.cmd, cwd: projectCwd, kind: item.kind },
        (tab) => tab.kind === "files" && tab.cwd === projectCwd,
      );
      setMenuPos(null);
      return;
    }
    addTab({ label: item.label, cmd: item.cmd, args: [], env: item.env ?? {}, cwd: projectCwd, kind: item.kind });
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

  function handleTabDrop(targetIndex: number) {
    const from = dragIndexRef.current;
    if (from !== null && from !== targetIndex) {
      // reorder() updates the store; CenterPanel's debounced effect persists it.
      reorder(from, targetIndex);
    }
    dragIndexRef.current = null;
    setDragIndex(null);
    setDragOverIndex(null);
  }

  return (
    <div className="tab-bar">
      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}${dragOverIndex === index ? " drag-over" : ""}${dragIndex === index ? " dragging" : ""}`}
            style={isActive ? { boxShadow: `inset 0 3px 0 ${TAB_ACCENT[tab.kind]}` } : {}}
            draggable
            onClick={() => setActive(tab.key)}
            onContextMenu={(e) => showTabMenu(e, tab.key)}
            onDragStart={(e) => {
              dragIndexRef.current = index;
              setDragIndex(index);
              e.dataTransfer.effectAllowed = "move";
              // Some webviews refuse to start a drag without payload data.
              e.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(e) => {
              // Always allow the drop; without preventDefault the browser
              // cancels it and onDrop never fires.
              if (dragIndexRef.current === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverIndex !== index) setDragOverIndex(index);
            }}
            onDragLeave={() => {
              if (dragOverIndex === index) setDragOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleTabDrop(index);
            }}
            onDragEnd={() => {
              dragIndexRef.current = null;
              setDragIndex(null);
              setDragOverIndex(null);
            }}
          >
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
        <button
          className={`tab-grid-btn${grid ? " active" : ""}`}
          title={grid ? "Single view" : "Grid view"}
          disabled={tabs.length < 2}
          onClick={() => toggleGrid()}
        >
          ▦
        </button>
      </div>
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
