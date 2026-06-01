import { useEffect, useRef, useState } from "react";
import { FILES_TAB_CMD, useTabsStore, TabKind } from "../../stores/tabs";

const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  shell: "var(--success)",
  files: "var(--warning)",
};

const MENU_ITEMS: Array<{ label: string; cmd: string; kind: TabKind }> = [
  { label: "Claude", cmd: "claude", kind: "agent" },
  { label: "Codex",  cmd: "codex",  kind: "agent" },
  { label: "Gemini", cmd: "gemini", kind: "agent" },
  { label: "Shell",  cmd: "bash",   kind: "shell"  },
  { label: "Files",  cmd: FILES_TAB_CMD, kind: "files" },
];

interface Props {
  projectCwd: string;
}

export function TabBar({ projectCwd }: Props) {
  const { tabs, activeKey, setActive, renameTab, addTab, ensureTab, removeTab } = useTabsStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !tabMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setTabMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
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

  function handleAdd(cmd: string, label: string, kind: TabKind) {
    if (kind === "files") {
      ensureTab(
        { label, cmd, cwd: projectCwd, kind },
        (tab) => tab.kind === "files" && tab.cwd === projectCwd,
      );
      setMenuOpen(false);
      return;
    }
    addTab({ label, cmd, cwd: projectCwd, kind });
    setMenuOpen(false);
  }

  function showTabMenu(event: React.MouseEvent, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
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
      <div className="tab-new-wrap" ref={menuRef}>
        <button
          className="tab-new-btn"
          title="New tab"
          onClick={() => setMenuOpen((v) => !v)}
        >
          +
        </button>
        {menuOpen && (
          <div className="tab-new-menu">
            {MENU_ITEMS.map((item) => (
              <button
                key={item.cmd}
                className="tab-new-menu-item"
                disabled={item.kind === "files" && !projectCwd}
                onClick={() => handleAdd(item.cmd, item.label, item.kind)}
              >
                <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
        {tabMenu && (
          <div
            className="context-menu tab-context-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            <button onClick={() => renameFromMenu(tabMenu.key)}>Rename tab</button>
            <button onClick={() => { removeTab(tabMenu.key); setTabMenu(null); }}>
              Close tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
