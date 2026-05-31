import { useState } from "react";
import { ProjectPill } from "../projects/ProjectPill";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { Theme } from "../../types";
import { THEMES } from "../../types";

interface Props {
  onToggleRight: () => void;
}

export function BottomBar({ onToggleRight }: Props) {
  const { projects, activeId, setActive } = useProjectsStore();
  const { settings, setTheme } = useSettingsStore();
  const [showSettings, setShowSettings] = useState(false);

  const currentTheme = (settings?.color_scheme ?? "fancy_dark") as Theme;

  return (
    <>
      {showSettings && (
        <div className="settings-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="settings-label">Theme</div>
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={`theme-btn ${currentTheme === t.value ? "selected" : ""}`}
              onClick={() => setTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="bottom-bar" onClick={() => showSettings && setShowSettings(false)}>
        {projects.map((p) => (
          <ProjectPill
            key={p.id}
            project={p}
            active={p.id === activeId}
            onClick={() => setActive(p.id)}
          />
        ))}
        <div style={{ flex: 1 }} />
        <button
          className="bottom-action-btn"
          title="Toggle file tree"
          onClick={onToggleRight}
        >
          ›
        </button>
        <button
          className="bottom-action-btn"
          title="Settings"
          onClick={(e) => { e.stopPropagation(); setShowSettings((v) => !v); }}
        >
          ⚙
        </button>
      </div>
    </>
  );
}
