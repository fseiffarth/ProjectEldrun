import { useEffect, useRef, useState } from "react";
import { useTabsStore, TabKind } from "../../stores/tabs";

const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  shell: "var(--success)",
};

const MENU_ITEMS: Array<{ label: string; cmd: string; kind: TabKind }> = [
  { label: "Claude", cmd: "claude", kind: "agent" },
  { label: "Codex",  cmd: "codex",  kind: "agent" },
  { label: "Gemini", cmd: "gemini", kind: "agent" },
  { label: "Shell",  cmd: "bash",   kind: "shell"  },
];

interface Props {
  projectCwd: string;
}

export function TabBar({ projectCwd }: Props) {
  const { tabs, activeKey, setActive, addTab, removeTab } = useTabsStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function handleAdd(cmd: string, label: string, kind: TabKind) {
    addTab({ label, cmd, cwd: projectCwd, kind });
    setMenuOpen(false);
  }

  return (
    <>
      <div className="tab-bar">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              className={`tab ${isActive ? "active" : ""}`}
              style={isActive ? { boxShadow: `inset 0 3px 0 ${TAB_ACCENT[tab.kind]}` } : {}}
              onClick={() => setActive(tab.key)}
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
      </div>

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
                onClick={() => handleAdd(item.cmd, item.label, item.kind)}
              >
                <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
