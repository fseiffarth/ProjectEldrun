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
  const { tabs, activeKey, setActive, renameTab, addTab, ensureTab, removeTab } = useTabsStore();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
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
    } catch (e) {
      addTab({
        label: model,
        cmd: "vibe",
        args: [],
        env: {},
        cwd: projectCwd,
        kind: "local_agent",
      });
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

  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}`}
            style={isActive ? { boxShadow: `inset 0 3px 0 ${TAB_ACCENT[tab.kind]}` } : {}}
            onClick={() => setActive(tab.key)}
            onContextMenu={(e) => showTabMenu(e, tab.key)}
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
