import { useTabsStore, TabKind } from "../../stores/tabs";

const TAB_COLORS: Record<TabKind, string> = {
  agent: "var(--accent)",
  shell: "var(--success)",
  root: "var(--text-muted)",
};

const QUICK_ADD: Array<{ label: string; cmd: string; kind: TabKind }> = [
  { label: "Claude", cmd: "claude", kind: "agent" },
  { label: "Codex", cmd: "codex", kind: "agent" },
  { label: "Gemini", cmd: "gemini", kind: "agent" },
  { label: "Shell", cmd: "bash", kind: "shell" },
];

interface Props {
  projectCwd: string;
}

export function TabBar({ projectCwd }: Props) {
  const { tabs, activeKey, setActive, addTab, removeTab } = useTabsStore();

  function handleAdd(cmd: string, label: string, kind: TabKind) {
    addTab({ label, cmd, cwd: projectCwd, kind });
  }

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.key}
          className={`tab ${tab.key === activeKey ? "active" : ""}`}
          style={
            tab.key === activeKey
              ? { boxShadow: `inset 0 2px 0 ${TAB_COLORS[tab.kind]}` }
              : {}
          }
          onClick={() => setActive(tab.key)}
        >
          <span className="tab-label">{tab.label}</span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              removeTab(tab.key);
            }}
            title="Close tab"
          >
            ×
          </button>
        </div>
      ))}
      <div className="tab-add-group">
        {QUICK_ADD.map((a) => (
          <button
            key={a.cmd}
            className="tab-add-btn"
            title={`New ${a.label} tab`}
            onClick={() => handleAdd(a.cmd, a.label, a.kind)}
          >
            +{a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
